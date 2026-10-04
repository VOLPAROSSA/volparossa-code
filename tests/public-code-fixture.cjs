// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Actual framed Unix socket, synthetic core/worker receipts only. No inference.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {CooperativeDelegation, createPublicCodeSnapshot} = require('../src/cooperative-delegation.cjs');
const {reply} = require('./conversation-fixture.cjs');
const sha = text => createHash('sha256').update(text).digest('hex');
const INPUT = {question: 'Return the complete corrected public file.', context: 'export const value = 1;\n',
  license: 'GPL-3.0-only', public_content: true, rights_confirmed: true};
function caps(profile = 'qwen3-0.6b-v1') {
  return {visibility: 'public_cooperative', network_access: true, private_data_supported: false,
    public_cache: true, training: false, cloud_fallback: false, retained_public_receipts: true,
    remote_erasure_guaranteed: false, model_execution_proven: false, model_profile: profile,
    max_question_bytes: 512, max_context_bytes: 4096, max_request_bytes: 32768, max_response_bytes: 65536,
    execution_slots: 1, max_connections: 8, max_retained_tasks: 32, retained_bytes_admission_limit: 268435456,
    max_seconds: 600, max_task_seconds: 1800, quarantined: false,
    code_proposal_v6: true, output_contract: 'single_file_replacement_v1'};
}
function result(input = INPUT, profile = 'qwen3-0.6b-v1') {
  const large = profile === 'qwen3-4b-instruct-2507-v1';
  const model = {model_id: large ? 'Qwen/Qwen3-4B-Instruct-2507' : 'Qwen/Qwen3-0.6B',
    model_revision: large ? 'cdbee75f17c01a7cc42f958dc650907174af0554' : 'c1899de289a04d12100db370d81485cdf75e47ca',
    base_weights: {bytes: large ? 8044982000 : 1503300328,
      sha256: large ? '79f6bbc34572c0063d12022f0f93074d90bbcd5dfd82134423bf892f7f8df3cf'
        : 'f47f71177f32bcd101b7573ec9171e6a57f4f4d31148d38e382306f42996874b'}, adapter_files: null};
  const fingerprint = sha(JSON.stringify(model));
  const output = {sample_index: 0, text: 'export const value = 2;\n', text_truncated: false, generated_tokens: 12,
    generation: {version: 1, stop_reason: 'eos', max_new_tokens: 1024, model_profile: profile}};
  const report = {mode: 'public_code_proposal', status: 'ok', purpose: 'code_proposal',
    output_contract: 'single_file_replacement_v1', public_data_only: true, private_data_supported: false,
    model_weights_loaded: true, updates_completed: 0, artifacts: [], better_answers_claimed: false,
    network_policy_changed: false, generation_policy: 'greedy_v1', proposal_complete: true,
    model: {id: model.model_id, revision: model.model_revision}, outputs: [output],
    dataset: {version: 6, visibility: 'public', license: input.license, purpose: 'code_proposal',
      output_contract: 'single_file_replacement_v1', sha256: 'd'.repeat(64), source_manifest_sha256: 'c'.repeat(64),
      source_sha256: sha(input.context), source_bytes: Buffer.byteLength(input.context), inference_examples: 1}};
  const binding = {job_id: '1'.repeat(32), dataset_manifest_id: 'e'.repeat(64), dataset_sha256: 'd'.repeat(64),
    model_fingerprint: fingerprint, row_indices: [0], expires_unix_seconds: 2000000000};
  return {version: 1, operation: 'public_code_proposal', purpose: 'code_proposal', output_contract: 'single_file_replacement_v1',
    visibility: 'public', model_profile: profile, source_sha256: sha(input.context), source_bytes: Buffer.byteLength(input.context),
    source_manifest_id: 'c'.repeat(64), dataset_sha256: 'd'.repeat(64), dataset_manifest_id: 'e'.repeat(64),
    provider_keys: ['a'.repeat(64)], model_fingerprint: fingerprint, execution_complete: true, proposal_complete: true,
    cleanup_confirmed: true, private_data_supported: false, remote_erasure_guaranteed: false, outputs: [output],
    receipt: {version: 1, handle: {version: 1, provider_key: 'a'.repeat(64), binding, capabilities: {
      model, model_fingerprint: fingerprint, public_inference_only: true, code_proposal_v6: true, runtime_slots: 1, max_rows: 1}},
    status: {binding: structuredClone(binding), state: 'complete', cancellation_requested: false,
      report_json: JSON.stringify(report), report_sha256: sha(JSON.stringify(report)), error: null}, verified_at_unix_seconds: 1900000000}};
}
function updateReport(value, change) {
  const report = JSON.parse(value.receipt.status.report_json);
  change(report); value.outputs = structuredClone(report.outputs); value.proposal_complete = report.proposal_complete;
  value.receipt.status.report_json = JSON.stringify(report);
  value.receipt.status.report_sha256 = sha(value.receipt.status.report_json);
}
async function fixture(t, {input = INPUT, profile, change = () => {}, handler} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-code-proposal-'));
  const socketPath = path.join(directory, 'core.sock'), requests = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', bytes => {
      pending = Buffer.concat([pending, bytes]); assert(pending.length <= 65536);
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE()) {
        const size = pending.readUInt32BE(); assert(size > 0 && size <= 32768);
        const message = JSON.parse(pending.subarray(4, 4 + size)); pending = pending.subarray(4 + size);
        requests.push(message);
        if (message.operation.type === 'capabilities') reply(socket, message, 'capabilities', {capabilities: caps(profile)});
        else if (handler) handler(socket, message);
        else {
          assert.equal(message.operation.type, 'public_code_proposal');
          const value = result(input, profile); change(value);
          reply(socket, message, 'admitted'); reply(socket, message, 'result', {result: value});
        }
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve)); await fs.chmod(socketPath, 0o600);
  const client = new CooperativeDelegation(socketPath), snapshot = createPublicCodeSnapshot(input);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await client.close().catch(() => {}); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, {recursive: true, force: false});
  });
  await client.connect();
  return {client, snapshot, socketPath, requests, execute: (signal) => client.execute({snapshot, tool_call_id: 'original_owner_call', signal})};
}
module.exports = {fixture, result, caps, INPUT, updateReport, sha};
