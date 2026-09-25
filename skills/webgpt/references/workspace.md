# Local files and completion

Use a working, authorized project connector already available in WebGPT. Otherwise this skill
includes a small MCP worker: `scripts/worker.mjs` + `workspace.mjs` (Node.js 22+). It exposes only
task lookup, supplied inputs, direct text-file read/write/delete, and completion submission—no Git,
shell, process control or account credentials. Text-only tasks can use it for completion events
without any workspace grant, or run without a connector using SKILL.md's backup checks.

For first use or missing connectivity, read [setup.md](setup.md). Use one worker for direct editing
and completion delivery; no separate callback receiver, arbitrary HTTP tool or shell in WebGPT.

## Per task

The parent imports `request` from the installed `scripts/client.mjs`, or uses the CLI with a local
JSON payload file. The client reads `controller.key` privately; never send that key to WebGPT.
Run the parent helpers in ordinary Node. Before registering browser work, run
`node <skill>/scripts/client.mjs dispatch preflight`; a browser REPL need not expose Node's
`process` or filesystem lifecycle. Keep browser actions in its authorized documented tool.

```text
node <skill>/scripts/client.mjs register <private-task.json>
```

Registration payload:

```json
{
  "id": "unique-task-id",
  "instructions": "Improve the onboarding docs for first-time users. Preserve compatibility notes. Success: concise updated files with focused checks, change receipts and any limitations.",
  "inputs": {}
}
```

Write `instructions` like a brief to a capable colleague: give the goal, relevant context, success
criteria and only material constraints. Do not paste the tool protocol below into each task. Within
the authorized request and workspace grant, WebGPT chooses the tools, implementation, checks and
useful next steps without routine reconfirmation.

For local files, add `"workspace":{"root":"/absolute/project","mode":"edit"}` to the payload.
The root is the permission boundary; no per-file lists or permission expansion are needed.
Use `mode:"read"` for review/analysis; omit workspace for text-only work. Concurrent workers may
share the project, with disjoint responsibilities coordinated in prompts. Revision checks reject
stale edits. Only the parent can choose the project root and mode.

Send the returned **task token** privately to its WebGPT worker.

Registration requires well-formed Unicode in `instructions`, every input name/value and
`workspace.root`. Valid UTF-8 JSON can still contain an escaped unpaired UTF-16 surrogate
(such as `"\ud800"`); those strings are rejected before task persistence or root resolution.
Do not automatically replace them with `�`: a changed name may be unreadable through the
tool contract, a changed root can select another directory, and different malformed strings
can encode to the same replacement-character bytes before hashing. This is an encoding
loss, not a SHA-256 collision. Normal Unicode, paired emoji, combining sequences, literal
backslash-u text, BOM, a deliberately supplied `�` and input NULs remain unchanged. No
Unicode normalization or new size limit is applied.

Older stored tasks are not rewritten or rejected at startup merely for these text fields.
`get_task` refuses malformed instructions/input names; `read_input` refuses a malformed
selected value for both full and ranged reads, without returning a digest or raw content.
Other tasks and valid selected inputs remain usable; controller inspection and explicit
cancellation remain available. Preserve the original private request/state and inspect its
source before correcting registration. A root already converted by an older worker cannot
be reconstructed from its stored canonical spelling. Update matching worker/workspace
scripts through the usual stopped-worker procedure; no state migration or automatic retry
is added. Registration rejection does not permit resending an earlier browser message.

If a registration response is lost, resubmit the exact payload with the same ID. An identical
running registration returns the original token with `duplicate:true` without renewing its deadline.
Different inputs, instructions, grants or a terminal task reject ID reuse. This is controller retry
handling, not permission to send the chat prompt twice. IDs are strings and cannot differ only by
case from an existing ID or be Windows device names (`CON`, `NUL`, `COM1`, etc.), because IDs become
result and recovery filenames. Other existing IDs and JSON payload shapes remain supported.

The project root cannot contain or be located inside the private worker data directory, including
its recovery subdirectories. Registration checks this, and file calls recheck it for older saved
grants. Keep projects and runtime data in separate trees. This
protects worker credentials and records, not arbitrary secrets such as a project's `.env` file.
The comparison resolves both roots through the native filesystem, including Windows short names;
saved grants are checked again on file calls. Ordinary short-path project grants and registration
retries remain supported when they refer to the same directory identity and access mode.


### Worker tool reference

This is the protocol available to the worker, not a sequence to copy into ordinary delegation prompts:

