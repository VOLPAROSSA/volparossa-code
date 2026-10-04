# Third-party provenance

Original code in this repository is GPL-3.0-only; see [LICENSE](LICENSE).

## OpenCode — selected foundation

OpenCode v1.18.34 is pinned to
[`aec0b9a6d8898f68f923aaf08b7306d931fd9d76`](https://github.com/anomalyco/opencode/tree/aec0b9a6d8898f68f923aaf08b7306d931fd9d76).
Its [original MIT license](third_party/opencode-LICENSE.txt) is retained unchanged.
[The source record](third_party/opencode.json) binds the upstream license, Bun
lockfile, config source and compatible provider version. The recorded
[patch](patches/opencode-no-runtime-installs.patch) disables implicit config-loader
dependency installation in explicit VOLPAROSSA mode. No upstream binaries,
generated SDK or dependency tree are committed. Redistribution must retain all
upstream/dependency notices. A pin does not prove model quality or peer privacy.

## Codex — historical experiment

The **open Codex CLI/app-server** is an Apache-2.0 project. This independent
protocol client was checked against commit
[`67727e7cf114cf3e1b71db368d74b24e32f6cb12`](https://github.com/openai/codex/tree/67727e7cf114cf3e1b71db368d74b24e32f6cb12).
[The pin](third_party/codex.json) records the checked schema and notice hashes.
No upstream runtime, generated bindings or implementation is bundled in Git.
An explicit workspace build now produces the app-server from that exact source,
with one [recorded recursion-limit patch](patches/codex-chatgpt-recursion-limit.patch).
The original upstream checkout remains untouched. The [build pin](third_party/codex-runtime.json)
binds original and patched source hashes, Cargo.lock and the workspace compiler;
the [build-tool record](third_party/codex-build-tools.json) identifies the
checksum-covered bundled protoc used for protocol generation. Original upstream
LICENSE/NOTICE and dependency notices are retained with the ignored build state.
See [the actual build and runtime observations](docs/RUNTIME_BUILD.md).
Future runtime redistribution must retain its original LICENSE, NOTICE and
dependency notices; an exact source pin alone is not a binary provenance check.

The proprietary Codex IDE extension is **not** copied, repackaged or relicensed.
This is an independent VOLPAROSSA project, not an OpenAI product or endorsement.
