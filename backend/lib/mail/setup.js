'use strict';
// ============================================================
//  TecXPaneL — lib/mail/setup.js — constructores de args del script `setup` + parseo de salidas
// ============================================================

function setupEmailAddArgs(addr, pass) { return ['setup', 'email', 'add', addr, pass]; }
function setupEmailDelArgs(addr) { return ['setup', 'email', 'del', '-y', addr]; }
function setupEmailUpdateArgs(addr, pass) { return ['setup', 'email', 'update', addr, pass]; }
function setupEmailListArgs() { return ['setup', 'email', 'list']; }
function setupAliasAddArgs(src, dst) { return ['setup', 'alias', 'add', src, dst]; }
function setupAliasDelArgs(src, dst) { return ['setup', 'alias', 'del', src, dst]; }
function setupAliasListArgs() { return ['setup', 'alias', 'list']; }
function setupDkimArgs(domain) { return ['setup', 'config', 'dkim', 'keysize', '2048', 'domain', domain]; }

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

function parseEmailList(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m1 = line.match(EMAIL_RE);
    if (m1 && m1.length) out.push({ address: m1[0] });
  }
  return out;
}

function parseAliasList(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m1 = line.match(EMAIL_RE);
    if (m1 && m1.length >= 2) out.push({ source: m1[0], destination: m1[1] });
  }
  return out;
}

module.exports = {
  setupEmailAddArgs, setupEmailDelArgs, setupEmailUpdateArgs, setupEmailListArgs,
  setupAliasAddArgs, setupAliasDelArgs, setupAliasListArgs, setupDkimArgs,
  parseEmailList, parseAliasList,
};