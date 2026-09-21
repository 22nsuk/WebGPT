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
webgpt p 이 저장소 전체를 읽고 오류 가능성과 개선 우선순위를 검토해줘.
파일은 수정하지 말고 근거가 되는 파일과 위치를 알려줘.
```

```text
webgpt xh 이 프로젝트의 검색 필터를 구현해줘. 기존 동작을 유지하고 관련 테스트도 수정해줘.
Codex는 변경 내용을 검토하고 로컬 테스트 결과를 확인해줘.
```

`xh` = Extra High · `p` = Pro.

For repository work, WebGPT reads the assigned project directly through a `read` or `edit`
grant; it can choose relevant files without repeated copy/paste or per-file permission requests.
WebGPT edits project text, and Codex reviews the changes and runs local checks and Git operations.
Research that needs no local files can use a text-only task. The
[practical usage guide (한국어)](skills/webgpt/references/usage.md) covers review, implementation,
research, follow-ups, parallel ownership and interruption recovery with example prompts.

## Safety defaults in this fork

Retain task chats by default, including setup tests, failed tasks and recovery chats.
After collecting results, close only task-owned tabs; closing a tab does not delete its chat.
Delete a chat only when the user explicitly requests deletion of that chat.

Git metadata is blocked in file operations and directory listings, including Windows
case variants, trailing dots/spaces, `GIT~1` and NTFS stream aliases. Ordinary project
files such as `.gitignore`, `.gitattributes` and `.github` remain accessible.
Existing path components are checked using their native filesystem names, so other Windows
short aliases of `.git` are blocked too. Project/runtime overlap checks use native paths as well.


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

Run `node <skill>/scripts/client.mjs dispatch preflight` in ordinary Node before task registration.
Node owns the private ledger, lock, controller and hashes; documented browser tools own UI actions.
Dispatch errors expose only fixed `code`, `stage`, `reason` and `message` fields, making runtime
and storage failures distinguishable without printing paths, prompts or tokens. See
[dispatch.md](skills/webgpt/references/dispatch.md) for the staged commands and UI evidence rules.

Use `collect --resume <task-id>` after an interrupted verification. It verifies retained bytes,
recognizes already collected or discarded results, and acknowledges only an eligible uncollected
result. Recovery warnings require inspection; this does not reopen chats, resend work or reset state.
Keep the original private setup record so browser verification and tab cleanup can resume separately.

`list_files` supports optional `limit` (1–500) and `cursor` arguments. Follow `nextCursor` until
`truncated:false`; a changed directory invalidates the cursor instead of silently skipping entries.
`read_file` also accepts optional `offset`, `limit` and `maxChars` for complete-line windows with
range metadata and the **whole-file** SHA. Calls without them still return the full file. Compare
revisions between windows, and read the whole file before replacing it; an excerpt is not a new
file body. This adapts the bounded-read idea from
[faithforone/WebGPT](https://github.com/faithforone/WebGPT/tree/b8206c57866cf574fdb65aa2aadc146a4ad2e469)
to this fork's revision and recovery contracts.
Follow the [update procedure](skills/webgpt/references/operations-windows.md#parent-resume-transition-and-rollback):
confirm idle, stop the identified worker and restart owner, verify exit, preserve a consistent
private backup, then replace the matching worker/client/helpers. Keep a healthy existing tunnel
and ChatGPT connection during a code-only update; verify its settings and refresh stale schemas.

After an uncertain registration response, repeat the exact registration with the same ID.
Only an identical, still-running task returns the original token; changed or finished tasks are
rejected. This never authorizes resending a browser message. IDs cannot differ only by case or use
Windows device names. Task IDs take precedence over same-named local files in CLI commands;
use `--file <json-file>` when explicitly reading a payload file.

A project grant cannot overlap the worker's private data directory in either direction, including
its recovery subdirectories. Keep projects and runtime data separate. State-save failures do not
report successful completion or retire task access; an unrecorded file change blocks further edits
until inspected. See workspace.md for recovery limits.

If a terminal result cannot be collected, inspect and preserve its evidence before explicitly
cancelling the abandoned registration. Cancellation revokes its token and retires the event,
preserving the original status and files with `discarded:true` instead of certifying collection.

## Request and recovery checks

The worker validates MCP request IDs, protocol headers and tool arguments before execution.
It handles `ping` and negotiates the implemented `2025-03-26` / `2025-06-18` versions instead
of echoing an unknown version. This does not establish browser/ChatGPT end-to-end readiness.

Invalid UTF-8 and lone-surrogate tool strings are rejected instead of changing file contents.
The MCP wire-body limit is 8 MiB to accommodate JSON escaping; decoded files/results still have
an independent 1 MiB limit, and controller request bodies remain limited to 2 MiB.
Malformed or conflicting recovery journals block the affected task without replaying its changes
or preventing unrelated tasks from starting. Preserve the journal and inspect it before recovery.

## Recovery and readiness

The authenticated local controller provides `ready`, `reconcile` and `shutdown` commands.
Readiness checks storage, state consistency, active recovery journals and workspace access;
the public `/health` endpoint reports only liveness. Reconciliation includes retired tasks
and verifies retained result hashes without acknowledging results or resending browser work.

Interrupted result files remain visible as uncommitted candidates. Conflicting resubmissions
cannot overwrite them, and terminal retries verify the saved artifact before reporting success.
Missing recorded journals block only the affected task. See
[result and recovery integrity](skills/webgpt/references/recovery-integrity.md) before resuming
interrupted work or rolling back to an older worker.

Confirmed dead local lock owners can be recovered with the old lock preserved. An optional
local `service.mjs` launcher restarts only its own worker within a finite retry budget and
supports graceful shutdown. These commands do not add MCP tools or shell access. Keep the
running installation separate from editable source checkouts; workspace grants cannot overlap
the running scripts directory or private runtime.

Operational configuration is also excluded from read/edit workspace grants, including
canonical aliases and future configuration paths. Recovery checks verify original backup
bytes against edit/delete receipts, and applied journal publication preserves the prepared
record if interrupted. See [backup safety](skills/webgpt/references/backup-safety.md).

See [Windows operation and recovery](skills/webgpt/references/operations-windows.md) for failure
classes, migration, rollback and the review-only WinSW template. Service registration, accounts,
ACLs, fixed tunnel addresses and browser/Codex resumption are separate deployment work.
