'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// Clave de encriptación derivada del entorno o clave fija del sistema
function getMasterKey() {
  const secret = process.env.TXPL_SECRET || process.env.ADMIN_PASS || 'txpl-docker-default-secret-key-32b';
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encripta un texto en claro (ej. token de GitHub) usando AES-256-GCM.
 * Devuelve un string codificado en hex: iv:authTag:ciphertext
 */
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

/**
 * Desencripta un string en formato iv:authTag:ciphertext.
 */
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
  encryptText,
  decryptText
};
