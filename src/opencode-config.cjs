// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const VERSION = '1.18.34';
const COMMIT = 'aec0b9a6d8898f68f923aaf08b7306d931fd9d76';
const MODEL = 'qwen3-0.6b-v1';

// These settings require the recorded no-runtime-installs patch AND the outer
// network/mount sandbox. Upstream permission settings alone are not a sandbox.
function runtimeSettings({baseUrl, bearerToken, password, cooperative = false}) {
  if (typeof baseUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1$/.test(baseUrl) ||
      Number(new URL(baseUrl).port) > 65535 ||
      typeof cooperative !== 'boolean' ||
      ![bearerToken, password].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value))) {
    throw Error('opencode_configuration_scope');
  }
  const permission = {'*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
    task: 'allow', bash: 'ask', edit: 'ask', external_directory: 'deny'};
  if (cooperative) permission.volparossa_delegate_public = 'allow';
  const config = {
    model: `volparossa/${MODEL}`, small_model: `volparossa/${MODEL}`,
    enabled_providers: ['volparossa'], share: 'disabled', autoupdate: false,
    snapshot: false, plugin: [], mcp: {}, lsp: false, formatter: false,
    permission,
    agent: {
      build: {model: `volparossa/${MODEL}`, temperature: 0, permission},
      general: {model: `volparossa/${MODEL}`, temperature: 0, permission},
      explore: {model: `volparossa/${MODEL}`, temperature: 0,
        permission: {...permission, bash: 'deny', edit: 'deny'}},
    },
    provider: {volparossa: {
      name: 'VOLPAROSSA', npm: '@ai-sdk/openai-compatible',
      options: {baseURL: baseUrl, apiKey: bearerToken, headerTimeout: 620000, timeout: 650000},
      models: {[MODEL]: {name: 'VOLPAROSSA core conversation',
        limit: {context: 32768, output: 1024}, tool_call: true, reasoning: false,
        modalities: {input: ['text'], output: ['text']}}},
    }},
  };
  const env = {
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: '/opt/state/config', XDG_CACHE_HOME: '/opt/state/cache',
    XDG_DATA_HOME: '/opt/state/data', XDG_STATE_HOME: '/opt/state/state',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_SERVER_USERNAME: 'volparossa', OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EMBEDDED_WEB_UI: '1',
    OPENCODE_DISABLE_FFF: '1', OPENCODE_DISABLE_AUTOCOMPACT: '1', OPENCODE_PURE: '1',
    VOLPAROSSA_NO_RUNTIME_INSTALLS: '1',
  };
  return {config, env};
}
module.exports = {VERSION, COMMIT, MODEL, runtimeSettings};
