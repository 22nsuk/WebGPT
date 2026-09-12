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
  including on Windows.
- `submit_result(token,status,summary,result)` ends the task with status `completed`, `failed` or
  `cancelled`. Include the deliverable, any changed paths/receipts, checks and limitations;
  unexecuted checks are NOT_RUN. Submission saves the result, closes file access and removes backup
  checks, after which the worker stops.

With no workspace grant, only `get_task`, `read_input` and `submit_result` are available to the task.

The service rejects stale revisions, symlinks/hardlinks, traversal and Git metadata access; Git
remains the parent's responsibility. Other project text files need no individual grant. Never
transmit secrets unnecessarily. Originals and operation receipts are retained under the private data
directory's `recovery/<task-id>/`; deletions are recoverable by the parent, never silently restored.
This is for cooperative developer workspaces, not isolation from hostile local filesystem races.

## Completion and lifecycle

```js
// Import using the actual installed script's file URL; no user-specific adapter is needed.
const { request } = await import(clientModuleUrl);
const notice = await request('wait');
```

Or run `node <skill>/scripts/client.mjs wait`. It returns on a terminal event, a 15-minute backup
check, or at most 55 seconds; neither interval expires the task. With no active or uncollected tasks
it returns immediately.
Resume empty waits without scanning chats. Run useful independent work while awaiting results.

- `events`: verify the saved artifact's SHA-256 and relevant output/diffs, record disposition, then
  `await request('ack', {id})`. Events persist until acknowledged, including across service restarts.
- `backupDue`: check only each named running chat once, then `await request('checked', {id})`.
  If output is complete but its callback failed, save it and request a narrow `submit_result` retry.
  Never send a fabricated worker-success event. Identical terminal submissions are safe to retry;
  conflicting results are rejected.
- Acknowledgment revokes the task token and redacts its inputs/instructions from active state;
  supervisor cancellation does the same. Retained artifacts/recovery copies remain private evidence.
  Retries are valid only before acknowledgment, not with a retired token.
- Abandoned tasks: stop their actual generation separately, preserve partial output and
  `await request('cancel', {id})`. Cancellation disables the registration, not the browser chat.
- `await request('status')` is read-only. CLI POST actions take a JSON file containing `{ "id": "..." }`.

Terminal tasks lose deadlines immediately, independent of collection/chat deletion. Once the
batch is terminal, stop waiting; never reschedule its checks. State and results survive restarts.
The active parent handles due browser checks; this is not a cron job or after-final wake-up service,
and timed-out wait resumptions can still cost tokens. Keep the shared worker running and preserve
the task/chat ledger for recovery; delete task chats per SKILL.md.

On restart, applied recovery journals restore missing change receipts. An incomplete/unreadable
journal produces `recoveryRequired` in `status`/`wait` and `get_task`, blocking further edits and
successful completion for that task. Inspect its journal, original and current file without guessing
or silently restoring. Preserve partial output, cancel the affected registration after inspection,
and register any narrow correction in the same chat with a new task token. Stop waiting on that
blocked task; other independent tasks can continue. No crash-durability guarantee is made for
filesystem/hardware failure beyond these local recovery records.

Test locally: `node --test scripts/*.test.mjs` from the installed skill directory.
