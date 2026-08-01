'use strict';
// ============================================================
//  TecXPaneL — lib/backups/commands.js — constructores de argumentos
//  para comandos dump/tar/extract (puros, sin exec).
// ============================================================

const path = require('path');

function mysqldumpArgs(dbName, rootPassword) {
  return { cmd: 'mysqldump', args: ['-u', 'root', `-p${rootPassword}`, '--single-transaction', '--routines', '--triggers', dbName] };
}

function pgDumpArgs(dbName) {
  return { cmd: 'sudo', args: ['-u', 'postgres', 'pg_dump', dbName] };
}

function siteTarArgs(domain, outPath, sitesDir) {
  return { cmd: 'tar', args: ['-czf', outPath, '-C', sitesDir, domain] };
}

function appTarArgs(appPath, outPath) {
  return { cmd: 'tar', args: ['-czf', outPath, '-C', path.dirname(appPath), path.basename(appPath)] };
}

function packageTarArgs(workDir, outPath) {
  return { cmd: 'tar', args: ['-czf', outPath, '-C', workDir, '.'] };
}

function readManifestArgs(archivePath) {
  return { cmd: 'tar', args: ['-xzOf', archivePath, './manifest.json'] };
}

function extractMemberArgs(archivePath, memberPath, destDir) {
  return { cmd: 'tar', args: ['-xzf', archivePath, '-C', destDir, memberPath] };
}

module.exports = { mysqldumpArgs, pgDumpArgs, siteTarArgs, appTarArgs, packageTarArgs, readManifestArgs, extractMemberArgs };