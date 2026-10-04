# Owner-selected verification and continuation

An OpenCode assistant ending a turn is not evidence that its code works. The
optional owner-verification route runs a fixed, explicitly approved check on the
current workspace after a normally completed native turn. A real failed check
can return its actual, bounded output to **the same native session**. The model
may then continue the original task; no particular answer, patch or tool call is
injected or required.

The original 40-minute task deadline, workspace scope, native permissions and
one-shot edit/command approvals remain in force across every continuation. The
owner selects a maximum number of checks before starting (default API limit:
three; maximum sixteen). An unavailable check, declined approval, cancellation,
runtime error or incomplete native response does **not** cause another turn.
The terminal native session is deleted once. Owner-side check cancellation and
runtime cleanup must be joined before the caller reports completion.

## Use from the owner CLI

Create a mode-`0600` JSON plan **outside** the model-writable workspace, containing
the explicit runtime inputs already required by [the OpenCode integration](OPENCODE.md).
The directories and runtime files must satisfy the existing launcher checks.
This example describes a Python project; choose the real check for your project.

```json
{
  "version": 1,
  "workspace": "/absolute/private/project",
  "runtime": {
    "version": 1,
    "opencode": "/absolute/pinned/opencode",
    "opencodeSha256": "<64 lowercase hexadecimal characters>",
    "buildReport": "/absolute/pinned/build-report.json",
    "node": "/absolute/pinned/node",
    "nodeSha256": "<64 lowercase hexadecimal characters>",
    "socketPath": "/absolute/private/core.sock"
  },
  "prompt": "Implement the requested change in this workspace.",
  "verification": {
    "executable": "/usr/bin/python3",
    "args": ["-B", "-m", "unittest", "-v"],
    "timeoutMs": 15000,
    "maxRounds": 3
  }
}
```

```sh
node scripts/run_opencode_task.cjs --preview --plan /absolute/private/owner-task.json
node scripts/run_opencode_task.cjs --execute --plan /absolute/private/owner-task.json
```

Preview does not launch OpenCode, a model, a check or network participation, and
does not print the private prompt. Execution requires an interactive terminal:
type `START` for the selected task, then `APPROVE ONCE` for each proposed native
write/command and each execution of the fixed owner check. Declining the check
leaves verification unavailable; it is not a failed test to retry. Control-C
cancels the task and joins cleanup. Private replies and proposals are shown only
to this owner terminal, not published as telemetry or exported as public proof.

The process exits `0` only after the selected check reports passed and cleanup
is confirmed, `2` for declined startup or a completed task with failed/unavailable
verification, and `1` for task/runtime/configuration/cleanup failure.

## Isolation and meaning of a pass

The verifier captures the executable and arguments before the model starts.
Only an owner-selected root-owned executable under `/usr/bin` is accepted. It
runs unprivileged in a separate bubblewrap user/PID/network namespace, with
read-only `/usr` and current workspace, temporary `/tmp`, a clean environment
and no model/core credentials or sockets mounted. A socket-denying seccomp
filter also blocks pathname Unix sockets that happen to exist in the workspace.
The command is never executed on the host or through native OpenCode `/shell`.

Checks that need network access, writable project files, host credentials or
dependencies outside these mounts are not supported by this first route. Setup
failure, signal termination, timeout or excessive output are unavailable, never
fabricated failures. A normal nonzero exit is a failed selected check. Combined
stdout/stderr is limited to 4096 bytes, and its complete JSON-escaped feedback
must fit the separate 8192-byte bridge limit. Exceeding either bound is
unavailable, not a truncated failure treated as actionable feedback. Feedback remains untrusted
data, and contains no permission to broaden the original task.

The result retains `taskVerified: false`. An optional separate
`verification: {status, checks, continuations}` describes **only** the selected
check. Passing project tests does not prove general task correctness, test
integrity, protected remote execution or completed network cooperation. In
particular, a model may edit a test in its authorized workspace: this route does
not turn mutable tests into an independent acceptance oracle.

## API and current integration boundary

`OpenCodeRuntime.run(prompt, {verify, maxVerificationRounds, signal, approve})`
accepts an owner callback. The inner runtime requests a numbered check with the
remaining original budget; it never supplies a command or success criterion.
`createWorkspaceVerifier({workspace, executable, args, timeoutMs, approve})`
provides the executable isolated implementation. The callback receives
`{round, remainingMs, signal}` and returns exactly `{status, feedback}`.
Only `failed` can continue; `passed` and `unavailable` terminate. Native summaries
must match completed owner receipts, and late receipts cannot revive a cancelled
operation. Existing callers with no verifier keep their previous one-turn API.

The owner CLI is wired end to end. The editor extension does **not yet** expose a
trusted verifier-selection/approval UI, so its existing route remains unchanged;
merely setting a model prompt does not enable verification. The real coding
trial now selects this verifier before runtime startup and checks the original
test-file identity before each execution. Its initial prompt, model, total time
budget, native approval quota and final independent acceptance check are unchanged.
Only the closed check status/counts are exported, never check output. Unit tests exercise protocol
and lifecycle with synthetic native dependencies; the separate actual bwrap
smoke proves isolated checks and cancellation, not model-guided coding success.

## Latest real model evidence remains a failure

The unchanged greedy-policy trial
[`37073231635`](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37073231635)
on Code `d6ec3146c646c89eb0f38992f9908accd969af92` failed: it observed one
completed native read, two core provider requests (one function-call result and
one assistant response), no edit/bash, an unchanged fixture and a failed final
independent check. Both core requests confirmed cleanup. This did not prove that
greedy generation fixes premature completion.

Owner verification was subsequently exercised with the real model in
[`37076283235`](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37076283235),
Code `40d89016c3e0155f054026c5553b5e8224b9cf9f`, with the same pinned core and
unchanged initial task and acceptance criteria. Three actual checks failed and
their feedback produced two continuations in the same session. The model made
one read call, no edit or test command, and left the fixture unchanged. The final
independent check failed. This proves that the verification/continuation path was
used, **not** that it repaired the task. The reported cleanup-accounting defect
and original artifact identity are recorded in [OpenCode trial evidence](OPENCODE.md#disposable-execution).
