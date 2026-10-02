// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {runtimeSettings, COMMIT, VERSION, MODEL} = require('../src/opencode-config.cjs');
const input = {baseUrl: 'http://127.0.0.1:1234/v1', bearerToken: 'a'.repeat(64), password: 'b'.repeat(64)};
test('pinned runtime uses only core provider with separate one-shot tool boundaries', () => {
  const {config, env} = runtimeSettings(input);
  assert.equal(COMMIT, 'aec0b9a6d8898f68f923aaf08b7306d931fd9d76');
  assert.equal(VERSION, '1.18.34');
  assert.equal(config.model, `volparossa/${MODEL}`);
  assert.deepEqual(config.enabled_providers, ['volparossa']);
  assert.equal(config.share, 'disabled');
  assert.equal(config.permission.task, 'allow');
  assert.equal(config.permission.bash, 'ask');
  assert.equal(config.permission.external_directory, 'deny');
  assert.equal(config.agent.general.permission.edit, 'ask');
  assert.equal(config.lsp, false); assert.equal(config.formatter, false);
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), config);
  assert.equal(env.VOLPAROSSA_NO_RUNTIME_INSTALLS, '1');
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  assert.equal(env.OPENCODE_PURE, '1');
  assert.equal(Object.hasOwn(env, 'HOME'), false);
  assert.equal(Object.hasOwn(env, 'OPENAI_API_KEY'), false);
});
test('configuration rejects remote, malformed and unauthenticated endpoints', () => {
  for (const baseUrl of ['https://example.org/v1', 'http://localhost:1234/v1',
    'http://127.0.0.1:99999/v1', 'http://127.0.0.1:1234/v1?key=x']) {
    assert.throws(() => runtimeSettings({...input, baseUrl}));
  }
  assert.throws(() => runtimeSettings({...input, password: ''}));
  assert.throws(() => runtimeSettings({...input, cooperative: 'yes'}));
});
test('public snapshot tool is allowed only for an explicitly mounted cooperative proxy', () => {
  const local = runtimeSettings(input), enabled = runtimeSettings({...input, cooperative: true});
  assert.equal(local.config.permission.volparossa_delegate_public, undefined);
  assert.equal(enabled.config.permission.volparossa_delegate_public, 'allow');
  assert.equal(enabled.config.agent.general.permission.volparossa_delegate_public, 'allow');
  assert.equal(enabled.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  assert.equal(enabled.env.OPENCODE_PURE, '1');
  assert.equal(enabled.config.permission.external_directory, 'deny');
});
