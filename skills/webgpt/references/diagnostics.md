# Optional connection diagnostics

Use this only for an actionable connection problem, not continuous progress polling.
The controller's committed state, result hashes and recovery journals remain authoritative.
Public `GET /health` and `HEAD /health` indicate process liveness only; `HEAD` returns no
body. Other methods at that exact path return `405` with `Allow: GET, HEAD`. Origin
checks still apply, and private `ready`/`reconcile` remain on the authenticated controller.
A successful health probe does not verify the tunnel, connector, storage or a task.

## Enable deliberately

Capture is **off by default**. For a new or safely stopped, identified worker, set
`WEBGPT_MCP_AUDIT=1` in its existing authorized launch environment. Unset or `0` disables
capture; any other value is a configuration error. It is not an MCP argument and a task
cannot enable it. No configuration migration, service installation or permission change
is performed. Do not restart active work merely to turn diagnostics on; use the existing
[transition procedure](operations-windows.md#parent-resume-transition-and-rollback).

With the existing private configuration selected, examples for an ordinary local launch:

```sh
WEBGPT_MCP_AUDIT=1 node <skill>/scripts/worker.mjs
```

```powershell
$env:WEBGPT_MCP_AUDIT = '1'
node <skill>/scripts/worker.mjs
```

The existing service launcher passes its launch environment to its child. Changing a
service environment or restarting it still requires the usual explicit operational
permission; these examples do not install or reconfigure a service.

## What is recorded

Private `dataDir/mcp-audit.jsonl` and `.1` contain at most 1 MiB each. Rotation replaces
only a valid older diagnostic segment; these are disposable observations, **not recovery
journals**. Records contain generated run/request IDs, timestamps, method category,
HTTP status/aborted flag, bounded tool name, task ID when a token actually matches, tool
error boolean and elapsed milliseconds. A tool record links to its HTTP record using
a generated transport ID. The caller's JSON-RPC ID is never logged. Task IDs are local
identifiers, not credentials; do not embed secrets or personal information in them.

No prompt, input text, file/result contents, pathname, URL, header, task token, controller
key, browser data or raw exception is recorded. This restriction applies to these new
logs and the diagnostic report, not every existing CLI or browser-tool output. Do not
publish the raw private runtime or assume unrelated logs are redacted.

The writer rejects symlinks, hardlinks, invalid file types and oversized existing logs.
Existing group/other-readable POSIX logs are rejected rather than chmodded. Windows
relies on the existing private runtime ACL. A write/rotation/validation failure emits one
generic warning and disables capture for that run; it does not change a tool's outcome,
revoke a token or affect completion/collection. Late response callbacks cannot write
after runtime ownership has been released. No crash-durable audit, hostile-filesystem
isolation, per-request latency bound or measured speed improvement is claimed. Capture
adds synchronous local I/O and should stay off when it is not needed.

## Inspect one owned task

```text
node <skill>/scripts/diagnose.mjs <owned-task-id>
```

The command is offline and read-only: no controller writes, acknowledgments, cancellation,
re-registration, browser access, tunnel repair or automatic retries. It uses the existing
private configuration, validates the persisted inventory, and rechecks a retained result
with the normal expected-path, single-link and SHA-256 checks. It never follows an
artifact path supplied by state to an arbitrary location. It reads at most 32 MiB of
state and 1 MiB from each log, rejects malformed UTF-8 and unsafe files, and returns no
more than 50 recent records for the selected task. Unknown record fields are discarded.

Optional audit failures do not hide a valid task inventory or result information.
Each `audit.segments` entry identifies `previous` or `current`, with `read`, `missing`
or `unavailable` status; it contains no path or raw exception. Unsafe, oversized or
invalid-UTF-8 segments remain rejected, not repaired or treated as empty logs. The
other segment can still be read. `audit.availability` distinguishes:

- `observed`: at least one readable segment, with no detected segment/record error.
- `partial`: readable evidence exists, but a segment is unavailable or a line is malformed.
- `unavailable`: a segment could not be read and no readable segment remains.
- `not_observed`: both segments are absent.

Counters cover valid records in the readable window only, never missing traffic or
lifetime totals. Even `observed` does not imply complete capture. A malformed line
is counted and excluded, without echoing its contents. Corrupt, linked, missing or
oversized **task state** still prevents a report; optional logs cannot replace it.

`stateMarker` is `valid`, `absent`, or `invalid_or_unreadable`. Its read is capped at
4 KiB and uses the same marker-byte validator as worker startup. Absence is not by
itself corruption: valid legacy state can predate the marker. Offline diagnosis
cannot determine whether a live worker previously saw a now-missing marker.

`pendingResults` lists at most two candidate kinds (`artifact` and `temporary`) using
the existing result inspector. Each has `uncommitted` or `unreadable` integrity; only
readable candidates include byte count and observed SHA-256. No paths, contents or
native error text are returned. A hash describes candidate bytes, not a committed
result. Candidates remain visible after cancellation, and a verified collected result
can coexist with an uncommitted temporary candidate. No candidate is promoted/deleted.

Exit code 0 means a report was produced, not that the worker or task is healthy. Check
the marker, stage, candidate and audit fields separately; this is not a replacement
for authenticated `ready`/`reconcile`, journal inspection or retained-chat evidence.

`stateStage: present` means an uncommitted state candidate requires the existing recovery
procedure; the diagnostic command does not promote or remove it. `integrity: verified`
means saved bytes match their recorded hash, not that the result is correct or its tests
ran. Corrupt/unreadable state fails with a bounded error rather than a guessed inventory.

## Interpret the evidence narrowly

- `not_observed` means no log segment was present. Capture may be disabled, failed or
  rotated; absence is not evidence that ChatGPT never tried or that a platform is faulty.
- `tool_received`/`tool_completed` locate local processing. A missing completion in the
  retained window is not proof of a hung operation. HTTP errors and invalid-token calls
  are **unscoped**; do not assign them to the selected task without independent evidence.
- HTTP `finish` means Node handed the response to the operating system, not that ChatGPT
  received it. Disconnects do not cancel a task. Only saved controller state confirms
  terminal submission; inspect state/results before any retry.

A live offline read is not an atomic cross-file snapshot: state can change and log rotation
can overlap reading. Counts describe the available window, not lifetime totals. Logs are
not tamper-evident or authoritative. Preserve relevant private evidence before authorized
maintenance; never reset state or erase a journal to make a diagnostic warning disappear.

## Regression checks

`node --test --test-reporter=tap scripts/audit.test.mjs` from the installed skill checks
real loopback HTTP/MCP traffic, opt-in/disabled behavior, all seven tools, task scoping,
redaction, rotation, read bounds, link rejection, shutdown ordering and failure isolation.
`scripts/diagnose.test.mjs` additionally checks degraded audit segments, bounded marker
reads, uncommitted results, redaction and agreement with real controller warnings.
Run the full repository suite and supported OS/Node matrix before deployment. Local
fixtures do not establish live ChatGPT, tunnel or production-service compatibility.

Sources: [upstream/fork review](upstream-review-2026-09-23.md),
[Node HTTP response events](https://nodejs.org/docs/latest-v22.x/api/http.html#event-finish_2),
[HTTP HEAD](https://www.rfc-editor.org/rfc/rfc9110.html#name-head),
[OWASP logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).
