---
name: webgpt
description: Use when the user asks to delegate work to signed-in web ChatGPT (WebGPT, xh/xhigh, p/pro) or continue that delegation. Not for a mere mention of the WebGPT repository; token-assigned workers execute their task rather than dispatching another worker.
---

# WebGPT

Use web ChatGPT as a capable collaborator, not merely a browser click target or a file-operation
probe. The parent owns scope, permissions, integration and verification; the web worker owns the
assigned analysis, research or direct project changes. Do not substitute CLI/native subagents or
API models for requested web ChatGPT work. Use only documented, authorized browser controls.

## Route the request before doing the work

- **Parent delegation:** the user asks to have WebGPT do work. Establish a useful deliverable and
  delegate before independently solving that same assignment. Inspect enough to set scope and
  acceptance criteria; independent duplicate analysis is appropriate only when requested/justified.
- **Assigned worker:** a current private task token and connector assignment identify this role.
  Read `get_task` through the selected connector, use supplied inputs and the granted project, then
  submit the actual deliverable and limitations, then stop. Skip the parent-only sections below.
  Do not start a nested parent workflow, invent/reuse
  an old token, or treat missing parent CLI/Git access as proof that granted file work is impossible.
- **Repository maintenance or explanation:** a mention of WebGPT alone does not require a browser
  delegation. Follow the requested review/edit/PR scope using available authorized tools. Do not
  count such maintenance as a production delegation or claim an unperformed web-worker contribution.

The remaining sections govern parent delegation, not ordinary repository maintenance.
For assignment design and a complete parent walkthrough, see [parent-workflow.md](references/parent-workflow.md).
User-facing examples remain in [usage.md](references/usage.md); tradeoffs are in
[browser-use-comparison.md](references/browser-use-comparison.md).

## Give the worker a useful part of the task

Choose one coherent outcome: investigate a cause, evaluate alternatives, review a subsystem, or
implement a bounded change. Give the objective, relevant context, deliverable/acceptance criteria,
ownership and material constraints in the user's language. Let the worker choose its investigation
and implementation within that scope; do not prescribe every tool call or replace real work with
known-answer exercises. Preserve the requested format and necessary source material; omit credentials,
unrelated data, arbitrary titles/preambles and chat-cleanup instructions.

The seven MCP tools are the local project/result bridge, not the limit of the web model's reasoning.
Use separately available research/tools only when the task permits them; do not assume they exist.
The bridge grants no shell, Git/PR/push or process-control authority. The parent runs authorized local
tests/builds and integration. Missing worker shell alone does not block analysis or text-file editing.

Use one chat for coherent work and related follow-ups. Split only genuinely independent outcomes
with disjoint writes; order dependent steps. Reduce concurrency on throttling, not by cloning tasks.
Do independent authorized parent work while the worker runs; do not race its files or redo its task.

<a id="dispatch"></a>
<a id="collect"></a>

## Execute the normal loop

1. **Establish the actual route.** Identify the installed skill path, local Node host, connected
   browser/profile and required project connector, not just their names. Run
   `node <skill>/scripts/client.mjs dispatch preflight` in ordinary Node before registration.
   This checks only the helper runtime. CUA is for browser controls, never a Node filesystem/lock/
   controller host. A merged PR, enabled file-URL toggle or `/health` is not end-to-end readiness.
   Use [setup.md](references/setup.md) only for missing capability or installation work.
