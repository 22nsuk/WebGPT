# Parent dispatch: one ledger, one attempted transmission

This is parent-side bookkeeping for the existing authorized browser workflow, not another MCP
server, queue, browser SDK or completion protocol. Use it after controller registration (when a
connector is needed), before sending. `submitted` means that matching UI evidence was observed;
only the controller establishes task completion, saved-result integrity, acknowledgment and token
retirement. Existing wait/collect behavior and default chat retention are unchanged.

## Private ledger and state

Choose **one canonical private JSON ledger per task** in an existing private directory outside the
project/skill. All cooperating parents, CLI calls and resumed sessions must use that same file.
Dispatch commands extend its `dispatch` property and preserve other objective, ownership, output,
work/cleanup and handoff fields. Optional `record-review` appends separate `reviewEvidence`
observations after confirmed dispatch; `inspect-review` reports their latest summary without
changing dispatch or controller state. See [review-evidence.md](review-evidence.md).
Do not point the ledger helper at controller `state.json`, configuration, or a
multi-task ledger. Migrate the relevant task record explicitly first; never initialize a new ledger
for an already-dispatched task merely because its old record lacks this schema. Keep the original
record/evidence and reconcile the retained chat/controller before adopting the new flow.

The `dispatch` record holds task ID, requested mode, connector requirement, prepared-body digest,
owned tab/chat, timestamps and bounded before/after message evidence. It never stores the prompt
or task token itself. Other existing ledger fields may contain secrets: the **whole file remains
private**. Use a private payload file or in-memory object, not secret text in shell arguments.

`registered -> sending -> submitted|uncertain`

An explicit preparation checkpoint remains available: `registered -> prepared -> sending`.

Registration is idempotent only for the same task, body digest, mode, connector requirement,
required attachment names (when declared) and initial target. It cannot reset any transmission. Preparation records the narrowly observed UI;
`begin` publishes fresh readiness and `sending` together in one flushed replacement before any
send-capable browser action; it does not separately save an intermediate `prepared` state. The
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
and observations. Do not run this helper's ledger/controller lifecycle inside the managed CUA
runtime. Use only the browser tool's supported private evidence-transfer capabilities between
those roles. A generic MCP server `cwd` setting does not configure that managed runtime.

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

For text-only tasks, call `dispatchPrompt(ledgerPath, preparedPrompt, adapter)`. The adapter contains exactly three
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

Text-only confirmation adds exactly this `userMessage` object. Its outer `lastUserMessageId` must be the new
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

### Required attachments use the split CLI and a deferred confirmation

For a **new attachment-dependent task**, add `requiredAttachments` to the initial private dispatch
registration specification (not controller registration). Omit it for text-only work:

```json
"requiredAttachments": ["source-A.pdf", "source-B.csv"]
```

The helper stores a version-2 dispatch record with those immutable names. Re-registering cannot
change/remove them or upgrade an existing version-1 record. Input order is irrelevant. Use 1–32 unique,
exact, case-sensitive visible basenames, each at most 255 UTF-8 bytes, with no paths, control characters
or leading/trailing whitespace. These are local evidence bounds, **not provider upload limits**.
Duplicate, truncated or ambiguous display names cannot establish identity; stop for inspection rather
than guessing, silently renaming originals or changing the requirements. Keep source paths/digests
and stronger identity evidence in the existing private task record, not the bounded observation.

Follow [file-uploads.md](file-uploads.md): verify the actual browser/profile, source host and supported
upload action. Use split CLI `begin` **before any upload-capable action**. Only the caller whose locked
begin succeeds may continue that uninterrupted attempt. A failed begin or resumed `sending`/`uncertain`
state permits inspection, not another upload. For version 2, `dispatchPrompt` rejects with
`DISPATCH_ATTACHMENTS` before any browser callback; use the split workflow, not a downgraded record.

After begin, upload once and observe every required file ready in the exact owned composer before
batched body fill/send. Pre-send readiness remains the parent's responsibility. After sending, inspect
the same actual new user message. Add this field **inside its `userMessage` observation**:

```json
"attachmentNames": ["source-A.pdf", "source-B.csv"]
```

