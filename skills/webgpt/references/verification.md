# Parent-owned delegation verification

Use this opt-in workflow for an installation change or a small operational comparison,
not on every task or every CI job. Its unit is a useful, verified delegation, not PR or
test count. Keep the existing [dispatch](dispatch.md), [collection](usage.md) and
[recovery](recovery-integrity.md) paths; do not add worker shell, Git or process authority.

## Feature / evidence map

All four exercises use the existing MCP callback. `text` means **no project grant**;
it is not the separate connector-free chat fallback. The fixtures are small, known
transport/verification exercises, not hidden benchmarks of model intelligence.

| Scenario | Parent entry / worker path | Local evidence checked | Evidence the parent must still inspect |
|---|---|---|---|
| `text` | `prepare text` → register → observed web dispatch → `read_input` / `submit_result` | Saved result hash and exact arithmetic JSON | Requested web mode, selected connector, actual new user message and useful answer |
| `read` | `prepare read` → read-only project → `read_file` / `submit_result` | Original two-file fixture unchanged, no change receipts, correct defect report | Actual file-read calls and granted read-only root; no substitution with pasted code |
| `edit` | `prepare edit` → edit project → `write_file` / `submit_result` | One expected receipt, original backup/recovery checks, exact corrected bytes and arithmetic behavior | Actual stale-SHA write rejection; the result's `staleWriteRejected` boolean is only a claim |
| `resume` | `prepare resume` once → dispatch once → terminal output → fresh parent `check` / explicit `collect --resume` | Retained result, current collection state and unchanged fixture | Same task/chat/ledger; no replacement registration, new prompt or repeated acknowledgment |

Implementation owners: [verification.mjs](../scripts/verification.mjs) prepares/checks;
[dispatch.mjs](../scripts/dispatch.mjs) owns the private send ledger;
[client.mjs](../scripts/client.mjs) owns scoped observation/conditional collection;
[worker.mjs](../scripts/worker.mjs), [workspace.mjs](../scripts/workspace.mjs) and
[results.mjs](../scripts/results.mjs) retain task authority and evidence validation.
[verification.test.mjs](../scripts/verification.test.mjs) checks the parent helper using
real loopback controller/MCP traffic, **not a browser or model**. Existing dispatch,
collection, recovery and workspace suites remain the deeper contract tests.

## Prepare without side effects on the controller

Use matching scripts through ordinary Node and an identified private `WEBGPT_CONFIG`.
Keep `WEBGPT_DATA_DIR`, if set, consistent with it. Do not point a verification run at
production project files. Create its new absolute directory under an existing private
parent, outside the worker runtime and installed skill. Check that the worker and
connector being tested are the intended instance; `/health` is not readiness.

```text
node <skill>/scripts/client.mjs dispatch preflight
node <skill>/scripts/client.mjs ready
node <skill>/scripts/verification.mjs prepare <text|read|edit|resume> <new-absolute-run-dir> <pro|xhigh>
```

`prepare` creates `verification.json`, `request.json`, `measurements.json` and, for
read/edit, `project/orders.json` plus `project/total.mjs`. It does not register a task,
open a browser, start a worker, generate credentials or send a prompt. Existing run
paths are refused, including partial preparations. Inspect any partial directory;
never use a new one to bypass an already attempted send. The static manifest identifies
an exercise; it is not another completion ledger. Keep the request/manifest unchanged.
POSIX creation modes do not replace appropriate Windows ACLs on the private parent.

## Run the existing delegation path

Read the generated request and register it **once** using the identified controller:

```text
node <skill>/scripts/client.mjs register <run-dir>/request.json
```

The registration response contains a task token: capture it privately under the run
(e.g. `registration.json`), never in normal commentary or a public log. Privately build
the prompt for that exact task/token. Use `<run-dir>/dispatch.json` as the one existing
parent ledger, following [dispatch.md](dispatch.md). The helper's normal observe/begin/
confirm contracts still apply: save intent before sending, inspect the actual new user
message, and never substitute a connector chip, an empty composer or a fabricated
observation. Preserve required approvals and the requested Pro/Extra High mode. No
browser selector, session cookie or private API shortcut is supplied here.

```text
node <skill>/scripts/client.mjs wait <task-id>
node <skill>/scripts/verification.mjs check <absolute-run-dir>
```

`check` requests only the owned scoped reconciliation. It neither acknowledges nor
cancels, registers, retries, dispatches or deletes work. It reuses bounded result/ledger
readers; the controller may still perform its usual readiness canary and live quarantine
observation. Reading the dispatch ledger briefly takes its existing cooperative lock.
Do not run this checker concurrently with the parent's ledger mutation.