- `get_task(token)` returns instructions, input names and any workspace grant;
  `read_input(token,name)` reads a named string supplied in `inputs`. With no range
  arguments, the original `{name,text}` full response is unchanged. Optional `offset`
  (1-based line), `limit` (1–5000 lines) and `maxChars` (1–200000 UTF-16 code units,
  including line endings) use the same complete-line window as `read_file`. If any
  is supplied, omitted values default to 1 / 400 / 16000. The response also includes
  `sha256` of the **entire supplied string encoded as UTF-8**, `partial`, `startLine`,
  `endLine`, `totalLines` and `nextOffset`. The digest is not of the JSON envelope or
  returned excerpt and does not grant file access. Keep the same task/input identity
  and whole-input digest across windows; follow `nextOffset` until all context needed
  for the task has been read. Do not describe one page as the full original.
  CRLF, CR, LF, BOM, Unicode and supplied NULs are preserved, not normalized. A first
  line that exceeds the budget is rejected, not split or skipped; explicitly choose
  a larger allowed budget or a full read. Empty input has zero lines; unknown names
  and offsets beyond the input are errors. Names are exact input keys, never paths.
  Reads retain the current state/token checks and never acknowledge a task. This
  reduces returned context for selective rereads, not the shared-state verification
  or complete-input hash/line scan. It does not measure or promise model-token savings.
  Update the matching scripts (including `text-window.mjs`) through the normal idle,
  stopped-worker procedure and refresh the connector's tool schema before using the
  new optional arguments. Older workers reject them; there is no silent full-read
  fallback, new registration format or stored-state migration.
- When local files are needed and granted, `list_files(token,path,limit?,cursor?)` lists a directory
  (`.` for root, default/max 500 entries per page). When `truncated:true`, pass the returned
  `nextCursor` as `cursor` with the same path; continue until `truncated:false`. The cursor is opaque,
  scoped to the directory listing and not a permission grant. Changed names/types invalidate it;
  restart without a cursor rather than silently accepting an incomplete listing. `limit` is 1–500.
  Old calls without optional arguments keep their result shape for a non-truncated directory.
  `read_file(token,path)` gets text and SHA-256 (missing files return `exists:false`).
  Optional `offset` (1-based line), `limit` (1–5000 lines) or `maxChars` (1–200000 UTF-16 code units)
  enables a bounded window; omitted values then default to 1, 400 and 16000. Calls with none of
  these options preserve the full-file response. A window adds `partial`, `startLine`, `endLine`,
  `totalLines` and `nextOffset` (`null` at end). Empty files have zero lines and `endLine:0`;
  missing files keep `exists:false` without range metadata. An offset beyond the file is rejected.
  Complete lines retain their original LF, CRLF or CR endings. If the first requested line exceeds
  the character budget, increase it or use the full-file call; a line tail is never silently omitted.
  `sha256` always covers the **entire original file**, not the excerpt. Compare it between windows;
  restart reading after a revision change. Read the whole file before a replacement write so an
  excerpt is never mistaken for the full body. The 1 MiB/UTF-8/link/path checks still apply to the
  whole file, including bytes outside the returned window.
- For requested edits, `write_file(token,path,text,expectedSha256)` creates (`null` revision) or
  replaces a file using its read revision; `delete_file(token,path,expectedSha256)` removes a read
  file. These directly change local files; Codex does not apply a returned patch. No recursive
  deletion. Content is UTF-8, at most 1 MiB/file. MCP project-relative paths always use `/`,
  including on Windows. Drive-relative paths, NTFS stream syntax (`:`), and path components
  consisting only of dots/spaces are rejected before filesystem access on every platform.
- `submit_result(token,status,summary,result)` ends the task with status `completed`, `failed` or
  `cancelled`. Include the deliverable, any changed paths/receipts, checks and limitations;
  unexecuted checks are NOT_RUN. Submission saves the result, closes file access and removes backup
  checks, after which the worker stops.

With no workspace grant, only `get_task`, `read_input` and `submit_result` are available to the task.

The service rejects stale revisions, symlinks/hardlinks, traversal and Git metadata access; Git
remains the parent's responsibility. The same metadata-name check applies to every path component
and directory listing: case variants of `.git`, trailing dots/spaces, `GIT~1` and NTFS stream
aliases are protected on every platform. `.gitignore`, `.gitattributes`, `.gitmodules` and `.github`
remain ordinary project files. Existing components are also checked by their native filesystem
names, so an actual short alias such as `GIT~2` cannot select `.git` or a Git worktree pointer.
The root itself and its ancestors use the same metadata-name policy: do not register `.git`,
`.git/hooks`, or their protected aliases as a project. Registration checks both the named root
and its native target; every file-tool access rechecks retained grants, including a parent
alias redirected into metadata while the root directory identity stays unchanged. An invalid
root fails before file contents are read, parent directories are created, or mutation backups
and journals are written. A normal working-tree root containing a hidden `.git` child stays
usable, as do ordinary `.github`, `.git-notes` and `git~10` directories.

