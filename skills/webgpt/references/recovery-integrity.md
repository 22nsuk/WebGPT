# Interrupted results and runtime ownership

Use alongside [operations-windows.md](operations-windows.md). This describes local
recovery evidence, not permission to install services, change ACLs, reset state,
execute delegated code, or restart a parent/browser automatically.

Implementation ownership, the read-limit inventory and deliberately different
state/streaming paths are documented in [file-read-contract.md](file-read-contract.md).

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

Presence-only notices and edit/delete gates use `lstat` on the same candidate
paths, without opening or hashing candidate bodies. Any directory entry, including
a dangling link or an oversized file, is enough to require inspection; metadata
errors other than `ENOENT` also remain blocking. This is a negative guard, not
result verification or permission to overwrite a candidate. Each call probes
again; no presence or integrity verdict is cached across requests.

Detailed reconciliation, offline diagnosis, explicit resubmission and conditional
collection retain their bounded content/type/hash checks. Reconciliation hashes
only the candidates needed for its selected task details; global active-task
notices need presence only. A candidate can still change after a probe, so this
is not a filesystem transaction or a guarantee of future absence. Result evidence,
input/token retention, read-only project access and recovery policy are unchanged.

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

Result verification, pending-candidate inspection and explicit candidate re-flushing read
at most 1 MiB plus one overflow-detection byte per snapshot. A file that grows after its
size check is rejected without reading its entire new contents. No oversized prefix is
hashed as a valid result, acknowledged or published. Existing candidates remain unchanged
and I/O errors keep the existing failure behavior. The shared bounded reader also serves
workspace/recovery snapshots and diagnostic reads, each with its existing limit; this
introduces no new size cap on the worker's committed task inventory. It is a byte-budget
bound, not a transaction, read-timeout, hostile-filesystem sandbox or total-heap guarantee.

## Windows replacement failure diagnostics

A failing Windows prepare/replace helper now returns only a bounded, versioned
envelope. The ordinary MCP error contains `WINDOWS_REPLACEMENT_FAILED`, the action,
last reported stage, diagnostic status, operation ID, `diagnosticSaved`, and
`recoveryReviewRequired=true`. A verified revision mismatch also retains the fixed
`file revision conflict` wording. No raw stderr/stdout, exception message, stack,
file path, process arguments or credentials are copied into this error.
This covers the Windows helper boundary, not a general redaction of every worker error.

The helper records at most four outer-to-inner exceptions using fixed type names
(or `unknown`), signed 32-bit `hresult` values and an explicit `NativeErrorCode` only
for `Win32Exception`. The Node validator accepts at most 4096 UTF-8 bytes and checks
exact fields, action/stage/reason combinations, numeric ranges and chain bounds.
The private evidence adds `win32Code` and `win32Source`: either `native_error_code`
or the exact `0x8007xxxx` error layout, `hresult_from_win32`. Other HRESULT low bits
are not decoded as OS errors. Null means unavailable, and `chainTruncated=true`
means deeper causes were not recorded. Even a mapped code identifies reported
error metadata, not the program holding a handle or a proven historical cause.

| Reported stage | What it locates | What it does not establish |
| --- | --- | --- |
| `read_request`, `read_source_acl` | Request decoding or source security-descriptor access. | That native replacement was attempted. |
| `create_private_stage`, `verify_stage_ownership` | Protected stage preparation or owner/group validation. | Ownership of a colliding stage, or permission to remove it. |
| `verify_source_revision` with `revision_conflict` | The helper's explicit size/hash mismatch check. | Which writer changed the source, or permission to overwrite it. |
| `native_replace` | The helper reached the File.Replace call site. | Native API completion, unchanged original bytes, or the exact OS cause. |
| `unknown` | No validated stage was received. | Success, a retryable error, or absence of partial changes. |

`diagnosticStatus` distinguishes `structured`, `missing_output`, `invalid_output`,
`oversized_output`, `output_limit`, `process_error`, `process_interrupted` and
`process_unconfirmed`. Truncated JSON is invalid output, not a partially trusted
envelope. Process failures preserve only a fixed code vocabulary (otherwise
`unknown`); they do not prove whether the child reached an API. No fallback parses
English error text or prints the original process error. A structured diagnostic
with reason `unknown` and no exceptions means the helper could not build details.

