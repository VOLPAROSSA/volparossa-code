// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {register, selectionInput} = require('../src/extension.cjs');

function fixture({trusted = true, confirm = true, partial = false} = {}) {
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
  register(api, context, Client);
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
  assert.equal(value.dependencies, undefined); assert.equal(value.activationEvents, undefined);
});