Report the complete observed list of ready attachments, not expected names echoed from registration,
not draft chips and not another message's files. All existing body/target/mode/predecessor checks still
apply. Missing, duplicate, extra or mismatched names prevent confirmation and leave `uncertain` with
`evidence_unconfirmed`, inspection required and resending blocked. A subsequent matching observation
can confirm the original attempt without another begin, upload or send. A second identical confirmation
is idempotent; incomplete evidence cannot downgrade an already submitted record.

Version-2 compact output adds only `requiredAttachmentCount` and `attachmentEvidenceConfirmed`.
The latter means matching **reported UI name/count evidence**, not independently verified uploads,
remote bytes, parsing or model usage. The helper cannot detect fabricated observations, distinguish
different bytes with the same basename, inspect a browser or enforce instructions on callers that
bypass it. Do not substitute controller completion or `collected:true` for attachment/content review.

Text-only records and observations remain version 1 with their original output shape. Older helpers
reject version 2 instead of silently treating it as text-only; install matching parent scripts and
instructions together before starting new attachment tasks. No worker/MCP schema change is required.
Do not reset, rewrite or auto-upgrade retained version-1 records. Their body-only `submitted` is still
valid body evidence, but required attachments need independent review before accepting the work.
Keep the original requirements and any valid body evidence when a check is unfinished.

This extends the existing ledger schema, not its states/locks or an upload transport. `sendingAt`
precedes upload here, so confirmation time includes upload/review, not pure send latency. Preserve
partial results and inspect a confirmed non-submission before an explicit operator decision; no
automatic retry, repair, replacement task, collection bypass or service change is added.

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

Wait for `register` to finish successfully before calling `begin` on the same ledger. Programmatic
callers must `await` each in order, not launch them together with `Promise.all`. A separate `prepare`
is optional: `begin` captures and validates fresh readiness itself. Its private payload has exactly
`prompt` and `observation`, not the registration spec or a bare readiness object:

```json
{
  "prompt": "Review the assigned task and return the requested evidence.",
  "observation": {
    "target": {"tabId": "owned-tab", "chatUrl": "https://chatgpt.com/c/example-conversation"},
    "mode": "pro",
    "connectorSelected": true,
    "approvalPending": false,
    "composerSha256": null,
    "lastUserMessageId": "previous-user-message"
  }
}
```

These are illustrative values, not observed UI evidence. Use the registered prompt and freshly
observed owned-target readiness. Only the caller whose `begin` succeeds may continue that
uninterrupted attempt: upload if required, observe readiness, fill/send once, then confirm from the
actual new message. After a lost response or interrupted attempt, use the reconciliation table
below; never repeat `begin` to find out whether the earlier action ran.

Text-only helper/dispatch CLI results contain only `state`, `mode`, `connectorRequired`,
`uiPrepared`, `submissionConfirmed`, `resendBlocked`, `needsInspection` and a fixed `reason` code.
Version-2 attachment tasks additionally expose `requiredAttachmentCount` and `attachmentEvidenceConfirmed`;
filenames remain private. A CLI exit of zero means the state operation succeeded, **not** that
sending succeeded: check `state` and `submissionConfirmed`.

Failures retain exactly `code`, `stage`, `reason`, `message`, with fixed text and WeakMap-backed
trusted diagnostics. No prompt, token, path, tab/chat/message identity, digest, JSON excerpt or
stack is printed. `<action>` below means one of the fixed supported command names, never an echoed
unknown argument. Existing storage, lock, ledger-validation and resend-blocked diagnostics retain
their meanings.