Keep each report separately (e.g. `local-before.json`, `local-after.json`). `checks`
distinguishes controller availability, global health, task recovery, result contents,
fixture bytes, arithmetic behavior and change receipts. Global health can be blocked by
another active task; inspect the existing controller diagnostics privately rather than
exporting that task's details here. The read fixture intentionally
still computes the wrong total; its correct *review* plus unchanged source is success.
The edit fixture must exactly match the requested one-line correction. Alternative
implementations require a separately reviewed exercise, not a weakened acceptance check.
Only those exact bundled bytes are evaluated from an in-memory module, never an arbitrary
returned module, file path, subprocess or repository test command. Every check revalidates
current bytes even if Node has cached the immutable module. This is not a general sandbox.

**Exit 0 means local fixture PASS only.** Exit 2 means PENDING, BLOCKED or FAIL; exit 1
means invalid input or inability to produce the report. `browserChecked` is always false
and `liveVerdict` is always `NOT_EVALUATED`, even with a confirmed dispatch ledger. The
ledger records prior parent observations; it cannot independently prove current UI state.
Missing, invalid or wrong-task/mode dispatch evidence and numeric measurements are reported
separately; they do not erase valid local evidence or confer end-to-end acceptance.

Inspect `parentMustVerify` and the actual narrow UI/tool evidence. Quoted errors and a
`staleWriteRejected: true` result are not proof of an invocation: match the real `write_file`
call, task, expected old SHA and rejected response; confirm no second change receipt.
Read and judge the full answer/diff privately. A correct fixture result is not evidence
that reported tests ran or that unrelated production work is correct. Record a private
accepted/rejected/partial disposition with evidence references in the existing parent
ledger. Only then use the normal explicit collection path:

```text
node <skill>/scripts/client.mjs collect <task-id>
node <skill>/scripts/verification.mjs check <absolute-run-dir>
```

For `resume`, stop only the parent observation after terminal output; preserve the worker,
run directory, ledger and chat. A fresh parent first runs `check`, performs the missing
UI/evidence review, then explicitly runs `collect --resume <task-id>`. **Resume may collect
an uncollected task**; it is not always read-only. Run it again from a fresh parent after
collection and verify `disposition: already_collected` without new acknowledgment. Do not
prepare a second resume run, re-register or redispatch. Record both observations. Retain
the chat and evidence; close only verified owned terminal tabs. Failure is not deletion
consent. Follow the normal recovery policy instead of removing candidates to make PASS.

## Comparable measurements, not inferred savings

Fill only observed nonnegative integer fields in `measurements.json`; retain `taskId`.
Unknowns stay `null`, not zero. The checker rejects extra fields and strings, and labels
accepted numbers `parent_reported`. This is input validation, not independent metering.
Keep raw supporting evidence privately; the summary emits no prompt, token, URL, tab,
result body, arbitrary path, error stack or caller-supplied free text.

| Field | Counting boundary |
|---|---|
| `browserToolCalls` | Parent browser tool invocations from UI preparation through submitted-message confirmation; count a call once, not once per panel view |
| `returnedBytes` | UTF-8 bytes actually returned by those browser observations; a context proxy, not model tokens |
| `parentInterventions` | Unplanned corrections/recovery actions needed to obtain useful output, excluding planned approvals and final review |
| `sendAttempts`, `duplicateMessages` | Actual send-capable actions and observed extra user messages for the same task; absence of observations is unknown |
| `endToEndMs` | Wall-clock elapsed registration start → completed parent acceptance/collection; includes model wait and parent pauses |
| `inputTokens`, `outputTokens` | Actual provided usage totals for this run under a consistent provider/account boundary; never convert bytes to tokens |

When a task-bound `dispatch.json` exists, the checker exports recorded wall-clock intervals
for ledger registration → last preparation, preparation → sending and sending → confirmation.
Missing/reversed timestamps yield `null`. These are not model compute time, complete task
latency, automatic usage billing or a live browser timer. Pauses/clock adjustments can affect
them. Uncertain sends have no confirmed-send interval and must not be treated as success.

Compare the same scenario, mode, script revision and environment before/after; keep failure,
blocked and intervention cases in the denominator. Report useful accepted runs / attempted
runs with the sample count, correction burden and metric availability. Do not pool different
scenarios or replace missing cost with zero. Four smoke cases do not establish a reliable
success rate or quota saving. Measure the baseline before selecting a performance claim.

## Boundaries and follow-up

This workflow supplies a repeatable parent path and an evidence map, not autonomous outer-loop
scheduling, a browser adapter, a deployment or a general code-quality evaluator. Without
actual signed-in browser access, record the live phase as NOT_RUN and test only the local
helper; do not fill UI observations with stubs and call that an end-to-end trial. Keep
local fixture, parent-recorded observation and independently confirmed live evidence separate.

After a few live runs, prioritize the dominant measured costs (UI preparation/recovery,
large repeated `read_input`, or shared-state I/O). Do not add a worker pool, new transport,
privileges, integrity cache, database or automatic evidence deletion without that need.
Durable code paths and executable checks come before more general prompt rules. Useful
boundary comments are retained; no blanket no-comments rule or external framework is imported.
