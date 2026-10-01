# Native coding in the editor

The explicit **VOLPAROSSA: Run Native Coding Task (Private, Local)** command
connects the editor to the source-built open Codex app-server and the existing
VOLPAROSSA conversation service. The runtime may read and edit the chosen project
and execute approved tools. The extension does not contain a model or a second
peer scheduler, and does not supply a predefined repair or fabricate tool output.

This is a Linux development integration. Controller and launcher checks are not
proof of reliable model-driven coding or a native VS Code/VSCodium end-to-end
trial. The original selected-code advice commands remain available separately.

## Explicit setup

Prepare the [pinned runtime](RUNTIME_BUILD.md) and an existing same-owner private
VOLPAROSSA conversation service using the `qwen3-0.6b-v1` profile. Nothing is
downloaded or installed by this command. In **user settings**, configure:

```json
{
  "volparossaCode.privateSocket": "/absolute/private-directory/compute.sock",
  "volparossaCode.nativeRuntime": {
    "version": 1,
    "appServer": "/absolute/runtime-bundle/runtime/codex-app-server",
    "appServerSha256": "<SHA-256 from the verified build report>",
    "buildReport": "/absolute/runtime-bundle/BUILD_REPORT.json",
    "node": "/absolute/prepared-node/bin/node",
    "nodeSha256": "<SHA-256 of the explicitly prepared Node executable>",
    "upstreamPrompt": "/absolute/pinned-source/codex-rs/models-manager/prompt.md"
  }
}
```

Use canonical absolute paths and lowercase 64-character SHA-256 values, not the
placeholders above. The launcher verifies the exact upstream revision, source
tree, lockfile, declared patch, retained license/notice, executable hash and full
native prompt. A workspace setting cannot replace these machine-scoped inputs.
Runtime inputs must be owned by the current user or root and must not be writable
by group or others. Use a dedicated prepared bundle (executables `0700` or `0555`,
report and prompt `0400` or `0444`), rather than relaxing checks for a group-writable
source checkout. Keep the original pinned source and its notices unchanged.
The core socket must belong to the current user with mode `0600` in an owned
`0700` directory. Existing runtime/model installation remains the operator's
explicit action. System Python 3 and bubblewrap must already be available.

Open a trusted local project and invoke the command. In a multi-folder workspace,
choose one folder; the other folders are not implicitly included. Enter the task
and confirm the selected read/write scope. Opening the extension or workspace
alone starts no runtime, model or network participation.

## Execution and privacy boundaries

The selected project is mounted as `/workspace` inside a disposable Linux
sandbox. The sandbox has a separate network/PID/mount namespace, no host user
home or inherited credentials, and only the prepared runtimes, system runtime
files, exact private core socket and selected project. It does not change host
DNS, routes or firewall. Broad system directories and overlap with launcher
inputs are refused as projects. The core processes private input locally; no
public cache, training, remote peer or OpenAI fallback is enabled by this slice.

The native runtime's workspace sandbox and approval policy remain in force.
When it requests command approval, the editor shows the exact command and its
relative working directory. **Run once** grants only that request, not a session,
future rule, network access or wider filesystem permissions. Unsupported tool
approval kinds and privilege/network expansion are refused. Workspace content
and model output do not grant permissions.

The agent can modify real files in the selected folder. Changes are **not** rolled
back on cancellation or failure; inspect Source Control and run the relevant
project checks. Prefer a dedicated working branch. The frontend does not label
a completed native turn as a verified completed task. Generated output is shown
as plaintext rather than executable HTML or Markdown.

Cancellation is forwarded to the exact thread and turn, including cancellation
during turn admission. Closing the extension also closes its owned session.
The launcher waits for provider/runtime shutdown; forced stops or uncertain
cleanup remain errors, not successful completion. Runtime stderr, bearer secrets
and raw prompts are not exported as diagnostics. The frontend does not retain
a durable conversation; the final untitled text can be saved only by the user.

## Verification scope and remaining work

Focused tests cover actual frontend/controller logic with synthetic protocol
events: explicit launch, user-only settings, scope selection, one-shot approval,
early native notifications, cancellation, EOF, cleanup failure and no automatic
startup. Launcher tests separately exercise process and namespace construction.
They do not stand in for the outstanding native editor/model trial.

A separate local protocol probe has passed through the production launcher and
the actual source-built app-server: initialize, open an ephemeral VOLPAROSSA
thread, unsubscribe, EOF and confirmed runtime/provider shutdown. Its core socket
was **synthetic and capability-only**: no turn, inference or tool execution was
requested, and VS Code/VSCodium itself was not launched. The temporary selected
project and read-only runtime staging were removed; original runtime bytes/modes
and host network state remained unchanged. Earlier attempts stopped before the
protocol handshake: first on group-writable source inputs, then because the
launcher rejected bubblewrap's own `PWD=/workspace`. Dedicated private staging
and an exact namespace-local PWD check resolved those launch blockers without
relaxing input ownership or importing host environment settings.

