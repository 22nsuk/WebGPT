---
name: webgpt
description: Delegate short independent tasks to parallel conversations in the user's signed-in Web ChatGPT, collect and verify results, and clean up task chats. Use when the user requests WebGPT, including xh/xhigh or p/pro delegation.
---

# WebGPT

Codex coordinates and verifies; Web ChatGPT does the delegated work. Do not substitute Codex
subagents, CLI workers or API models. This skill requires supported browser control of a signed-in
ChatGPT session. If unavailable, explain the missing capability; do not invent access, scrape
private account APIs, copy session cookies, or take over unrelated tabs.

## Dispatch

1. Verify the requested mode in the UI: `xh|xhigh` means Extra High (default), `p|pro` means Pro.
   Do not silently substitute if the mode or account feature is unavailable.
2. Split work into short, independently verifiable deliverables, one owned chat per task. Run
   independent tasks in parallel within service/tool limits. Stage dependencies; never assign
   overlapping file writes. Keep small corrections in the same chat, and use new chats for
   substantial follow-on work. Reduce concurrency on throttling rather than repeatedly retrying.
3. Give each worker a self-contained prompt: objective, necessary inputs, allowed actions,
   deliverable, focused checks and stopping condition. Share only authorized task data, not the
   entire parent conversation, repository, credentials or unrelated files.
4. Keep a local ledger of task ID, ownership, conversation URL/tab IDs, output path, work state,
   cleanup state and last backup check. Do not include long worker transcripts in parent context.

Provide selected source text through the chat and collect its response. Use only documented,
authorized tools when exchanging files or completion signals. Coding workers return patches or replacement
files; Codex reviews, integrates and verifies them under repository rules. Delegation does not
grant Git, PR, push, process-control or extra filesystem authority.

## Collect

Prefer a supported completion event over repeated chat inspection. Read
[notifications.md](references/notifications.md) only when setting up callbacks. Register before
dispatch. Workers save results before sending a compact terminal signal; failures include partial
output and limitations. A completion signal is a claim, not verification.

Without a callback, use one targeted check every **15 minutes** per unfinished chat. With callbacks,
keep the same check as a backup for missing signals. Use host-supported waits between checks;
do not repeatedly capture screenshots or full conversations. Host wait limits can require short
resumptions; those may consume tokens, but do not justify rechecking every chat.

Collect finished tasks promptly, without waiting for the whole batch. Preserve full results and
evidence in local files; read the relevant output/diff and return only a concise summary and file
references to parent context. Distinguish PASS, FAIL and NOT_RUN. Correct narrowly; do not repeat
an unchanged failed approach or replace whole conversations just to retry.

**Remove each terminal task from periodic checks immediately.** Acknowledgment and chat deletion
are tracked separately. Cancel abandoned registrations. End the wait loop when no active tasks
remain. Keep the parent execution active while monitoring; neither this skill nor its optional
receiver wakes Codex after a final answer or runtime shutdown. Never claim a background schedule
was installed. Preserve pending task IDs and evidence before an unavoidable handoff.

## Close

Track work (`RUNNING → COLLECTED → VERIFIED`, or `FAILED/CANCELLED`) separately from cleanup
(`PENDING → DELETED → CLOSED`, or `BLOCKED` with the exact reason).

Tell every worker: “Return/save the deliverable, evidence and limitations, send a completion signal
if configured, then stop. Do not delete this chat or its only result before collection is acknowledged.
Do not stop shared services.”

After saving output and recording its accepted, rejected or partial disposition:

1. Stop any still-running generation for this task. Never erase uncollected output.
2. Delete the exact owned task conversation, not merely archive it, with the user's authorization
   and any action-time confirmation the browser tool requires. This skill does not itself grant
   deletion permission. Never delete personal chats or bypass confirmation requirements.
3. Verify deletion through redirect/unavailability and disappearance of its exact recent-chat entry
   when exposed. Close all owned tabs/mirrors. Closing a tab alone is not deletion proof.
4. Reconcile failed/recovery chats too. On blocked cleanup, retain their IDs and report the next
   action. Do not call them closed. Preserve unrelated browser sessions and shared services.

Self-deletion is optional and only valid with a genuinely exposed, documented capability after
output acknowledgment. Otherwise Codex handles cleanup. Do not invent self-termination APIs.
Close an owned per-batch receiver after collection; keep its journal and result files.