After the existing backup and prepared journal, a helper failure attempts exactly
one exclusive, flushed write of at most 4096 bytes to the private runtime's
`recovery/<task-id>/<operation>.diagnostic.txt`. Match its operation to the canonical
`<operation>.json` and original `<operation>.before.txt`, plus any workspace
`.webgpt-<operation>.tmp`. The diagnostic includes no file-content/status snapshot:
inspect the actual source, backup and stage separately with the existing type,
single-link, size and hash checks. These are observations, not a transaction.

The `.diagnostic.txt` suffix is intentionally not `.json` or `.json.tmp`:
`inspectRecovery` continues to scan only mutation journals, without treating
diagnostics as receipts or weakening validation of other JSON records. Windows
storage relies on the same configured private runtime ACLs as backups; POSIX
creation uses mode 0600. Do not grant access or change ACLs to get a diagnostic saved.
For manual inspection, first establish a regular, non-linked file within the bound.
Keep recovery evidence private and out of ordinary logs and PR attachments.

`diagnosticSaved=true` means that write/flush returned successfully, not that the
file is still intact or survives every storage failure. `false` can leave no file,
a preserved partial file, or a pre-existing entry; it does not erase any of them.
Diagnostic save failure leaves the original replacement failure authoritative,
without another retry, cleanup or global storage-state transition. In particular,
it cannot turn the edit into success, promote a prepared journal or clear quarantine.
The original backup, journal and any stage remain the primary recovery evidence.

Stop further writes for the affected task and compare the retained evidence before
deciding its disposition. File.Replace can fail after partial moves/metadata work;
an old `readonly=false` observation or ACL comparison does not identify the cause.

| Current target observation | Supervisor interpretation and next decision |
| --- | --- |
| Content SHA equals `beforeSha256` | Original content is present at observation time; do not infer that no intermediate operation occurred or immediately retry. |
| Content SHA equals `afterSha256`, but journal is prepared | Expected content is present without a committed mutation receipt. Do not promote the journal or bypass collection. |
| Missing, changed, wrong type, linked or unreadable | Preserve all candidates; investigate and obtain an explicit recovery decision. Never automatically overwrite with the backup. |
| Diagnostic missing or partial | Preserve primary evidence and report unavailable details; do not reconstruct an OS code or repeat the edit to obtain one. |

The affected task remains unable to write/delete or submit `completed`; it can
retain partial output through `failed`. Conditional collection still refuses
unresolved recovery. Other tasks remain usable. Do not use `/ack`, a replacement
token, journal initialization, deletion-then-copy, ignored metadata errors or a
blanket retry to bypass this uncertainty. Explicit cancellation/discard remains a
separate disposition, not successful collection or recovery of the original attempt.

Before deployment, run `scripts/windowsReplacementDiagnostics.test.mjs`,
`scripts/workspacePermissions.test.mjs` and `scripts/recoveryIntegrity.test.mjs`
under the repository's test workflow. The permissions suite reuses a real Windows
sharing lock and actual helper-startup SHA conflict, retaining source/backup/stage
and ACL/owner/group checks. Diagnostic tests distinguish synthetic error envelopes,
injected partial moves/storage failures, and actual Worker/MCP isolation/collection
checks from native OS reproductions. Non-Windows skips are not Windows passes.
Full repository/installed-layout and supported Node/Windows checks are still needed;
none of these tests establishes the cause of a past incident or measured speedup.

## Mutation journals are checked in both directions

Each applied journal must agree with its recorded state receipt, and each recorded
receipt must still have a matching applied journal. Missing, malformed, conflicting
or incomplete records block further edits and successful completion of the affected
task. Startup and live checks preserve the uncertainty; they do not infer or replay
file mutations. Unrelated tasks remain available. Edit/delete receipts also require
an intact original backup matching their recorded hash, as described in
[backup-safety.md](backup-safety.md). No deleted backup or history is reconstructed.

### Receipt matching cost

Recovery inspection still reads and validates journal and original-backup bytes on
every call. The worker indexes those validated receipts by operation ID only for
that inspection, then compares the complete receipt, including extra fields. It
checks both recorded receipts without matching journals and applied journals not
recorded in state. Duplicate state records are not collapsed; startup preserves
the first-match rule and reports conflicting evidence without overwriting it.
Recovery warning paths are unique in first-observed order at startup as well as
live inspection. This normalizes only `recoveryRequired`, not the `changes` array,
journal contents or original backups; a repeated path is not a separate conflict.

