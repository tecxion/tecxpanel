'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  CATALOG, getEntry, containerName, pm2Name, volumeName, nginxConfName,
  validateInstallOptions,
} = require('../lib/catalog');

test('CATALOG: integridad de todas las entradas', () => {
  assert.ok(Array.isArray(CATALOG) && CATALOG.length === 5);
  const ids = CATALOG.map((e) => e.id);
  assert.deepStrictEqual(ids.sort(), ['ghost', 'nextcloud', 'uptime-kuma', 'vaultwarden', 'wordpress']);
  for (const e of CATALOG) {
    assert.ok(/^[a-z0-9-]+$/.test(e.id), `id inválido: ${e.id}`);
    assert.ok(e.name && e.description, `${e.id}: falta name/description`);
    assert.ok(Array.isArray(e.modes) && e.modes.length >= 1, `${e.id}: modes vacío`);
    for (const m of e.modes) assert.ok(['docker', 'native', 'pm2'].includes(m), `${e.id}: modo ${m}`);
    // Toda app con modo docker declara imagen con TAG FIJADO (nunca vacío ni 'latest' implícito)
    if (e.modes.includes('docker')) {
      assert.ok(e.docker && e.docker.image && e.docker.tag, `${e.id}: docker.image/tag`);
      assert.ok(e.docker.port > 0, `${e.id}: docker.port`);
    }
    assert.ok(e.db === 'mysql' || e.db === null, `${e.id}: db inválido`);
  }
});

test('CATALOG: modos según el diseño aprobado', () => {
  assert.deepStrictEqual(getEntry('wordpress').modes, ['docker', 'native']);
  assert.deepStrictEqual(getEntry('ghost').modes, ['docker', 'pm2']);
  assert.deepStrictEqual(getEntry('nextcloud').modes, ['docker']);
  assert.deepStrictEqual(getEntry('vaultwarden').modes, ['docker']);
  assert.deepStrictEqual(getEntry('uptime-kuma').modes, ['docker', 'pm2']);
  assert.strictEqual(getEntry('wordpress').db, 'mysql');
  assert.strictEqual(getEntry('ghost').db, 'mysql');
  assert.strictEqual(getEntry('nextcloud').db, null);
  assert.strictEqual(getEntry('no-existe'), null);
});

test('nombres de recursos', () => {
  assert.strictEqual(containerName('wordpress'), 'txpl-app-wordpress');
  assert.strictEqual(pm2Name('ghost'), 'txpl-app-ghost');
  assert.strictEqual(volumeName('uptime-kuma'), 'txpl_uptime-kuma_data');
  assert.strictEqual(nginxConfName('vaultwarden'), 'txpl-app-vaultwarden');
});

