# OpenCode integration — development candidate

The selected foundation is OpenCode v1.18.34 at
`aec0b9a6d8898f68f923aaf08b7306d931fd9d76`. Codex scripts and reports are historical,
not an alternative implicitly selected by the editor.

## Explicit source build

On Linux amd64, with Python 3 and bubblewrap already installed:

```sh
python3 -B scripts/build_opencode_runtime.py
python3 -B scripts/build_opencode_runtime.py --execute
```

The first command only previews the work. The second downloads the pinned Bun
build tool, exact upstream source and frozen-lockfile dependencies inside ignored
`build/opencode-runtime/`. Dependency lifecycle scripts are disabled; compilation
runs without network access or access to the owner's files and credentials.
No tool is installed globally. An interrupted, unfinished build can be resumed
with `--execute --resume`; a finished report is not overwritten.

The tested headless build occupies about 3.1 GB. Its embedded web UI is intentionally
absent; reusing upstream web/mobile/desktop clients remains separate work. The
operator-owned `build-report.json` records the binary and source hashes. Supply
a separately provisioned, owner-controlled Node executable to the launcher;
the build script does not download Node or a model.

## Explicit native editor inputs

Set user-level, machine-scoped settings, not repository settings:

```json
{
  "volparossaCode.privateSocket": "/absolute/owned-private/compute.sock",
  "volparossaCode.openCodeRuntime": {
    "version": 1,
    "opencode": "/absolute/prepared/opencode",
    "opencodeSha256": "<actual executable SHA-256>",
    "buildReport": "/absolute/prepared/BUILD_REPORT.json",
    "node": "/absolute/prepared/node",
    "nodeSha256": "<actual Node executable SHA-256>"
  }
}
```

Use canonical owner-controlled inputs, not group/other-writable files. The build
report binds the upstream revision, lockfile, local patch, executable hash and
runtime version. It is an operator-owned build record, not independent release
authorization or evidence of model behavior. The launcher downloads nothing.

The core socket must be same-owner mode `0600` in a mode-`0700` directory. The
owner-selected executor must advertise one of the exact supported conversation
profiles below; the editor does not choose an arbitrary model or download one.
Python 3, bubblewrap and system runtime libraries must already be available.
No existing OpenCode/Codex profile is modified.

### Core-selected coding profiles

- `qwen3-0.6b-v1`: the unchanged default; native template
  `qwen3-tools-nonthinking-v1`, model context 32,768 tokens.
- `qwen3-4b-instruct-2507-v1`: the explicit larger profile; native template
  `qwen3-tools-instruct-2507-v1`, model context 262,144 tokens.

Both profiles keep the same bounded conversation allowance: at most 12,288 prompt
tokens, 1,024 new tokens, 4,096 output bytes and a 524,288-byte request envelope.
The larger model context does not enlarge the admitted prompt or authorize silent
truncation. The core remains responsible for exact token validation and resource
admission. Model quality and useful execution still require real-model evidence.

Before starting OpenCode, the owner validates the complete core capability reply,
including template, limits, private-local scope and negotiated `greedy_v1` policy.
That one model identity binds the native catalog, all agent roles, provider,
task/session checks and trial receipt. Each provider request checks the core again;
a different profile or incompatible result is refused, not silently substituted.
The existing version-1 ready bridge without a model identity is interpreted only
as its historical fixed 0.6B profile, never as 4B. Current owners report the actual
validated identity explicitly. Socket and orchestration tests cover these bindings;
they are not evidence of successful 4B coding or confidential peer execution.

## Execution path

```text
Editor scope and approvals -> bounded stdio bridge
  -> disposable Linux namespace owner
  -> authenticated OpenCode HTTP/SSE sessions
  -> authenticated loopback Chat Completions provider
  -> same-owner core conversation IPC -> current private-local executor
```

OpenCode HTTP and the model provider stay inside the disposable network namespace.
Only the selected project is writable as `/workspace`; configuration and session
state are temporary. Host routes, DNS and firewall remain unchanged. Upstream
permissions are defense in depth, not the OS sandbox.

The configured `build`, `general` and read-only `explore` agents use a compact
prompt for the current Qwen single-tool conversation interface. Each tool turn
must propose one offered call, then wait for its correlated result. This replaces
the pinned upstream default prompt, which explicitly requests parallel tool calls
that this core interface cannot represent. Workspace/approval permissions,
read/edit/test requirements and core-owned scheduling are unchanged. This prompt
alignment does not itself prove that the model can complete a coding task.

