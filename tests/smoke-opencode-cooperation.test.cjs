// SPDX-License-Identifier: GPL-3.0-only
// Pure scope and synthetic PRIVATE planner tests. No native runtime/public peers.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const {PrivateConversation} = require('../src/private-conversation.cjs');
const {options, snapshotBytes, resultEvidence, plannerState, privatePlanner, guestAllowed, CALL, TOOL, FINISHED}
  = require('../scripts/smoke_opencode_cooperation.cjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const PUBLIC = {question: 'Explain this explicitly public example.', context: 'pub fn answer() -> u8 { 42 }',
  license: 'GPL-3.0-only', public_content: true, rights_confirmed: true};
const args = ['--execute', '--yes', '--node', '/guest/node', '--build-report', '/guest/build.json',
  '--public-socket', '/guest/core/public.sock', '--snapshot', '/guest/public.json', '--snapshot-sha256', 'a'.repeat(64),
  '--project-parent', '/guest/projects', '--output', '/guest/report.json'];
function original() {
  return {tool_call_id: CALL, core_task_id: 'd'.repeat(32), visibility: 'public_cooperative', result: {
    answer_complete: true, answer_status: 'complete', execution_complete: true, output: {text: 'Fixture answer; no live peer claim.'},
    provider_keys: ['a'.repeat(64), 'b'.repeat(64)], selected_provider_keys: ['a'.repeat(64), 'b'.repeat(64)],
    joining: 'hierarchical_peer_synthesis', package_count: 1, total_parts: 2, synthesis_levels: 1,
    source_manifest_id: 'c'.repeat(64), remote_cleanup_confirmed: true, cleanup: {complete: true},
    retained_public_receipts: true, model_answer_correctness_proven: false, semantic_completeness_proven: false}};
}
function input(history = [{type: 'message', role: 'user', text: 'Use the enrolled public tool.'}]) {
  return {version: 1, visibility: 'private_local', instructions: 'Synthetic integration planner.', history,
    tools: [{type: 'function', name: TOOL, namespace: null, description: 'Only the owner-enrolled public task.',
      parameters: {type: 'object', properties: {}}}]};
}
test('caller contract requires explicit execution, exact snapshot hash, paths and bounded time', () => {
  assert.equal(options(args).seconds, 2400);
  assert.equal(options([...args, '--timeout-seconds', '120']).seconds, 120);
  for (const bad of [args.slice(1), [...args, '--yes', 'true'], [...args, '--public-socket', '/other'],
    [...args, '--timeout-seconds', '2401'], [...args, '--timeout-seconds', '0'],
    args.map(value => value === '/guest/public.json' ? '../private.json' : value),
    args.map(value => value === 'a'.repeat(64) ? 'not-a-hash' : value)]) assert.throws(() => options(bad));
});
test('source enrollment is exactly hash bound; consent, unknown fields, duplicate keys and invalid UTF-8 are rejected', () => {
  const bytes = Buffer.from(JSON.stringify(PUBLIC)); const enrolled = snapshotBytes(bytes, sha(bytes));
  assert.equal(enrolled.context_sha256, sha(PUBLIC.context)); assert.equal(enrolled.snapshot_sha256, sha(bytes));
  assert.equal(enrolled.token.visibility, 'public_cooperative');
  assert.ok(!JSON.stringify(enrolled).includes(PUBLIC.context));
  assert.throws(() => snapshotBytes(bytes, 'a'.repeat(64)));
  for (const change of [{rights_confirmed: false}, {public_content: false}, {private_history: 'private'}, {license: 'unknown'}]) {
    const changed = Buffer.from(JSON.stringify({...PUBLIC, ...change}));
    assert.throws(() => snapshotBytes(changed, sha(changed)));
  }
  for (const changed of [Buffer.from('{"question":"a","question":"b"}'), Buffer.from([0xc3, 0x28])]) {
    assert.throws(() => snapshotBytes(changed, sha(changed)));
  }
});
test('closed evidence binds original IDs and hashes without persisting answer; selected peers are not execution peers', () => {
  const value = original(), raw = JSON.stringify(value), evidence = resultEvidence(value, raw);
  assert.equal(evidence.complete_with_two_execution_providers, true);
  assert.equal(evidence.original_tool_result_sha256, sha(raw));
  assert.equal(evidence.original_core_result_sha256, sha(JSON.stringify(value.result)));
  assert.equal(evidence.source_manifest_id, value.result.source_manifest_id);
  assert.equal(evidence.core_task_id, value.core_task_id);
  assert.ok(!JSON.stringify(evidence).includes(value.result.output.text));
  value.result.provider_keys.pop();
  assert.equal(resultEvidence(value, JSON.stringify(value)).complete_with_two_execution_providers, false);
  assert.equal(resultEvidence(value, JSON.stringify(value)).selected_provider_keys.length, 2);
});
test('incomplete original results remain incomplete; fabricated identity or unconfirmed cleanup is rejected', () => {
  const value = original(); Object.assign(value.result, {answer_complete: false, answer_status: 'incomplete',
    execution_complete: false, provider_keys: [], joining: 'awaiting_fragments_before_peer_synthesis', output: {text: ''}});
  const evidence = resultEvidence(value, JSON.stringify(value));
  assert.equal(evidence.answer_complete, false); assert.equal(evidence.complete_with_two_execution_providers, false);
  for (const modify of [v => {v.tool_call_id = 'another';}, v => {v.core_task_id = 'bad';},
    v => {v.visibility = 'private';}, v => {v.result.cleanup.complete = false;},
    v => {v.result.provider_keys = ['f'.repeat(64)];}, v => {v.result.source_manifest_id = '0'.repeat(64);}]) {
    const bad = structuredClone(value); modify(bad); assert.throws(() => resultEvidence(bad, JSON.stringify(bad)));
  }
  assert.throws(() => resultEvidence(value, JSON.stringify(original())));
});
test('deterministic planner only invokes the enrolled tool then observes the unmodified core result', () => {
  const planner = plannerState(); const first = input(); const call = planner.reply(first);
  assert.deepEqual(call, {type: 'function_call', call_id: CALL, namespace: null, name: TOOL, arguments: {}});
  const value = original(), raw = JSON.stringify(value);
  const second = input([...first.history, call, {type: 'tool_result', call_id: CALL, output: raw}]);
  assert.deepEqual(planner.reply(second), {type: 'assistant', text: FINISHED});
  assert.equal(planner.state.evidence.original_tool_result_sha256, sha(raw)); assert.equal(planner.state.stage, 2);
  assert.throws(() => planner.reply(second)); assert.equal(planner.state.failed, true);
});
test('actual Unix PRIVATE planner passes production conversation validation without starting models or public service', async t => {
  let failures = 0;
  const planner = await privatePlanner(() => failures++), client = new PrivateConversation(planner.socketPath);
  t.after(async () => { client.close(); await planner.close(); });
  const capabilities = await client.connect(); assert.equal(capabilities.local_only, true);
  const first = input(); const turn = await client.submit(first);
  assert.equal(turn.output.name, TOOL); assert.deepEqual(turn.output.arguments, {});
  const raw = JSON.stringify(original());
  const next = input([...first.history, turn.output, {type: 'tool_result', call_id: CALL, output: raw}]);
  assert.equal((await client.submit(next)).output.text, FINISHED);
  assert.equal(planner.state.evidence.original_tool_result_sha256, sha(raw)); assert.equal(failures, 0);
});
test('preview is inert and execute cannot bypass the disposable guest guard', () => {
  const file = path.resolve(__dirname, '../scripts/smoke_opencode_cooperation.cjs');
  const preview = spawnSync(process.execPath, [file, '--preview'], {encoding: 'utf8', timeout: 5000,
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}});
  assert.equal(preview.status, 0); const value = JSON.parse(preview.stdout);
  assert.equal(value.execute, false); assert.equal(value.synthetic_private_planner, true);
  assert.equal(value.synthetic_public_core, false); assert.equal(value.actual_native_runtime_started, false);
  const rejected = spawnSync(process.execPath, [file, ...args], {encoding: 'utf8', timeout: 5000,
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}});
  assert.equal(rejected.status, 1); assert.equal(JSON.parse(rejected.stderr).failure, 'guard_or_input_rejected');
});
test('guest scope accepts only the two known nonroot accounts under exact disposable KVM identity', () => {
  const guest = {platform: 'linux', hostname: 'volparossa-alpha', username: 'volparossa', uid: 123, virtualization: 'kvm'};
  assert.equal(guestAllowed(guest), true); assert.equal(guestAllowed({...guest, username: 'vpci'}), true);
  for (const change of [{username: 'root'}, {uid: 0}, {hostname: 'developer'}, {virtualization: 'none'},
    {virtualization: 'docker'}, {platform: 'darwin'}, {username: 'other'}]) assert.equal(guestAllowed({...guest, ...change}), false);
});