| Stage | Reason examples | Interpretation |
| --- | --- | --- |
| `cli_arguments` | `invalid_arguments`, `unknown_action`, `begin_arguments_invalid` | Invalid argument vector, unsupported action or wrong action-specific argument count; no file access. |
| `cli_arguments` | `<action>_ledger_path_invalid`, `<action>_payload_path_invalid` | Expected a well-formed Unicode absolute ledger `.json` path or absolute payload path; no file access. |
| `payload_read` | `<action>_payload_missing`, `<action>_payload_file_invalid` | Missing payload, unsafe type/link, oversized data or changed file identity; not a corrupt task ledger diagnosis. I/O failures still use `DISPATCH_STORAGE` and its fixed reason. |
| `payload_decode` | `<action>_payload_utf8_invalid`, `<action>_payload_json_invalid` | Payload bytes could not be decoded or parsed; no parser excerpt and no ledger mutation. |
| `payload_validate` | `register_input_shape_invalid`, `begin_input_shape_invalid` | Wrong top-level routing fields, rejected before taking a ledger lock. |
| `payload_validate` | `begin_input_invalid`, `prepare_input_invalid`, `register_input_invalid` | A core input/observation check rejected the value. Existing readiness, stored-ledger and conflict checks are not relabeled as input errors. |
| `ledger_path` | `native_path_not_utf8` | The canonical ledger path cannot be represented as UTF-8. `DISPATCH_LEDGER` refuses it before locking or writing; this is not a payload error. |

A decodable but incomplete `confirm` observation deliberately keeps the existing behavior: it
records `uncertain`/`evidence_unconfirmed` and can exit zero, or refuses to downgrade `submitted`.
Invalid JSON cannot reach that check and leaves the prior state unchanged. Neither case permits a
resend. An input error describes this invocation; it does not prove that no earlier attempt ran.
`DISPATCH_LOCKED` is not an instruction to add `await` and retry: another parent may own the lock.
Inspect ownership and retained state rather than stealing the lock, registering a replacement ID
or uploading again. Interpret trusted diagnostics instead of printing rejected Promises or payloads.

Existing controller commands retain their contracts; notably controller `register` still returns
a private task token. Consume that result privately, not as general diagnostic output. The compact
projection does not sanitize separate browser-tool logs; constrain their returned observations too.

## Interruption and reconciliation

On resumption, use the existing controller readiness/reconciliation checks and match owned tasks
to the same private ledger. `inspect` summarizes recorded evidence, not the live UI; `recover`
changes interrupted `sending` to `uncertain`, never to ready and never sends. Keep UI submission,
result collection and final-answer completion as separate observations:

| Observed state | Next permitted step | Boundary |
| --- | --- | --- |
| `registered`/`prepared`, no previous attempt | Verify fresh owned UI and inputs, then continue the existing sequential `begin` path. | A sample or stored summary cannot replace live readiness. |
| `sending`/`uncertain` | Inspect the original chat, required attachments and controller; use late matching evidence to `confirm` the original attempt. | No new begin, upload, send, ledger or replacement task to bypass uncertainty. |
| Controller terminal, dispatch uncertain | Collect the verified saved result through the existing conditional collection checks when recovery is clear. | Collection does not establish UI submission, attachment bytes/use, result quality or completed final chat text. Do not manufacture `submitted`. |
| Recovery warnings or uncommitted result | Preserve source/result/journal candidates and obtain the authorized recovery disposition. | No normal collection or `/ack` bypass, journal reset or automatic replay. |
| Already collected | Reuse the verified disposition and finish independent final-answer observation/preservation. | Do not repeat collection, whole-system checks or transmission merely to clear a UI uncertainty. |

Collect a verified terminal result promptly to retire its task token; do not keep authority live
solely while waiting for chat text. `submit_result` closes project-file access and backup deadlines,
not the independent final answer. Submission or collection alone never authorizes pressing Stop,
cancelling generation or deleting the chat. Preserve the completed final answer before closing the
owned tab, following [parent-workflow.md](parent-workflow.md) and [chat-lifecycle.md](chat-lifecycle.md).

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
`dispatchAttachments.test.mjs` additionally exercises version-1 compatibility, declared attachment
requirements, incomplete/mismatched evidence, duplicate begins and fresh-process CLI resumption using
explicit UI fixtures. `dispatchCli.test.mjs` checks action-specific diagnostics, refusal before
ledger writes, forged diagnostics, v1/v2 CLI compatibility and real Worker conditional collection
independent of uncertain UI records, including recovery refusal. The repository test runner discovers
all three files without a separate runtime or new workflow.

These tests are not a live signed-in ChatGPT/connector/browser end-to-end run. Verify the actual
adapter's supported controls and evidence contract in the authorized environment before routine use.
No token/latency savings or new transport/backend compatibility is claimed; measurement is a
separate follow-up after the minimum dispatch changes.
