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

### Worker tool reference

This is the protocol available to the worker, not a sequence to copy into ordinary delegation prompts:

- `get_task(token)` returns instructions, input names and any workspace grant;
  `read_input(token,name)` reads a named string supplied in `inputs`.
- When local files are needed and granted, `list_files(token,path)` lists a directory
  (`.` for root, up to 500 entries with a truncation flag), and `read_file(token,path)` gets text
  and SHA-256 (missing files return `exists:false`).
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
are ordinary project paths, not Git metadata. Other project text files need no individual grant. Never
transmit secrets unnecessarily. Originals and operation receipts are retained under the private data
directory's `recovery/<task-id>/`; deletions are recoverable by the parent, never silently restored.
This is for cooperative developer workspaces, not isolation from hostile local filesystem races.
Read-only blocks changes, not disclosure: project text files can contain secrets. Use a sanitized
project snapshot or explicitly supplied inputs when unrelated credentials must remain inaccessible.

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
- `await request('status')` is read-only. CLI `ack`, `checked` and `cancel` accept either a returned
  task ID or the existing JSON file containing `{ "id": "..." }`. Registration JSON is unchanged.

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

On restart, applied recovery journals restore missing change receipts. An incomplete/unreadable
journal produces `recoveryRequired` in `status`/`wait` and `get_task`, blocking further edits and
successful completion for that task. Inspect its journal, original and current file without guessing
or silently restoring. Preserve partial output, cancel the affected registration after inspection,
and register any narrow correction in the same chat with a new task token. Stop waiting on that
blocked task; other independent tasks can continue. No crash-durability guarantee is made for
filesystem/hardware failure beyond these local recovery records.

Test locally: `node --test --test-reporter=tap` from the installed skill directory; Node discovers the test files without shell glob expansion.