A separate **actual VSCodium UI** probe also passed: F1/Command Palette, the
capabilities view, the native-task input box, the consent dialog and clicking
Cancel before runtime startup. There were zero automatic requests and exactly
one capability request to a synthetic capability-only service. The editor exited
normally; its private profile was removed and host network state was unchanged.
This is UI admission evidence, **not** native inference or coding evidence:
**Run once**, model-driven edits and the final task-result view remain unproven.

## Disposable guest UI trial

`scripts/smoke_editor_ui.cjs` drives the real editor UI; it does **not** start an
editor, model, core service or VM. Execution requires `--execute --yes`, Linux
hostname `volparossa-alpha`, user `vpci` and KVM virtualization. Do not run the
model trial on the development host or bypass these guards.

The supervising guest launcher must first provide:

- The source-verified native runtime, complete upstream prompt and notices,
  hash-verified Node 24 and VSCodium; reuse these assets, without downloading at
  launch. VSCodium **1.135.06055**, commit
  `1a46a584725d5dd330e0bcd7f5510f24990efcf2`, has actually opened a headless
  workbench with `--ozone-platform=headless`; this version needs no Xvfb.
- A **real** owner-private `qwen3-0.6b-v1` conversation service with verified model
  and Python-runtime provenance: two threads, 600 seconds per request, a 5 GiB
  memory cgroup, no swap and a 2,700-second service window. Preserve the worker's
  existing RSS/admission limits; an out-of-memory or admission failure is not
  permission to weaken them.
- An isolated network/PID/mount/IPC environment, empty account home, no host
  `DISPLAY`, Wayland, D-Bus or other host IPC mounts, and no inherited credentials.
  Use an ordinary unprivileged user; **never add `--no-sandbox`**. Keep the core
  socket and its parent at `0600`/`0700` and loopback CDP inside this environment.

The examples below assume that environment exposes this extension at `/extension`,
Node at `/opt/node`, and new owner-only directories under `/trial`. The project
must already be empty and mode `0700`, with a name such as `editor-ui-project-01`.
The reports directory must also be `0700`; output files must not already exist.

```sh
/opt/node /extension/scripts/smoke_editor_ui.cjs \
  --prepare-project --execute --yes \
  --project /trial/editor-ui-project-01 --output /trial/reports/prepare.json
```

Merge the explicit runtime/socket settings from the setup example into the
isolated profile's `User/settings.json`, alongside:

```json
{
  "window.dialogStyle": "custom",
  "workbench.startupEditor": "none",
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoCheckUpdates": false,
  "extensions.autoUpdate": false,
  "security.workspace.trust.enabled": false
}
```

The last setting is **only for this disposable, explicitly selected fixture**,
not a recommended user default. Custom dialogs and English UI are required for
the real DOM selectors. Start the prepared editor inside the same isolation:

```sh
/usr/share/codium/codium --new-window --ozone-platform=headless --disable-gpu \
  --disable-updates --disable-telemetry --disable-crash-reporter --locale=en \
  --user-data-dir=/trial/profile --extensions-dir=/trial/extensions \
  --extensionDevelopmentPath=/extension --skip-welcome --skip-release-notes \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  /trial/editor-ui-project-01
```

Once its workbench is ready, run from a separate supervised process:

```sh
/opt/node /extension/scripts/smoke_editor_ui.cjs --execute --yes \
  --cdp http://127.0.0.1:9222 --project /trial/editor-ui-project-01 \
  --output /trial/reports/ui.json --timeout-seconds 2400
```

The driver requires the unchanged prepared fixture, enters a real task, clicks
consent and approves only the bounded fixture commands. The model supplies the
edit expression. Success requires actual recorded read/edit/test actions,
unchanged helper code, a changed source file, an independent passing test and the
UI result displayed after runtime cleanup. The receipt contains closed statuses,
counts and hashes, not prompts, commands or private paths. **The full real-model
UI trial has not yet passed.** The parent supervisor still owns editor/core/VM
shutdown, private-profile/project removal and unchanged-host verification;
`ui.json` does not claim that broader cleanup.

The current prepared model is small; usable general coding quality is still to
be measured. Reviewable native diffs, durable multi-turn sessions, additional
tool types, broader platform support and eligible cooperative delegation remain
separate unfinished work. The core must own delegation and its privacy decision;
this local command must not silently publish a private project to peers.

Protocol reference: [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