The index relies on `inspectRecovery()` accepting an operation only from its exact
`<operation>.json` filename. A copy under another name remains unresolved even
when its internal ID and receipt fields match; it cannot replace an indexed
receipt or supply a missing canonical journal. Tests exercise that producer
contract with actual files sorted before and after the canonical name.

Comparison-budget tests also require every operation to receive a full same-ID
comparison. Long-history negative cases preserve a matching prefix and reject
only the late mismatch, so reducing comparison counts by skipping verification
is not an optimization. These checks do not replace the normal byte validation.

Reconciliation uses one fresh recovery scan for each active task: its health
quarantine and selected task details share that scan's journal issues inside the
same synchronous response. Unselected active tasks still contribute to global
health, and selected terminal tasks are inspected independently. The temporary
map holds diagnostic paths only, not receipt contents or backup bytes, and is
created for each request. A transient scan failure is reported in both sections;
a later request rescans the files, without clearing sticky recovery quarantine.

This removes a duplicate journal/backup read, not the underlying byte/hash checks.
It does not promise the latest possible sample at response time: an external file
change after the scan may appear only on the next request. Reconciliation never
acknowledges work. Conditional collection and its post-commit observation each
continue to verify current evidence independently; they do not reuse this map.

This removes repeated full-array receipt searches, using temporary memory linear
in the history size. It is not an integrity cache, a new recovery policy or a
constant-time request guarantee. File reads/hashing, directory sorting, shared
state checks, conditional collection and the external-writer limits remain.

## Interrupted controller state stages

`state.json` is the committed task inventory; `state.json.tmp` is only a candidate.
The writer creates the stage exclusively instead of truncating an existing path.
A partial, different, linked or invalid stage is preserved and cannot replace the
committed inventory. Existing stages with group/other POSIX permissions are also
rejected; Windows still relies on the private runtime directory's configured ACLs.

Within the same live worker, an explicit transition may reuse a regular single-link
stage only when its bytes exactly match the proposed next state. The writer flushes
those bytes again before replacement. A repeated API payload is not necessarily
byte-identical state: registration can generate a new token/deadline, `/checked`
recomputes `nextCheck` from the current time, and another transition may change the
inventory. After a failed `/checked` publication, a later retry normally conflicts
with the retained candidate and requires the deliberate offline recovery below.
An `/ack` retry can remain byte-identical when the inventory is otherwise unchanged.
Do not retry unrelated actions to clear a conflict. Failed state publication does
not report success, retire tokens or publish
the proposed in-memory transition. Project edits and result bytes have separate
journals/commits and may already exist; inspect those rather than repeating them.

Startup refuses any remaining stage, including one beside an empty committed array
or a dangling symlink. It neither overwrites the candidate with older state nor
promotes the candidate automatically. `STATE_STAGING_CONFLICT` is non-retryable;
at startup it maps to storage exit 74, not a supervisor restart loop. While the
worker is running, `ready` and `reconcile` detect a remaining stage and report
`STORAGE_UNAVAILABLE` with `storage.code: STATE_STAGING_CONFLICT`. Read-only task
inspection remains available when committed state is intact. Unlike a per-task
result conflict, the shared state stage can block persistence for every task.

Before a new `write_file` or `delete_file`, the worker checks for an existing state
stage. Any stage (including an empty file, directory or dangling link), or an error
inspecting it, blocks the operation before project parent creation, backups, journals
or file changes. The same storage-failure path interrupts waits and marks readiness
unavailable. This is a shared persistence obstruction, so it blocks new file mutations
for all tasks, not just the task associated with an interrupted transition. Task/input
inspection and permitted file reads/listings remain available with valid committed state.

