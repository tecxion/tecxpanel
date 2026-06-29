const { test } = require('node:test');
const assert = require('node:assert');
const appdeploy = require('../lib/appdeploy');

test('appdeploy exporta los helpers esperados', () => {
  for (const fn of ['removeAppDir', 'buildPm2Launch', 'checkBuildRequirements', 'detectProject', 'flattenSingleSubdir']) {
    assert.strictEqual(typeof appdeploy[fn], 'function', `falta ${fn}`);
  }
});
