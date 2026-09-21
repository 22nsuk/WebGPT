# Parent dispatch: one ledger, one attempted transmission

This is parent-side bookkeeping for the existing authorized browser workflow, not another MCP
server, queue, browser SDK or completion protocol. Use it after controller registration (when a
connector is needed), before sending. `submitted` means that matching UI evidence was observed;
only the controller establishes task completion, saved-result integrity, acknowledgment and token
retirement. Existing wait/collect behavior and default chat retention are unchanged.

## Private ledger and state

Choose **one canonical private JSON ledger per task** in an existing private directory outside the
project/skill. All cooperating parents, CLI calls and resumed sessions must use that same file.
The helper extends its `dispatch` property and preserves other objective, ownership, output,
work/cleanup and handoff fields. Do not point it at controller `state.json`, configuration, or a
multi-task ledger. Migrate the relevant task record explicitly first; never initialize a new ledger
for an already-dispatched task merely because its old record lacks this schema. Keep the original
record/evidence and reconcile the retained chat/controller before adopting the new flow.

The `dispatch` record holds task ID, requested mode, connector requirement, prepared-body digest,
owned tab/chat, timestamps and bounded before/after message evidence. It never stores the prompt
or task token itself. Other existing ledger fields may contain secrets: the **whole file remains
private**. Use a private payload file or in-memory object, not secret text in shell arguments.

`registered -> prepared -> sending -> submitted|uncertain`

Registration is idempotent only for the same task, body digest, mode, connector requirement and
initial target. It cannot reset any transmission. Preparation records the narrowly observed UI;
`begin` publishes both readiness and `sending` before any send-capable browser action. The
high-level helper keeps a per-ledger exclusive lock across its browser calls. Split CLI calls
release the lock after each saved transition, but `sending` still blocks every subsequent begin.
The helper does not retry browser actions. `sending`, `uncertain` and `submitted` all block resends.

Files use a flushed temporary write plus replacement, single-link checks and a private lock;
external ledger changes are rejected rather than overwritten. Newly written files use mode 0600.
Directory creation, Windows ACL configuration, services, accounts and tunnels are not changed.
Use an already secured local directory; POSIX mode alone does not establish Windows privacy.
This is cooperative same-ledger/process safety, **not exactly-once browser delivery**, power-loss
or hostile filesystem isolation. Independent ledger copies or bypassing the helper cannot be
serialized. Do not delete/copy/reset the ledger or alter its dispatch fields to defeat a block.

## Parent helper

For interactive Codex use, prefer the split Node CLI below. Ordinary Node owns filesystem access,
ledger locks, controller calls and SHA-256 calculation; CUA owns only documented browser actions
and observations. Do not import this helper or Node filesystem/network modules into the managed
CUA runtime. A generic MCP server `cwd` setting does not configure that managed runtime.

Capture only the required owned-target UI evidence through supported browser controls and pass it
privately to the local helper. Compute digests from that actual observed text in ordinary Node,
not from an assumed copy of the outgoing prompt. If the available browser tool cannot return the
necessary text privately and narrowly, report the evidence limitation without exposing tokens or
inventing a digest. Do not use broad UI snapshots as diagnostic output.

Import `registerDispatch`, `dispatchPrompt`, `confirmDispatch`, `inspectDispatch`, `recoverDispatch`
and `textDigest` from the installed `scripts/dispatch.mjs`. No dependency installation is needed.
`prepareDispatch` and `beginDispatch` are also available for an explicitly staged workflow.
The high-level adapter is for a supported ordinary Node host that can call authorized browser
controls; its availability does not imply that CUA can host arbitrary Node code.

Register with this private shape (the prompt here is illustrative, not a protocol requirement):

```json
{
  "taskId": "owned-task-id",
  "mode": "pro",
  "prompt": "Review the assigned task and return the requested evidence.",
  "connectorRequired": true,
  "target": {"tabId": "owned-tab", "chatUrl": "https://chatgpt.com/c/example-conversation"}
}
```

`mode` is `pro` or `xhigh`; never normalize an unverified selection to the requested mode.
For an observed new, empty owned chat, `chatUrl` and the previous user message ID are `null`.
After sending, retain the actual conversation URL in the confirmation evidence. Existing chat URLs
must match exactly. An unrelated/reused tab is not an acceptable replacement target.

