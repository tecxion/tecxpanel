'use strict';

// ============================================================
//  TecXPaneL — Ejecutor de rclone para backups remotos
//
//  Lee backup_remote, descifra las credenciales y las pasa al
//  proceso rclone por VARIABLES DE ENTORNO (no argv, no rclone.conf).
//  Si el SFTP usa clave, se materializa en un fichero temporal 0600
//  y se borra en cleanup(). Todo comando via execFile con arrays.
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const R = require('./rclone');
const B = require('./backups');
const { decryptSecret } = require('./crypto');
const { queries } = require('../database');

const execFileP = promisify(execFile);

function runRclone(args, extraEnv = {}) {
  return execFileP('rclone', args, {
    env: { ...process.env, ...extraEnv },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 0,
  });
}

async function obscurePassword(pass) {
  const { stdout } = await runRclone(R.obscureArgs(pass));
  return String(stdout || '').trim();
}

// Construye el env para el proceso rclone a partir de la config guardada.
// Devuelve además cleanup() para borrar el fichero temporal de la clave SSH.
async function buildEnv() {
  const cfg = queries.getBackupRemote.get();
  if (!cfg) { const e = new Error('Destino remoto no configurado.'); e.http = 400; throw e; }
  const creds = JSON.parse(decryptSecret(cfg.config_enc));

  let env = {};
  let cleanup = async () => {};
  if (cfg.type === 's3') {
    env = R.buildS3Env(creds);
  } else if (cfg.type === 'sftp') {
    let keyFile = null;
    if (creds.keyContent) {
      keyFile = path.join(os.tmpdir(), `txpl-sshkey-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.writeFileSync(keyFile, creds.keyContent, { mode: 0o600 });
      cleanup = async () => { try { fs.unlinkSync(keyFile); } catch (_) {} };
    }
    env = R.buildSftpEnv({ host: creds.host, port: creds.port, user: creds.user, password: creds.password, keyFile });
  } else {
    const e = new Error('Tipo de remoto no soportado.'); e.http = 400; throw e;
  }

  if (cfg.encrypt_enabled) {
    if (!cfg.crypt_pass_enc) { await cleanup(); const e = new Error('Cifrado activado sin passphrase.'); e.http = 400; throw e; }
    const pass = decryptSecret(cfg.crypt_pass_enc);
    const obsc = await obscurePassword(pass);
    Object.assign(env, R.buildCryptEnv({ passphraseObscured: obsc, remotePath: cfg.remote_path }));
  }
  const remote = R.effectiveRemote(!!cfg.encrypt_enabled, cfg.remote_path);
  return { env, cleanup, remote, cfg };
}

async function uploadArchive({ filename }) {
  if (!B.isValidBackupFilename(filename)) return { ok: false, message: 'Nombre de backup inválido' };
  const local = path.join(B.BACKUP_DIR, filename);
  if (!fs.existsSync(local)) return { ok: false, message: 'El archivo local no existe' };
  const { env, cleanup, remote } = await buildEnv();
  try {
    await runRclone(R.copyArgs(local, remote), env);
    return { ok: true, message: 'Subido' };
  } catch (e) {
    return { ok: false, message: (e.stderr || e.message || '').toString().slice(0, 300) };
  } finally { await cleanup(); }
}

async function listRemote() {
  const { env, cleanup, remote } = await buildEnv();
  try {
    const { stdout } = await runRclone(R.lsjsonArgs(remote), env);
    return { ok: true, items: R.parseLsjson(stdout) };
  } catch (e) {
    return { ok: false, items: [], message: (e.stderr || e.message || '').toString().slice(0, 300) };
  } finally { await cleanup(); }
}

async function downloadArchive({ filename }) {
  if (!B.isValidBackupFilename(filename)) return { ok: false, message: 'Nombre de backup inválido' };
  const { env, cleanup, remote } = await buildEnv();
  try {
    // rclone copy `<remote>/<filename>` `<BACKUP_DIR>` deposita el archivo dentro.
    await runRclone(R.copyArgs(`${remote.replace(/\/$/, '')}/${filename}`, B.BACKUP_DIR), env);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e.stderr || e.message || '').toString().slice(0, 300) };
  } finally { await cleanup(); }
}

async function deleteRemote({ filename }) {
  if (!B.isValidBackupFilename(filename)) return { ok: false, message: 'Nombre de backup inválido' };
  const { env, cleanup, remote } = await buildEnv();
  try {
    await runRclone(R.deleteArgs(`${remote.replace(/\/$/, '')}/${filename}`), env);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e.stderr || e.message || '').toString().slice(0, 300) };
  } finally { await cleanup(); }
}

async function testConnection() {
  const { env, cleanup, remote } = await buildEnv();
  try {
    await runRclone(R.checkRemoteArgs(remote), env);
    return { ok: true, message: 'Conexión correcta' };
  } catch (e) {
    return { ok: false, message: (e.stderr || e.message || '').toString().slice(0, 300) };
  } finally { await cleanup(); }
}

module.exports = { obscurePassword, buildEnv, uploadArchive, listRemote, downloadArchive, deleteRemote, testConnection };