Older overlapping grants are retained, not silently cancelled or rewritten. Their file access
fails and readiness reports the workspace unavailable; task/input inspection, saved evidence,
independent work and explicit cancellation remain available. Retire the bad grant deliberately
and register the actual working-tree root. These checks extend the existing name-based rule;
they do not discover arbitrary bare repositories, custom `GIT_DIR` locations or every host alias,
and are not an OS sandbox against hostile concurrent filesystem changes.

Link checks precede canonicalization, and existing ancestors are checked before new files or
directories are created. Other project text files need no individual grant. Never
transmit secrets unnecessarily. Originals and operation receipts are retained under the private data
directory's `recovery/<task-id>/`; deletions are recoverable by the parent, never silently restored.
This is for cooperative developer workspaces, not isolation from hostile local filesystem races.
Read-only blocks changes, not disclosure: project text files can contain secrets. Use a sanitized
project snapshot or explicitly supplied inputs when unrelated credentials must remain inaccessible.

File, original-backup and mutation-journal reads enforce the 1 MiB limit with actual
bounded reads, not only an earlier file-size check. They read at most 1 MiB plus one
sentinel byte per snapshot and reject overflow; no prefix is returned as a complete file.
Optional line windows still validate and hash the whole bounded snapshot before selecting
lines. Empty files, UTF-8, CRLF and whole-file revision semantics are unchanged. A read
error does not authorize truncation, retrying a write or skipping recovery inspection.
This byte cap is not a read deadline or an atomic snapshot against concurrent writers.

### MCP request contract

Send tool invocations as JSON-RPC 2.0 requests with a string or safe-integer request ID and
object parameters. The task token is still required; the request ID is not authorization or an
idempotency key. Do not retry a write merely because its HTTP response was lost: read the current
file/revision and task receipts first. Unknown argument fields and invalid types are rejected using
the seven tools' existing input schemas. Tool strings must be well-formed Unicode. The local
controller is a separate API and retains its existing payload shapes.

The implemented protocol versions are `2025-03-26` and `2025-06-18`. Initialization negotiates a
supported version, and an unsupported `MCP-Protocol-Version` header is rejected. A `ping` request
returns an empty result without changing task state. Protocol notifications receive empty HTTP 202
responses; a transport cancellation notification does not revoke a logical task or undo an already
synchronous file operation. Use the controller's explicit task cancellation for that purpose.

Files/results remain limited to 1 MiB of decoded UTF-8. JSON escaping may use up to six wire bytes
per text byte, so MCP bodies are capped at 8 MiB including the envelope. Controller bodies remain
capped at 2 MiB. Invalid wire UTF-8 and tool strings containing unpaired UTF-16 surrogates fail
rather than being silently replaced. This is bounded request parsing, not a denial-of-service sandbox.

### Builds, tests and Git

WebGPT edits text through the file tools; it cannot execute tests, builds, package
installs, Git or interactive programs through this worker. State checks it could
not run as NOT_RUN. Codex reviews executable changes and runs relevant checks using
the project's verified workflow within the user's existing authorization. Return
the necessary failure output to the retained chat for a focused correction; if the
previous task has ended, register a new task token in that chat. Git integration
remains with Codex. Do not add shell access to resolve a missing verification step.
See [fork-policy.md](fork-policy.md) for execution risks and isolation requirements.

## Completion and lifecycle

Prefer a wait scoped to the task IDs owned by this batch:

```js
// Import from the actual installed script URL; no user-specific adapter is needed.
const { request, waitForTasks, collectTask } = await import(clientModuleUrl);
const notice = await waitForTasks(ownedTaskIds);
// Inspect a returned result and its relevant evidence before acknowledging it.
const collected = await collectTask(finishedTaskId);
```

CLI equivalents are `node <skill>/scripts/client.mjs wait <task-id> [task-id ...]` and
`node <skill>/scripts/client.mjs collect <task-id>`. Wait also accepts a private JSON file with
`{"ids":["task-a","task-b"]}` or `{"id":"task-a"}`. Invalid or unknown IDs fail, not widen the scope.

### Resume verification and collection

`request('reconcile')` is the raw controller snapshot. It does **not** perform local result-file
hash verification. Use `reconcileTasks(config)` or CLI `reconcile` for `integrity` and `attention`.
Use an explicit private configuration when more than one worker is installed.

After a saved result and its relevant changes/evidence have been reviewed, collection can resume:

