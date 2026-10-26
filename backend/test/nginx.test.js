'use strict';

const test = require('node:test');
const assert = require('node:assert');
const nginx = require('../lib/nginx');

test('isApexDomain: apex (2 etiquetas) devuelve true', () => {
  assert.strictEqual(nginx.isApexDomain('ejemplo.com'), true);
  assert.strictEqual(nginx.isApexDomain('tecxart.es'), true);
});

test('isApexDomain: subdominio (3+ etiquetas) devuelve false', () => {
  assert.strictEqual(nginx.isApexDomain('vps.tecxart.es'), false);
  assert.strictEqual(nginx.isApexDomain('a.b.ejemplo.com'), false);
});

test('isApexDomain: entrada no-string no rompe', () => {
  assert.strictEqual(nginx.isApexDomain(''), false);
  assert.strictEqual(nginx.isApexDomain('localhost'), false);
});

test('buildSite: tipo proxy reenvía al puerto indicado', () => {
  const conf = nginx.buildSite('ejemplo.com', 'proxy', 4321);
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:4321;/);
  assert.doesNotMatch(conf, /root /);
});
