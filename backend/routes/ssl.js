'use strict';

// ============================================================
//  TecXPaneL — Certificados SSL (Let's Encrypt / Certbot)
//
//  Dashboard real de certificados: lista lo que hay en el sistema
//  (`certbot certificates`), permite renovar, eliminar y emitir para
//  un dominio nuevo. Fuente de la verdad = certbot, no la BD del panel.
//  JWT ya aplicado por el middleware global de /api.
// ============================================================

const express = require('express');
const { ok, fail, clientIp, run, runSafe, wrap } = require('../lib/helpers');
const { isValidDomain } = require('../lib/validators');
const { parseCertbotCertificates, certCategory, isValidCertName } = require('../lib/ssl');
const nginx = require('../lib/nginx');
const { audit } = require('../database');

const router = express.Router();

// Certbot puede tardar; sin límite de tiempo para renovar/emitir.
const LONG = { timeout: 0, maxBuffer: 16 * 1024 * 1024 };

// Comprueba si certbot está instalado.
async function certbotInstalled() {
  const r = await runSafe('certbot', ['--version']);
  return r.ok;
}

// Cabeceras + helpers de streaming (patrón plugins/n8n/catalog).
function startStream(res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  return {
    write: (s) => res.write(s),
    done: (code) => res.end(`\n__TXPL_DONE__${code}`),
  };
}

// GET /certificates — lista real de certificados con su estado.
router.get('/certificates', wrap(async (req, res) => {
  if (!(await certbotInstalled())) {
    return ok(res, { certbot: false, certificates: [] });
  }
  const r = await runSafe('certbot', ['certificates']);
  if (!r.ok) return fail(res, 500, 'No se pudo consultar certbot: ' + (r.stderr || '').split('\n')[0]);
  const certificates = parseCertbotCertificates(r.stdout).map((c) => ({
    ...c, category: certCategory(c),
  }));
  ok(res, { certbot: true, certificates });
}));

// POST /:name/renew — renueva un certificado concreto (si toca). Streaming.
router.post('/:name/renew', wrap(async (req, res) => {
  const name = req.params.name;
  if (!isValidCertName(name)) return fail(res, 400, 'Nombre de certificado inválido.');
  const force = req.query.force === 'true';

  audit(req.user.username, clientIp(req), 'ssl.renew', name + (force ? ' (forzada)' : ''));
  const { write, done } = startStream(res);
  write(`▶ Renovando certificado ${name}${force ? ' (forzado)' : ''}...\n\n`);
  try {
    const args = ['renew', '--cert-name', name, '--nginx', '--non-interactive'];
    if (force) args.push('--force-renewal');
    const r = await runSafe('certbot', args, LONG);
    write((r.stdout || '') + (r.stderr || ''));
    write(r.ok ? '\n✓ Proceso de renovación terminado.\n' : '\n✖ Certbot devolvió un error.\n');
    return done(r.ok ? 0 : 1);
  } catch (e) {
    write(`\n✖ ${e.message}\n`);
    return done(1);
  }
}));

// POST /issue — emite un certificado nuevo para un dominio (proxy a certbot --nginx).
// El dominio debe apuntar ya por DNS a este servidor y tener un vhost en Nginx.
router.post('/issue', wrap(async (req, res) => {
  const domain = String((req.body && req.body.domain) || '').trim();
  const www = !!(req.body && req.body.www);
  if (!isValidDomain(domain)) return fail(res, 400, 'Dominio inválido.');

  audit(req.user.username, clientIp(req), 'ssl.issue', domain);
  const { write, done } = startStream(res);
  write(`▶ Emitiendo certificado para ${domain}${www ? ' (+www)' : ''}...\n`);
  write('  El dominio debe apuntar ya a este servidor y tener un sitio en Nginx.\n\n');
  try {
    await nginx.installSsl(domain, { www });
    write('\n✓ Certificado emitido y HTTPS activo.\n');
    return done(0);
  } catch (e) {
    write(`\n✖ No se pudo emitir: ${e.message}\n`);
    return done(1);
  }
}));

// DELETE /:name — elimina un certificado (revoca + borra sus ficheros). Streaming.
router.delete('/:name', wrap(async (req, res) => {
  const name = req.params.name;
  if (!isValidCertName(name)) return fail(res, 400, 'Nombre de certificado inválido.');

  audit(req.user.username, clientIp(req), 'ssl.delete', name);
  const { write, done } = startStream(res);
  write(`▶ Eliminando certificado ${name}...\n\n`);
  try {
    // Revoca best-effort (si la clave existe) y luego borra los ficheros.
    const rev = await runSafe('certbot', ['revoke', '--cert-name', name, '--non-interactive', '--no-delete-after-revoke'], LONG);
    if (rev.ok) write('✓ Certificado revocado.\n');
    const del = await runSafe('certbot', ['delete', '--cert-name', name, '--non-interactive'], LONG);
    write((del.stdout || '') + (del.stderr || ''));
    write(del.ok ? '\n✓ Certificado eliminado.\n' : '\n✖ No se pudo eliminar.\n');
    return done(del.ok ? 0 : 1);
  } catch (e) {
    write(`\n✖ ${e.message}\n`);
    return done(1);
  }
}));

module.exports = router;