Supported message/tool history and call identities are preserved. Unsupported
inputs fail rather than being silently shortened or stripped. The provider waits
for core cleanup before returning SDK-compatible SSE or JSON; this is not
token-by-token model streaming. Exhaustion remains `length`, not successful `stop`.
Cleanup-confirmed invalid/truncated output or an unmet tool choice returns a
terminal HTTP 422, so the pinned SDK and OpenCode do not blindly regenerate that
unusable turn. Busy/execution/transport availability and uncertain cleanup remain
separate failures; this change does not make an incomplete answer usable.
An already reported, known terminal task failure is separate from runtime cleanup:
the task still fails, while a confirmed session/provider/process shutdown can
succeed. Unknown/protocol errors and any unconfirmed cleanup still fail closed.
The provider also counts cleanup for a correlated, admitted task ending with
the core's terminal `execution_failed` or `cancelled` response, or a valid result
that races local cancellation. These remain failed requests, not model results.
The receipt is retained per rejection inside the checked transport; an error code
alone, admission alone, a cancellation acknowledgement or a disconnect cannot
establish cleanup. This prevents a later native retry from turning a safely
reaped failed attempt into a false runtime-cleanup mismatch.
Cancellation reaches the core and owned session tree. Cleanup uncertainty remains
an error even when text was generated.

Only correlated one-shot bash/edit requests can be approved. Inspect proposed
changes and relevant tests: a completed native turn is not task-correctness proof.
Cancellation does not roll back existing edits. Background subagent mode is not
enabled until its extended lifecycle is supported.

## No implicit provider or installation fallback

Generated configuration enables only `volparossa`, disables sharing, auto-updates,
default/external plugins, LSP downloads and repository configuration, and inherits
no owner credentials. Upstream flags alone do not prevent background dependency
installation: the recorded `opencode-no-runtime-installs.patch` disables the config
loader's install when `VOLPAROSSA_NO_RUNTIME_INSTALLS=1`. Outer network isolation
remains mandatory; the launcher requires the patch in the build report.

## Network cooperation remains required

The public core broker currently performs signed-public-dataset text inference,
not private conversation/tool turns. It must not receive private OpenCode history
disguised as public content. The implemented `volparossa_delegate_public` tool
delegates an exact owner-authorized public snapshot through that broker and returns
the original result, tool-call ID and core task ID. It does not invent an execution
receipt or treat provider selection as proof that a peer executed anything.

