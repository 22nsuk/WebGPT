---
name: webgpt
description: Use when the user asks to delegate work to signed-in web ChatGPT (WebGPT, xh/xhigh, p/pro) or continue that delegation. Not for a mere mention of the WebGPT repository; token-assigned workers execute their task rather than dispatching another worker.
---

# WebGPT

Minimize parent model work, intervention and context while maximizing useful web-worker work
within actual capabilities, permissions and usage limits. The parent owns scope, permissions,
acceptance and collection; the worker owns the complete authorized outcome, including available
validation and corrective iterations. This is not a goal to consume quota or skip necessary checks.
Do not substitute CLI/native subagents or API models for requested web ChatGPT work. Use only
documented, authorized browser controls.

This applies to non-Git local folders, provided text, research, uploaded data, documents/media
and connected-app work too. Git, a remote repository, a commit and CI are not prerequisites.
Complete the requested artifact or action, not merely instructions for the parent to finish it;
a requested review, plan or draft remains that narrower outcome, not permission to edit or send.

## Route the request before doing the work

- **Parent delegation:** the user asks to have WebGPT do work. Establish a useful deliverable and
  delegate before independently solving that same assignment. Inspect enough to set scope and
  acceptance criteria; independent duplicate analysis is appropriate only when requested/justified.
- **Assigned worker:** a current private task token and connector assignment identify this role.
  Read `get_task` through the selected connector, use actual inputs and any granted project, then
  finish the worker-owned investigation, changes, available checks and corrections before
  `submit_result`; an initial patch is not completion of a broader assignment. Report concrete
  blockers and parent-only gaps, then finish a user-facing final chat answer. For delegated GitHub publication,
  read [GitHub workflow](references/github-workflow.md) before declaring a capability unavailable.
  For non-repository work, use [task-completion.md](references/task-completion.md) for input routes,
  artifact checks and delivery; no Git setup or parent handback is required merely by task type.
  For code changes, use [development-loop.md](references/development-loop.md) for exact text edits
  and check-evidence handoff; this adds no execution authority.
  Make no further project/tool changes after submission. Skip the parent-only sections below.
  Do not start a nested parent workflow, invent/reuse
  an old token, or treat missing parent CLI/Git access as proof that granted file work is impossible.
- **Repository maintenance or explanation:** a mention of WebGPT alone does not require a browser
  delegation. Follow the requested review/edit/PR scope using available authorized tools. Do not
  count such maintenance as a production delegation or claim an unperformed web-worker contribution.

The remaining sections govern parent delegation, not ordinary repository maintenance.
For assignment design and a complete parent walkthrough, see [parent-workflow.md](references/parent-workflow.md).
User-facing examples remain in [usage.md](references/usage.md); tradeoffs are in
[browser-use-comparison.md](references/browser-use-comparison.md).

<a id="give-the-worker-a-useful-part-of-the-task"></a>

## Delegate the complete permitted outcome

Choose one coherent outcome: a finished analysis, document, data transformation, app update,
review or implementation. Give the objective, actual inputs, output format/destination, acceptance criteria,
ownership and material constraints in the user's language. Let the worker choose its investigation
and implementation within that scope; do not prescribe every tool call or replace real work with
known-answer exercises. Preserve the requested format and necessary source material; omit credentials,
unrelated data, arbitrary titles/preambles and chat-cleanup instructions.

The seven MCP tools are a local project/result bridge, not the worker's complete tool inventory.
They grant no shell, Git/PR/push or process-control authority. Discover the worker's actual separate
research, sandbox and connected-app capabilities only as needed; their presence is not permission.
Assign available authorized investigation, implementation, validation and correction to the worker.
If PR publication is authorized, include final-head CI and review follow-through by default unless
the user limits that outcome. Otherwise do not publish. See [GitHub workflow](references/github-workflow.md).

Choose the authoritative inputs and each output's destination before dispatch: an ordinary local
folder, supplied text/attachments, a connected object, a worker-created artifact, or a Git branch
when relevant. Do not introduce a repository, duplicate copies or parent synchronization without
need. Preserve local/unsaved inputs instead of substituting a remote version. Use task-appropriate
checks and actual source/output identities; Git SHA/CI is only one form of evidence. Reserve parent
assistance for a named capability, environment, approval or delivery gap. See
[task-completion.md](references/task-completion.md) for the general route and
[development-loop.md](references/development-loop.md) for code-specific checks.

Use one chat for coherent work and related follow-ups. Split only genuinely independent outcomes
with disjoint writes; order dependent steps. Reduce concurrency on throttling, not by cloning tasks.
Do independent authorized parent work while the worker runs; do not race its files or redo its task.

<a id="dispatch"></a>
<a id="collect"></a>

## Execute the normal loop

1. **Establish the actual route.** Identify the installed skill path, local Node host, connected
   browser/profile and required project connector, not just their names. Run
   `node <skill>/scripts/client.mjs dispatch preflight` in ordinary Node once per unchanged parent
   session/host/install/configuration; it checks only the helper runtime. Reuse that evidence and
   the verified connection identity, not cached per-task permissions or UI state. Recheck affected
   capabilities after restart, configuration/endpoint/schema/account/profile changes or an error.
   CUA is for browser controls, never a Node filesystem/lock/controller host. A merged PR,
   file-URL toggle or `/health` is not end-to-end readiness. Use [setup.md](references/setup.md)
   only for missing capability or installation work; do not repeat setup for every healthy task.
