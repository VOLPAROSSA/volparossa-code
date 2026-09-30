# Open app-server runtime: explicit development build

This repository builds the **open** `codex-app-server` executable, not OpenAI's
proprietary editor extension. The exact source revision and Cargo lockfile are
recorded in [codex-runtime.json](../third_party/codex-runtime.json). Every staged
source file is checked against its Git blob at that revision. The upstream
checkout stays unchanged. The build snapshot receives exactly one recorded
[compatibility patch](../patches/codex-chatgpt-recursion-limit.patch): raise only
`codex-chatgpt`'s query recursion limit to 256. Original and patched file hashes
are both pinned; no other staged-source difference is accepted.

The preparation script never installs software, starts Codex, reads the owner's
Codex authentication/configuration, or performs inference. It requires an
already-present source checkout and the separately verified workspace-only Rust
1.98.1 provision. Upstream specifies Rust 1.95.0; use of 1.98.1 is recorded as a
candidate compiler, not disguised as the upstream toolchain.

```sh
python3 -B scripts/build_codex_runtime.py --build --fetch \
  --toolchain /absolute/workspace/path/stalwart-rust-1.98.1
```

`--fetch` explicitly permits Cargo to fetch only the lockfile's checksum-bound
registry packages and exact-revision Git dependencies into a **private workspace
cache**. Without it, dependency resolution is offline. No credentials or global
Git/Cargo configuration are supplied. Compilation is always offline in a
bubblewrap network namespace, with source files and host filesystems read-only,
owner homes hidden, and only the new build state writable. No `HOME` or
`CODEX_HOME` override is used.

Upstream's protocol-generation step invokes the **bundled `protoc` build tool**
from exact Cargo.lock-checksummed `protoc-bin-vendored` 3.2.0 packages. It is not
compiled from source by this recipe. Its archive and executable hashes are
[recorded explicitly](../third_party/codex-build-tools.json); there is no
secondary unpinned download or host installation. This is distinct from claiming
that the app-server executable itself was downloaded prebuilt.

The build uses at most two CPUs/jobs, disables incremental artifacts and debug
symbols, limits fetch/build time and artifact growth, and records separate
receipts/log hashes. An explicit `--resume` can reuse the same state only when
source, compiler, pins and build settings still match. The original failed build
can explicitly migrate using `--resume --apply-compatibility-patch`; its old
ownership/source record is retained alongside the new patched record. This does
not overwrite an already staged runtime or authorize arbitrary new patches.

Outputs are ignored under `build/codex-runtime/`:

- `source/`: the verified source snapshot plus the single recorded compatibility
  patch, with its original notices.
- `cargo/`, `target/`, `tmp/`: private build inputs and intermediates.
- `notices/`: unchanged upstream LICENSE/NOTICE and dependency notice inventory.
- `runtime/codex-app-server`: created only after a successful build.
- `BUILD_REPORT.json`: source tree/lock/compiler binding and actual binary hash;
  explicitly distinguishes **built** from **executed** or **inference proven**.

The notice inventory retains available originals and license metadata. It is not
a complete redistribution review. This development build also does not claim
bit-for-bit reproducibility, a complete auxiliary-tool package, or a working
coding model. Native lifecycle and real provider/tool-loop proofs are separate.

## First build observation

On 2026-09-30, the locked Linux dependency fetch and offline metadata/notice
staging succeeded. The actual unmodified app-server build with the workspace
Rust 1.98.1 candidate stopped in `codex-chatgpt`: rustc reported a query recursion
depth overflow while computing the layout of `connectors::list_connectors`.
The build exited 101 after 465.385 seconds. Its log SHA256 is
`0a48271faea0ef339297e42df23a8602e5f9570abe6cc82f96f4aed6b5305d8d`.

That attempt produced no app-server binary. The explicitly approved follow-up
retains compiler 1.98.1 and the dependency cache, applying only the compiler's
suggested recursion-limit change in the isolated build snapshot. The original
upstream remains unchanged. A successful patched build is reported only after
the executable exists and its hash has been recorded; runtime execution remains
a separate check.

The patched retry **succeeded**, reusing the cache and compiling offline in
50.307 seconds. The staged `codex-app-server` is 322,584,616 bytes with SHA256
`9635cc912ca720b1dd496ba34ca5be920ec46af4319d936a8aa5e59f57094e9f`.
`build/codex-runtime/BUILD_REPORT.json` records the source tree, original and
patched hashes, lockfile, compiler and executable; that report's SHA256 is
`4f510df2044c4daceff66decbd2146df91ea8d32a89fd380515f0f497a31d684`.
This recipe did not execute it or perform inference. Read-only ELF inspection
shows the Linux loader, libc, libm, libgcc_s, OpenSSL 3 and libcrypto 3 dependencies.

## Real native lifecycle observation

The subsequent `scripts/smoke_app_server.py` trial on 2026-09-30 **passes** with
the binary above and Node 24.19.0. The independent client actually initializes
the process, creates an ephemeral thread with the VOLPAROSSA provider, receives
`unsubscribed` for that exact thread and observes graceful exit zero. The test
sends no `turn/start`: **model inference, tool execution and a core-model
connection remain unproved by this trial**.

Execution uses fresh user, network, PID, mount, IPC and UTS namespaces. Existing
home/configuration paths are hidden, environment variables are cleared, and
neither `HOME` nor `CODEX_HOME` is overridden. The owned process is joined and
temporary configuration/state removed; host routes, DNS and network namespace
are unchanged. Only the bounded report remains under
`build/native-app-server-01/report.json`, SHA256
`3600919efef73eab71f67d524bf60cb8300325f4a70b258a0e5cca961df87185`.

To repeat explicitly with already verified workspace executables, choose a
**new** output directory under this repository's `build/` directory:

```sh
python3 -B scripts/smoke_app_server.py \
  --app-server /absolute/workspace/path/codex-app-server \
  --app-server-sha256 VERIFIED_BINARY_SHA256 \
  --node /absolute/workspace/path/node --node-sha256 VERIFIED_NODE_SHA256 \
  --output /absolute/workspace/path/volparossa-code/build/new-native-trial \
  --execute --yes
```

Without `--execute --yes`, the script prints its plan without starting a runtime.
It never accepts an existing output directory or downloads a model.

Offline script checks (no dependencies, downloads or runtime execution):

```sh
python3 -B -m unittest discover -s tests -p 'test_build_codex_runtime.py'
```

The interface follows the [official app-server documentation](https://learn.chatgpt.com/docs/app-server),
with exact pinned source taking precedence where current documentation describes
a newer version.
