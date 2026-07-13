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
