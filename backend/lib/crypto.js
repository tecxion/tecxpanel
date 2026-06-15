'use strict';

// ============================================================
//  TecXPaneL — Criptografía y 2FA
//
//  Aquí está todo lo relacionado con cifrado y seguridad "matemática":
//   - Cifrar/descifrar secretos (ej. contraseñas de bases de datos)
//     para que en disco NUNCA estén en texto plano.
//   - Implementación de TOTP (los códigos de 6 dígitos de Google
//     Authenticator) para el segundo factor de autenticación (2FA).
//   - Un generador de contraseñas aleatorias.
// ============================================================

const crypto = require('crypto');

// Clave de cifrado en memoria. Se deriva una sola vez al arrancar (initEncryption)
// y se reutiliza para cifrar/descifrar. No se guarda en disco.
let ENC_KEY;

// Deriva la clave de cifrado a partir de un secreto (TXPL_SECRET_KEY o JWT_SECRET).
// scrypt es una función lenta a propósito: dificulta los ataques de fuerza bruta.
// El segundo argumento ('txpl-enc-v1') es la "sal"; 32 = longitud en bytes (AES-256).
function initEncryption(secret) {
  ENC_KEY = crypto.scryptSync(secret, 'txpl-enc-v1', 32);
}

// Cifra un texto con AES-256-GCM y devuelve una cadena "enc:v1:<base64>".
// GCM además autentica (detecta si el dato cifrado fue manipulado).
//  - iv: vector de inicialización aleatorio (12 bytes), distinto en cada cifrado.
//  - authTag: etiqueta de autenticación que valida la integridad al descifrar.
function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  // Guardamos iv + authTag + datos juntos, en base64, con un prefijo de versión.
  return 'enc:v1:' + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

// Descifra lo que produjo encryptSecret. Si el dato no tiene el prefijo "enc:v1:"
// se devuelve tal cual (compatibilidad con datos antiguos sin cifrar).
function decryptSecret(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('enc:v1:')) return stored;
  try {
    const raw = Buffer.from(stored.slice(7), 'base64');
    // Separamos las tres partes: iv (12), authTag (16) y los datos cifrados.
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (_) { return '(no descifrable)'; } // si la clave cambió o el dato está corrupto
}

// ── TOTP (RFC 6238): los códigos 2FA de 6 dígitos ─────────────
// Alfabeto Base32 estándar (así se codifican los secretos TOTP).
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Convierte bytes a texto Base32 (para mostrar/guardar el secreto del 2FA).
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// Convierte texto Base32 de vuelta a bytes (para verificar el código).
function base32Decode(str) {
  const clean = str.replace(/=+$/, '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

// HOTP: genera un código de 6 dígitos a partir de una clave y un contador.
// Es el corazón del algoritmo; TOTP no es más que HOTP usando el tiempo como contador.
function hotp(keyBuf, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', keyBuf).update(buf).digest();
  // "Truncamiento dinámico": se eligen 4 bytes del hash y se reducen a 6 dígitos.
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

// Verifica un código 2FA que escribe el usuario. El tiempo se divide en
// ventanas de 30 s; comprobamos la actual y las contiguas (-1, 0, +1) para
// tolerar pequeños desfases de reloj entre el móvil y el servidor.
function totpVerify(secretB32, token) {
  if (!secretB32 || !/^\d{6}$/.test(String(token || '').trim())) return false;
  const key = base32Decode(secretB32);
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let w = -1; w <= 1; w++) {
    if (hotp(key, step + w) === String(token).trim()) return true;
  }
  return false;
}

// Genera una contraseña aleatoria de longitud "len" (por defecto 20),
// quitando caracteres que podrían dar problemas en URLs o SQL (+ / =).
function genPassword(len = 20) {
  return crypto.randomBytes(len).toString('base64').replace(/[+/=]/g, '').slice(0, len);
}

module.exports = {
  initEncryption, encryptSecret, decryptSecret,
  base32Encode, base32Decode, totpVerify, genPassword,
};
