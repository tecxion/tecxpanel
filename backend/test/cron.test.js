const { test } = require('node:test');
const assert = require('node:assert');
const c = require('../lib/cron');

test('constantes y ruta de log', () => {
  assert.strictEqual(c.CRON_MARKER, '# txpl-cron:');
  assert.strictEqual(c.CRON_LOG_DIR, '/var/log/txpl/cron');
  assert.strictEqual(c.cronLogPath(7), '/var/log/txpl/cron/7.log');
});

test('isValidCronField acepta tokens válidos', () => {
  for (const t of ['*', '5', '0', '1-5', '*/10', '0-30/5', '1,15,30', '1-5/2']) {
    assert.strictEqual(c.isValidCronField(t), true, `debería aceptar ${t}`);
  }
});

test('isValidCronField rechaza basura', () => {
  for (const t of ['', '   ', 'abc', '*/', '5-', '1,,2', '* *', null, undefined, 5]) {
    assert.strictEqual(c.isValidCronField(t), false, `debería rechazar ${JSON.stringify(t)}`);
  }
});

test('isValidCommand rechaza vacío y saltos de línea', () => {
  assert.strictEqual(c.isValidCommand('rsync -a /a /b'), true);
  assert.strictEqual(c.isValidCommand(''), false);
  assert.strictEqual(c.isValidCommand('   '), false);
  assert.strictEqual(c.isValidCommand('echo hola\nrm -rf /'), false);
  assert.strictEqual(c.isValidCommand('echo hola\r* * * * * evil'), false);
  assert.strictEqual(c.isValidCommand(42), false);
});

test('buildCronJobLines arma marcador + línea con redirección', () => {
  const out = c.buildCronJobLines({ id: 3, minute: '0', hour: '2', dom: '*', month: '*', dow: '*', command: 'backup.sh' });
  assert.strictEqual(out, '# txpl-cron:3\n0 2 * * * backup.sh >> /var/log/txpl/cron/3.log 2>&1');
});

test('rebuildCrontab conserva líneas ajenas y regenera el bloque', () => {
  const current = [
    '0 3 * * * /usr/bin/node /opt/txpl/backend/backup-runner.js >> /var/log/txpl/backup.log 2>&1',
    '# txpl-cron:1',
    '*/5 * * * * viejo.sh >> /var/log/txpl/cron/1.log 2>&1',
    '@reboot algo-del-usuario',
  ].join('\n');
  const jobs = [
    { id: 2, minute: '0', hour: '4', dom: '*', month: '*', dow: '1', command: 'nuevo.sh' },
  ];
  const out = c.rebuildCrontab(current, jobs);
  // Conserva la línea de backups y la del usuario; elimina el bloque txpl-cron:1; añade txpl-cron:2.
  assert.match(out, /backup-runner\.js/);
  assert.match(out, /@reboot algo-del-usuario/);
  assert.ok(!out.includes('# txpl-cron:1'), 'debe eliminar el bloque previo');
  assert.ok(!out.includes('viejo.sh'), 'debe eliminar el comando previo');
  assert.match(out, /# txpl-cron:2\n0 4 \* \* 1 nuevo\.sh >> \/var\/log\/txpl\/cron\/2\.log 2>&1/);
  assert.ok(out.endsWith('\n'), 'debe terminar en salto de línea');
});

test('rebuildCrontab con lista vacía deja solo las líneas ajenas', () => {
  const current = '# txpl-cron:9\n* * * * * x.sh >> /var/log/txpl/cron/9.log 2>&1\nMAILTO=root';
  const out = c.rebuildCrontab(current, []);
  assert.ok(!out.includes('txpl-cron'), 'sin bloque gestionado');
  assert.match(out, /MAILTO=root/);
});
