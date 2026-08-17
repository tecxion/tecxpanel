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

test('isValidCronField aplica rangos específicos por campo', () => {
  const valid = {
    minute: '59', hour: '23', dom: '31', month: '12', dow: '7',
  };
  const invalid = {
    minute: '60', hour: '24', dom: '0', month: '13', dow: '8',
  };
  for (const [field, value] of Object.entries(valid)) {
    assert.strictEqual(c.isValidCronField(value, field), true, `${field}=${value} debería aceptarse`);
  }
  for (const [field, value] of Object.entries(invalid)) {
    assert.strictEqual(c.isValidCronField(value, field), false, `${field}=${value} debería rechazarse`);
  }
});

test('isValidCronField rechaza rangos invertidos y pasos inválidos', () => {
  for (const [value, field] of [['10-1', 'minute'], ['*/0', 'hour'], ['*/25', 'hour'], ['*/1001', 'generic']]) {
    assert.strictEqual(c.isValidCronField(value, field), false, `debería rechazar ${field}=${value}`);
  }
});

test('isValidCommand rechaza vacío y saltos de línea', () => {
  assert.strictEqual(c.isValidCommand('rsync -a /a /b'), true);
  assert.strictEqual(c.isValidCommand(''), false);
  assert.strictEqual(c.isValidCommand('   '), false);
  assert.strictEqual(c.isValidCommand('echo hola\nrm -rf /'), false);
  assert.strictEqual(c.isValidCommand('echo hola\r* * * * * evil'), false);
  assert.strictEqual(c.isValidCommand(42), false);
  assert.strictEqual(c.isValidCommand('x'.repeat(4096)), true);
  assert.strictEqual(c.isValidCommand('x'.repeat(4097)), false);
});

test('buildCronJobLines arma marcador + línea con flock y redirección', () => {
  const out = c.buildCronJobLines({ id: 3, minute: '0', hour: '2', dom: '*', month: '*', dow: '*', command: 'backup.sh' });
  assert.strictEqual(out, "# txpl-cron:3\n0 2 * * * flock -n -E 75 /var/log/txpl/cron/3.lock /bin/sh -c 'backup.sh' >> /var/log/txpl/cron/3.log 2>&1");
});

test('buildCronJobLines escapa comillas simples del comando', () => {
  const out = c.buildCronJobLines({ id: 5, minute: '*', hour: '*', dom: '*', month: '*', dow: '*', command: "echo it's ok" });
  // La comilla simple se escapa como '\'' para no romper el sh -c '...'
  assert.match(out, /\/bin\/sh -c 'echo it'\\''s ok'/);
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
  assert.match(out, /# txpl-cron:2\n0 4 \* \* 1 flock -n -E 75 \/var\/log\/txpl\/cron\/2\.lock \/bin\/sh -c 'nuevo\.sh' >> \/var\/log\/txpl\/cron\/2\.log 2>&1/);
  assert.ok(out.endsWith('\n'), 'debe terminar en salto de línea');
});

test('rebuildCrontab con lista vacía deja solo las líneas ajenas', () => {
  const current = '# txpl-cron:9\n* * * * * x.sh >> /var/log/txpl/cron/9.log 2>&1\nMAILTO=root';
  const out = c.rebuildCrontab(current, []);
  assert.ok(!out.includes('txpl-cron'), 'sin bloque gestionado');
  assert.match(out, /MAILTO=root/);
});
