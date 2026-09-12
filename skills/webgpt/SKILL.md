---
name: webgpt
description: Delegate short independent tasks to parallel conversations in the user's signed-in Web ChatGPT, collect and verify results, and clean up task chats. Use when the user requests WebGPT, including xh/xhigh or p/pro delegation.
---

# WebGPT

## Dispatch

Use signed-in Web ChatGPT through documented, authorized browser controls; Codex coordinates and
verifies, never substitutes CLI/native subagents or API models. If access is unavailable, report
the missing capability; never invent access, use private account APIs, copy cookies or take over
unrelated tabs.

- Verify the UI mode: `xh|xhigh` = Extra High (default), `p|pro` = Pro; never silently substitute.
- Give independent, short, verifiable tasks separate parallel chats within service/tool limits.
  Stage dependencies; forbid overlapping writes. Keep narrow corrections in the same chat; give
  substantial follow-ons new chats. Reduce concurrency on throttling, not repeated retries.
- Prompt naturally in the user's language, without a title/preamble; let ChatGPT auto-title.
  Include objective, necessary authorized inputs, permissions, deliverable, focused checks and stop
  condition—not entire parent/repository/worker transcripts, credentials or unrelated files.
- Keep one local ledger: task ID, objective, ownership, allowed inputs/actions, URL/tab IDs, output
  path, work/cleanup states and last backup check.
- For development, WebGPT directly reads, creates, edits and deletes task-owned local project files
  through a working, authorized workspace connector. Do not default to returning patches for Codex
  or the user to apply. For analysis/review/check-only requests, use read-only access unless changes
  are separately requested.
- Before dispatch, verify the connector reaches the exact project and exposes the required file
  operations in the worker's chat—not merely in Codex. Bound access to owned paths; protect other
  sessions' edits, secrets and unrelated files. Read before overwriting/deleting, reject stale
  revisions, and preserve recoverable originals for material deletion.
- Missing direct access blocks implementation: report the missing connection/capability; never
  silently substitute parent-applied patches or claim direct edits. Text-only work needs no connector.
  Use patch-only delivery only when requested. Codex owns review, verification and Git/integration;
  direct file access grants no extra Git/PR/push, process-control or out-of-scope authority.

For the bundled direct-edit worker, read [workspace.md](references/workspace.md) during connection
setup; reuse the service and register only a small file grant per task.

Prepare prompt, UI mode, attachments and callback registration before typing. Fill and immediately
submit in one browser-tool call where supported, using already-observed documented controls.
Between them, no screenshot/snapshot, model round trip, commentary or fixed sleep; wait only for
Send to become actionable. Verify afterward; inspect uncertain submission before retrying to
prevent duplicates.

## Collect

Prefer supported completion events over polling. Read [notifications.md](references/notifications.md)
when setting up callbacks; register before dispatch. Workers save output before a compact terminal
signal (failure includes partial output and limitations). Signals/summaries are claims, not proof.

Use host/runtime waits or useful independent coordination. Every **15 minutes**, check each due,
unfinished chat once—as callback backup, or the fallback without callbacks. No repeated screenshots,
chat/log reads or whole-worker checks on wait resumptions. Resume timed-out waits as needed; this
costs tokens. Collect finished output even without its callback; otherwise record blockers and wait,
never resend merely because work continues.

Collect each finished task promptly, not after the batch. Save full results/evidence locally, inspect
relevant output/diffs against the requested outcome, and return only status, short summary, artifact
references and focused checks. Distinguish PASS/FAIL/NOT_RUN; acknowledge callbacks after collection.
Correct narrowly in the same chat. On repeated unchanged failure, preserve partial work and the
specific limitation; do not repeat the approach or create replacement chats.

Remove terminal tasks from periodic checks immediately, independently of acknowledgment/deletion.
Cancel abandoned registrations/deadlines; end waits when none remain. Keep the parent execution
active: neither skill nor receiver wakes it after final answer/runtime shutdown. Do not claim an
installed background schedule. Preserve pending IDs/evidence for unavoidable handoff and reconcile
on resume.

## Close

Track work (`RUNNING → COLLECTED → VERIFIED` or `FAILED/CANCELLED`) separately from cleanup
(`PENDING → DELETED` or `BLOCKED` with reason/next action). Verified chat deletion completes cleanup;
closing the ChatGPT website/tab is not required.

Tell each worker: “Save/return deliverable, evidence/check status and limitations; send the configured
terminal signal, then stop generating/starting actions. Do not delete the chat/only result before
saved-output acknowledgment or stop shared services/browser processes.”

After saving output and recording accepted/rejected/partial disposition, including failures:

1. Stop remaining owned generation; never erase active work, uncollected output or its only copy.
2. Workflow requests include permanent deletion of chats created for that task. Ask no initial,
   per-chat or repeated consent; delete the exact owned chat (not archive) and accept its dialog.
   Apply the actual tool policy: when it allows pre-approval for test-only data explicitly designated
   disposable by the user in a named test workflow, use that approval without asking again.
   Do not misclassify it under the general permanent-deletion rule or relabel ordinary chats as tests.
   Exclude personal/unrelated chats; honor action-time confirmation only where genuinely required.
3. Verify URL redirect/unavailability and exact Recent entry disappearance where exposed.
   Keep the resulting ChatGPT home tab open; where agent tabs auto-close, use the documented
   keep-open/deliverable mechanism to honor this preference. Do not close/reopen the site for cleanup.
   Tab closure, model claims or unrelated navigation are not deletion proof; missing evidence means
   unverified, not complete. Preserve saved results/evidence.
4. Reconcile every task chat, including failed setup/recovery. If authentication/UI/confirmation
   blocks cleanup, retain URL/tab IDs, report BLOCKED and next action, retry when access returns;
   never claim deletion. Preserve other sessions, browsers and shared services.
5. Close only an owned per-batch receiver after collection; retain its journal/results.

Batch grounded menu → Delete → matching-dialog acceptance → verification actions
in one tool call where supported. Use targeted reads only for new controls or target/outcome checks;
no fixed sleeps, redundant full snapshots, commentary or model round trips between known actions.
Never skip target validation or mandatory tool gates.

Self-deletion is optional only through a documented, exposed, authorized capability after saved-output
acknowledgment; Codex still verifies deletion and keeps the site open. Otherwise delete directly; invent no
self-termination APIs.
