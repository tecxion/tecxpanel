'use strict';
// ============================================================
//  TecXPaneL — lib/backups/engine.js — motor de backups (efectos en el sistema)
//  Copia literal de lib/backupEngine.js v1, con imports reorganizados.
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, runSafe, runInput } = require('../common/run');
const getQueries = () => require('../../database').queries;
const nginx = require('../nginx');
const { checkBuildRequirements } = require('../appdeploy');
const B = require('./index');

// Resuelve UNA sola vez cómo autenticar contra MySQL/MariaDB, replicando la
// cadena de databases.js: socket directo → sudo → --defaults-file → contraseña.
// Devuelve build(tool, tailArgs) => { cmd, args }, válido para 'mysql' y 'mysqldump'.
let _mysqlBuild = null;
function mysqlStrategies() {
  const strats = [
    (tool, tail) => ({ cmd: tool, args: [...tail] }),
    (tool, tail) => ({ cmd: 'sudo', args: ['-n', tool, ...tail] }),
  ];
  if (fs.existsSync('/etc/mysql/debian.cnf')) {
    strats.push((tool, tail) => ({ cmd: 'sudo', args: ['-n', tool, '--defaults-file=/etc/mysql/debian.cnf', ...tail] }));
  }
  if (process.env.MYSQL_ROOT_PASSWORD) {
    strats.push((tool, tail) => ({ cmd: tool, args: ['-u', 'root', `-p${process.env.MYSQL_ROOT_PASSWORD}`, ...tail] }));
  }
  return strats;
}
async function resolveMysqlBuild() {
  if (_mysqlBuild) return _mysqlBuild;
  for (const build of mysqlStrategies()) {
    const { cmd, args } = build('mysql', ['-e', 'SELECT 1']);
    const r = await runSafe(cmd, args, { timeout: 30_000 });
    if (r.ok) { _mysqlBuild = build; return build; }
  }
  throw new Error('No se pudo autenticar contra MySQL (revisa MYSQL_ROOT_PASSWORD o el acceso por socket)');
}

const SITES_DIR = path.resolve(process.env.SITES_DIR || '/var/www');
const PANEL_DB = path.resolve(process.env.TXPL_DIR || '/opt/txpl', 'data', 'txpl.db');
const PANEL_ENV = path.resolve(process.env.TXPL_DIR || '/opt/txpl', '.env');

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19) + '-' + Math.random().toString(36).slice(2, 6);
}
const emit = (write, msg) => { if (write) write(msg + '\n'); };

function resolveResourceItems(selection) {
  const items = [];
  for (const sel of selection) {
    if (sel.class === 'db-mysql') items.push({ class: 'db-mysql', name: sel.name, path: `db/mysql/${sel.name}.sql.gz`, size: 0 });
    else if (sel.class === 'db-pg') items.push({ class: 'db-pg', name: sel.name, path: `db/pg/${sel.name}.sql.gz`, size: 0 });
    else if (sel.class === 'site') items.push({ class: 'site', name: sel.name, path: `sites/${sel.name}.tar.gz`, size: 0 });
    else if (sel.class === 'app') {
      const app = getQueries().listApps.all().find((a) => a.name === sel.name);
      items.push({ class: 'app', name: sel.name, path: `apps/${sel.name}.tar.gz`, size: 0, _appPath: app && app.path });
    } else if (sel.class === 'panel') items.push({ class: 'panel', name: 'panel', path: 'panel/txpl.db', size: 0 });
  }
  return items;
}