This preflight does not delete, parse or promote the candidate, and does not disable
the writer's explicit byte-identical controller retry. A caller may deliberately finish
the original transition within the same live worker only when the next state still
matches the candidate exactly; repeating a time-dependent `/checked` payload does
not guarantee that. Otherwise preserve the obstruction for offline recovery. Result
submission keeps its separate candidate-preservation/retry contract; it is not a new
project mutation. Do not treat a candidate or a successful probe as permission to replay
an edit. A storage failure first arising after this check can still leave an applied
project change with an uncommitted receipt; existing backups and journals remain necessary.
The preflight is not a cross-file transaction or a guarantee against concurrent OS changes.

For offline recovery, stop new dispatch and the worker/restart owner, then preserve
both state files, results and recovery records in the private backup. Compare the
candidate with committed state and the retained task/collection evidence. Have the
authorized supervisor resolve the uncommitted transition and preserve its disposition
before removing the stage from the active runtime path. Do not delete evidence,
rename a candidate over committed state, reset the inventory or replay edits merely
to get startup working. No automatic repair or persisted-state format migration is
introduced. Older workers can still truncate these candidates on restart or save.

## State and owner interruptions

Authenticated `wait`, `status`, and `tasks` verify state consistency at request entry.
An open long poll also rechecks state before returning its event or timeout response.
If state or its initialization marker changed externally, they return a non-retryable
`STATE_INVALID` error instead of a healthy-looking stale task inventory. Diagnostic
`ready` and `reconcile` remain available to report the failure. Detection is request-
based, not an instantaneous filesystem watcher; an already-open long poll can remain
open until its next event/timeout, when corrupted state must produce an error rather
than a normal snapshot. Public `/health` remains liveness only.

The initialization marker still requires the exact 28-byte `WebGPT state initialized v1\n`
sequence, and lock `owner.json` still has its 4096-byte ceiling. Their runtime readers
reject oversized metadata before opening the body and recheck the opened regular,
single-link file. Actual reads stop at the respective limit plus one overflow byte
(29 or 4097 bytes), even if the file grows after its size check. A truncated prefix
cannot certify initialization or ownership. The descriptor closes on success and
failure; no invalid file is rewritten or removed. Marker corruption remains
`STATE_INVALID`, uncertain ownership remains `LOCK_UNCERTAIN`, and marker I/O
failures retain their native error classification. An unreadable owner is not proof
of a dead process or permission to steal its lock.

These bounds apply only to the two small control-file formats, not `state.json` or
its staged task inventory. Missing-marker/legacy migration, live-owner checks,
dead-owner archival and explicit recovery rules are unchanged. No verdict is cached,
and the bound is not a read timeout or isolation from hostile filesystem races.
`scripts/runtimeMetadata.test.mjs` covers these limits with disposable files.

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
Run the repository's full `node tests/run.mjs` workflow and
platform-specific service probes before production deployment. The focused regression
file is `scripts/recoveryIntegrity.test.mjs`; it tests only disposable temporary data
and owned local child processes, without ChatGPT, DNS or service installation.

No persisted-state format migration is introduced. A code rollback still requires
stopping the new process and preserving runtime evidence; never pair old code with
an old state snapshot to hide new work. Older code does not enforce these new checks
and can overwrite uncommitted results, so resolve/preserve pending evidence first.
Do not enable infinite wrapper retries to turn a data error into a restart loop.

Relevant official contracts:

- [Windows ReplaceFile failure states and metadata](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)
- [Exception.HResult](https://learn.microsoft.com/en-us/dotnet/api/system.exception.hresult?view=netframework-4.8.1)
- [Win32Exception.NativeErrorCode](https://learn.microsoft.com/en-us/dotnet/api/system.componentmodel.win32exception.nativeerrorcode?view=netframework-4.8.1)
- [HRESULT_FROM_WIN32 mapping](https://learn.microsoft.com/en-us/windows/win32/api/winerror/nf-winerror-hresult_from_win32)
- [Node IPC disconnect](https://nodejs.org/docs/latest-v24.x/api/process.html#event-disconnect)
- [Node child-process exit, disconnect and kill behavior](https://nodejs.org/docs/latest-v24.x/api/child_process.html)
- [Node filesystem flags and flush behavior](https://nodejs.org/docs/latest-v24.x/api/fs.html)
- [HTTP retry semantics, RFC 9110 section 9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods)

File flush and rename do not establish a cross-file transaction or prove survival
of every power-loss/storage failure. Private ACLs and a cooperative filesystem are
still required; these checks are not an OS sandbox against hostile local races.
