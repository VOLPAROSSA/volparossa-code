# Native Codex → core → real coding trial

This additive development harness connects the **actual pinned app-server** to
the local Responses adapter and an already-running VOLPAROSSA Qwen conversation
service. The real trial now reaches the native runtime and model, but **a successful
native model-driven read/edit/test loop has not yet been observed**. Offline protocol/helper tests
are not a substitute for that result.

The ordinary extension and `AppServer` defaults remain unchanged: no automatic
runtime/model startup, read-only threads and declined tool approvals. An explicit
caller may select an exact advertised model and supply a per-command approval
handler. Only a thread in that caller's exact writable root receives workspace
write access. The test harness uses that opt-in for one synthetic project; it
does not add an automatic-approval mode to normal editor use.

## One small, real task

The model receives the entire original 20,903-byte Codex base prompt from commit
`67727e7cf114cf3e1b71db368d74b24e32f6cb12`, SHA256
`ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807`.
The explicit `qwen3-0.6b-v1` model catalog chooses native `exec_command` /
`write_stdin` tools and no reasoning or grammar-based apply-patch tool. Unsupported
grammar remains an error in the provider, not something silently stripped from a
tool definition. There is no shortened replacement system prompt.

The disposable project contains only `arithmetic.py`, whose `add` function is
incorrect. The model must choose actual native tool calls to:

1. Read that file through the read-only mounted fixture helper.
2. Supply its own bounded arithmetic expression for the helper to write.
3. Run three actual unit tests and finish the native turn.

The helper performs real I/O and tests. It does not generate a model response or
substitute a predetermined repair. Its three command forms are the only commands
the caller approves, bound to the exact thread, turn and working directory. The
caller declines session approvals, network requests, policy amendments, unknown
commands and file-change requests. Successful reads precede edits, and edits
precede tests. A separate post-turn test verifies the actual changed file again.

This narrow task is an interoperability test, **not** evidence of general coding
ability, free-form shell authority, editor integration or private distributed
inference. The core remains responsible for model execution, limits and cleanup.
No peer scheduler or secondary inference engine is introduced here.

## Explicit execution

Requirements: Debian 13/Linux with unprivileged bubblewrap namespaces, an existing
verified source-built app-server bundle including `BUILD_REPORT.json` and notices,
a verified Node 22+ executable, the pinned upstream prompt, and an explicitly
started same-owner Qwen private-conversation service. The script fetches, builds
and starts none of these dependencies. Its core socket and parent must be mode
0600 and 0700 respectively.

Choose a fresh output directory below this checkout's existing `build/` directory:

```sh
python3 -B scripts/smoke_native_coding.py \
  --app-server /absolute/workspace/codex-runtime/runtime/codex-app-server \
  --app-server-sha256 VERIFIED_BINARY_SHA256 \
  --build-report /absolute/workspace/codex-runtime/BUILD_REPORT.json \
  --node /absolute/workspace/node --node-sha256 VERIFIED_NODE_SHA256 \
  --upstream-prompt /absolute/pinned-source/codex-rs/models-manager/prompt.md \
  --socket /absolute/owner-private-directory/private.sock \
  --output /absolute/checkout/build/new-native-coding-trial \
  --execute --yes
```

Without `--execute --yes`, only validation and the action plan run. Actual execution
uses new user, network, PID, mount, IPC and UTS namespaces with all capabilities
dropped. Only system runtime files, the exact socket, verified runtimes, adapter
sources and synthetic state are exposed. The owner's home and Codex configuration
are absent; neither `HOME` nor `CODEX_HOME` is overridden. The app-server uses a
new in-memory loopback bearer secret, not an OpenAI credential, and that secret is
excluded from tool environments. Outside networking, telemetry, external tools,
cloud login and automatic retries are disabled.

The complete native task is bounded to 40 minutes and at most six accepted fixture
commands across at most two native turns. A normally completed turn is not proof
of a completed task: if observed read/edit/test actions are still missing, the
same thread receives at most one neutral continuation asking to finish the
original task. It does not supply an expression, command or answer. Failed,
interrupted or disconnected turns do not trigger continuation. Turn correlation,
approval ordering, the shared command budget and the original deadline remain in
force; neither budgets nor permissions reset for the second turn.
Every model request remains subject to the core's existing token, memory and
600-second execution bounds. The separate two-turn core KVM fixture currently
has a **1,400-second service window**, so this longer trial needs an explicitly
extended or separate service window; do not append it after that service stops.
Memory admission refusal, invalid model tools, token exhaustion or a missing
read/edit/test action fails the trial visibly. No reclaims, restarts, silent input
truncation or canned answers turn those failures into success.

## Evidence and cleanup

