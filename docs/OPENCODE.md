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
current executor must advertise the exact `qwen3-0.6b-v1` conversation profile.
Python 3, bubblewrap and system runtime libraries must already be available.
No existing OpenCode/Codex profile is modified.

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

Supported message/tool history and call identities are preserved. Unsupported
inputs fail rather than being silently shortened or stripped. The provider waits
for core cleanup before returning SDK-compatible SSE or JSON; this is not
token-by-token model streaming. Exhaustion remains `length`, not successful `stop`.
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

## Real-model trial driver

`scripts/smoke_opencode_inference.py` prepares one explicit disposable Debian 13
KVM trial; it does not install or run the model on the development host. Its
`pack` mode captures each Code source/runtime file by hash and the exact core
archive `708bcdd2960ae019579b1c4ce6991ed57653050c`. A dirty source capture is
labelled as such, not attributed to an unchanged Git HEAD. The guest provisions
the pinned Qwen3-0.6B profile using the existing guarded core provisioner.

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

The actual runtime/model must read and edit a disposable Python project and run
its existing tests. A separate sandbox independently checks the result using
unchanged tests; a generated success message alone is not success. Only bounded
read/test commands and edits to the selected fixture can be approved. The reports
separate task execution, model provenance and guest/resource cleanup. Four
JavaScript and five Python driver checks pass; these checks and a successfully
packed source bundle are **not** evidence that the real-model trial passes.
