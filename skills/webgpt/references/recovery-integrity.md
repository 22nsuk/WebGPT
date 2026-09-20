# Interrupted results and runtime ownership

Use alongside [operations-windows.md](operations-windows.md). This describes local
recovery evidence, not permission to install services, change ACLs, reset state,
execute delegated code, or restart a parent/browser automatically.

## A result file is not a committed result

`submit_result` publishes UTF-8 result bytes, then commits terminal task state.
An interruption between these steps can leave `<id>.result.txt` or
`<id>.result.txt.tmp` while the task still says `running`. Neither filename alone
proves completion, a successful callback, or collection.

The worker preserves both candidates. A different submission cannot overwrite
existing candidate bytes; invalid file types, links, oversized files and partial
candidates require inspection instead of truncation. A complete candidate whose
bytes match an explicit resubmission is flushed again before finishing the state
transition; a flush error must leave task state uncommitted.
The original status/summary may not have been committed: recover their intended
values from the retained chat/parent ledger and resubmit the original payload.
Only already-committed terminal state can enforce identical status and summary.
No automatic replay, acknowledgment, token replacement or journal repair occurs.

`client.mjs reconcile` includes `pendingResults` with observed paths, sizes and
SHA256 values or an unreadable classification. These hashes describe observed
bytes, not a verified terminal result. The command does not acknowledge or cancel
work. Its existing readiness check can create/remove a private probe file, but it
does not modify task state or result/journal evidence. `browserChecked` stays false.

For a running task with candidate evidence:

- `/ready` reports `RESULT_RECOVERY_REQUIRED`, `pendingResultTasks`, and
  `automaticRestartRecommended: false`.
- Scoped `/wait` reports only the requested tasks in `resultRecoveryRequired`.
  The matching client returns that notice rather than renewing an empty wait.
- Reads remain available, but further project writes/deletes for that task are
  blocked until the result is reconciled. Unrelated tasks are not blocked.

An explicit cancellation retires the task token without deleting candidate bytes;
reconciliation continues to show their need for inspection. A conflicting
candidate is not authorization to erase it. Preserve the original evidence and
let the authorized supervisor decide the disposition. A legacy runtime with no
state file but only a result temporary file must not be treated as a fresh runtime.

A duplicate submission for a terminal task verifies the saved artifact's current
path, regular single-link type, size and SHA256 before returning `accepted:true`.
Missing or changed bytes are an error, not permission to reconstruct the artifact
or bypass collection's integrity check. Once collected, its revoked token remains
revoked. Hash verification says nothing about the quality of work or reported tests.

## Mutation journals are checked in both directions

Each applied journal must agree with its recorded state receipt, and each recorded
receipt must still have a matching applied journal. Missing, malformed, conflicting
or incomplete records block further edits and successful completion of the affected
task. Startup and live checks preserve the uncertainty; they do not infer or replay
file mutations. Unrelated tasks remain available. Edit/delete receipts also require
an intact original backup matching their recorded hash, as described in
[backup-safety.md](backup-safety.md). No deleted backup or history is reconstructed.

## State and owner interruptions

Authenticated `wait`, `status`, and `tasks` verify state consistency at request entry.
An open long poll also rechecks state before returning its event or timeout response.
If state or its initialization marker changed externally, they return a non-retryable
`STATE_INVALID` error instead of a healthy-looking stale task inventory. Diagnostic
`ready` and `reconcile` remain available to report the failure. Detection is request-
based, not an instantaneous filesystem watcher; an already-open long poll can remain
open until its next event/timeout, when corrupted state must produce an error rather
than a normal snapshot. Public `/health` remains liveness only.

A responsive Worker launched with an IPC owner starts graceful shutdown if that IPC channel
closes, including during startup. Shutdown handlers are installed before startup's
first await. This avoids leaving an unmanaged child after the local launcher exits.
A normally started Worker without IPC is not tied to a browser or Codex process.
A hung event loop still needs separately authorized external supervision; an IPC
handler does not provide a watchdog or a Windows SCM integration by itself.
If force termination also kills the child process, graceful handlers cannot run;
the next launcher must verify the dead owner and recover its preserved stale lock.
Both paths must preserve the registered tasks and tokens.

## Transition and validation

Update the idle, identified worker and client together, including `results.mjs`.
Stop new dispatch, inventory and preserve owned unfinished work with the installed
revision's supported commands, then stop the worker and its restart owner before
swapping code. Follow the [transition and rollback procedure](operations-windows.md#parent-resume-transition-and-rollback)
for verified process exit, a consistent private backup and legacy command limitations.
Run the repository's full `node --test` workflow and
platform-specific service probes before production deployment. The focused regression
file is `scripts/recoveryIntegrity.test.mjs`; it tests only disposable temporary data
and owned local child processes, without ChatGPT, DNS or service installation.

No persisted-state format migration is introduced. A code rollback still requires
stopping the new process and preserving runtime evidence; never pair old code with
an old state snapshot to hide new work. Older code does not enforce these new checks
and can overwrite uncommitted results, so resolve/preserve pending evidence first.
Do not enable infinite wrapper retries to turn a data error into a restart loop.

Relevant official contracts:

- [Node IPC disconnect](https://nodejs.org/docs/latest-v24.x/api/process.html#event-disconnect)
- [Node child-process exit, disconnect and kill behavior](https://nodejs.org/docs/latest-v24.x/api/child_process.html)
- [Node filesystem flags and flush behavior](https://nodejs.org/docs/latest-v24.x/api/fs.html)
- [HTTP retry semantics, RFC 9110 section 9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods)

File flush and rename do not establish a cross-file transaction or prove survival
of every power-loss/storage failure. Private ACLs and a cooperative filesystem are
still required; these checks are not an OS sandbox against hostile local races.
