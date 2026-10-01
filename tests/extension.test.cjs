// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {register, selectionInput} = require('../src/extension.cjs');

function fixture({trusted = true, confirm = true, partial = false, native} = {}) {
  const commands = new Map(), calls = [], documents = [], errors = [];
  const context = {subscriptions: []};
  const editor = {selection: {isEmpty: false}, document: {uri: {scheme: 'file'},
    getText(selection) { assert.equal(selection, editor.selection); return 'const answer = 42;'; }}};
  class Client {
    constructor(path) { calls.push(['connect', path]); }
    async connect() { return {model_profile: 'smol360', max_context_bytes: 4096}; }
    async ask(value) { calls.push(['ask', value]); return {answer_complete: !partial,
      output: {text: '<script>not executable</script>'}, cleanup: {complete: true}}; }
    close() { calls.push(['close']); }
  }
  const api = {
    env: {}, ProgressLocation: {Notification: 15},
    workspace: {isTrusted: trusted, getConfiguration() { return {inspect() {
      return {globalValue: '/run/owner/private.sock', workspaceValue: '/tmp/attacker.sock'};
    }}; }, async openTextDocument(value) { documents.push(value); return value; }},
    commands: {registerCommand(name, action) { commands.set(name, action); return {dispose() {}}; }},
    window: {activeTextEditor: editor, async showInputBox() { return 'Explain this code.'; },
      async showInformationMessage() { return confirm ? 'Send locally' : undefined; },
      async showErrorMessage(value) { errors.push(value); }, async showTextDocument() {},
      async withProgress(_options, action) { return action({}, {isCancellationRequested: false,
        onCancellationRequested() { return {dispose() {}}; }}); }}
  };
  register(api, context, Client, native);
  return {commands, calls, documents, errors, api, context};
}
test('activation has no compute side effects and configuration cannot be redirected by the workspace', async () => {
  const f = fixture(); assert.deepEqual(f.calls, []);
  await f.commands.get('volparossaCode.reviewSelection')();
  assert.deepEqual(f.calls[0], ['connect', '/run/owner/private.sock']);
  const request = f.calls.find(call => call[0] === 'ask')[1];
  assert.equal(request.question, 'Explain this code.'); assert.equal(request.context, 'const answer = 42;');
  assert.deepEqual(Object.keys(request).sort(), ['context', 'question', 'signal']);
  assert.equal(f.documents[0].language, 'plaintext'); assert.match(f.documents[0].content, /not executable/);
  assert.equal(f.calls.at(-1)[0], 'close');
});
test('untrusted, remote and unconfirmed requests never connect', async () => {
  const untrusted = fixture({trusted: false}), refused = fixture({confirm: false}), remote = fixture();
  remote.api.env.remoteName = 'ssh-remote';
  for (const f of [untrusted, refused, remote]) {
    await f.commands.get('volparossaCode.reviewSelection')(); assert.deepEqual(f.calls, []);
  }
});
test('oversized selections are rejected, never silently truncated or replaced by the full document', () => {
  const make = text => ({selection: {isEmpty: false}, document: {uri: {scheme: 'file'}, getText: () => text}});
  assert.equal(selectionInput(make('x'.repeat(4096))).length, 4096);
  for (const text of ['x'.repeat(4097), 'é'.repeat(2049), '\0']) assert.throws(() => selectionInput(make(text)));
  assert.throws(() => selectionInput(null));
});
test('partial answers stay visibly partial and are not automatically applied', async () => {
  const f = fixture({partial: true}); await f.commands.get('volparossaCode.reviewSelection')();
  assert.match(f.documents[0].content, /no \(partial\/truncated\)/); assert.deepEqual(f.errors, []);
});
test('manifest declares trust and machine scope without telemetry, accounts or automatic runtime', () => {
  const value = JSON.parse(readFileSync(new URL('../package.json', `file://${__filename}`)));
  assert.equal(value.capabilities.untrustedWorkspaces.supported, false);
  assert.equal(value.contributes.configuration.properties['volparossaCode.privateSocket'].scope, 'machine');
  assert.equal(value.contributes.configuration.properties['volparossaCode.nativeRuntime'].scope, 'machine');
  assert.equal(value.dependencies, undefined); assert.equal(value.activationEvents, undefined);
});

