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
