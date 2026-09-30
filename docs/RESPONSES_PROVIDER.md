# Local Responses → core conversation adapter

This executable adapter connects the open Codex runtime's HTTP Responses wire to
the **existing VOLPAROSSA private-conversation service**. It implements no model,
peer scheduler or tool executor. It is not a decentralized/private-peer inference
claim: this core operation explicitly advertises `private_local`, no network,
public cache, training or cloud fallback.

`src/private-conversation.cjs` negotiates the additive conversation handshake on
the same-owner, mode-0600 Unix socket. It reuses the original Q&A connection,
framing reader, owner checks and cancellation lifecycle; `private-compute.cjs`
is unchanged. Conversation-only request framing may use the separately negotiated
larger bound. No legacy Q&A request or response is rewritten.

## Explicit application-owned startup

Requiring the module or opening an editor starts nothing. An integrating local
application explicitly calls:

```javascript
const { startResponsesProvider } = require('../src/responses-provider.cjs');
const provider = await startResponsesProvider({
  socketPath: '/absolute/owner-private-directory/compute.sock',
  model: 'qwen3-0.6b-v1',
});
// Pass provider.baseUrl and provider.bearerToken directly to the explicitly
// launched local runtime. Keep the random token in memory, never in logs or Git.
// On application shutdown:
await provider.close();
```

The service binds only an ephemeral `127.0.0.1` port, exposes `POST /v1/responses`,
and requires its newly generated 256-bit bearer secret. This is **not an OpenAI
credential**. Host-header checks and rejection of Origin/Referer block browser
cross-origin use; there is no CORS, WebSocket, remote-listener or cloud route.
Same-user processes are not isolated adversaries. The adapter does not modify
Codex authentication, global configuration, user home or editor settings.

The endpoint permits one active request, eight connections, bounded headers and
body-read time, and at most 512 KiB request bodies. Actual model-specific limits
are narrower and checked without truncation. HTTP disconnect/shutdown requests
the exact core task's cancellation. The slot remains occupied until terminal
core cleanup or a bounded cleanup-uncertainty failure; an acknowledgement alone
is never presented as successful cleanup. No automatic retry occurs.

## Supported, lossless subset

Requests select the exact operator model, `store:false`, `stream:true`, and
`tool_choice:"auto"` when supplied. Instructions, ordered text-only messages,
function/custom calls and their correlated tool results are translated to the
core's typed history. Plain text parts are joined in their original order with
two newline separators; images, audio, binary attachments and unsupported item
types are refused. Original call IDs and explicit namespaces survive round trips.
Every historical call must refer to an offered tool and have exactly one matching
result before a later message. The adapter never silently drops old tools.

Function tools pass their object schema to the core as data; neither layer claims
arbitrary JSON Schema enforcement. `strict:true` is rejected. Literal custom
tools are supported; grammar formats are rejected rather than weakened. Namespace
descriptions are retained in each member's bounded description. A complete core
turn proposes at most one tool call, even when the request permits parallel calls.
The native tool harness still owns argument validation, approvals and execution.

The exact pinned Codex builder includes several optional transport fields even
for external providers. The adapter accepts these explicitly:

- `reasoning:{}` or no-thinking settings (`effort:"none"`, `summary:"none"`,
  `context:"current_turn"`); actual reasoning requests are refused.
- `include:["reasoning.encrypted_content"]`: there are no reasoning items to
  expand, so none are fabricated.
- Bounded `prompt_cache_key` and string-valued `client_metadata`: discarded in
  memory, never sent to the model, stored, logged or used as authority. No cache
  hit or telemetry service is claimed.
- Empty text controls, default service tier and optional usage-stream request.

Stateful response IDs, built-in hosted tools, structured-output constraints,
unknown options, ambiguous duplicate JSON keys and unsafe integer values are
explicit errors. No prompt, schema, tool result or model output is truncated.

## Model budgets and truthful completion

The SmolLM2 profiles remain unchanged: 135M uses 192 prompt / 64 output tokens;
360M and 1.7B use 1,024 / 256. **A normal Codex prompt does not fit these profiles.**
The core tokenizer remains authoritative and rejects oversize input.

The new explicit `qwen3-0.6b-v1` conversation contract reserves 12,288 prompt and
1,024 output tokens within a conservative 32,768-token model context. Its typed
input bound is 256 KiB, instructions 64 KiB, history 128 items and tools 32;
messages are at most 64 KiB, descriptions 8 KiB, and individual tool payloads
remain 4 KiB. Its conversation-only request frame is 512 KiB; response frames
remain 64 KiB and model output 4 KiB. These are advertised limits, not measured
memory usage or evidence that arbitrary projects fit. The adapter accepts the
exact core limits and does not raise them. Qwen history preserves system/developer
roles and ordering; Smol still rejects those roles.

Only a validated terminal core result with confirmed worker/staging cleanup can
produce SSE. Complete assistant/tool data emits the corresponding ordered item,
text/argument events and `response.completed`. This is buffered protocol
adaptation, **not** backend token-by-token streaming. `token_limit`, truncated
wire data and invalid generated syntax instead produce `response.incomplete`
with no executable output and never `response.completed`. A syntactically complete
tool proposal is not proof that the proposal is safe, correct or accomplished.

## Verification and source binding

Focused tests use real loopback HTTP and same-owner Unix framing with a clearly
synthetic protocol peer. They cover exact text/tool round trips, native-shaped
request metadata, a Qwen frame larger than 32 KiB without truncation, owner and
capability gates, cleanup-before-SSE, cancellation and incomplete/error handling.
The unchanged Q&A regression tests pass alongside them. These checks do **not**
execute a model, native Codex edit/test loop, editor integration or private peers.

```sh
node --test tests/private-conversation.test.cjs tests/responses-provider.test.cjs tests/private-compute.test.cjs
```

Interoperability targets the unmodified open Codex source
`67727e7cf114cf3e1b71db368d74b24e32f6cb12`: request construction in
`codex-rs/core/src/client.rs`, request schemas in `codex-rs/codex-api/src/common.rs`,
tool types in `codex-rs/tools/src/responses_api.rs`, and SSE consumption in
`codex-rs/codex-api/src/sse/responses.rs`. That parser treats incomplete reasons
other than `interrupted` as stream failures; this adapter never mislabels model
exhaustion as a successful interrupted response. The core's
`crates/volparossa/src/compute/private_conversation/WIRE.md` remains the authoritative
IPC contract. This is independently written GPL-3.0-only protocol glue; no upstream
source is copied here. Existing runtime provenance and notices remain unchanged.

The event/tool shapes were also checked against the official
[Responses streaming documentation](https://developers.openai.com/api/docs/guides/streaming-responses)
and [function/custom-tool documentation](https://developers.openai.com/api/docs/guides/function-calling).
Only the explicitly described subset is implemented, not the entire hosted API.