function codingFixture() {
  const events = [];
  const native = {
    Runtime: {async start(config, options) {
      events.push(['launch', config, options]);
      return {readable: {}, writable: {}, async close() { events.push(['cleanup']); }};
    }},
    Server: class {
      constructor(_read, _write, options) { events.push(['server', options]); }
      close() { events.push(['server-close']); }
    },
    Task: class {
      constructor(_server, approval, options) { this.approval = approval; this.options = options; }
      async run(prompt) {
        events.push(['task', prompt]);
        assert.equal(await this.approval({command: 'node --test', directory: '.'}), true);
        this.options.onStatus({commands: 1, status: 'completed'});
        return {text: 'Generated reply', commands: 1, nativeTurnCompleted: true, taskVerified: false};
      }
      async stop() { events.push(['stop']); }
    }
  };
  const f = fixture({native});
  f.api.workspace.workspaceFolders = [{name: 'project', uri: {scheme: 'file', fsPath: '/projects/selected'}}];
  f.api.workspace.getConfiguration = () => ({inspect: key => ({
    globalValue: key === 'privateSocket' ? '/run/owner/conversation.sock' : {version: 1, appServer: '/explicit/runtime'},
    workspaceValue: key === 'privateSocket' ? '/tmp/untrusted.sock' : {appServer: '/project/untrusted-runtime'}
  })});
  f.api.window.showInformationMessage = async (_text, _options, action) => action;
  f.api.window.showWarningMessage = async (text, options, action) => {
    events.push(['approval', text, options]); return action;
  };
  f.api.window.withProgress = async (_options, action) => action({report(value) { events.push(['progress', value]); }}, {
    isCancellationRequested: false, onCancellationRequested() { return {dispose() {}}; }
  });
  return {...f, events, native};
}

test('explicit coding command launches only user-selected inputs, asks one-shot approval and waits for cleanup', async () => {
  const f = codingFixture(); assert.deepEqual(f.events, []);
  await f.commands.get('volparossaCode.codingTask')();
  assert.deepEqual(f.events[0], ['launch', {version: 1, appServer: '/explicit/runtime', socketPath: '/run/owner/conversation.sock'},
    {workspace: '/projects/selected'}]);
  const options = f.events.find(e => e[0] === 'server')[1];
  assert.equal(options.writableRoot, '/workspace'); assert.deepEqual(options.allowedModels, ['qwen3-0.6b-v1']);
  assert(f.events.find(e => e[0] === 'approval')[1].includes('node --test'));
  assert.deepEqual(f.events.slice(-2), [['server-close'], ['cleanup']]);
  assert.equal(f.documents[0].language, 'plaintext');
  assert.match(f.documents[0].content, /not independently verified/);
  assert.match(f.documents[0].content, /Generated reply/); assert.deepEqual(f.errors, []);
});

test('cancelled consent, remote, untrusted and missing folders never launch a native runtime', async () => {
  for (const configure of [f => { f.api.window.showInformationMessage = async () => undefined; },
    f => { f.api.env.remoteName = 'ssh-remote'; }, f => { f.api.workspace.isTrusted = false; },
    f => { f.api.workspace.workspaceFolders = []; }]) {
    const f = codingFixture(); configure(f);
    await f.commands.get('volparossaCode.codingTask')(); assert.deepEqual(f.events, []);
  }
});

test('runtime cleanup failure never displays a successful coding result or raw private error', async () => {
  const f = codingFixture();
  f.native.Runtime.start = async () => ({readable: {}, writable: {}, async close() { throw Error('private-token-and-path'); }});
  await f.commands.get('volparossaCode.codingTask')();
  assert.deepEqual(f.documents, []); assert.equal(f.errors.length, 1);
  assert(!f.errors[0].includes('private-token-and-path'));
});

test('deactivation during native startup closes the new runtime without beginning a task', async () => {
  const f = codingFixture(); let joined = false;
  f.native.Runtime.start = async () => {
    f.context.subscriptions.at(-1).dispose();
    return {readable: {}, writable: {}, async close() { joined = true; }};
  };
  await f.commands.get('volparossaCode.codingTask')();
  assert.equal(joined, true); assert.deepEqual(f.events, []); assert.deepEqual(f.documents, []);
});

test('deactivation while progress callback is queued cannot begin native inference', async () => {
  const f = codingFixture();
  f.api.window.withProgress = async (_options, action) => {
    f.context.subscriptions.at(-1).dispose();
    return action({}, {});
  };
  await f.commands.get('volparossaCode.codingTask')();
  assert(!f.events.some(e => e[0] === 'task'));
  assert.deepEqual(f.events.slice(-2), [['server-close'], ['cleanup']]);
  assert.deepEqual(f.documents, []);
});