async function dumpItem(item, stageDir, write) {
  const dest = path.join(stageDir, item.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (item.class === 'db-mysql') {
    emit(write, `🐬 MySQL: ${item.name}`);
    const build = await resolveMysqlBuild();
    const { cmd, args } = build('mysqldump', ['--single-transaction', '--routines', '--triggers', item.name]);
    const out = await run(cmd, args, { timeout: 0, maxBuffer: 512 * 1024 * 1024 });
    fs.writeFileSync(dest, require('zlib').gzipSync(Buffer.from(out)));
  } else if (item.class === 'db-pg') {
    emit(write, `🐘 PostgreSQL: ${item.name}`);
    const { cmd, args } = B.commands.pgDumpArgs(item.name);
    const out = await run(cmd, args, { timeout: 0, maxBuffer: 512 * 1024 * 1024 });
    fs.writeFileSync(dest, require('zlib').gzipSync(Buffer.from(out)));
  } else if (item.class === 'site') {
    emit(write, `🌐 Sitio: ${item.name}`);
    const siteStage = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-site-'));
    fs.cpSync(path.join(SITES_DIR, item.name), path.join(siteStage, 'www'), { recursive: true });
    const vhost = path.join(nginx.NGINX_AVAILABLE, item.name);
    if (fs.existsSync(vhost)) fs.copyFileSync(vhost, path.join(siteStage, 'nginx.conf'));
    await run('tar', ['-czf', dest, '-C', siteStage, '.'], { timeout: 0, maxBuffer: 64 * 1024 * 1024 });
    fs.rmSync(siteStage, { recursive: true, force: true });
  } else if (item.class === 'app') {
    emit(write, `📦 App: ${item.name}`);
    if (!item._appPath || !fs.existsSync(item._appPath)) throw new Error(`No se encontró el directorio de la app ${item.name}`);
    const { cmd, args } = B.commands.appTarArgs(item._appPath, dest);
    await run(cmd, args, { timeout: 0, maxBuffer: 64 * 1024 * 1024 });
  } else if (item.class === 'panel') {
    emit(write, '📋 Config del panel');
    const rb = await runSafe('sqlite3', [PANEL_DB, `.backup ${dest}`], { timeout: 0 });
    if (!fs.existsSync(dest)) {
      if (!rb.ok && !/ENOENT/.test(rb.stderr || '')) {
        throw new Error(`sqlite3 .backup falló: ${(rb.stderr || '').trim().slice(0, 200)}`);
      }
      emit(write, '⚠️ sqlite3 no disponible; copia directa de la BD del panel (puede ser inconsistente en WAL)');
      fs.copyFileSync(PANEL_DB, dest);
    }
    if (fs.existsSync(PANEL_ENV)) fs.copyFileSync(PANEL_ENV, path.join(path.dirname(dest), 'txpl.env'));
  }
  return fs.existsSync(dest) ? fs.statSync(dest).size : 0;
}

async function createBackup({ items, kind, origin = 'manual', write }) {
  fs.mkdirSync(B.manifest.BACKUP_DIR, { recursive: true });
  try { fs.chmodSync(B.manifest.BACKUP_DIR, 0o700); } catch (_) {}
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-bk-'));
  const filename = `backup-${ts()}.tar.gz`;
  const archive = path.join(B.manifest.BACKUP_DIR, filename);
  const createdAt = new Date().toISOString();

  const row = { filename, created_at: createdAt, size_bytes: 0, kind, scope: JSON.stringify(items.map((i) => ({ class: i.class, name: i.name }))), origin, status: 'running', notes: null };
  const info = getQueries().insertBackup.run(row);
  const id = info.lastInsertRowid;

  try {
    const resolved = resolveResourceItems(items);
    for (const it of resolved) it.size = await dumpItem(it, stageDir, write);
    const manifest = B.manifest.buildManifest({ kind, createdAt, items: resolved.map(({ _appPath, ...rest }) => rest) });
    fs.writeFileSync(path.join(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const pkg = B.commands.packageTarArgs(stageDir, archive);
    await run(pkg.cmd, pkg.args, { timeout: 0, maxBuffer: 64 * 1024 * 1024 });
    const size = fs.statSync(archive).size;
    try { fs.chmodSync(archive, 0o600); } catch (_) {}
    getQueries().updateBackupStatus.run({ id, status: 'ok', size_bytes: size, notes: null });
    emit(write, `✅ Backup completado: ${filename}`);
    return { filename, size, id };
  } catch (e) {
    getQueries().updateBackupStatus.run({ id, status: 'failed', size_bytes: 0, notes: e.message });
    emit(write, `❌ Error: ${e.message}`);
    throw e;
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

async function readManifest(filename) {
  if (!B.manifest.isValidBackupFilename(filename)) throw new Error('Nombre de backup inválido');
  const archive = path.join(B.manifest.BACKUP_DIR, filename);
  if (!fs.existsSync(archive)) throw new Error('Backup no encontrado');
  const { cmd, args } = B.commands.readManifestArgs(archive);
  const out = await run(cmd, args, { timeout: 0 });
  return B.manifest.parseManifest(out);
}

async function restoreItem({ filename, item, write }) {
  if (!B.manifest.isValidBackupFilename(filename)) throw new Error('Nombre de backup inválido');
  if (typeof item.path !== 'string' || item.path.includes('..') || path.isAbsolute(item.path)) {
    throw new Error('Ruta de pieza inválida');
  }
  const archive = path.join(B.manifest.BACKUP_DIR, filename);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-restore-'));
  try {
    const ex = B.commands.extractMemberArgs(archive, item.path, tmp);
    await run(ex.cmd, ex.args, { timeout: 0, maxBuffer: 64 * 1024 * 1024 });
    const extracted = path.join(tmp, item.path);

    if (item.class === 'db-mysql') {
      emit(write, `🐬 Restaurando MySQL: ${item.name}`);
      const sql = require('zlib').gunzipSync(fs.readFileSync(extracted)).toString();
      const build = await resolveMysqlBuild();
      const { cmd, args } = build('mysql', [item.name]);
      await runInput(cmd, args, sql);
    } else if (item.class === 'db-pg') {
      emit(write, `🐘 Restaurando PostgreSQL: ${item.name}`);
      const sql = require('zlib').gunzipSync(fs.readFileSync(extracted)).toString();
      await runInput('sudo', ['-u', 'postgres', 'psql', '-d', item.name], sql);
    } else if (item.class === 'site') {
      emit(write, `🌐 Restaurando sitio: ${item.name}`);
      const siteTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-site-r-'));
      await run('tar', ['-xzf', extracted, '-C', siteTmp], { timeout: 0, maxBuffer: 64 * 1024 * 1024 });
      const wwwDir = path.join(siteTmp, 'www');
      if (fs.existsSync(wwwDir)) fs.cpSync(wwwDir, path.join(SITES_DIR, item.name), { recursive: true });
      const conf = path.join(siteTmp, 'nginx.conf');
      if (fs.existsSync(conf)) await nginx.enableSite(item.name, fs.readFileSync(conf, 'utf8'));
      else await nginx.reload();
      fs.rmSync(siteTmp, { recursive: true, force: true });
    } else if (item.class === 'app') {
      emit(write, `📦 Restaurando app: ${item.name}`);
      const app = getQueries().listApps.all().find((a) => a.name === item.name);
      if (!app || !app.path) throw new Error(`La app ${item.name} no existe en el panel`);
      await run('tar', ['-xzf', extracted, '-C', path.dirname(app.path)], { timeout: 0, maxBuffer: 64 * 1024 * 1024 });
      const aviso = checkBuildRequirements(app);
      if (aviso) { emit(write, `⚠️ ${aviso} No se reinicia automáticamente.`); }
      else { await runSafe('pm2', ['restart', app.pm2_name]); }
    } else if (item.class === 'panel') {
      emit(write, '📋 Restaurando config del panel');
      fs.copyFileSync(extracted, PANEL_DB);
      const envMember = path.posix.join(path.posix.dirname(item.path), 'txpl.env');
      const exEnv = B.commands.extractMemberArgs(archive, envMember, tmp);
      const rEnv = await runSafe(exEnv.cmd, exEnv.args, { timeout: 0 });
      const envPath = path.join(tmp, envMember);
      if (rEnv.ok && fs.existsSync(envPath)) { fs.copyFileSync(envPath, PANEL_ENV); emit(write, '📋 .env del panel restaurado'); }
    }
    emit(write, '✅ Restauración completada');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { createBackup, readManifest, restoreItem, resolveResourceItems };