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
| `read` | `prepare read` → read-only project → `read_file` / `submit_result` | Matching recorded read grant, unchanged two-file fixture, no receipts, correct defect report | Actual file-read calls and intended registration; no substitution with pasted code |
| `edit` | `prepare edit` → edit project → `write_file` / `submit_result` | Matching recorded edit grant, one expected receipt, backup/recovery checks, exact corrected bytes and behavior | Actual stale-SHA write rejection; the result's `staleWriteRejected` boolean is only a claim |
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
distinguishes controller availability, its current state observation, global health,
registered workspace identity, task recovery, result contents, fixture bytes, arithmetic
behavior and change receipts. Global health can be blocked by another active task;
inspect the existing controller diagnostics privately rather than exporting its details.
The read fixture intentionally
still computes the wrong total; its correct *review* plus unchanged source is success.
The edit fixture must exactly match the requested one-line correction. Alternative
implementations require a separately reviewed exercise, not a weakened acceptance check.
Only those exact bundled bytes are evaluated from an in-memory module, never an arbitrary
returned module, file path, subprocess or repository test command. Every check revalidates
current bytes even if Node has cached the immutable module. This is not a general sandbox.

## Verdict and exit-code contract (check report version 2)

`localVerdict` measures this task's result/fixture acceptance, not overall worker readiness
or web dispatch. It uses an explicit list of task checks, never every observation in
`checks`. `checks.globalHealth`, `dispatch` and parent-reported measurements are separate:
an unrelated recovery issue or a recorded mode mismatch does not change local PASS.
They still require investigation before operational acceptance; exit 0 is **not** permission
to collect, send again, ignore readiness or certify the requested browser mode.

| Field / outcome | Meaning | CLI exit |
|---|---|---|
| `PASS` | Completed, not discarded; owned result, recovery, fixture and recorded grant checks pass | 0 |
| `PENDING` | A supported response identifies a running task; final acceptance has not occurred | 2 |
| `FAIL` | Terminal outcome is failed/cancelled/discarded, or a task acceptance check fails | 2 |
| `BLOCKED` | Required controller/state/grant proof is unavailable, unsupported or incomplete | 2 |
| Invalid local input / no report | Unable to produce a report | 1 |

`taskStatus` makes the observed lifecycle explicit; it is null without a supported task
response. A running edit can have `files:FAIL`, `receipts:FAIL` and `result:NOT_RUN` while
`localVerdict:PENDING`. These checks compare against the final target, which need not yet
exist. PENDING is neither a claim that current files are correct nor authorization to keep
writing through a recovery warning. Read each check. Missing authoritative state or grant
proof takes precedence and yields BLOCKED even for running work.

`checks.controllerState` requires the controller's new `health.stateVerified:true`:
its ordinary state/initialization-marker check matched the owned snapshot in this response,
with no latched invalid-state fault. A failed write canary, pending state stage or unrelated
active task can make `health.ok:false` despite that successful read. Those readiness faults
remain visible but do not turn an otherwise correct result into a wrong answer. Conversely,
unreadable/changed state yields `controllerState:UNAVAILABLE` and BLOCKED, **not PASS** based
on stale in-memory task data. This is a point-in-time observation, not future writeability,
an atomic filesystem snapshot or permission to bypass the existing collection guards.

`checks.workspaceGrant` compares explicit owner metadata (`root`, `mode`, `device`, `inode`)
with the existing `grantWorkspace` descriptor of this run's fixed `project/`. `text`/`resume`
require an explicit null grant. A different root or mode, or a recreated directory with
identical content but different identity, fails. The checker never opens a root supplied
by the response and emits no path/device/inode values in its summary. Reconciliation exposes
this allowlisted descriptor only on the authenticated controller, including retired tasks;
it describes the recorded grant, not continuing file access after retirement. No task or
credential fields are added to public MCP or health output.

`browserChecked` remains false and `liveVerdict` remains `NOT_EVALUATED`, even with local
PASS and a confirmed dispatch ledger. Missing, invalid or wrong-task/mode dispatch evidence
and numeric measurements remain separate observations, never end-to-end acceptance.

**Compatibility:** check reports now use version 2 because acceptance no longer depends
on global readiness. Prepared manifests and measurements remain version 1 / unchanged.
Update the matching idle worker and parent scripts together: old responses lacking explicit
`stateVerified` or `workspace` proof produce BLOCKED/exit 2. There is no fallback to global
`/tasks`, token lookup, direct state-file reads or an unchecked collection path.

Inspect `parentMustVerify` and the actual narrow UI/tool evidence. The automated grant
comparison verifies stored identity, not the intended registration, original instructions
or proof that the browser actually used those file tools. Quoted errors and a
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
