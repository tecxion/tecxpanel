// Tests de los helpers puros del despliegue Docker desde Git.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { DEPLOY_TEMPLATES } = require('../lib/docker/config');
const { parseImageReference, buildPullPath, calculateCpuPercent, normalizeStats, sanitizeContainerDetails } = require('../lib/docker/service');
const {
  sanitizeRepoUrl, buildGitAuthEnv, isInsideBase, validatePort, validateImageRef,
  normalizeEnvLines, validateZipEntries, redactEnvLines, buildCommandEnv, parseVolumeBind,
} = require('../lib/dockerDeploy');

test('sanitizeRepoUrl: quita credenciales embebidas', () => {
  assert.strictEqual(sanitizeRepoUrl('https://user:tok@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.strictEqual(sanitizeRepoUrl('https://github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.strictEqual(sanitizeRepoUrl(''), '');
});

test('buildGitAuthEnv: token simple => cabecera Basic con x-access-token', () => {
  const env = buildGitAuthEnv('ghp_ABC123', 'https://github.com/a/b.git');
  assert.strictEqual(env.GIT_CONFIG_COUNT, '1');
  assert.strictEqual(env.GIT_CONFIG_KEY_0, 'http.extraHeader');
  const decoded = Buffer.from(env.GIT_CONFIG_VALUE_0.replace('Authorization: Basic ', ''), 'base64').toString();
  assert.strictEqual(decoded, 'x-access-token:ghp_ABC123');
});

test('buildGitAuthEnv: token user:pass se respeta tal cual', () => {
  const env = buildGitAuthEnv('miuser:mipass', 'https://gitlab.com/a/b.git');
  const decoded = Buffer.from(env.GIT_CONFIG_VALUE_0.replace('Authorization: Basic ', ''), 'base64').toString();
  assert.strictEqual(decoded, 'miuser:mipass');
});

test('buildGitAuthEnv: sin token, URL ssh, o URL con @ => {}', () => {
  assert.deepStrictEqual(buildGitAuthEnv('', 'https://github.com/a/b.git'), {});
  assert.deepStrictEqual(buildGitAuthEnv('tok', 'git@github.com:a/b.git'), {});
  assert.deepStrictEqual(buildGitAuthEnv('tok', 'https://user:x@github.com/a/b.git'), {});
});

test('buildAuthedRepoUrl: inyecta token en URL de clonado HTTPS', () => {
  const { buildAuthedRepoUrl } = require('../lib/dockerDeploy');
  assert.strictEqual(buildAuthedRepoUrl('ghp_XYZ', 'https://github.com/a/b.git'), 'https://x-access-token:ghp_XYZ@github.com/a/b.git');
  assert.strictEqual(buildAuthedRepoUrl('usr:pwd', 'https://github.com/a/b.git'), 'https://usr:pwd@github.com/a/b.git');
  assert.strictEqual(buildAuthedRepoUrl('', 'https://github.com/a/b.git'), 'https://github.com/a/b.git');
});

test('isInsideBase: permite subrutas, rechaza traversal', () => {
  const base = '/opt/txpl/data/docker-builds/miapp';
  assert.strictEqual(isInsideBase(base, path.join(base, 'backend')), true);
  assert.strictEqual(isInsideBase(base, base), true);
  assert.strictEqual(isInsideBase(base, path.join(base, '../../etc')), false);
  assert.strictEqual(isInsideBase(base, path.join(base, 'a/../../../root')), false);
});

test('validatePort: vacío => null; válido => int; inválido => ok:false', () => {
  assert.deepStrictEqual(validatePort(''), { ok: true, port: null });
  assert.deepStrictEqual(validatePort(undefined), { ok: true, port: null });
  assert.deepStrictEqual(validatePort('8080'), { ok: true, port: 8080 });
  assert.strictEqual(validatePort('abc').ok, false);
  assert.strictEqual(validatePort('0').ok, false);
  assert.strictEqual(validatePort('70000').ok, false);
  assert.strictEqual(validatePort('8080abc').ok, false);
});

test('validateImageRef: acepta referencias normales y rechaza flags/espacios', () => {
  assert.deepStrictEqual(validateImageRef('nginx:alpine'), { ok: true, image: 'nginx:alpine' });
  assert.strictEqual(validateImageRef('--network=host').ok, false);
  assert.strictEqual(validateImageRef('nginx alpine').ok, false);
});

test('normalizeEnvLines: valida claves y limita contenido', () => {
  assert.deepStrictEqual(normalizeEnvLines('PORT=3000\nAPP_MODE=prod'), { ok: true, value: 'PORT=3000\nAPP_MODE=prod' });
  assert.strictEqual(normalizeEnvLines('INVALID-KEY=value').ok, false);
  assert.strictEqual(normalizeEnvLines('A=1\n\nB=2').value, 'A=1\nB=2');
});

test('validateZipEntries: rechaza traversal y exceso de entradas', () => {
  assert.deepStrictEqual(validateZipEntries(['app/index.js']), { ok: true });
  assert.strictEqual(validateZipEntries(['../etc/passwd']).ok, false);
  assert.strictEqual(validateZipEntries(['a', 'b'], { maxEntries: 1 }).ok, false);
});

test('buildCommandEnv: no hereda secretos del proceso', () => {
  const env = buildCommandEnv({ GIT_TERMINAL_PROMPT: '0' });
  assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0');
  assert.strictEqual(env.JWT_SECRET, undefined);
  assert.ok(env.PATH);
});

test('redactEnvLines: no expone valores al reconstruir configuración', () => {
  assert.deepStrictEqual(redactEnvLines(['API_KEY=secreto', 'EMPTY=']), ['API_KEY=***', 'EMPTY=***']);
});

test('plantillas Node y Python no ocultan errores de dependencias', () => {
  const nodeDockerfile = DEPLOY_TEMPLATES.node.gen(3000);
  const pythonDockerfile = DEPLOY_TEMPLATES.python.gen(8000);
  assert.match(nodeDockerfile, /npm ci --omit=dev/);
  assert.match(nodeDockerfile, /npm install --omit=dev/);
  assert.match(pythonDockerfile, /pip install --no-cache-dir -r requirements\.txt/);
  assert.doesNotMatch(nodeDockerfile, /\|\| true/);
  assert.doesNotMatch(pythonDockerfile, /\|\| true/);
});

test('servicio Docker: separa registry con puerto y siempre construye pull etiquetado', () => {
  assert.deepStrictEqual(parseImageReference('nginx'), { name: 'nginx', tag: 'latest' });
  assert.deepStrictEqual(parseImageReference('registry.local:5000/team/app:v2'), { name: 'registry.local:5000/team/app', tag: 'v2' });
  assert.strictEqual(buildPullPath('nginx'), '/images/create?fromImage=nginx&tag=latest');
  assert.strictEqual(buildPullPath('registry.local:5000/team/app:v2'), '/images/create?fromImage=registry.local%3A5000%2Fteam%2Fapp&tag=v2');
});

test('servicio Docker: normaliza CPU, memoria e I/O sin exponer secretos', () => {
  const stats = normalizeStats({
    cpu_stats: { cpu_usage: { total_usage: 130 }, system_cpu_usage: 300, online_cpus: 2 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 200 },
    memory_stats: { usage: 50, limit: 100 },
    networks: { eth0: { rx_bytes: 10, tx_bytes: 20 } },
    blkio_stats: { io_service_bytes_recursive: [{ op: 'read', value: 7 }, { op: 'write', value: 3 }] },
  });
  assert.strictEqual(calculateCpuPercent({ cpu_stats: { cpu_usage: { total_usage: 130 }, system_cpu_usage: 300, online_cpus: 2 }, precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 200 } }), 60);
  assert.deepStrictEqual(stats, { cpuPercent: 60, memoryUsed: 50, memoryLimit: 100, memoryPercent: 50, networkRx: 10, networkTx: 20, blockRead: 7, blockWrite: 3 });
  const details = sanitizeContainerDetails({ Name: '/demo', Config: { Image: 'app:latest', Env: ['TOKEN=secret', 'PORT=3000'], Cmd: ['node', 'server.js'], Labels: { 'txpl.domain': 'demo.test' } }, State: { Status: 'running', Running: true, Health: { Status: 'healthy', Log: [{ Output: 'ok' }] } }, Mounts: [], NetworkSettings: { Networks: {}, Ports: {} } });
  assert.deepStrictEqual(details.envKeys, ['TOKEN', 'PORT']);
  assert.strictEqual(JSON.stringify(details).includes('secret'), false);
});

test('parseVolumeBind: ambos, ninguno, o error', () => {
  assert.deepStrictEqual(parseVolumeBind('', ''), { ok: true, bind: null });
  assert.deepStrictEqual(parseVolumeBind('datos', '/var/lib/x'), { ok: true, bind: 'datos:/var/lib/x' });
  assert.strictEqual(parseVolumeBind('datos', '').ok, false);
  assert.strictEqual(parseVolumeBind('datos', 'relativa').ok, false);
  assert.strictEqual(parseVolumeBind('datos', '/x/../y').ok, false);
  assert.strictEqual(parseVolumeBind('nombre inválido', '/x').ok, false);
});

test('crypto: encriptar y desencriptar token de GitHub (AES-256-GCM)', () => {
  const { encryptText, decryptText } = require('../lib/crypto');
  const token = 'ghp_SampleGitHubPersonalAccessToken123456';
  const enc = encryptText(token);
  assert.notStrictEqual(enc, token);
  assert.strictEqual(typeof enc, 'string');
  assert.strictEqual(enc.split(':').length, 3);

  const dec = decryptText(enc);
  assert.strictEqual(dec, token);

  assert.strictEqual(decryptText(null), null);
  assert.strictEqual(decryptText('invalido'), null);
});