```js
// Run with ordinary Node and the actual installed module URL/configuration.
const { configuration, reconcileTasks, collectTask } = await import(clientModuleUrl);
const config = configuration(); // WEBGPT_CONFIG selects the intended private worker.
const state = await reconcileTasks(config);
const owned = state.tasks.find(task => task.id === ownedTaskId);
// Inspect owned.attention and saved evidence; do not interpret integrity as code quality.
const result = await collectTask(ownedTaskId, config, { resume: true });
```

CLI: `node <skill>/scripts/client.mjs collect --resume <task-id>`. The existing `collect <task-id>`
remains strict and still rejects a result already collected. Resume verifies the retained artifact
again and returns `disposition`: `collected`, `already_collected`, `discarded`, or
`cancelled_without_result`. Discarded results stay discarded; a cancellation with no result is not
certified as a successful collection. Status, integrity, recovery warnings and `browserChecked:false`
remain explicit. Already retired tasks receive no new acknowledgment. Reconciliation may perform
temporary readiness probes; it does not alter retained task/result/journal evidence.

Running tasks, invalid state, missing/changed result bytes and unresolved recovery or pending-result
evidence do not authorize a new acknowledgment. Retired records may be returned with recovery
warnings for inspection. If an acknowledgment response is lost, resume checks controller state
once without replaying the write. `COLLECTION_UNCONFIRMED` means preserve the task and reconcile;
it never means register or send again. One parent should own collection: the legacy acknowledgment
endpoint is not a compare-and-swap operation against concurrent cancellation. Resume keeps the
controller's final discarded/retired disposition rather than inventing a second completion store.

Keep browser verification, saved-byte verification, collection/token retirement and tab cleanup as
separate checkpoints in the original private setup record. Re-running this command verifies and
collects only the result; it cannot prove a browser tool call occurred or close any tab.

Each HTTP wait is bounded to 55 seconds. The client renews empty waits without returning to the
model and stops on an event, a 15-minute backup check, a recovery signal, or `settled:true` for the
selected tasks. Neither interval expires a task. Old no-argument `request('wait')` and CLI `wait`
still return a single bounded global snapshot. Do not loop that global command for a private batch.
A client/worker protocol mismatch is an error: update the identified idle worker and client together
rather than repeatedly retrying or restarting active tasks.

- `events`: inspect the saved result, relevant output/diffs and supporting evidence, record its
  accepted/rejected/partial disposition, then call `collectTask(id)`. Collection checks the expected
  private artifact path, regular single-link file and SHA-256 before acknowledgment. A missing,
  changed or unexpected artifact remains unacknowledged. Failed/cancelled results stay failed/cancelled;
  byte integrity is not a quality verdict. Events persist until acknowledged, including across restarts.
- `backupDue`: check only each named running chat once, then `await request('checked', {id})`.
  If output is complete but its callback failed, save it and request a narrow `submit_result` retry.
  Never send a fabricated worker-success event. Identical terminal submissions are safe to retry;
  conflicting results are rejected.
- Acknowledgment revokes the task token and redacts its inputs/instructions from active state;
  supervisor cancellation does the same. Retained artifacts/recovery copies remain private evidence.
  Retries are valid only before acknowledgment, not with a retired token. The low-level `ack` action
  remains for compatibility; do not use it to bypass failed integrity checks.
- Abandoned tasks: stop their actual generation separately, preserve partial output and
  `await request('cancel', {id})`. Cancellation disables the registration, not the browser chat.
  For a terminal but uncollected task, this explicitly abandons collection: it revokes the token,
  redacts inputs/instructions and retires the event while preserving its original terminal status,
  summary, result path/hash, files and recovery records. Saved state has `discarded:true` alongside
  `collected:true`; here `collected` means queue retirement, and `discarded` records that collection
  was abandoned, not integrity-verified. Inspect and preserve a failed collection before choosing
  this path. Repeated cancellation preserves that disposition, and already collected tasks are
  unchanged. Cancellation neither repairs nor deletes a corrupt/missing result. A failed state save
  leaves the task and its token unretired until storage is repaired and cancellation succeeds.
- `await request('status')` is read-only and reports events/deadlines, not all running tasks.
  `await request('tasks')` or CLI `tasks` returns outstanding IDs, statuses, deadlines, project roots
  and modes, plus running/uncollected counts. It does not return tokens, instructions or input text.
  Use it for recovery and idle checks, not continuous progress polling. It is authenticated on the
  loopback controller only and is not an eighth MCP tool.
