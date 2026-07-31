'use strict';

// ============================================================
//  TecXPaneL — Criptografía y 2FA
// ============================================================

const crypto = require('crypto');

let ENC_KEY;

function initEncryption(secret) {
  ENC_KEY = crypto.scryptSync(secret, 'txpl-enc-v1', 32);
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return 'enc:v1:' + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decryptSecret(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('enc:v1:')) return stored;
  try {
    const raw = Buffer.from(stored.slice(7), 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (_) { return '(no descifrable)'; }
}

// ── TOTP (RFC 6238): los códigos 2FA de 6 dígitos ─────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = str.replace(/=+$/, '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(keyBuf, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', keyBuf).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

function totpVerify(secretB32, token) {
  if (!secretB32 || !/^\d{6}$/.test(String(token || '').trim())) return false;
  const key = base32Decode(secretB32);
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let w = -1; w <= 1; w++) {
    if (hotp(key, step + w) === String(token).trim()) return true;
  }
  return false;
}

function genPassword(len = 20) {
  return crypto.randomBytes(len).toString('base64').replace(/[+/=]/g, '').slice(0, len);
}

// ── Cifrado de Tokens de GitHub / Docker ───────────────────────
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getMasterKey() {
  if (ENC_KEY) return ENC_KEY;
  const secret = process.env.TXPL_SECRET || process.env.ADMIN_PASS || 'txpl-docker-default-secret-key-32b';
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptText(text) {
  if (!text || typeof text !== 'string') return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getMasterKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptText(encryptedHex) {
  if (!encryptedHex || typeof encryptedHex !== 'string') return null;
  const parts = encryptedHex.split(':');
  if (parts.length !== 3) return null;
  
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const key = getMasterKey();
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    return null;
  }
}

module.exports = {
  initEncryption,
  encryptSecret,
  decryptSecret,
  base32Encode,
  base32Decode,
  totpVerify,
  genPassword,
  encryptText,
  decryptText
};