Call `dispatchPrompt(ledgerPath, preparedPrompt, adapter)`. The adapter contains exactly three
callbacks, bound to the parent's **available, documented and authorized browser controls**:

- `observeReady()` reads only the selected mode/required connector, approval state, composer and
  last user-message identity in the exact owned target. It returns the readiness object below.
- `fillAndSend(preparedPrompt)` replaces/inserts the complete prepared body **once**, preserves the
  connector, verifies that the actual body matches and Send is actionable, then sends in the same
  supported browser-tool call. No full snapshot, fixed sleep or parent round trip between fill
  and send. Never use blind character-by-character retries, append to an uncertain draft, bypass
  mandatory approval, or call an invented/private browser/session API. If the tool cannot safely
  batch these actions, preserve the pending intent and report that limitation rather than claiming
  an atomic browser operation.
- `observeSent()` reads only the actual new user message and its immediate previous user-message
  identity in that owned chat, plus the same relevant controls. It returns the confirmation object.

This repository intentionally does not bind to one browser product or invent its selectors. The
adapter is the trust boundary: derive fields and body digests from actual permitted UI observations,
not from the outgoing prompt, a guessed message ID, echoed request arguments or model claims.
The helper validates those bounded reports; it cannot independently inspect a browser it does not
control. Mandatory tool gates and exact-target checks still apply at action time.

Readiness object (all fields required; no extra fields, including nested ones):

```json
{
  "target": {"tabId": "owned-tab", "chatUrl": "https://chatgpt.com/c/example-conversation"},
  "mode": "pro",
  "connectorSelected": true,
  "approvalPending": false,
  "composerSha256": null,
  "lastUserMessageId": "previous-user-message"
}
```

`composerSha256` is `null` for no body text, otherwise `textDigest(actualVisibleComposerBody)`.
Readiness accepts only empty or fully matching text, not a partial/unrelated draft. A connector
chip alone is not a body. `textDigest` rejects blank and WebGPT-connector-only bodies and malformed
Unicode; it normalizes CRLF/CR to LF and outer whitespace, preserving internal text and emoji.
Obtain a stable message identity actually exposed by the allowed browser controls. If that or the
immediate predecessor cannot be established, leave the transmission uncertain; do not invent it.

Confirmation adds exactly this `userMessage` object. Its outer `lastUserMessageId` must be the new
ID and `composerSha256` must be `null`. A newly created chat must now have an actual owned URL.

```json
{
  "id": "new-user-message",
  "previousId": "previous-user-message",
  "role": "user",
  "bodySha256": "<64 lowercase hex characters from the actual visible user-message body>"
}
```

The ID must differ from the saved pre-send ID, the predecessor must equal that saved ID, the body
must match the prepared digest, and target/mode/connector/approval checks must still pass. A cleared
composer, Send click, assistant response, old matching message or unrelated chat is insufficient.

## Observe UI transitions and exact tool calls

For every browser action, establish the owned target and the expected visible transition. After
navigation, verify the resulting URL and page control; after opening a menu or selecting a mode or
connector, verify the menu/selected control; after sending, use the message evidence above.
A successful click return only establishes that the tool accepted the action. If the state appears
unchanged, inspect the relevant control and any pending approval/loading state before deciding
whether another action is needed. Use supported state-based waits where available, never a fixed
sleep or blind repeated click. Keep the existing fill/send batch intact.

A ChatGPT tool panel may list calls accumulated across the conversation. Once work is terminal,
inspect that final list once, identify the relevant invocation by its tool name, request/call
identity and arguments/target, and open that invocation's details. If no explicit call ID is
exposed, use its observed turn/order plus tool and target; report ambiguity instead of guessing.
Do not repeatedly expand the same accumulated list, count a call on each panel view, or interpret
quoted error strings in the answer as tool failures. Actual tool status/result is evidence;
reported checks remain claims until Codex verifies them locally. Reinspect only for new calls,
changed state or a specific missing piece of evidence. Preserve the selected evidence and local
verification disposition for resumption rather than repeating completed checks.

## CLI and compact output