- CLI `ack`, `checked` and `cancel` accept a task ID or a JSON path containing `{ "id": "..." }`.
  `wait` accepts IDs or a JSON path with `id`/`ids`. A valid task ID wins over a same-named local file;
  use `cancel --file payload` or `wait --file payload` to read an explicitly named JSON file.
  Existing `.json` paths still work without the flag. Registration JSON is unchanged.

`waitForTasks(ids, config, {signal})` accepts an AbortSignal; aborting a wait only stops that caller's
HTTP requests, not task execution or deadlines. Keep the owned IDs for resumption or explicit
cancellation. Running a wait requires an active parent runtime; it is not a cron job or an
after-exit wake-up service. It reduces model-level empty polling, not all coordination costs.

Terminal tasks lose deadlines immediately, independent of collection/chat deletion. Remove collected
IDs from the next wait and end the wait when the batch is settled; never revive completed checks.
State and results survive restarts. Keep the shared worker and task/chat ledger for recovery.
Retain task chats by default, including setup tests and failures; close only their owned tabs after
collection per SKILL.md. Chat retention never delays acknowledgment, token revocation, cancellation
or removal of backup deadlines. Delete a chat only when the user explicitly requests deletion of
that chat.

State transitions are published only after the state-file write and replacement succeed. A failed
registration creates no phantom task; failed completion, acknowledgment, cancellation or deadline
updates do not publish that transition or retire access. Preserve the error and fix the underlying
storage issue before retrying. A result file may exist after a failed completion-state save; its
existence alone is not an accepted completion. Identical result retries are acknowledged only after
state was actually saved. Results are written through a temporary file before replacement.

A file edit can already have happened when saving its receipt fails. The worker immediately reports
`recoveryRequired` and blocks later edits and successful completion for that task, preserving its
journals and files. Read-only inspection and independent tasks remain available. Do not blindly
repeat the write or restart an active shared worker. Inspect the current file, journal and backup;
then follow the recovery procedure below. Failed/cancelled partial results remain permitted once
storage works. These are process-level error/recovery guarantees, not power-loss, fsync, hardware
failure or hostile concurrent-filesystem isolation guarantees.

On restart, structurally valid applied recovery journals restore missing change receipts. The
worker checks operation/filename identity, relative path, action, hashes and expected backup path;
a conflict with an existing saved receipt is not silently resolved. Null, incomplete, malformed or
unreadable journal data (including an invalid recovery directory) produces `recoveryRequired` in `status`/`wait` and `get_task`, blocking further edits and
successful completion for that task while independent tasks remain usable. Recovery inspection validates
the journal metadata and each referenced original backup's actual bytes against `beforeSha256`,
rejecting missing, linked or corrupted backups. It does not compare every historical `afterSha256`
with the current project file (which may have changed again), or validate all of state.json.
Inspect its journal, original and current file without guessing
or silently restoring. Preserve partial output, cancel the affected registration after inspection,
and register any narrow correction in the same chat with a new task token. Stop waiting on that
blocked task; other independent tasks can continue. No crash-durability guarantee is made for
filesystem/hardware failure beyond these local recovery records.

Both the shared `recovery` directory and each task's directory must be real directories, not
symlinks or Windows junctions. A link or invalid type at the shared parent prevents trusting the
recovery tree for every running task, so several tasks may require inspection; task lookup and
explicit cancellation remain available. Do not delete or follow linked records as a repair.

Existing-file edits preserve POSIX permission bits (`0777`), owner and group before replacing the
file; the process umask does not reduce the final mode. Edits to files with setuid, setgid or sticky
bits are rejected before mutation. The worker cannot safely infer whether those special bits should
survive changed contents. If the operating system refuses ownership or mode preservation, the
original is not replaced. Extended POSIX ACLs and other extended attributes are outside this contract.

On Windows, existing-file edits require Windows PowerShell 5.1 and use a staging file created with a
protected current-user DACL before any replacement bytes are written. Owner and group must match the
original. Native `ReplaceFile` (through .NET `File.Replace`) preserves the target's DACL and fails on
ACL merge errors; there is no plain-rename fallback. This contract covers DACL, owner and group, not
SACL auditing settings. An error from native replacement can leave partial filesystem changes: retain
any `.webgpt-<operation>.tmp` in the project beside the prepared journal and original backup for
inspection. A failed staging creation does not authorize deleting an existing file at that path;
an unconfirmed Windows preparation also retains any stage because its creation was not acknowledged.
Do not retry or delete that evidence automatically. Windows edits use two short helper
processes; the helper checks the content revision again before replacement.

Test locally: `node --test --test-concurrency=2 --test-reporter=tap` from the installed skill directory; Node discovers the test files without shell glob expansion.
