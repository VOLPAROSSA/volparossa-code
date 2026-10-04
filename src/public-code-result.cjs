// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Validate bindings from the protected, same-owner core. Core authenticated the
// peer and its original receipts; this is not a portable remote attestation.
const {createHash} = require('node:crypto');
const {isDeepStrictEqual: equal} = require('node:util');
const {check, keys, text, object} = require('./private-conversation.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && !/^0+$/.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const models = Object.freeze({
  'qwen3-0.6b-v1': ['Qwen/Qwen3-0.6B', 'c1899de289a04d12100db370d81485cdf75e47ca', 1503300328,
    'f47f71177f32bcd101b7573ec9171e6a57f4f4d31148d38e382306f42996874b'],
  'qwen3-4b-instruct-2507-v1': ['Qwen/Qwen3-4B-Instruct-2507', 'cdbee75f17c01a7cc42f958dc650907174af0554', 8044982000,
    '79f6bbc34572c0063d12022f0f93074d90bbcd5dfd82134423bf892f7f8df3cf'],
});

function validateCodeResult(value, input, caps) {
  keys(value, ['version', 'operation', 'purpose', 'output_contract', 'visibility', 'model_profile',
    'source_sha256', 'source_bytes', 'source_manifest_id', 'dataset_sha256', 'dataset_manifest_id',
    'provider_keys', 'model_fingerprint', 'execution_complete', 'proposal_complete', 'cleanup_confirmed',
    'private_data_supported', 'remote_erasure_guaranteed', 'outputs', 'receipt']);
  check(value.version === 1 && value.operation === 'public_code_proposal' && value.purpose === 'code_proposal'
    && value.output_contract === 'single_file_replacement_v1' && value.visibility === 'public'
    && value.model_profile === caps.model_profile && Object.hasOwn(models, value.model_profile)
    && value.source_sha256 === sha(input.context) && value.source_bytes === Buffer.byteLength(input.context)
    && value.execution_complete === true && typeof value.proposal_complete === 'boolean'
    && value.private_data_supported === false && value.remote_erasure_guaranteed === false);
  check(value.cleanup_confirmed === true, 'cleanup_unconfirmed');
  check(['source_manifest_id', 'dataset_sha256', 'dataset_manifest_id', 'model_fingerprint'].every(key => hex(value[key]))
    && Array.isArray(value.provider_keys) && value.provider_keys.length === 1 && hex(value.provider_keys[0]));
  const receipt = value.receipt;
  keys(receipt, ['version', 'handle', 'status', 'verified_at_unix_seconds']);
  check(receipt.version === 1 && integer(receipt.verified_at_unix_seconds, 1, Number.MAX_SAFE_INTEGER));
  const handle = receipt.handle, status = receipt.status;
  keys(handle, ['version', 'provider_key', 'binding', 'capabilities']);
  keys(status, ['binding', 'state', 'cancellation_requested', 'report_json', 'report_sha256', 'error']);
  check(handle.version === 1 && handle.provider_key === value.provider_keys[0]
    && status.state === 'complete' && status.cancellation_requested === false && status.error === null
    && equal(handle.binding, status.binding));
  const binding = handle.binding, peer = handle.capabilities;
  keys(binding, ['job_id', 'dataset_manifest_id', 'dataset_sha256', 'model_fingerprint', 'row_indices', 'expires_unix_seconds']);
  check(typeof binding.job_id === 'string' && /^[0-9a-f]{32}$/.test(binding.job_id) && !/^0+$/.test(binding.job_id)
    && binding.dataset_manifest_id === value.dataset_manifest_id && binding.dataset_sha256 === value.dataset_sha256
    && binding.model_fingerprint === value.model_fingerprint && equal(binding.row_indices, [0])
    // A completed, authenticated receipt may be collected during the core's
    // terminal retention grace. This does not renew execution authority.
    && integer(binding.expires_unix_seconds, 1, Number.MAX_SAFE_INTEGER));
  check(object(peer) && peer.model_fingerprint === value.model_fingerprint && peer.public_inference_only === true
    && peer.code_proposal_v6 === true && peer.runtime_slots === 1 && peer.max_rows === 1);
  const model = peer.model, [modelId, revision, weightBytes, weightSha] = models[value.model_profile];
  keys(model, ['model_id', 'model_revision', 'base_weights', 'adapter_files']);
  keys(model.base_weights, ['bytes', 'sha256']);
  check(model.model_id === modelId && model.model_revision === revision && model.adapter_files === null
    && model.base_weights.bytes === weightBytes && model.base_weights.sha256 === weightSha);
  // Match Rust's fixed ModelIdentity field order, not JSON map iteration order.
  check(sha(JSON.stringify({model_id: modelId, model_revision: revision,
    base_weights: {bytes: weightBytes, sha256: weightSha}, adapter_files: null})) === value.model_fingerprint);
  text(status.report_json, 32768);
  check(hex(status.report_sha256) && sha(status.report_json) === status.report_sha256);
  const report = JSON.parse(status.report_json);
  check(object(report) && report.mode === 'public_code_proposal' && report.status === 'ok'
    && report.purpose === 'code_proposal' && report.output_contract === 'single_file_replacement_v1'
    && report.public_data_only === true && report.private_data_supported === false && report.model_weights_loaded === true
    && report.updates_completed === 0 && equal(report.artifacts, []) && report.better_answers_claimed === false
    && report.network_policy_changed === false && report.generation_policy === 'greedy_v1'
    && !Object.hasOwn(report, 'input_adapter') && !Object.hasOwn(report, 'conversation')
    && report.model?.id === modelId && report.model?.revision === revision && equal(report.outputs, value.outputs)
    && report.proposal_complete === value.proposal_complete);
  const dataset = report.dataset;
  check(object(dataset) && dataset.version === 6 && dataset.visibility === 'public' && dataset.license === input.license
    && dataset.purpose === 'code_proposal' && dataset.output_contract === 'single_file_replacement_v1'
    && dataset.sha256 === value.dataset_sha256 && dataset.source_manifest_sha256 === value.source_manifest_id
    && dataset.source_sha256 === value.source_sha256 && dataset.source_bytes === value.source_bytes
    && dataset.inference_examples === 1);
  check(Array.isArray(value.outputs) && value.outputs.length === 1);
  const output = value.outputs[0];
  check(object(output) && output.sample_index === 0 && typeof output.text_truncated === 'boolean'
    && integer(output.generated_tokens, 1, 1024));
  text(output.text, 4096, false);
  keys(output.generation, ['version', 'stop_reason', 'max_new_tokens', 'model_profile']);
  const generation = output.generation;
  check(generation.version === 1 && generation.max_new_tokens === 1024 && generation.model_profile === value.model_profile
    && ['eos', 'token_limit'].includes(generation.stop_reason)
    && (generation.stop_reason !== 'token_limit' || output.generated_tokens === 1024));
  check(value.proposal_complete === (generation.stop_reason === 'eos' && !output.text_truncated && !!output.text.trim()));
  return value;
}

module.exports = {validateCodeResult};