These commands are local-parent operations and do not read the controller key or invoke MCP:

```text
node <skill>/scripts/client.mjs dispatch preflight
node <skill>/scripts/client.mjs dispatch register <absolute-ledger.json> <absolute-spec.json>
node <skill>/scripts/client.mjs dispatch prepare <absolute-ledger.json> <absolute-readiness.json>
node <skill>/scripts/client.mjs dispatch begin <absolute-ledger.json> <absolute-begin.json>
node <skill>/scripts/client.mjs dispatch confirm <absolute-ledger.json> <absolute-confirmation.json>
node <skill>/scripts/client.mjs dispatch inspect <absolute-ledger.json>
node <skill>/scripts/client.mjs dispatch recover <absolute-ledger.json>
```

Run `preflight` in ordinary Node before controller registration. It returns
`{"runtime":"node","ready":true}` when the local dispatch helper can load; it does not establish
browser, connector, controller or project readiness. Keep those checks separate.

`begin.json` has exactly `{"prompt":"...","observation":{...readiness...}}`. A separate `prepare`
call is optional: `begin` captures and validates fresh readiness itself. Only after a successful
`begin` may the parent make the one fill/send call, followed by a narrowly observed confirmation.
If that call throws or its response is lost, run `recover` and inspect; do not run `begin` again.

Ordinary helper/dispatch CLI results contain only `state`, `mode`, `connectorRequired`,
`uiPrepared`, `submissionConfirmed`, `resendBlocked`, `needsInspection` and a fixed `reason` code.
No prompt, task token, task/tab/message ID, conversation URL, digest or raw error is printed.
Invalid JSON diagnostics also omit source excerpts. A CLI exit of zero means the state operation
was recorded, **not** that sending succeeded: check `state` and `submissionConfirmed`.
CLI failures use allowlisted `code`, `stage` and `reason` fields. Interpret those fields rather
than treating a rejected Promise's raw text as a safe diagnostic; do not print private payloads,
raw exception messages or stack traces while investigating an error.
Existing controller commands retain their contracts; notably controller `register` still returns
a private task token. Consume that result privately, not as general diagnostic output. The compact
projection does not sanitize separate browser-tool logs; constrain their returned observations too.

## Interruption and reconciliation

On resumption, run the existing controller readiness/reconciliation checks and match owned tasks
against the same private ledger. `inspect` only summarizes it; `recover` changes an interrupted
`sending` to `uncertain`, never to ready and never sends. A timeout during partial typing is not
proof of no submission. Inspect the owned draft/chat and saved controller result before deciding
what happened. `confirmDispatch`/CLI `confirm` can accept later matching evidence for the original
attempt. A controller-completed task can be collected even if its UI dispatch record is uncertain;
there is no need to resend or manufacture `submitted` to reconcile completion.

A forcibly terminated high-level caller may leave `<ledger>.dispatch.lock`. No TTL/PID-only stealing
is performed. Preserve the lock and ledger; establish that every relevant parent is stopped and
inspect the retained chat/controller before explicitly archiving the stale lock. Then use `recover`,
not another begin. Never remove a live/ambiguous owner's lock. An unreadable/corrupt ledger, changed
schema, failed publication or external edit is an inspection case, not permission to start over.
A confirmed non-submission requiring a new attempt needs an explicit operator decision and normal
task/token lifecycle handling; there is intentionally no automatic reset/retry command.

Retain chats and their private URLs by default. Do not expand task grants, bypass result integrity,
delay token retirement, clear backup checks prematurely, or touch services/ACLs/network settings.

## Validation and remaining measurements

`node --test --test-reporter=tap skills/webgpt/scripts/dispatch.test.mjs` exercises injected browser
callbacks, real filesystem publication, separate Node processes and the actual client CLI. It covers
response loss, partial typing, connector-only bodies, target/mode/approval mismatches, stale message
evidence, forced process termination, publication failures, lock conflicts and output redaction.
These tests are not a live signed-in ChatGPT/connector/browser end-to-end run. Verify the actual
adapter's supported controls and evidence contract in the authorized environment before routine use.
No token/latency savings or new transport/backend compatibility is claimed; measurement is a
separate follow-up after the minimum dispatch changes.
