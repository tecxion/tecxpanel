'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parseCertbotCertificates, certCategory, isValidCertName,
} = require('../lib/ssl');

const SAMPLE = `Saving debug log to /var/log/letsencrypt/letsencrypt.log

Found the following certs:
  Certificate Name: vps.tecxart.es
    Serial Number: 3f1abc
    Key Type: ECDSA
    Domains: vps.tecxart.es
    Expiry Date: 2026-09-15 10:20:30+00:00 (VALID: 60 days)
    Certificate Path: /etc/letsencrypt/live/vps.tecxart.es/fullchain.pem
    Private Key Path: /etc/letsencrypt/live/vps.tecxart.es/privkey.pem
  Certificate Name: blog.ejemplo.com
    Serial Number: aa11
    Key Type: RSA
    Domains: blog.ejemplo.com www.blog.ejemplo.com
    Expiry Date: 2026-07-20 00:00:00+00:00 (VALID: 7 days)
    Certificate Path: /etc/letsencrypt/live/blog.ejemplo.com/fullchain.pem
    Private Key Path: /etc/letsencrypt/live/blog.ejemplo.com/privkey.pem
  Certificate Name: caducado.com
    Domains: caducado.com
    Expiry Date: 2025-01-01 00:00:00+00:00 (INVALID: EXPIRED)
    Certificate Path: /etc/letsencrypt/live/caducado.com/fullchain.pem
`;

test('parseCertbotCertificates: extrae todos los certificados', () => {
  const certs = parseCertbotCertificates(SAMPLE);
  assert.strictEqual(certs.length, 3);

  assert.deepStrictEqual(certs[0], {
    name: 'vps.tecxart.es',
    domains: ['vps.tecxart.es'],
    expiry: '2026-09-15 10:20:30+00:00',
    daysLeft: 60,
    valid: true,
    path: '/etc/letsencrypt/live/vps.tecxart.es/fullchain.pem',
  });

  assert.deepStrictEqual(certs[1].domains, ['blog.ejemplo.com', 'www.blog.ejemplo.com']);
  assert.strictEqual(certs[1].daysLeft, 7);
  assert.strictEqual(certs[1].valid, true);

  assert.strictEqual(certs[2].name, 'caducado.com');
  assert.strictEqual(certs[2].valid, false);
  assert.strictEqual(certs[2].daysLeft, 0);
});

test('parseCertbotCertificates: sin certificados devuelve []', () => {
  assert.deepStrictEqual(parseCertbotCertificates('No certificates found.'), []);
  assert.deepStrictEqual(parseCertbotCertificates(''), []);
  assert.deepStrictEqual(parseCertbotCertificates(null), []);
});

test('certCategory: clasifica por días/validez', () => {
  assert.strictEqual(certCategory({ valid: true, daysLeft: 60 }), 'valid');
  assert.strictEqual(certCategory({ valid: true, daysLeft: 29 }), 'expiring');
  assert.strictEqual(certCategory({ valid: true, daysLeft: 0 }), 'expired');
  assert.strictEqual(certCategory({ valid: false, daysLeft: 0 }), 'expired');
  assert.strictEqual(certCategory({ valid: false, daysLeft: null }), 'expired');
});

test('isValidCertName: acepta nombres de certbot, rechaza inyección', () => {
  assert.strictEqual(isValidCertName('vps.tecxart.es'), true);
  assert.strictEqual(isValidCertName('blog.ejemplo.com-0001'), true);
  assert.strictEqual(isValidCertName('a_b.com'), true);
  assert.strictEqual(isValidCertName('../etc'), false);
  assert.strictEqual(isValidCertName('a b'), false);
  assert.strictEqual(isValidCertName('a;rm -rf'), false);
  assert.strictEqual(isValidCertName(''), false);
  assert.strictEqual(isValidCertName(null), false);
});
