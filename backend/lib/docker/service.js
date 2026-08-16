'use strict';

const { dockerRequest } = require('./socket');
const { runSafe } = require('../common/run');
const { buildCommandEnv } = require('../dockerDeploy');

const COMMAND_ENV = buildCommandEnv();

function parseImageReference(image) {
  const value = String(image || '').trim();
  const lastSlash = value.lastIndexOf('/');
  const lastColon = value.lastIndexOf(':');
  if (lastColon > lastSlash) {
    return { name: value.slice(0, lastColon), tag: value.slice(lastColon + 1) || 'latest' };
  }
  return { name: value, tag: 'latest' };
}

function buildPullPath(image) {
  const ref = parseImageReference(image);
  return '/images/create?fromImage=' + encodeURIComponent(ref.name) + '&tag=' + encodeURIComponent(ref.tag);
}

function calculateCpuPercent(stats) {
  const cpuDelta = Number(stats?.cpu_stats?.cpu_usage?.total_usage || 0) - Number(stats?.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = Number(stats?.cpu_stats?.system_cpu_usage || 0) - Number(stats?.precpu_stats?.system_cpu_usage || 0);
  const onlineCpus = Number(stats?.cpu_stats?.online_cpus || stats?.cpu_stats?.cpu_usage?.percpu_usage?.length || 1);
  return systemDelta > 0 && cpuDelta >= 0 ? Math.max(0, (cpuDelta / systemDelta) * onlineCpus * 100) : 0;
}

function normalizeStats(stats) {
  const memoryUsed = Number(stats?.memory_stats?.usage || 0);
  const memoryLimit = Number(stats?.memory_stats?.limit || 0);
  const networks = Object.values(stats?.networks || {}).reduce((total, network) => ({
    rx: total.rx + Number(network.rx_bytes || 0),
    tx: total.tx + Number(network.tx_bytes || 0),
  }), { rx: 0, tx: 0 });
  const blockIo = (stats?.blkio_stats?.io_service_bytes_recursive || []).reduce((total, item) => ({
    read: total.read + (item.op === 'read' ? Number(item.value || 0) : 0),
    write: total.write + (item.op === 'write' ? Number(item.value || 0) : 0),
  }), { read: 0, write: 0 });
  return {
    cpuPercent: calculateCpuPercent(stats),
    memoryUsed,
    memoryLimit,
    memoryPercent: memoryLimit ? (memoryUsed / memoryLimit) * 100 : 0,
    networkRx: networks.rx,
    networkTx: networks.tx,
    blockRead: blockIo.read,
    blockWrite: blockIo.write,
  };
}

function sanitizeContainerDetails(info) {
  const config = info?.Config || {};
  const state = info?.State || {};
  const health = state.Health || null;
  const labels = config.Labels || {};
  return {
    id: info?.Id || '',
    name: String(info?.Name || '').replace(/^\//, ''),
    image: config.Image || '',
    created: info?.Created || null,
    state: {
      status: state.Status || 'unknown', running: Boolean(state.Running),
      startedAt: state.StartedAt || null, finishedAt: state.FinishedAt || null,
      exitCode: Number.isInteger(state.ExitCode) ? state.ExitCode : null,
      health: health ? { status: health.Status || 'unknown', failingStreak: health.FailingStreak || 0, output: health.Log?.at(-1)?.Output?.trim() || '' } : null,
    },
    command: [config.Entrypoint, config.Cmd].flat().filter(Boolean).join(' ') || '—',
    workingDir: config.WorkingDir || '/',
    envKeys: (config.Env || []).map(line => String(line).split('=', 1)[0]).filter(Boolean),
    labels: {
      domain: labels['txpl.domain'] || null,
      composeProject: labels['com.docker.compose.project'] || null,
      composeService: labels['com.docker.compose.service'] || null,
    },
    mounts: (info?.Mounts || []).map(mount => ({ type: mount.Type, name: mount.Name || null, source: mount.Source, destination: mount.Destination, readOnly: !mount.RW })),
    networks: Object.entries(info?.NetworkSettings?.Networks || {}).map(([name, network]) => ({ name, ip: network.IPAddress || null, gateway: network.Gateway || null })),
    ports: Object.entries(info?.NetworkSettings?.Ports || {}).flatMap(([container, bindings]) => (bindings || []).map(binding => ({ container, host: binding.HostPort || null, hostIp: binding.HostIp || null }))),
  };
}

async function pullImage(image, options = {}) {
  return dockerRequest('POST', buildPullPath(image), null, {
    timeout: options.timeout || 30 * 60 * 1000,
  });
}

async function buildImage(tag, cwd, options = {}) {
  return runSafe('docker', ['build', '-t', tag, '.'], {
    cwd,
    timeout: options.timeout || 300_000,
    env: COMMAND_ENV,
  });
}

async function removeContainer(name, options = {}) {
  const query = options.removeVolumes === false ? 'force=1&v=0' : 'force=1&v=1';
  return dockerRequest('DELETE', '/containers/' + encodeURIComponent(name) + '?' + query);
}

async function createAndStartContainer(name, config) {
  const create = await dockerRequest('POST', '/containers/create?name=' + encodeURIComponent(name), config);
  if (create.statusCode >= 400) return { create, start: null, containerId: null };

  let containerId;
  try {
    containerId = JSON.parse(create.body.toString()).Id;
  } catch (_) {
    return { create, start: { statusCode: 500, body: Buffer.from('Respuesta inválida de Docker') }, containerId: null };
  }
  const start = await dockerRequest('POST', '/containers/' + containerId + '/start');
  return { create, start, containerId };
}

async function composeUp(cwd, options = {}) {
  const args = ['compose', 'up', '-d'];
  if (options.build) args.push('--build');
  if (options.removeOrphans !== false) args.push('--remove-orphans');
  let result = await runSafe('docker', args, { cwd, timeout: options.timeout || 300_000, env: COMMAND_ENV });
  if (!result.ok) {
    const legacyArgs = ['up', '-d'];
    if (options.build) legacyArgs.push('--build');
    if (options.removeOrphans !== false) legacyArgs.push('--remove-orphans');
    result = await runSafe('docker-compose', legacyArgs, { cwd, timeout: options.timeout || 300_000, env: COMMAND_ENV });
  }
  return result;
}

module.exports = {
  parseImageReference,
  buildPullPath,
  pullImage,
  buildImage,
  removeContainer,
  createAndStartContainer,
  composeUp,
  calculateCpuPercent,
  normalizeStats,
  sanitizeContainerDetails,
};
