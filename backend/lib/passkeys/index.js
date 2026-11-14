'use strict';

// lib/passkeys — passkeys (WebAuthn) con @simplewebauthn/server.
// Los retos (challenge) viven en memoria 5 min y son de un solo uso.
// Credenciales "descubribles" con verificación de usuario obligatoria (huella/PIN/Face ID):
// una passkey ya cuenta como dos factores, por eso el login con passkey no pide contraseña ni TOTP.
const crypto = require('crypto');
const swa = require('@simplewebauthn/server');

const RP_NAME = 'TecXPaneL';
const TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 200;
const challenges = new Map(); // id → { challenge, kind, userId, expires }

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s), 'base64url'));

// Origen y RP ID esperados. TXPL_ORIGIN (https://panel.dominio) fija el valor y evita fiarse de la cabecera Host.
function rp(req) {
  const origin = process.env.TXPL_ORIGIN || `${req.protocol}://${req.get('host')}`;
  return { origin, rpID: new URL(origin).hostname };
}

function putChallenge(kind, challenge, userId = null) {
  const now = Date.now();
  for (const [k, e] of challenges) if (e.expires < now) challenges.delete(k);
  if (challenges.size >= MAX_CHALLENGES) return null;
  const id = crypto.randomBytes(16).toString('base64url');
  challenges.set(id, { challenge, kind, userId, expires: now + TTL_MS });
  return id;
}

// Un solo uso: lo borra al leerlo. null si no existe, es de otro tipo o caducó.
function takeChallenge(id, kind) {
  const e = challenges.get(id);
  challenges.delete(id);
  return e && e.kind === kind && e.expires > Date.now() ? e : null;
}

async function registrationOptions(req, user, existing) {
  const { rpID } = rp(req);
  const options = await swa.generateRegistrationOptions({
    rpName: RP_NAME, rpID, userID: String(user.id), userName: user.username,
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: unb64(c.credential_id), type: 'public-key' })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const challengeId = putChallenge('reg', options.challenge, user.id);
  return challengeId && { challengeId, options };
}

async function verifyRegistration(req, entry, response) {
  const { origin, rpID } = rp(req);
  const v = await swa.verifyRegistrationResponse({
    response, expectedChallenge: entry.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
  });
  if (!v.verified || !v.registrationInfo) return null;
  const { credentialID, credentialPublicKey, counter } = v.registrationInfo;
  return { credentialId: b64(credentialID), publicKey: b64(credentialPublicKey), counter };
}

async function loginOptions(req) {
  const { rpID } = rp(req);
  const options = await swa.generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [] });
  const challengeId = putChallenge('login', options.challenge);
  return challengeId && { challengeId, options };
}

// Devuelve el nuevo contador si la firma es válida; null si no.
async function verifyLogin(req, entry, response, cred) {
  const { origin, rpID } = rp(req);
  const v = await swa.verifyAuthenticationResponse({
    response, expectedChallenge: entry.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    authenticator: { credentialID: unb64(cred.credential_id), credentialPublicKey: unb64(cred.public_key), counter: cred.counter },
  });
  return v.verified ? v.authenticationInfo.newCounter : null;
}

module.exports = { registrationOptions, verifyRegistration, loginOptions, verifyLogin, takeChallenge };
