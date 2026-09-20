# WebGPT

<img width="871" height="40" alt="image" src="https://github.com/user-attachments/assets/97d758f5-4666-4d21-9cc0-68a3f0fbcc88" />

**Delegate selected work to web ChatGPT.** A Codex skill for task handoff, saved results
and verification. Quota savings depend on the task and coordination overhead.

## Install

Paste this into Codex:

```text
Install https://github.com/22nsuk/WebGPT/tree/main/skills/webgpt
Follow the included references/setup.md and set up everything needed.
Handle installation, configuration and verification yourself; assume no setup knowledge.
I authorize the local worker and HTTPS forwarding, sharing its private connection
URL with my signed-in ChatGPT, and granting WebGPT read/create/edit/delete access
to projects I assign. Run the setup test, retain its test chats, and close its tabs
after saving results. Do not delete or archive chats unless I explicitly request it.
Do not ask again for the approved setup actions.
Ask only for sign-in or another action that genuinely requires me; continue afterward.
```

## Use

Tell Codex:

```text
Use webgpt xh as subagents to develop this project's planned features in parallel.
```

```text
webgpt p Research this topic and summarize the findings.
```

`xh` = Extra High · `p` = Pro.

## Safety defaults in this fork

Retain task chats by default, including setup tests, failed tasks and recovery chats.
After collecting results, close only task-owned tabs; closing a tab does not delete its chat.
Delete a chat only when the user explicitly requests deletion of that chat.

Git metadata is blocked in file operations and directory listings, including Windows
case variants, trailing dots/spaces, `GIT~1` and NTFS stream aliases. Ordinary project
files such as `.gitignore`, `.gitattributes` and `.github` remain accessible.


## Scoped task lifecycle

This file-scoped fork selectively adapts upstream's task-ID waits and result collection,
not its full-OS terminal or `webgpt open` modes. No shell or native PTY dependency is added.
The existing seven MCP tools, read/edit grants, revision checks and recovery records remain.

The controller supports `wait <task-id> [task-id ...]` with quiet HTTP renewal and
`collect <task-id>` with SHA-256 verification before acknowledgment. No-argument `wait`
keeps its bounded, global behavior; existing registration JSON is unchanged.
Collection verifies saved bytes, not code correctness or test claims. Codex reviews evidence
and performs relevant integration checks. See [workspace.md](skills/webgpt/references/workspace.md)
for commands and [fork policy](skills/webgpt/references/fork-policy.md) for the integration boundary.

## Practical operation

Use `node <skill>/scripts/client.mjs tasks` to inspect running tasks and uncollected results
before an update or recovery. An empty `status` event queue alone does not mean the worker is idle.
The inventory is controller-only and omits task tokens, instructions and input contents.

`list_files` supports optional `limit` (1–500) and `cursor` arguments. Follow `nextCursor` until
`truncated:false`; a changed directory invalidates the cursor instead of silently skipping entries.
Refresh the ChatGPT connection's tool schemas after updating the idle worker and client together.

After an uncertain registration response, repeat the exact registration with the same ID.
Only an identical, still-running task returns the original token; changed or finished tasks are
rejected. This never authorizes resending a browser message. IDs cannot differ only by case or use
Windows device names. Task IDs take precedence over same-named local files in CLI commands;
use `--file <json-file>` when explicitly reading a payload file.

A project grant cannot overlap the worker's private data directory in either direction, including
its recovery subdirectories. Keep projects and runtime data separate. State-save failures do not
report successful completion or retire task access; an unrecorded file change blocks further edits
until inspected. See workspace.md for recovery limits.

## Request and recovery checks

The worker validates MCP request IDs, protocol headers and tool arguments before execution.
It handles `ping` and negotiates the implemented `2025-03-26` / `2025-06-18` versions instead
of echoing an unknown version. This does not establish browser/ChatGPT end-to-end readiness.

Invalid UTF-8 and lone-surrogate tool strings are rejected instead of changing file contents.
The MCP wire-body limit is 8 MiB to accommodate JSON escaping; decoded files/results still have
an independent 1 MiB limit, and controller request bodies remain limited to 2 MiB.
Malformed or conflicting recovery journals block the affected task without replaying its changes
or preventing unrelated tasks from starting. Preserve the journal and inspect it before recovery.
