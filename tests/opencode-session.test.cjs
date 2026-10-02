// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Owner orchestration with synthetic dependencies; not native runtime proof.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {PassThrough} = require('node:stream');
const {EventEmitter} = require('node:events');
const {runSession} = require('../scripts/opencode_session.cjs');
const {readFrames, writeFrame, emptyProviderDiagnostic} = require('../src/opencode-bridge.cjs');

function fixture(Task, receive, options = {}) {
  const input = new PassThrough(), output = new PassThrough(), events = new EventEmitter(), observed = [];
  const provider = {baseUrl: 'http://127.0.0.1:1234/v1', bearerToken: 'a'.repeat(64),
    diagnostics: {summary: emptyProviderDiagnostic()},
    observations: {submitted: 0, cleanup_confirmed: 0},
    async close() { observed.push('provider-close'); if (options.badCleanup) throw Error('private detail'); }};
  const hooks = {Task, preflight: async () => {}, provider: async () => provider,
    prepare(cooperative) { assert.equal(cooperative, options.cooperative ?? false); },
    cooperative: () => options.cooperative ?? false, port: async () => 1235, approvalMs: 15,
    spawn(binary, args, config) {
      assert.equal(binary, '/opt/opencode'); assert.equal(config.env.OPENCODE_PURE, '1');
      assert.equal(config.env.OPENAI_API_KEY, undefined); assert.equal(args[0], 'serve');
      assert.equal(JSON.parse(config.env.OPENCODE_CONFIG_CONTENT).permission.volparossa_delegate_public,
        options.cooperative ? 'allow' : undefined);
      const child = new EventEmitter();
      child.kill = signal => { observed.push(signal); queueMicrotask(() => child.emit('close', null, signal)); };
      return child;
    },
    Client: class {
      constructor(options_) { assert.equal(options_.cooperative, options.cooperative ?? false); }
      async connect() { this.ready = true; } close() { observed.push('client-close'); }
    },
  };
  const unbind = readFrames(output, value => {
    observed.push(value.type);
    if (value.type === 'ready') writeFrame(input, {type: 'run', prompt: 'Synthetic task'});
    else receive(value, input);
  }, () => assert.fail('owner frame'));
  return {observed, input, done: runSession({input, output, events}, hooks).finally(unbind)};
}
const result = {text: 'Fixture only', commands: 0, nativeTurnCompleted: true, taskVerified: false};
test('owner connects pinned runtime, forwards exact approvals and waits for core/process cleanup', async () => {
  class Task {
    constructor(_client, approve) { this.approve = approve; }
    async run(prompt) {
      assert.equal(prompt, 'Synthetic task');
      assert.equal(await this.approve({permission: 'edit', command: 'fixture', directory: '/workspace'}), true);
      return result;
    }
  }
  const f = fixture(Task, (value, input) => {
    if (value.type === 'approval') writeFrame(input, {type: 'approval', id: value.id, accepted: true});
    else if (value.type === 'result') { assert.deepEqual(value.result, result); input.end(); }
  });
  assert.equal(await f.done, 0);
  assert.deepEqual(f.observed, ['ready', 'approval', 'result', 'client-close', 'provider-close', 'SIGTERM']);
});
test('expired approval does not prevent subsequent requests or accept a late response', async () => {
  class Task {
    constructor(_client, approve) { this.approve = approve; }
    async run() {
      assert.equal(await this.approve({permission: 'bash', command: 'one'}), false);
      assert.equal(await this.approve({permission: 'bash', command: 'two'}), true);
      return result;
    }
  }
  const f = fixture(Task, (value, input) => {
    if (value.type === 'approval' && value.id === 2) {
      writeFrame(input, {type: 'approval', id: 1, accepted: true});
      writeFrame(input, {type: 'approval', id: 2, accepted: true});
    } else if (value.type === 'result') input.end();
  });
  assert.equal(await f.done, 0);
});
test('unconfirmed provider cleanup produces failed owner exit after a generated result', async () => {
  class Task { async run() { return result; } }
  const f = fixture(Task, (_value, input) => input.end(), {badCleanup: true});
  assert.equal(await f.done, 1); assert(f.observed.includes('SIGTERM'));
});
test('cancellation resolves pending approval without granting the operation', async () => {
  class Task {
    constructor(_client, approve) { this.approve = approve; }
    async run(_prompt, {signal}) {
      assert.equal(await this.approve({permission: 'bash', command: 'cancelled'}), false);
      assert.equal(signal.aborted, true); throw Error('cancelled');
    }
  }
  const f = fixture(Task, (value, input) => {
    if (value.type === 'approval') writeFrame(input, {type: 'cancel'});
    else if (value.type === 'failed') input.end();
  });
  assert.equal(await f.done, 1);
});
test('inner owner enables public-snapshot tool only when proxy mount is present', async () => {
  class Task { async run() { return result; } }
  const f = fixture(Task, (_value, input) => input.end(), {cooperative: true});
  assert.equal(await f.done, 0);
});
test('task failure is a closed reason plus counters, never the private exception or a success', async () => {
  for (const message of ['opencode_task_native_error', 'PRIVATE_CANARY']) {
    class Task { async run() { throw Error(message); } }
    let failed;
    const f = fixture(Task, (value, input) => { failed = value; input.end(); });
    assert.equal(await f.done, 1);
    assert.equal(failed.type, 'failed');
    assert.equal(failed.reason, message === 'PRIVATE_CANARY' ? 'task_or_runtime_failed' : message);
    assert.deepEqual(failed.diagnostics, emptyProviderDiagnostic());
    assert.ok(!JSON.stringify(failed).includes('PRIVATE_CANARY'));
    assert(f.observed.includes('provider-close')); assert(f.observed.includes('SIGTERM'));
  }
});
