// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
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

test('each coding role explicitly selects the compact single-tool model prompt', () => {
  for (const cooperative of [false, true]) {
    const {config, env} = runtimeSettings({...input, cooperative});
    for (const name of ['build', 'general', 'explore']) {
      const prompt = config.agent[name].prompt;
      assert.equal(typeof prompt, 'string', `${name} must override the upstream default`);
      assert.ok(Buffer.byteLength(prompt) < 2500);
      assert.match(prompt, /qwen3-0\.6b-v1/);
      assert.match(prompt, /exactly one offered tool call/);
      assert.match(prompt, /no surrounding commentary/);
      assert.match(prompt, /matching tool result before/);
      assert.match(prompt, /supplied transport names and argument schemas/);
      assert.match(prompt, /not execution authority/);
      assert.match(prompt, /VOLPAROSSA core owns/);
      assert.match(prompt, /already enrolled public snapshot/);
      assert.doesNotMatch(prompt, /batch your tool calls|multiple tools calls to run the calls in parallel/);
      assert.equal(JSON.parse(env.OPENCODE_CONFIG_CONTENT).agent[name].prompt, prompt);
    }
    for (const name of ['build', 'general']) {
      assert.match(config.agent[name].prompt, /Read relevant files before changing them/);
      assert.match(config.agent[name].prompt, /run the relevant existing tests/);
      assert.match(config.agent[name].prompt, /Never claim an edit or test succeeded without/);
    }
    assert.match(config.agent.explore.prompt, /Read-only exploration/);
    assert.match(config.agent.explore.prompt, /Do not edit files or run commands/);
  }
});

test('prompt override does not expand permissions or configure another coordinator', () => {
  for (const cooperative of [false, true]) {
    const {config} = runtimeSettings({...input, cooperative});
    const original = {'*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
      task: 'allow', bash: 'ask', edit: 'ask', external_directory: 'deny'};
    if (cooperative) original.volparossa_delegate_public = 'allow';
    assert.deepEqual(config.permission, original);
    for (const name of ['build', 'general']) assert.deepEqual(config.agent[name].permission, original);
    assert.deepEqual(config.agent.explore.permission, {...original, bash: 'deny', edit: 'deny'});
    assert.deepEqual(config.enabled_providers, ['volparossa']);
    assert.deepEqual(config.plugin, []); assert.deepEqual(config.mcp, {});
  }
});

const upstream = path.resolve(__dirname, '../build/opencode-runtime/source');
test('available pinned upstream chooses the explicit prompt instead of its parallel-tool default',
  {skip: !fs.existsSync(path.join(upstream, 'packages/opencode/src/session/llm/request.ts'))}, () => {
    // Source-expression check only: no runtime, model, network or optional dependency is started.
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: upstream, encoding: 'utf8'}).trim(), COMMIT);
    const relative = 'packages/opencode/src/session/llm/request.ts';
    const source = execFileSync('git', ['show', `${COMMIT}:${relative}`], {cwd: upstream, encoding: 'utf8'});
    assert.equal(fs.readFileSync(path.join(upstream, relative), 'utf8'), source);
    const expression = source.match(/input\.agent\.prompt \? \[input\.agent\.prompt\] : SystemPrompt\.provider\(input\.model\)/)?.[0];
    assert.ok(expression, 'exact pinned prompt-selection seam');
    const legacy = fs.readFileSync(path.join(upstream, 'packages/opencode/src/session/prompt/default.txt'), 'utf8');
    assert.match(legacy, /multiple tools calls to run the calls in parallel/);
    const {config} = runtimeSettings(input);
    for (const name of ['build', 'general', 'explore']) {
      let defaultCalls = 0;
      const selected = vm.runInNewContext(expression, {
        input: {agent: config.agent[name], model: {}},
        SystemPrompt: {provider() { defaultCalls++; return [legacy]; }},
      }, {timeout: 1000});
      assert.equal(defaultCalls, 0);
      assert.deepEqual(Array.from(selected), [config.agent[name].prompt]);
    }
  });
