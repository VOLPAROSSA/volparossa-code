// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {EditorTask, WORKSPACE, MODEL} = require('../src/editor-task.cjs');

function setup(action) {
  const client = new EventEmitter(), calls = [], approvals = [];
  client.initialize = async () => { calls.push('initialize'); };
  client.startThread = async args => {
    calls.push(['thread', args]);
    return {model: MODEL, cwd: WORKSPACE, thread: {id: 'thread', modelProvider: 'volparossa', ephemeral: true}};
  };
  const event = (method, params) => client.emit('notification', {method, params: {threadId: 'thread', ...params}});
  client.interrupt = async (...args) => { calls.push(['interrupt', ...args]); };
  client.request = async (method, params) => { calls.push([method, params]); return {status: 'unsubscribed'}; };
  const task = new EditorTask(client, async proposal => { approvals.push(proposal); return true; });
  client.startTurn = async (thread, prompt) => {
    calls.push(['turn', thread, prompt]);
    event('turn/started', {turn: {id: 'turn'}});
    await action({client, task, event});
    return {turn: {id: 'turn'}};
  };
  return {client, task, calls, approvals};
}
const proposal = () => ({kind: 'command', threadId: 'thread', turnId: 'turn', itemId: 'item',
  command: '/bin/bash -c "node --test"', cwd: WORKSPACE});
const finish = event => event('turn/completed', {turn: {id: 'turn', status: 'completed', error: null}});

test('real editor controller accepts an arbitrary scoped command, keeps native lineage, and does not claim task correctness', async () => {
  const f = setup(async ({task, event}) => {
    assert.equal(await task.approve(proposal()), true);
    event('item/agentMessage/delta', {turnId: 'turn', delta: 'Inspect the actual changes.'});
    event('item/completed', {turnId: 'turn', item: {type: 'commandExecution', status: 'completed'}});
    finish(event); // Notifications may precede the turn/start reply.
  });
  const result = await f.task.run('Implement the selected task.');
  assert.deepEqual(result, {text: 'Inspect the actual changes.', commands: 1, nativeTurnCompleted: true, taskVerified: false});
  assert.deepEqual(f.approvals, [{command: proposal().command, directory: '.'}]);
  assert.deepEqual(f.calls.at(-1), ['thread/unsubscribe', {threadId: 'thread'}]);
  assert.equal(f.client.listenerCount('notification'), 0);
  assert.equal(await f.task.approve(proposal()), false);
});

test('wrong lineage, workspace escapes, network/escalation, and non-command approvals never reach the user', async () => {
  const f = setup(async ({task, event}) => {
    for (const change of [{threadId: 'other'}, {turnId: 'old'}, {itemId: ''}, {cwd: '/workspace-other'},
      {cwd: '/workspace/../tmp'}, {cwd: '/workspace/sub/../../tmp'}, {kind: 'writeStdin'},
      {additionalPermissions: {}}, {networkApprovalContext: {}}, {proposedNetworkPolicyAmendments: []},
      {command: 'x'.repeat(8193)}, {command: '\0'}, {command: ''}]) {
      assert.equal(await task.approve({...proposal(), ...change}), false);
    }
    // The proposed rule is not adopted; the underlying client sends accept once.
    assert.equal(await task.approve({...proposal(), cwd: '/workspace/src', proposedExecpolicyAmendment: ['node']}), true);
    finish(event);
  });
  await f.task.run('A task');
  assert.equal(f.approvals.length, 1); assert.equal(f.approvals[0].directory, './src');
});

test('an approval returned after cancellation or native completion is refused', async () => {
  const f = setup(async ({task, event}) => {
    let accept;
    task.approval = () => new Promise(resolve => { accept = resolve; });
    const pending = task.approve(proposal());
    finish(event); accept(true);
    assert.equal(await pending, false);
  });
  await f.task.run('A task');
});

test('cancel before start reply still interrupts the exact admitted native turn', async () => {
  const abort = new AbortController();
  const f = setup(async () => { abort.abort(); });
  await assert.rejects(f.task.run('A task', {signal: abort.signal}), /cancelled/);
  assert(f.calls.some(call => Array.isArray(call) && call[0] === 'interrupt' && call[1] === 'thread' && call[2] === 'turn'));
  assert(!f.calls.some(call => Array.isArray(call) && call[0] === 'thread/unsubscribe'));
});

test('native failure, EOF, oversize output and deadline are not successful tasks', async () => {
  const actions = [async ({event}) => event('turn/completed', {turn: {id: 'turn', status: 'failed', error: {message: 'private'}}}),
    async ({client}) => client.emit('closed'),
    async ({event}) => event('item/agentMessage/delta', {turnId: 'turn', delta: 'x'.repeat(65537)}),
    async () => {}];
  for (const action of actions) {
    const f = setup(action);
    await assert.rejects(f.task.run('A task', {timeoutMs: 10}), /editor_(turn_incomplete|task_cancelled)/);
    assert.equal(f.client.listenerCount('notification'), 0);
  }
});

test('cancellation before launch and provider/thread substitution fail without a model request', async () => {
  const abort = new AbortController(); abort.abort();
  const f = setup(async () => {});
  await assert.rejects(f.task.run('A task', {signal: abort.signal}), /cancelled/);
  assert.deepEqual(f.calls, []);
  const g = setup(async () => {});
  g.client.startThread = async () => ({model: MODEL, cwd: WORKSPACE,
    thread: {id: 'thread', modelProvider: 'other', ephemeral: true}});
  await assert.rejects(g.task.run('A task'), /thread_scope/);
  assert(!g.calls.some(call => Array.isArray(call) && call[0] === 'turn'));
});