To enable this development path, set `volparossaCode.publicSocket` in user settings
to a separately started, same-owner public-serve endpoint and run **OpenCode Task
with Enrolled Public Work**. This currently depends on core branch
`feature/browser-cooperative-compute`, inspected at
`610866b8770b63719ec1f4b4ce6abb6a83a596ef` (PR #178); it is not an interface supplied
by the current main branch. The private conversation service is still needed for
OpenCode's planning turns.

The editor captures and displays the exact public question (at most 512 UTF-8
bytes), selected excerpt (at most 4096 bytes) and supported license for explicit
rights confirmation. It does not rescan the project. Only a single-use proxy
socket enters the runtime namespace; the raw public service socket and its
general submission authority stay outside. The tool takes no model-supplied
content arguments. Private planning, tool history and other files do not become
public because the tool is enabled. Public disclosure cannot be reversed by
cancelling a task. Cancellation is propagated to the actual core task and cleanup
is awaited; incomplete results remain incomplete.

Remote conversation execution needs a suitable typed task family; confidential
execution additionally requires actual protection against the executing host.

Local subagents, TLS, split prompts, peer signatures and immune labels do not
prove that protection. Reuse upstream clients through the common provider, but
do not claim additional platforms tested here. The target remains cooperative
network execution and shared improvement, not a permanently local-only product.

## Evidence boundaries

Focused fixtures cover HTTP/Unix framing, tool identity, cancellation, public
snapshot enrollment, editor consent, child-session scope, late approvals, process
failure and cleanup. Python checks cover the builder and namespace proxy mount.
Model and OpenCode server responses in the unit fixtures are synthetic.

The separate native smoke uses the **actual source-built OpenCode process**,
production launcher, HTTP/SSE client and Chat Completions adapter, with only the
core/model responses simulated. It observes one approved command creating a
disposable file, correlated tool-result history on the next turn, final output
and session/process cleanup. It creates no real inference or peer-execution
claim. Run explicitly with an existing Node executable:

```sh
/absolute/node tests/real_opencode_smoke.cjs --execute \
  --node /absolute/node \
  --build-report /absolute/build/opencode-runtime/build-report.json
```

Its `native-smoke-report.json` is written beside the build record and is not
overwritten. The 2026-10-02 trial used Node v24.19.0 and the OpenCode binary with
SHA-256 `86b944fd0a279c7a24f7396e55aec0cca39685f5d32496a26941cec8ee2cc0bf`.

The actual-runtime terminal-error regression also passes: both `invalid_output`
and `wire_truncated` produce exactly one coding submission, no regeneration, no
tool approvals or project changes, and confirmed session/process cleanup. Core
outputs are deliberately synthetic; this does not explain the older VM03 failure
or prove real model-driven editing. Run without downloading a model:

```sh
/absolute/node tests/real_opencode_provider_errors.cjs --execute \
  --node /absolute/node \
  --build-report /absolute/build/opencode-runtime/build-report.json \
  --report /absolute/build/opencode-runtime/native-errors-terminal.json
```

The native cooperative smoke also passes with this actual runtime. Both complete
and incomplete answers traverse the trusted custom tool, single-use owner proxy
and public-core adapter. The next actual OpenCode model request contains the
original result and call IDs; a private sentinel is absent from public requests.
An approved sandbox check confirms that the limited proxy exists and the raw
public core socket is unavailable. Model and public-core replies remain simulated:
the report explicitly records `model_inference: false` and `peer_execution: false`.

```sh
/absolute/node tests/real_opencode_cooperative_smoke.cjs --execute \
  --node /absolute/node \
  --build-report /absolute/build/opencode-runtime/build-report.json
```

Its `native-cooperative-smoke-report.json` is separate from the local-tool report.
Neither report may be relabelled as real inference or immune-policy proof.
Actual model-driven coding, native editor UI operation, confidential peer
execution and full immune supervision remain unproved.

## Real public-core integration driver

`scripts/smoke_opencode_cooperation.cjs` uses the production OpenCode runtime and
enrolled proxy against an **externally supplied public-serve endpoint**, rather
than generating public-core replies. It runs only as `vpci` or `volparossa` inside
the explicitly identified disposable KVM guest. The launcher supports the exact
`volparossa` service account home by creating an empty namespace directory; it
does not expose the account's host files.

```sh
/absolute/node scripts/smoke_opencode_cooperation.cjs --execute --yes \
  --node /absolute/node --build-report /absolute/runtime/build-report.json \
  --public-socket /absolute/owner/public.sock \
  --snapshot /absolute/owner/public-snapshot.json --snapshot-sha256 EXACT_SHA256 \
  --project-parent /absolute/owner/new-projects --output /absolute/owner/new-report.json
```

The hash-bound JSON snapshot contains `question`, `context`, `license`,
`public_content: true` and `rights_confirmed: true`. Only the private planning
turns are synthetic, to exercise exactly one native delegation without claiming
model-driven planning. Success requires a complete original result naming at
least two execution providers, an unchanged tool-result round trip and confirmed
runtime/task cleanup. The report contains bounded status, IDs and hashes, not
the submitted text or answer. The parent topology must independently join these
to the real workers, retained receipts, protected traffic and VM cleanup. The
driver and its eight focused checks are **not a completed live-peer proof**.

The core's `agent-cooperative-code` disposable topology consumes an explicit
offline bundle rather than fetching or executing an unreviewed editor runtime.
Capture committed Code files and an already source-built OpenCode runtime:

```sh
python3 -B scripts/pack_opencode_cooperation.py --execute \
  --code-revision b3a4cfe79158d24e1dd61dcb56d37123f9d3d55c \
  --node /absolute/prepared/node \
  --build-report /absolute/build/opencode-runtime/build-report.json \
  --output /absolute/code-worktree/build/opencode-cooperative-inputs-01
```

The manifest binds all 25 source/runtime/license files by hash, size and mode.
The packer reads source blobs at the selected commit, not uncommitted changes,
and verifies the existing source-build record and pinned Node distribution. It
does not download or launch anything. Pass this new directory and the reported
manifest SHA-256 to the core VM runner with `--code-bundle` and
`--code-manifest-sha256`. Bundle capture and transfer are input preparation,
not proof of real model execution, peer success or private-task confidentiality.

## Real-model trial driver

### Requested generation behavior

OpenCode's `temperature:0` now requests the core's explicitly negotiated
`greedy_v1` policy. The adapter first sends `conversation_capabilities` with
`generation_policy_version:1`, requires the advertised policy, and binds the
result's `generation_policy` to the submitted input. Missing capability or
missing/conflicting result evidence is an error, not a sampled fallback.
An older ordinary conversation client can still use its unchanged handshake;
omitting the policy retains the core's previous profile behavior.

This corrects a real contract mismatch: the earlier adapter accepted zero
temperature while the Qwen worker used its default sampled 0.7/0.8/20 profile.
The fixed worker passes `do_sample:false,num_beams:1`; model, token budgets,
tool permissions, task and independent success checks remain unchanged.
Protocol/backend-double checks verify the wiring, not model quality. The earlier
[run `37066003771`](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37066003771)
remains failed: one completed native read, then an assistant stop, without an edit
or passing independent check. The mismatch is not a proven explanation for that
stop, and greedy generation does not guarantee a completed coding task.

### Disposable execution

`scripts/smoke_opencode_inference.py` prepares one explicit disposable Debian 13
KVM trial; it does not install or run the model on the development host. Its
`pack` mode captures each Code source/runtime file by hash and the exact core
archive selected by its explicit model profile. The default Qwen3-0.6B profile
retains core `845cc84d0d0b766ab1c5227231dbf6c8eaeb8cc3`; the separate
`qwen3-4b-instruct-2507-v1` candidate binds core
`39bfc0d14bd45563957c8a41e8183592e7ee7a73`. A dirty source capture is
labelled as such, not attributed to an unchanged Git HEAD. The guest provisions
only that pinned profile using the existing guarded core provisioner.

```sh
python3 -B scripts/smoke_opencode_inference.py
python3 -B scripts/smoke_opencode_inference.py pack \
  --core /absolute/core-at-required-revision \
  --node /absolute/prepared/node \
  --output /absolute/code-worktree/build/opencode-inference-inputs-01.tar.gz
python3 -B scripts/smoke_opencode_inference.py execute --yes \
  --core /absolute/core-at-required-revision \
  --tools /absolute/verified-workspace-vm-tools \
  --image /absolute/pinned/debian-13-genericcloud-amd64-20260826-2582.qcow2 \
  --bundle /absolute/code-worktree/build/opencode-inference-inputs-01.tar.gz \
  --output /absolute/code-worktree/build/opencode-inference-vm-01
```

Inputs must already exist and match their pins; output paths must be new. The
runner prints a no-execution preview without a mode. Actual execution requires
usable KVM, no other QEMU instance and at least 8 GiB of currently available host
memory. It owns a 6 GiB/two-vCPU headless guest in a bounded no-swap user cgroup;
it never closes the owner's applications or changes host routing/DNS/firewall.
The explicit 4B profile instead requires at least 14 GiB available host memory,
uses a 12 GiB/two-vCPU guest with a 13 GiB no-swap cgroup, and reserves a
40 GiB virtual disk with a 20 GiB provisioning budget. Select the same
`--model-profile qwen3-4b-instruct-2507-v1` for both `pack` and `execute`;
the larger profile does not replace the default or relax the coding task.

The actual runtime/model must read and edit a disposable Python project and run
its existing tests. A separate sandbox independently checks the result using
unchanged tests; a generated success message alone is not success. Only bounded
read/test commands and edits to the selected fixture can be approved. The reports
separate task execution, model provenance and guest/resource cleanup. Four
JavaScript and five Python driver checks pass; these checks and a successfully
packed source bundle are **not** evidence that the real-model trial passes.

The completed `opencode-inference-vm-03` attempt provisioned the real Qwen model
and observed five supervised worker results, but did not complete a native coding
turn, edit or test. Its original task error was obscured by a subsequent
`cleanup_unconfirmed` label; the guest units and QEMU were nevertheless stopped,
private state removed and host route/DNS snapshots unchanged. The current driver
preserves the first closed task-error category separately from session and runtime
cleanup failures, plus bounded provider result/error counters. It exports no raw
prompt, code, model answer or exception text. This diagnostic correction does not
turn the original failed trial into a pass.

The subsequent `opencode-inference-vm-04` trial used Code
`11a7063f178a3094c0d6f2d1052894f1fef8dc4a` and the same exact core revision. The real
Qwen worker reached an EOS-complete, non-truncated output that failed the strict
conversation decoder: one submitted turn, `invalid_output`, no retry and no
approved edit or test. The original `opencode_task_incomplete` error remained
visible; runtime cleanup was confirmed, guest processes/private state and QEMU
scratch were removed, and observed host routes/DNS were unchanged. The retained
closed diagnostics do not identify the malformed output shape; raw output was
not exported. The parallel-prompt conflict above is a verified integration issue,
**not a proven explanation of this particular failure**. Its correction still
requires a new real-model trial; VM04 remains failed.

The owner-verification trial
[`37076283235`](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37076283235)
on Code `40d89016c3e0155f054026c5553b5e8224b9cf9f` and core
`845cc84d0d0b766ab1c5227231dbf6c8eaeb8cc3` also **failed**. Three actual owner
checks and two same-session continuations ran, but only one native read completed;
no edit or test command was requested, the fixture was unchanged and the final
independent check failed. Five core requests produced one execution failure and
four results: one function call and three assistant responses. The report did not
export model text, so it does not establish why the model stopped without editing.

That original report also marks runtime cleanup unconfirmed: its provider counted
only the four successful-result cleanups, not the first admitted terminal
execution failure. The transport accounting correction above preserves that
failure while retaining its actual cleanup receipt. Socket/provider regressions
exercise the correction; they do not retroactively change the failed trial or
prove coding success. Guest private state and owned units were removed, QEMU was
joined and its scratch removed; the outer host route/DNS comparison was false,
so this run is not evidence of unchanged host state. Original artifact ZIP SHA-256:
`9ac899f449239debc07817df803216891639836c03e3b8533e71e315399eccf9`.

The first explicit 4B trial
[`37204436941`](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37204436941),
on Code `0295710c6e93bcdf989f5b1527f4ffde746ab16e` and core
`39bfc0d14bd45563957c8a41e8183592e7ee7a73`, **failed during model provisioning**.
The guest compiled the real core but never confirmed model installation or
started a coding task. Its closed report retains only `model-provision` /
`stage_failed`, not the failing provisioning operation; neither model quality
nor coding completion can be inferred from this attempt. Guest private state
and owned processes were cleaned up, QEMU was joined and its scratch removed.
The guest network snapshot matched, but the outer CI host's IPv6-route hash
changed; this is not proof of unchanged outer host state. Original artifact ZIP
SHA-256: `41e48432b0b36f409517895b3fbf47b0832d222c369187a797fdd9e77539ad98`.

Subsequent trials retain closed provisioning diagnostics: the substage, process
and HTTP status, fixed failure categories, and pin-validated ordered download
starts—not completed downloads. Raw logs, URLs and error text stay private and
are removed during cleanup. This does not establish the original failure's
cause or change any resource limit, coding task or success condition.

The manual `opencode-inference.yml` workflow adds an explicit GitHub-hosted
Ubuntu 24.04 host-tool profile for that same trial. It requires the dispatched
Code SHA, a clean checkout, the fixed core revision and newly verified runtime
inputs. The guest task is unchanged: actual OpenCode/core/Qwen must request
approved tool work, edit the disposable project and run its check. It is not
a mocked provider or a private-peer execution proof.

The workflow checks KVM and effective user-cgroup limits before source-building
OpenCode. Its default retains the 8 GiB admission threshold, 6 GiB/two-vCPU guest,
7 GiB cgroup, disabled swap and disposable cleanup. The explicit 4B choice uses
the separate source and resource profile described above. Only on the ephemeral CI host,
official packages and narrowly scoped KVM ACL/AppArmor changes are permitted;
the owned changes must be restored. Only closed provenance/result/cleanup
receipts are exported. The existing pinned Debian workspace-tool path is
unchanged. Focused offline contracts and shell/syntax checks pass; hosted
admission has been exercised, but actual coding completion remains unproved.

For pre-merge testing, the identical manual workflow file must first exist on
the default branch. Dispatch it on `feature/opencode-integration`, supplying
that exact reviewed commit as `expected_code_sha`; dispatching an unprepared
main branch cannot pass the source guard and must not install tools or launch
a guest. There is no automatic inference run on push or pull request.
