'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isValidGitToken, gitEnv, tokenNeedsHttps } = require('../lib/deploy');

test('isValidGitToken: acepta tokens típicos y rechaza saltos de línea/espacios', () => {
  assert.ok(isValidGitToken('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.ok(isValidGitToken('github_pat_11ABC_xyz'));
  assert.ok(!isValidGitToken('corto'));
  assert.ok(!isValidGitToken('ghp_abc\nInjected: header'));
  assert.ok(!isValidGitToken('ghp abc12345'));
});

test('gitEnv: sin token no añade cabecera; con token va por env y en base64', () => {
  assert.strictEqual(gitEnv('').GIT_CONFIG_COUNT, undefined);
  const e = gitEnv('ghp_secret123');
  assert.strictEqual(e.GIT_CONFIG_KEY_0, 'http.extraHeader');
  assert.strictEqual(e.GIT_CONFIG_VALUE_0, 'Authorization: Basic ' + Buffer.from('x-access-token:ghp_secret123').toString('base64'));
  assert.strictEqual(e.GIT_TERMINAL_PROMPT, '0');
});

test('tokenNeedsHttps: token con ssh/http se rechaza; sin token siempre vale', () => {
  assert.ok(tokenNeedsHttps('git@github.com:u/r.git', 'tok12345'));
  assert.ok(tokenNeedsHttps('http://x/y.git', 'tok12345'));
  assert.ok(!tokenNeedsHttps('https://github.com/u/r.git', 'tok12345'));
  assert.ok(!tokenNeedsHttps('git@github.com:u/r.git', ''));
});
