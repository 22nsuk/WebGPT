# Direct local editing

Use a working, authorized project connector already available in WebGPT. Otherwise this skill
includes a small MCP worker: `scripts/worker.mjs` + `workspace.mjs` (Node.js 22+). It exposes only
task lookup, supplied inputs, direct text-file read/write/delete, and completion submission—no Git,
shell, process control or account credentials. Text-only tasks do not need it.

## One-time connection

Run `worker.mjs` with `WEBGPT_DATA_DIR` set to a private, persistent directory outside the project.
It binds MCP to `127.0.0.1:43137/mcp` and a parent-only controller to `127.0.0.1:43139`.
Connect only MCP through a supported authenticated private tunnel to ChatGPT; never expose the
controller or publish the generated `controller.key`. Honor required connection approval. No public
unauthenticated endpoint or browser-private API is needed. Registering the connector is not enough:
verify its file tools are actually callable by the selected WebGPT chat.
ChatGPT's plugin permission is separate from the project boundary: a low-risk-only setting may
block file replacement/deletion. If the user explicitly requests all project actions, set Allow
all actions for this worker only, not the global default; otherwise honor their chosen permission.

## Per task

The parent reads `controller.key` locally and calls the loopback controller with
`Authorization: Bearer <controller-key>`. Never send that key to WebGPT. POST `/register`:

```json
{
  "id": "unique-task-id",
  "instructions": "Implement the assigned change, report checks, then submit_result.",
  "inputs": {},
  "workspace": {
    "root": "/absolute/project",
    "mode": "edit"
  }
}
```

The project root is the permission boundary; no per-file lists or permission expansion are needed.
Use `mode:"read"` for review/analysis; omit workspace for text-only work. Concurrent workers may
share the project, with disjoint responsibilities coordinated in prompts. Revision checks reject
stale edits. Only the parent can choose the project root and mode.

Send the returned **task token** privately to its WebGPT worker. It calls:

1. `get_task(token)` to learn instructions and project root; `list_files(token,path)` lists a directory
   (`.` for root, up to 500 entries with a truncation flag).
2. `read_file(token,path)` to get text and SHA-256 (missing files return `exists:false`).
3. `write_file(token,path,text,expectedSha256)` to create (`null` revision) or replace (read revision),
   or `delete_file(token,path,expectedSha256)` to remove a read file. These directly change local files;
   Codex does not apply a returned patch. No recursive deletion. Content is UTF-8, at most 1 MiB/file.
4. `submit_result(token,status,summary,result)` after edits. Include changed paths/receipts, checks
   and limitations; unexecuted checks are NOT_RUN. This closes file access and removes backup checks.

The service rejects stale revisions, symlinks/hardlinks, traversal and Git metadata access; Git
remains the parent's responsibility. Other project text files need no individual grant. Never
transmit secrets unnecessarily. Originals and operation receipts are retained under the private data
directory's `recovery/<task-id>/`; deletions are recoverable by the parent, never silently restored.
This is for cooperative developer workspaces, not isolation from hostile local filesystem races.

## Completion and lifecycle

GET `/wait` returns on a terminal event, a 15-minute backup deadline, or at most 55 seconds.
Resume empty waits without scanning chats. GET `/status` is read-only. POST `/ack` with `{id}` only
after saving/verifying the event artifact and SHA; `/checked` advances one due task's backup;
`/cancel` disables abandoned tasks. Terminal tasks never get periodic checks again. No after-final
parent wake-up is provided. Keep the shared service running; delete task chats per SKILL.md.

Test locally: `node --test scripts/worker.test.mjs scripts/workspace.test.mjs`.
