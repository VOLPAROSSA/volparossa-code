// SPDX-License-Identifier: GPL-3.0-only
// Explicit synthetic-workspace policy, not a general editor approval policy.
'use strict';
const {createHash} = require('node:crypto');
const MODEL = 'qwen3-0.6b-v1';
const PROJECT = '/opt/work/project';
const PROMPT_SHA256 = 'ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807';

function modelCatalog(instructions) {
  if (Buffer.byteLength(instructions) !== 20903 || createHash('sha256').update(instructions).digest('hex') !== PROMPT_SHA256) {
    throw Error('native_prompt_mismatch');
  }
  return {models: [{slug: MODEL, display_name: 'VOLPAROSSA Qwen3 0.6B', description: null,
    supported_reasoning_levels: [], default_reasoning_level: null, shell_type: 'unified_exec',
    visibility: 'list', supported_in_api: true, priority: 1, upgrade: null,
    model_messages: {instructions_template: instructions}, include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: false, default_reasoning_summary: 'none',
    support_verbosity: false, default_verbosity: null, apply_patch_tool_type: null,
    truncation_policy: {mode: 'bytes', limit: 65536}, context_window: 32768, max_context_window: 32768,
    effective_context_window_percent: 95, experimental_supported_tools: [], input_modalities: ['text'],
    tool_mode: 'direct', use_responses_lite: false}]};
}

function runtimeSettings(baseUrl) {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1$/.test(baseUrl)) throw Error('provider_scope');
  return [`model="${MODEL}"`, 'model_provider="volparossa"', 'model_catalog_json="/opt/catalog.json"',
    'model_providers.volparossa.name="VOLPAROSSA"', `model_providers.volparossa.base_url="${baseUrl}"`,
    'model_providers.volparossa.env_key="VOLPAROSSA_PROVIDER_TOKEN"',
    'model_providers.volparossa.wire_api="responses"', 'model_providers.volparossa.requires_openai_auth=false',
    'model_providers.volparossa.supports_websockets=false', 'model_providers.volparossa.request_max_retries=0',
    'model_providers.volparossa.stream_max_retries=0', 'model_providers.volparossa.stream_idle_timeout_ms=610000',
    'model_reasoning_summary="none"', 'check_for_update_on_startup=false', 'analytics.enabled=false',
    'feedback.enabled=false', 'web_search="disabled"', 'mcp_servers={}', 'tools.update_plan.enabled=false',
    'tools.experimental_request_user_input.enabled=false', 'features.view_image=false',
    'features.code_mode=false', 'features.code_mode_host=false', 'features.multi_agent=false',
    'features.multi_agent_v2=false', 'features.apps=false', 'features.plugins=false',
    'features.tool_suggest=false', 'features.tool_search=false', 'features.shell_snapshot=false',
    'features.exec_permission_approvals=false', 'features.request_permissions_tool=false',
    'features.unified_exec_tty=false', 'shell_environment_policy.exclude=["VOLPAROSSA_PROVIDER_TOKEN"]'];
}

// Decode only the native shlex-joined display; this function never executes it.
function shellWords(text) {
  if (typeof text !== 'string' || text.length > 4096 || /[\0\r\n]/.test(text)) return null;
  const words = []; let value = '', quote = null, present = false;
  for (let at = 0; at < text.length; at++) {
    const c = text[at];
    if (quote === "'") { if (c === "'") quote = null; else value += c; }
    else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\') { if (++at === text.length) return null; value += text[at]; }
      else value += c;
    } else if (/\s/.test(c)) {
      if (present) { words.push(value); value = ''; present = false; }
    } else if (c === "'" || c === '"') { quote = c; present = true; }
    else if (c === '\\') { if (++at === text.length) return null; value += text[at]; present = true; }
    else { value += c; present = true; }
  }
  if (quote) return null;
  if (present) words.push(value);
  return words;
}

function commandKind(display) {
  const words = shellWords(display);
  if (!words) return null;
  let command = display;
  if (words.length === 3 && ['/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh'].includes(words[0]) &&
      ['-c', '-lc'].includes(words[1])) command = words[2];
  if (command === 'python3 -B /opt/fixture.py read') return 'read';
  if (command === 'python3 -B /opt/fixture.py test') return 'test';
  if (/^python3 -B \/opt\/fixture\.py edit '[ab0-9 ()+*/-]{1,80}'$/.test(command)) return 'edit';
  return null;
}

const APPROVAL_DENIALS = Object.freeze(['lineage', 'kind', 'item', 'cwd', 'command',
  'network', 'permissions', 'network_policy', 'order', 'budget']);

// Closed reasons only: never return commands, paths, IDs or permission contents.
function approvalDenial(params, threadId, turnId) {
  if (!threadId || !turnId || !params || params.threadId !== threadId || params.turnId !== turnId) return 'lineage';
  if (params.kind !== 'command') return 'kind';
  if (typeof params.itemId !== 'string' || params.itemId.length > 256) return 'item';
  if (params.cwd !== PROJECT) return 'cwd';
  if (!commandKind(params.command)) return 'command';
  if (params.networkApprovalContext) return 'network';
  if (params.additionalPermissions) return 'permissions';
  if (params.proposedNetworkPolicyAmendments) return 'network_policy';
  // The pinned native runtime also proposes an execpolicy rule for ordinary
  // commands. This is not an extra permission request: AppServer returns only
  // one-shot "accept"/"decline", never acceptWithExecpolicyAmendment or session
  // approval. Ignore the proposal; it neither authorizes nor changes a command.
  return null;
}

function authorize(params, threadId, turnId) {
  return approvalDenial(params, threadId, turnId) === null;
}

const TASK = `Fix the add(a,b) function in the synthetic fixture, then verify it. Do not guess its current source.
Use native exec_command, workdir ${PROJECT}, shell /bin/bash, login false, tty false, max_output_tokens 1024.
Only these command forms are authorized, one at a time:
1. python3 -B /opt/fixture.py read
2. python3 -B /opt/fixture.py edit 'EXPRESSION' (replace EXPRESSION with your arithmetic expression in a and b)
3. python3 -B /opt/fixture.py test
The edit helper writes exactly your proposed expression, not a predetermined repair. It accepts only arithmetic.
Read first, inspect the returned source, make the minimal edit, and run the actual tests. Finish only after tests pass.
Do not execute other commands, request escalation, alter tests, use network, or invent tool results.`;
module.exports = {MODEL, PROJECT, PROMPT_SHA256, modelCatalog, runtimeSettings, commandKind,
  APPROVAL_DENIALS, approvalDenial, authorize, TASK};