test('validateInstallOptions: casos válidos', () => {
  const wp = getEntry('wordpress');
  let r = validateInstallOptions(wp, { mode: 'docker' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.opts.domain, null);
  assert.strictEqual(r.opts.ssl, false);
  r = validateInstallOptions(wp, { mode: 'native', domain: 'blog.ejemplo.com', ssl: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.opts.domain, 'blog.ejemplo.com');
  assert.strictEqual(r.opts.ssl, true);
});

test('validateInstallOptions: casos inválidos', () => {
  const wp = getEntry('wordpress');
  assert.strictEqual(validateInstallOptions(wp, { mode: 'pm2' }).ok, false);          // modo no soportado
  assert.strictEqual(validateInstallOptions(wp, { mode: 'native' }).ok, false);       // nativo exige dominio
  assert.strictEqual(validateInstallOptions(wp, { mode: 'docker', domain: 'mal_dominio' }).ok, false);
  assert.strictEqual(validateInstallOptions(wp, { mode: 'docker', domain: null, ssl: true }).ok, false); // ssl sin dominio
  assert.strictEqual(validateInstallOptions(getEntry('nextcloud'), { mode: 'native' }).ok, false);
});

const {
  buildAppContainerConfig, buildDbEnv, buildWpConfig, buildGhostConfig,
} = require('../lib/catalog');

const CREDS = { name: 'wpdb', user: 'txpl_wpdb', password: 'S3cr3ta' };

test('buildDbEnv: wordpress y ghost; apps sin DB devuelven []', () => {
  assert.deepStrictEqual(buildDbEnv('wordpress', CREDS, '172.17.0.1'), [
    'WORDPRESS_DB_HOST=172.17.0.1',
    'WORDPRESS_DB_NAME=wpdb',
    'WORDPRESS_DB_USER=txpl_wpdb',
    'WORDPRESS_DB_PASSWORD=S3cr3ta',
  ]);
  const ghostEnv = buildDbEnv('ghost', CREDS, '172.17.0.1');
  assert.ok(ghostEnv.includes('database__client=mysql'));
  assert.ok(ghostEnv.includes('database__connection__host=172.17.0.1'));
  assert.ok(ghostEnv.includes('database__connection__password=S3cr3ta'));
  assert.deepStrictEqual(buildDbEnv('vaultwarden', null, null), []);
});

test('buildAppContainerConfig: imagen con tag, volumen, puerto en loopback', () => {
  const entry = getEntry('wordpress');
  const cfg = buildAppContainerConfig(entry, { hostPort: 8090, domain: 'blog.com', dbCreds: CREDS, dbHost: '172.17.0.1' });
  assert.strictEqual(cfg.Image, 'wordpress:6.8-apache');
  assert.deepStrictEqual(cfg.HostConfig.Binds, ['txpl_wordpress_data:/var/www/html']);
  assert.deepStrictEqual(cfg.HostConfig.PortBindings['80/tcp'], [{ HostIp: '127.0.0.1', HostPort: '8090' }]);
  assert.strictEqual(cfg.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.ok(cfg.Env.includes('WORDPRESS_DB_NAME=wpdb'));
  assert.strictEqual(cfg.Labels['txpl.domain'], 'blog.com');
  assert.ok(cfg.HostConfig.ExtraHosts.includes('host.docker.internal:host-gateway'));
});

test('buildAppContainerConfig: app sin DB ni dominio', () => {
  const cfg = buildAppContainerConfig(getEntry('vaultwarden'), { hostPort: 8091 });
  assert.strictEqual(cfg.Image, 'vaultwarden/server:1.34.1');
  assert.deepStrictEqual(cfg.Env, []);
  assert.deepStrictEqual(cfg.Labels, {});
});

test('buildWpConfig: credenciales y salts presentes, sin placeholders', () => {
  const salts = 'define(\'AUTH_KEY\', \'x\');';
  const conf = buildWpConfig({ dbName: 'wpdb', dbUser: 'txpl_wpdb', dbPass: 'S3cr3ta', salts });
  assert.ok(conf.includes("define( 'DB_NAME', 'wpdb' )"));
  assert.ok(conf.includes("define( 'DB_USER', 'txpl_wpdb' )"));
  assert.ok(conf.includes("define( 'DB_PASSWORD', 'S3cr3ta' )"));
  assert.ok(conf.includes("define( 'DB_HOST', 'localhost' )"));
  assert.ok(conf.includes(salts));
  assert.ok(conf.includes('$table_prefix'));
  assert.ok(!conf.includes('put your unique phrase here'));
});

test('buildGhostConfig: url, puerto y conexión MySQL', () => {
  const c = buildGhostConfig({ url: 'https://blog.com', port: 2368, dbName: 'ghostdb', dbUser: 'u', dbPass: 'p', contentPath: '/opt/txpl-apps/ghost/content' });
  assert.strictEqual(c.url, 'https://blog.com');
  assert.strictEqual(c.server.port, 2368);
  assert.strictEqual(c.server.host, '127.0.0.1');
  assert.strictEqual(c.database.client, 'mysql');
  assert.strictEqual(c.database.connection.database, 'ghostdb');
  assert.strictEqual(c.paths.contentPath, '/opt/txpl-apps/ghost/content');
});
