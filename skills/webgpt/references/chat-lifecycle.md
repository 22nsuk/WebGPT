# Task chat retention and closure

Read this procedure before closing owned task tabs or carrying out explicitly requested chat deletion.
For task/token retirement, use [workspace.md](workspace.md).

Retain task chats by default, including setup tests, failed tasks and recovery chats.
Do not delete or archive them automatically. A setup or delegation request is not deletion
consent; do not ask about deletion during routine completion. Keep their URLs in the private ledger
so the user can revisit the context and evidence.

Track work (`RUNNING → COLLECTED → VERIFIED` or `FAILED/CANCELLED`) separately from cleanup.
The default cleanup path is `PENDING → CHAT_RETAINED → DONE`; only explicitly requested deletion
uses `PENDING → CHAT_DELETED → DONE`. Either path can be `BLOCKED` with a reason/next action.
Retaining a chat is successful cleanup, not a blocker. Track final chat-answer status separately
from controller work/collection in the existing private ledger: pending, complete, interrupted or
unobserved, with the actual evidence. This is parent bookkeeping, not a new worker state or schema.
Successful `submit_result` closes project-file access and ends controller backup deadlines;
collection/acknowledgment retires the token. Neither proves final chat-answer completion.
After saving output and recording its accepted/rejected/partial disposition, including failures:

1. Verify and collect submitted results promptly per workspace.md, even if the final chat answer
   is still being written. Do not keep task tokens or controller backup checks active for that
   answer. Continue waiting for the owned chat's final answer independently; a settled controller
   wait cannot observe it. Check once at collection, then on a relevant browser event or each
   15-minute parent backup check while it remains pending. Do not repeatedly poll, resend, reload
   active generation, or press Stop merely because submission/collection succeeded.
   Require a substantive final answer and observed generation completion; a cleared composer,
   tool result, absent Stop button alone, or "stopped" message is insufficient. Preserve the final
   answer and compare material claims with the saved result. A disagreement or new caveat needs
   a recorded disposition, not silent replacement of the collected artifact.
   If a chat read reports truncation, record partial content coverage even when the
   turn is completed and has no older-page cursor. A verified local result export
   proves the submitted deliverable, not the missing final-chat text. Its numbered
   message files are local copies, not observed assistant messages. Use an authorized
   full-chat read if available; otherwise retain the missing-coverage limitation.
   Stop generation only for an explicit user cancellation or a concrete safety reason. Record an
   interruption as such, retain partial output and do not claim the final answer was received.
   If access is lost, preserve the pending chat and report the missing observation; no new task or
   after-final wake-up is implied. Never erase active work, uncollected output or its only copy.
2. By default, record `CHAT_RETAINED` and preserve the chat without opening Delete or Archive.
   Delete a chat only when the user explicitly requests deletion of that chat or a clearly
   identified set of task chats. A chat being a test or disposable does not itself grant consent.
   Follow actual tool policy and any mandatory action-time confirmation; exclude unrelated chats.
   For requested deletion, verify the exact owned chat, accept only its matching dialog, then verify
   redirect/unavailability and exact Recent entry disappearance where exposed. Tab closure, model
   claims or unrelated navigation are not deletion proof. Preserve saved results/evidence.
3. Close the exact terminal task-owned tabs only after collection and final-answer completion, or
   a recorded explicit cancellation/interruption, whether the chats are retained or explicitly
   deleted, including recovery duplicates and tabs redirected to home. Recheck IDs/current
   URLs against the ledger; preserve unrelated or repurposed tabs and the browser. Keep the saved
   URLs for retained chats. Verify those task-tab IDs are absent from the tab list; do not open a
   replacement home tab. If closure fails, preserve the retention/deletion disposition and report
   tab cleanup `BLOCKED`.
4. Reconcile all owned task chats, including failed setup/recovery. If access/UI/confirmation blocks
   an explicitly requested deletion or tab closure, preserve URL/tab IDs, report `BLOCKED` and the
   next action, and retry when access returns. Do not schedule deletion for retained chats.
   Preserve shared services, other sessions and browsers; clean only owned temporary resources.

Batch known actions and target/outcome checks where supported; use targeted reads for new controls.
Never open deletion controls on the default retention path. For explicitly requested deletion,
verify deletion before task-tab closure and tab-list verification. No fixed sleeps, redundant full
snapshots, commentary or round trips between known actions. Never skip tool gates or target checks.
Self-deletion is optional only when the user explicitly requested that deletion, through an exposed,
documented, authorized capability after saved-output acknowledgment; Codex still verifies the
requested deletion and closes only task-owned tabs, not the browser.
