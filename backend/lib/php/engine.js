'use strict';

// ============================================================
//  TecXPaneL — PHP: motor de efectos (comprobar / endurecer / parchear)
//  Helpers puros en ./index.js. Solo ramas con php-fpm instalado.
// ============================================================

const fs = require('fs');
const { runSafe } = require('../common/run');
const P = require('./index');

// Ramas con php-fpm instalado (/usr/sbin/php-fpm8.3 → '8.3').
function installedBranches() {
  try {
    return fs.readdirSync('/usr/sbin')
      .map((f) => /^php-fpm(\d+\.\d+)$/.exec(f)?.[1])
      .filter((b) => b && P.RE_BRANCH.test(b));
  } catch (_) { return []; }
}

// Estado de cada rama: versión, si está soportada y si lleva el parche.
async function check() {
  const out = [];
  for (const branch of installedBranches()) {
    const v = await runSafe(`/usr/sbin/php-fpm${branch}`, ['-v']);
    const changelog = await runSafe('zgrep', ['-E', P.CVE_PATTERN, `/usr/share/doc/php${branch}-fpm/changelog.Debian.gz`]);
    out.push({
      branch,
      version: P.parsePhpVersion(v.stdout)?.full || null,
      supported: P.isSupportedBranch(branch),
      patched: changelog.ok || P.isFixedUpstream(v.stdout),
      hardened: fs.existsSync(P.hardeningIniPath(branch)),
    });
  }
  return out;
}

// Escribe el drop-in de mitigación y recarga FPM. Devuelve las ramas tocadas.
async function harden() {
  const done = [];
  for (const branch of installedBranches()) {
    fs.writeFileSync(P.hardeningIniPath(branch), P.HARDENING_INI);
    const r = await runSafe('systemctl', ['reload', `php${branch}-fpm`]);
    if (!r.ok) throw new Error(`No se pudo recargar php${branch}-fpm: ${r.stderr.trim().split('\n')[0]}`);
    done.push(branch);
  }
  return done;
}

// apt: sube solo los paquetes phpX.Y ya instalados (sin traer nada nuevo) y
// reinicia FPM para soltar la librería antigua. Devuelve 0 si todo quedó parcheado.
async function patch(log = () => {}) {
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
  const opts = { timeout: 0, maxBuffer: 64 * 1024 * 1024, env };
  const upd = await runSafe('apt-get', ['update', '-qq'], opts);
  if (!upd.ok) { log('✗ apt-get update falló: ' + upd.stderr.trim().split('\n')[0]); return 1; }
  for (const branch of installedBranches()) {
    const q = await runSafe('dpkg-query', ['-W', '-f=${db:Status-Abbrev} ${Package}\\n', `php${branch}*`]);
    const pkgs = P.parseInstalledPkgs(q.stdout);
    log(`⬆ php${branch}: actualizando ${pkgs.length} paquetes…`);
    const r = await runSafe('apt-get', ['install', '-y', '--only-upgrade', ...pkgs], opts);
    log(r.ok ? r.stdout.split('\n').slice(-3).join('\n') : '✗ ' + r.stderr.trim().split('\n').slice(-2).join(' '));
    await runSafe('systemctl', ['restart', `php${branch}-fpm`]);
  }
  const after = await check();
  for (const b of after) {
    log(`${b.patched ? '✓' : '✗'} php${b.branch} ${b.version || '?'} ${b.patched ? 'parcheado' : (b.supported ? 'SIGUE VULNERABLE (¿repos sin actualización publicada aún?)' : 'rama sin soporte: migra a 8.3+')}`);
  }
  return after.length && after.every((b) => b.patched) ? 0 : 1;
}

module.exports = { installedBranches, check, harden, patch };