2. **Register when needed.** Follow [workspace.md#per-task](references/workspace.md#per-task).
   Give the exact project root `read` for review or `edit` for changes, not per-file allowlists;
   keep runtime data outside it. Text/research can omit the workspace or use no connector.
   Put large permitted text in named `inputs`; project files stay available through the grant.
   Do not upload a repository just to replace working direct access. Required binary/visual
   attachments are a separate delivery route, not interchangeable with `read_input` or file tools.
   Verify required direct file access in the selected chat; if absent, report the blocked part,
   never silently implement returned patches yourself. Patch-only delivery requires a request.
3. **Dispatch once.** Read [dispatch.md](references/dispatch.md) before a transmission. Use one
   canonical private task ledger containing objective, ownership, allowed inputs/actions, target
   and recovery tab/URL IDs, outputs, work/cleanup state, disposition and last backup check.
   Verify actual mode: `xh|xhigh` = Extra High (default), `p|pro` = Pro; never silently substitute.
   Persist `sending` before a send-capable action. Fill the full body and immediately submit in
   one supported browser-tool call, with no snapshot, commentary, round trip or fixed sleep between.
   Confirm the actual new user message against the saved target, predecessor and body, not a click.
   For required attachments, read [file-uploads.md](references/file-uploads.md), declare
   `requiredAttachments` at initial dispatch registration, use split CLI `begin` before any upload,
   observe all files ready before sending and same-message `userMessage.attachmentNames` before
   `confirm`. Only the successful begin owner continues; v2 metadata is not remote-byte/parsing proof.
   Keep legacy evidence and independent attachment review; no silent record upgrade/reset.
4. **Wait for owned work.** Follow [workspace.md](references/workspace.md): use `waitForTasks` or
   `client.mjs wait <owned-task-id> ...`. Empty renewals remain in the active client process.
   Inspect on an event, recovery signal or due backup; every **15 minutes**, check each due unfinished
   chat once. This is not a task timeout. No repeated full snapshots, idle narration or resend because
   work continues. A finished result without a callback is still collected. An empty event queue is
   not an idle worker; use `client.mjs tasks` when inventory is needed. No after-final wake-up is supplied.
5. **Verify and collect.** Save the full result/evidence, inspect relevant diffs and key claims, run
   focused authorized checks, and record accepted/rejected/partial disposition. Then use `collectTask`
   or `client.mjs collect <task-id>` per [workspace.md](references/workspace.md); this verifies saved
   bytes and acknowledges receipt. Integrity is not correctness or proof of reported tests. Inspect
   accumulated tool calls once by exact call identity/target, not quoted errors or repeated panel views.
   Collect each finished task promptly, remove terminal tasks from periodic checks, cancel abandoned
   registrations/deadlines and end terminal-batch waits. Preserve partial failures and verification progress.

Never bypass action-time confirmations, copy cookies, use private browser APIs or touch unrelated tabs.
Return only bounded owned-target evidence; keep prompts/tokens, IDs, URLs, full transcripts and raw
browser errors private. Read before changing files, follow `nextCursor`/`nextOffset`, compare whole-file
SHA across read windows, and read the full file before replacement; preserve others' edits and backups.

<a id="resume-and-service-recovery"></a>

## Resume existing work; register genuine follow-ups

For an uncertain registration response, retry only the identical payload with the same ID; that does
not confirm or authorize another browser send. `sending`/`uncertain`/`submitted` block resends.
After interruption, use `client.mjs ready`, scoped `client.mjs reconcile <owned-task-id> ...`, the
original ledger/chat and [recovery-integrity.md](references/recovery-integrity.md). Reconciliation is
read-only and reports `browserChecked: false`; a result file alone is not completion. Preserve candidate
bytes on `resultRecoveryRequired`/`inspect_uncommitted_result`; never reset state, replay journals,
overwrite candidates, steal a live/ambiguous lock or retry edits to clear warnings. Respect finite wait
retry budgets. Use [backup-safety.md](references/backup-safety.md) for backup/config isolation issues.

A **confirmed terminal** task needing new work uses a new ID/token and its own linked task ledger in
the same retained chat; do not reuse closed authority. A still-running or uncertain attempt must first
be reconciled, not replaced. Send narrow feedback and actual parent check results, not a complete redo.
`collect --resume` reverifies retained results and can collect uncollected ones; it is not always read-only
and does not rerun tests. Already collected work needs no new acknowledgment. Repeated unchanged failure
requires preserving partial work and its limitation, not another identical attempt.

Service restart does not resume the parent/browser. Installation, accounts/ACLs and network publication
need separate explicit permission; follow [operations-windows.md](references/operations-windows.md) and
[fork-policy.md](references/fork-policy.md). Do not substitute an upstream terminal worker.

<a id="close"></a>

## Close and report the contribution

Retain task chats by default, including setup tests, failed tasks and recovery chats. Keep their URLs
in the private ledger. Do not automatically delete/archive or ask about deletion on routine completion.
Track work separately from cleanup: `PENDING → CHAT_RETAINED → DONE`.
Retaining a chat is successful cleanup, not a blocker; retained chats must not keep task tokens or
backup checks active. Close the exact terminal task-owned tabs after collection, not the browser or
unrelated/repurposed tabs. Read [chat-lifecycle.md](references/chat-lifecycle.md) before closure/deletion.
Delete a chat only when the user explicitly requests deletion of that chat or identified set.
Never open deletion controls on the default retention path. Preserve results; verify exact requested
deletion and tab absence, or report cleanup `BLOCKED` without erasing successful work.

Report what WebGPT actually contributed, what the parent verified/integrated, disposition and remaining
blockers. Do not present parent-only work, fixture/CI PASS or a connection probe as productive delegation.
Use [parent-acceptance.md](references/parent-acceptance.md) for a requested usage review; the four small
[verification.md](references/verification.md) exercises are optional operational checks, not every task's
prerequisite or a substitute for a useful result. Do not claim unmeasured token, cost or quality gains.
