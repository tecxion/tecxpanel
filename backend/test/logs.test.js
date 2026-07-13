'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { siteLogPath, clampLines } = require('../lib/logs');

test('siteLogPath: dominio válido + tipo válido', () => {
  assert.strictEqual(siteLogPath('ejemplo.com', 'access'), '/var/log/nginx/ejemplo.com.access.log');
  assert.strictEqual(siteLogPath('blog.ejemplo.com', 'error'), '/var/log/nginx/blog.ejemplo.com.error.log');
});

test('siteLogPath: rechaza dominio o tipo inválido', () => {
  assert.strictEqual(siteLogPath('../etc/passwd', 'access'), null);
  assert.strictEqual(siteLogPath('mal_dominio', 'access'), null);
  assert.strictEqual(siteLogPath('a;rm', 'error'), null);
  assert.strictEqual(siteLogPath('ejemplo.com', 'debug'), null);
  assert.strictEqual(siteLogPath('', 'access'), null);
  assert.strictEqual(siteLogPath(null, 'access'), null);
});

test('clampLines: normaliza el número de líneas', () => {
  assert.strictEqual(clampLines('300'), 300);
  assert.strictEqual(clampLines('100'), 100);
  assert.strictEqual(clampLines(undefined), 300);   // por defecto
  assert.strictEqual(clampLines('abc'), 300);       // basura => defecto
  assert.strictEqual(clampLines('5'), 50);          // mínimo 50
  assert.strictEqual(clampLines('999999'), 2000);   // máximo 2000
  assert.strictEqual(clampLines('-10'), 50);
});