The original core [run 36913897403](https://github.com/VOLPAROSSA/volparossa/actions/runs/36913897403)
on `527e8ac35d9a0c0e461f76fac17e97ed10a93db9`, with Code
`7e35ba8d56df8ec43715119ceb0a1ae3f02f1f63`, successfully compiled and executed
the pinned native app-server and made two real private-model requests. One
response completed and one was incomplete; both confirmed worker cleanup. The
driver declined one command approval and accepted none, so no read/edit/test
action completed. The original closed receipt did not retain the rejection's
reason or private command text. It does not prove why approval failed or which
model-output condition caused the second incomplete result.

Runtime exit was graceful, private state and services were cleaned up, no OOM
occurred and host network state was unchanged. The original eight-file artifact
SHA-256 is `0389a4754bd08470e815b2e452089ee933010711ca4bd3ddb02c1a6dbae002b4`.
Preserve this as a failed coding trial, not a successful loop or evidence of
general coding ability.

A subsequent isolated, synthetic Responses protocol reproduction with the same
pinned native source observed a canonical read approval carrying
`proposedExecpolicyAmendment`. Every other exact fixture check matched; the
previous policy rejected the request solely because that proposal existed.
The local binary was `9635cc912ca720b1dd496ba34ca5be920ec46af4319d936a8aa5e59f57094e9f`,
not the CI binary. The protocol report SHA-256 is
`e58ea8b86b803821a1d7930e44a920c20ac2ccb2f12009c9da5ad252734af2dd`.
Every command in that reproduction was declined, the native runtime exited
cleanly, private state was removed and host network state was unchanged. This
is protocol evidence, not inference or command-execution evidence, and does
not reconstruct the original model's unretained approval payload.

The correction treats the offered execpolicy rule as a proposal, not extra
authority. Exact command, working-directory, thread/turn, action-kind, network
and additional-permission checks remain. The adapter still emits only one-shot
`accept` or `decline`, never session or persistent-rule approval, consistent
with the [official app-server approval semantics](https://learn.chatgpt.com/docs/app-server#command-execution-approvals).
Receipt version 2 adds only fixed denial-category counts (including ordering
and command budget), whose sum equals declined approvals; it never retains
commands, arguments, paths, identifiers or stderr. Historical version-1 receipts
remain readable. A fresh actual model-driven coding trial remains required.
The same isolated native protocol probe now evaluates the observed request as
authorized under the corrected policy, while still returning `decline` for the
probe itself: zero commands executed, clean native exit and unchanged host state.
That after-fix protocol report SHA-256 is
`1ba245d00f749c66ba1dd4af5500420d9be05c078d21f2db8fb8c57ba0d7abe6`.

The original [run 36925945880](https://github.com/VOLPAROSSA/volparossa/actions/runs/36925945880)
on core `ff2abe632a6779494301685014f89ec49aa2d259` / Code
`eb48696eb37afb9cda59bffc350845309b963dbb` now completes an actual native read:
one approval accepted, none declined, two real model responses completed and both
worker cleanups confirmed. The native turn ends normally **without editing or
testing**, so the task fails its actual-action assertion, before independent tests.
Elapsed time is 790,763 ms and service CPU usage 1,559,652,831 microseconds;
peak memory is 1,883,226,112 bytes with no OOM. No timeout or forced stop occurs,
private/runtime cleanup passes and host state is unchanged. The original eight-file
artifact SHA-256 is `6aafeaee20a247d05f0e334bad07ac630e810417719783f8c8d45138ac80abe4`.
The second response's text was not retained; these counters do not establish why
the model stopped or whether it attempted a tool in an unsupported text format.

Receipt version 3 therefore adds opt-in, closed per-response diagnostics: output
kind, prompt/generated token counts, completion/incomplete reason and elapsed
time from submission through confirmed cleanup, at most 16 records. Fixed native
completed-item type counters and started/completed turn counts distinguish model
text, tool proposals and actual command events. They never retain text, commands,
arguments, paths or identifiers. Historical version-1/2 receipts remain readable.
The bounded continuation and these diagnostics have offline controller/protocol
coverage, not a newly successful model-driven read/edit/test proof.

Success requires the actual app-server's command-completion events, changed file
hash, independent passing tests, at least four cleanup-confirmed real core
responses, exact thread unsubscribe and graceful runtime exit. Partial responses,
unexpected commands and uncertain cleanup cannot pass. The JSON report contains
closed statuses, counters and source/runtime/input hashes—not prompts, model text,
tool output, URLs or credentials. Runtime source/lock/patch provenance is checked
against the tracked build pin, and the original upstream notices remain intact.

The owned PID namespace is joined and the synthetic project, ephemeral app-server
home and temporary configuration are removed. Read-only before/after snapshots
must show unchanged host network namespace, routes and DNS. A surrounding KVM
fixture must independently account for its actual core/model service lifecycle.

Offline checks require no model or app-server execution:

```sh
node --test tests/app-server.test.cjs tests/native-coding.test.cjs tests/responses-provider.test.cjs
```