2. **Register when needed.** Follow [workspace.md#per-task](references/workspace.md#per-task).
   Give the exact local folder root `read` for review or `edit` for changes, not per-file allowlists;
   Git is not required. Keep runtime data outside it. Attachment-only, connected-app, remote-only
   or text/research work can omit the workspace when no local access is needed.
   Browser-only work can omit the local connector, but then has no saved-result collection.
   Put large permitted text in named `inputs`; project files stay available through the grant.
   Do not upload a repository just to replace working direct access. Required binary/visual
   attachments are a separate delivery route, not interchangeable with `read_input` or file tools.
   Verify required direct file access in the selected chat; if absent, report the blocked part,
   never silently implement returned patches yourself. Patch-only delivery requires a request.
3. **Dispatch once.** Follow [dispatch.md](references/dispatch.md); reuse instructions already read
   at this installed revision instead of rereading unchanged documents per task. Use one
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
4. **Wait and read for review.** For one owned task, use `reviewTask` or
   `client.mjs review <owned-task-id>`: it waits and returns the verified full result as `review.content`
   without collecting. See [result-review.md](references/result-review.md). Use `waitForTasks` or
   `client.mjs wait <owned-task-id> ...` for metadata-only or multiple-task waits. Empty renewals stay
   in the client. A null `review` is not success: handle the returned recovery/interruption/due-backup
   or settled-without-event notice. Every **15 minutes**, inspect each due unfinished chat once;
   this is not a task timeout. No repeated full snapshots, idle narration or resend because work
   continues. An empty event queue is not an idle worker; use `tasks` when inventory is needed.
   No after-final wake-up is supplied. Retained/interrupted work uses the recovery route below.
5. **Verify and collect.** Use the verified body already returned for this review rather than reopening
   it just to display it. Preserve evidence and inspect relevant diffs, key claims and actual
   revision-bound check results. Reuse sufficient worker/CI evidence; do not routinely repeat the
   same analysis or tests. Run additional checks for an explicit risk, missing evidence, changed
   revision or environment gap, then record accepted/rejected/partial disposition. Then use `collectTask` or
   `client.mjs collect <task-id>` per [workspace.md](references/workspace.md); collection still freshly
   verifies bytes, recovery and retirement. Do not duplicate its successful post-check with a routine
   full `reconcile`. Integrity is not correctness or proof of reported tests. Inspect
   accumulated tool calls once by exact call identity/target, not quoted errors or repeated panel views.
   Collect each finished task promptly, remove terminal tasks from periodic checks, cancel abandoned
   registrations/deadlines and end terminal-batch waits. Preserve partial failures and verification progress.
   Controller completion and collection do not establish that the final chat answer has finished.
   Continue observing that owned chat separately until the final answer is complete; do not stop
   generation merely because the result was submitted or collected. Follow [chat-lifecycle.md](references/chat-lifecycle.md).

Never bypass action-time confirmations, copy cookies, use private browser APIs or touch unrelated tabs.
Return only bounded owned-target evidence; keep prompts/tokens, IDs, URLs, full transcripts and raw
browser errors private. Read before changing files, follow `nextCursor`/`nextOffset`, compare whole-file
SHA across read windows (pin `read_file.expectedSha256` when supported), and read the full file before
full replacement. For a local correction, `write_file.oldText` may select one exact span from relevant
context with the same whole-file SHA; preserve others' edits and backups. Never drop `oldText` as a
fallback to an older worker: that would replace the whole file with only the replacement span.

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
the same retained chat; do not reuse closed authority. Let the prior final chat answer finish before
sending the follow-up, unless that generation was explicitly cancelled. A still-running or uncertain attempt must first
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
backup checks active. Close the exact terminal task-owned tabs after collection and observed final
chat-answer completion, not the browser or unrelated/repurposed tabs. An explicitly cancelled or
interrupted chat keeps that disposition instead of being reported as a completed answer.
Read [chat-lifecycle.md](references/chat-lifecycle.md) before closure/deletion.
Delete a chat only when the user explicitly requests deletion of that chat or identified set.
Never open deletion controls on the default retention path. Preserve results; verify exact requested
deletion and tab absence, or report cleanup `BLOCKED` without erasing successful work.

Have the worker return the requested deliverable with a compact acceptance summary: outcome,
revision, changes, check evidence, limitations and the smallest remaining parent action (or none).
Keep detailed evidence at accessible authorized references; do not truncate a requested full report.
For non-Git work, use available input/output identities instead of demanding a commit. Include the
real artifact/attachment or app reference, not a sandbox path alone. `submit_result` saves text,
not binary attachments; distinguish creation, validation and delivery to the requested destination.
Report what WebGPT actually contributed, what the parent verified/integrated, disposition and remaining
blockers. Do not present parent-only work, fixture/CI PASS or a connection probe as productive delegation.
Use [parent-acceptance.md](references/parent-acceptance.md) for a requested usage review; the four small
[verification.md](references/verification.md) exercises are optional operational checks, not every task's
prerequisite or a substitute for a useful result. Do not claim unmeasured token, cost or quality gains.
