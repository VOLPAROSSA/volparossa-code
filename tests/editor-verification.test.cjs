// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {verificationSettings} = require('../src/editor-verification.cjs');
const plan = () => ({executable: '/usr/bin/python3', args: ['-B', '-m', 'unittest'], timeoutMs: 15000, maxRounds: 3});

test('absent settings preserve the single-turn route; exact plans are copied and frozen', () => {
  assert.equal(verificationSettings(undefined), null);
  assert.equal(verificationSettings({}), null);
  const config = plan(), result = verificationSettings(config);
  config.args.push('later'); config.maxRounds = 16;
  assert.deepEqual(result, plan());
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.args));
  assert.equal(verificationSettings({...plan(), args: [], timeoutMs: 1, maxRounds: 1}).timeoutMs, 1);
  assert.equal(verificationSettings({...plan(), timeoutMs: 60000, maxRounds: 16}).maxRounds, 16);
});

test('malformed, unbounded and model-style plans fail closed without echoing their values', () => {
  const missing = plan(); delete missing.maxRounds;
  for (const value of [null, false, 'private-value', [], missing, {...plan(), command: 'private-value'},
    {...plan(), executable: '/project/private-value'}, {...plan(), executable: '/usr/bin/../private-value'},
    {...plan(), args: ['private-value\0']}, {...plan(), args: Array(129).fill('')},
    {...plan(), args: ['a'.repeat(4097)]}, {...plan(), args: Array(5).fill('a'.repeat(4096))},
    {...plan(), args: [false]}, {...plan(), timeoutMs: 0}, {...plan(), timeoutMs: 60001},
    {...plan(), timeoutMs: 1.5}, {...plan(), maxRounds: 0}, {...plan(), maxRounds: 17}]) {
    assert.throws(() => verificationSettings(value), error =>
      error.message.startsWith('Configure the owner verification') && !error.message.includes('private-value'));
  }
});
