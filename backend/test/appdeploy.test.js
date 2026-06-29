const { test } = require('node:test');
const assert = require('node:assert');
const appdeploy = require('../lib/appdeploy');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('appdeploy exporta los helpers esperados', () => {
  for (const fn of ['removeAppDir', 'buildPm2Launch', 'checkBuildRequirements', 'detectProject', 'flattenSingleSubdir']) {
    assert.strictEqual(typeof appdeploy[fn], 'function', `falta ${fn}`);
  }
});

test('detectProject: bot Python sin framework => worker, venv, entry bot.py', () => {
  const dir = tmpProject({ 'requirements.txt': 'python-telegram-bot==21.0\n', 'bot.py': 'print(1)' });
  const det = appdeploy.detectProject(dir);
  assert.strictEqual(det.type, 'python');
  assert.strictEqual(det.mode, 'worker');
  assert.match(det.installCmd, /python3 -m venv \.venv/);
  assert.match(det.installCmd, /\.venv\/bin\/pip install -r requirements\.txt/);
  assert.strictEqual(det.startCmd, 'python bot.py');
  assert.ok(det.pyFiles.includes('bot.py'));
});

test('detectProject: web FastAPI => mode web', () => {
  const dir = tmpProject({ 'requirements.txt': 'fastapi\nuvicorn\n', 'main.py': 'x=1' });
  const det = appdeploy.detectProject(dir);
  assert.strictEqual(det.type, 'python');
  assert.strictEqual(det.mode, 'web');
  assert.strictEqual(det.startCmd, 'python main.py');
});

test('detectProject: Flask => mode web', () => {
  const dir = tmpProject({ 'requirements.txt': 'Flask==3.0\n', 'app.py': 'x=1' });
  assert.strictEqual(appdeploy.detectProject(dir).mode, 'web');
});

test('detectProject: solo bot.py sin requirements => python, venv sin pip', () => {
  const dir = tmpProject({ 'bot.py': 'print(1)' });
  const det = appdeploy.detectProject(dir);
  assert.strictEqual(det.type, 'python');
  assert.strictEqual(det.installCmd, 'python3 -m venv .venv');
});

test('detectProject: proyecto Node mantiene mode web y pyFiles vacío', () => {
  const dir = tmpProject({ 'package.json': '{"scripts":{"start":"node index.js"}}', 'index.js': '' });
  const det = appdeploy.detectProject(dir);
  assert.strictEqual(det.type, 'nodejs');
  assert.strictEqual(det.mode, 'web');
  assert.deepStrictEqual(det.pyFiles, []);
});
