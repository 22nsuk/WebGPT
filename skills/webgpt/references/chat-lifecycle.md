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
Retaining a chat is successful cleanup, not a blocker. After saving output and recording its
accepted/rejected/partial disposition, including failures:

1. Stop remaining owned generation. Never erase active work, uncollected output or its only copy.
   Acknowledge collected results or cancel abandoned registrations per workspace.md regardless
   of chat retention; retained chats must not keep task tokens or backup checks active.
2. By default, record `CHAT_RETAINED` and preserve the chat without opening Delete or Archive.
   Delete a chat only when the user explicitly requests deletion of that chat or a clearly
   identified set of task chats. A chat being a test or disposable does not itself grant consent.
   Follow actual tool policy and any mandatory action-time confirmation; exclude unrelated chats.
   For requested deletion, verify the exact owned chat, accept only its matching dialog, then verify
   redirect/unavailability and exact Recent entry disappearance where exposed. Tab closure, model
   claims or unrelated navigation are not deletion proof. Preserve saved results/evidence.
3. Close the exact terminal task-owned tabs after collection, whether the chats are retained or
   explicitly deleted, including recovery duplicates and tabs redirected to home. Recheck IDs/current
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
