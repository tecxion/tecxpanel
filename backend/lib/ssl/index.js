'use strict';

// ============================================================
//  TecXPaneL — Helpers puros de SSL (Let's Encrypt / Certbot)
//
//  Parsea la salida de `certbot certificates` a datos estructurados
//  y clasifica el estado de cada certificado. Sin estado ni efectos:
//  la ejecución de certbot vive en routes/ssl.js.
// ============================================================

// Nombre de certificado de certbot: letras, números, punto, guion y guion
// bajo. Rechaza espacios, `..`, `/`, `;` y demás (defensa ante inyección al
// pasarlo como `--cert-name`).
const RE_CERT_NAME = /^[A-Za-z0-9._-]{1,253}$/;
const isValidCertName = (n) =>
  typeof n === 'string' && RE_CERT_NAME.test(n) && !n.includes('..');

// Parsea la salida de `certbot certificates`. Devuelve un array de
// { name, domains[], expiry, daysLeft, valid, path }. Tolera basura/vacío.
function parseCertbotCertificates(stdout) {
  if (!stdout || typeof stdout !== 'string') return [];
  const certs = [];
  // Cada certificado empieza en "Certificate Name:"; partimos por ahí.
  const blocks = stdout.split(/^\s*Certificate Name:\s*/m).slice(1);
  for (const block of blocks) {
    const nameMatch = block.match(/^(.+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();

    const domMatch = block.match(/^\s*Domains:\s*(.+)$/m);
    const domains = domMatch ? domMatch[1].trim().split(/\s+/) : [];

    // Expiry Date: <fecha> (VALID: N days) | (INVALID: EXPIRED)
    const expMatch = block.match(/^\s*Expiry Date:\s*(.+?)\s*\((VALID|INVALID):\s*([^)]+)\)/m);
    let expiry = null, valid = false, daysLeft = null;
    if (expMatch) {
      expiry = expMatch[1].trim();
      valid = expMatch[2] === 'VALID';
      const daysMatch = expMatch[3].match(/(\d+)\s*day/);
      daysLeft = daysMatch ? parseInt(daysMatch[1], 10) : (valid ? null : 0);
    }

    const pathMatch = block.match(/^\s*Certificate Path:\s*(.+)$/m);
    const path = pathMatch ? pathMatch[1].trim() : null;

    certs.push({ name, domains, expiry, daysLeft, valid, path });
  }
  return certs;
}

// Clasifica un certificado para pintarlo: 'valid' | 'expiring' | 'expired'.
// Expira pronto = válido pero con menos de 30 días.
function certCategory({ valid, daysLeft }) {
  if (!valid || daysLeft === null || daysLeft <= 0) {
    // Un cert válido sin días parseados lo tratamos como válido (no expirado);
    // solo INVALID o 0 días cuenta como expirado.
    if (valid && daysLeft === null) return 'valid';
    return 'expired';
  }
  if (daysLeft < 30) return 'expiring';
  return 'valid';
}

module.exports = { parseCertbotCertificates, certCategory, isValidCertName };
