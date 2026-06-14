'use strict';

const os = require('os');
const fs = require('fs');
const express = require('express');
const { ok, fail, clientIp, wrap } = require('../lib/helpers');
const { runSafe } = require('../lib/helpers');
const { cpuPercent, memInfo } = require('../lib/websocket');
const { ALLOWED_SERVICES, ALLOWED_SVC_ACTIONS } = require('../lib/validators');
const { audit } = require('../database');

const router = express.Router();

function osInfo() {
  let distro = 'Linux', release = '';
  try {
    const r = fs.readFileSync('/etc/os-release', 'utf8');
    distro = (r.match(/^NAME="?([^"\n]+)"?/m) || [])[1] || 'Linux';
    release = (r.match(/^VERSION_ID="?([^"\n]+)"?/m) || [])[1] || '';
  } catch (_) {}
  return { hostname: os.hostname(), distro, release, arch: os.arch(), uptime: Math.floor(os.uptime()) };
}

async function diskInfo() {
  const out = await runSafe('df', ['-PB1', '-x', 'tmpfs', '-x', 'devtmpfs']);
  if (!out.ok) return [];
  return out.stdout.trim().split('\n').slice(1).map((l) => {
    const c = l.trim().split(/\s+/);
    return { fs: c[0], size: +c[1], used: +c[2], avail: +c[3], percent: parseInt(c[4], 10), mount: c[5] };
  }).filter((d) => d.mount && !d.mount.startsWith('/snap'));
}

router.get('/stats', wrap(async (req, res) => {
  const [cpu, disk] = await Promise.all([cpuPercent(), diskInfo()]);
  ok(res, { cpu, memory: memInfo(), disk, os: osInfo() });
}));

router.get('/services', wrap(async (req, res) => {
  const result = [];
  for (const name of ['nginx', 'mysql', 'postgresql', 'redis', 'ssh']) {
    const r = await runSafe('systemctl', ['is-active', name]);
    result.push({ name, status: r.stdout.trim() === 'active' ? 'running' : 'stopped' });
  }
  ok(res, result);
}));

router.post('/service/:name/:action', wrap(async (req, res) => {
  const { name, action } = req.params;
  if (!ALLOWED_SERVICES.includes(name)) return fail(res, 400, 'Servicio no permitido');
  if (!ALLOWED_SVC_ACTIONS.includes(action)) return fail(res, 400, 'Acción no permitida');
  const r = await runSafe('systemctl', [action, name]);
  audit(req.user.username, clientIp(req), 'service.' + action, name);
  if (!r.ok) return fail(res, 500, r.stderr.trim() || 'Error al gestionar el servicio');
  ok(res);
}));

router.get('/processes', wrap(async (req, res) => {
  const out = await runSafe('ps', ['-eo', 'pid,comm,%cpu,%mem', '--sort=-%cpu']);
  if (!out.ok) return ok(res, []);
  const procs = out.stdout.trim().split('\n').slice(1, 21).map((l) => {
    const c = l.trim().split(/\s+/);
    return { pid: +c[0], name: c[1], cpu: parseFloat(c[2]) || 0, mem: parseFloat(c[3]) || 0 };
  });
  ok(res, procs);
}));

router.get('/ip', wrap(async (req, res) => {
  let ip = '';
  const r1 = await runSafe('curl', ['-4', '-s', '--max-time', '3', 'https://api.ipify.org']);
  if (r1.ok && r1.stdout.trim()) ip = r1.stdout.trim();
  if (!ip) {
    const r2 = await runSafe('hostname', ['-I']);
    if (r2.ok) ip = r2.stdout.trim().split(/\s+/).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || '';
  }
  ok(res, { ip: ip || 'desconocida' });
}));

router.get('/php-versions', wrap(async (req, res) => {
  const r = await runSafe('bash', ['-c', 'ls /run/php/php*-fpm.sock 2>/dev/null || true']);
  const versions = [];
  if (r.ok && r.stdout.trim()) {
    for (const line of r.stdout.trim().split('\n')) {
      const m = line.match(/php(\d+\.\d+)-fpm\.sock/);
      if (m) versions.push(m[1]);
    }
  }
  ok(res, versions);
}));

module.exports = router;
