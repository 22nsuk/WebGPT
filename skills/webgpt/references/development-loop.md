# Focused development without a remote shell

Use the normal [parent workflow](parent-workflow.md): one coherent assignment,
worker validation/correction → `review` → gap-only parent checks/disposition → `collect`. This page is for code/test work,
not another preflight checklist. The seven tools, project grant, 10 MiB UTF-8 file
limit, recovery evidence and separate acceptance/collection remain the boundary.

<a id="1-send-one-useful-validation-handoff"></a>

## 1. Keep validation and correction with the worker

For a revised/manual assignment or a host-only check handoff, use the optional
[revision-bound handoff](worker-handoff.md). It inventories selected inputs and
compares caller-reported tested hashes, without running commands or granting authority.

Before dispatch, name the authoritative source revision/workspace, desired outcome,
authorized actions and any known parent-only check. The worker owns the available
checks and corrective iterations, not just test-code authoring. Discover only the
needed capabilities in that worker session; an absent MCP shell does not mean an
absent sandbox or GitHub connection, and a listed tool does not authorize its use.

Use an available authorized worker sandbox for suitable checks of an exact source
copy, or inspect the task branch's actual CI through connected GitHub tools when
publication is authorized. Record which files/revision and environment were tested;
a partial copy is not a full checkout, and sandbox/CI PASS is not local-installation
PASS. Use only inputs authorized for that environment; never transfer credentials
or bypass approvals to obtain execution. Review executable changes and side effects
before running checks within the granted permissions.

Fix actionable failures and inspect subsequent results within the same active
assignment before `submit_result`. Do not return an initial patch for the parent
to debug when the worker can complete the remaining authorized work. Batch related
findings; do not create one task per assertion. Stop dependent checks after failed
setup/build and mark them NOT_RUN. Do not rerun unchanged failures until green.

### Parent assistance is the exception

When a required check genuinely needs the parent's host, unavailable inputs or a
user-only approval, finish independent worker work and report the smallest gap:
why that environment is needed, the exact proposed check, expected evidence and
tested revision. A proposed command is evidence, not permission to execute it.
The parent reviews the command/side effects, runs only authorized missing checks
and returns related failures together. There is no live execution request queue:
use the existing terminal handoff/new-assignment lifecycle below, not a new tool,
blocked pseudo-callback or early success claim. Include:

```text
Revision: tested commit plus dirty-file whole SHA-256 / relevant change receipts
Environment: OS, Node/tool version, working directory; no credentials
Checks: exact approved command, actual exit code/signal, PASS/FAIL/NOT_RUN
Failure: test name, file/line, expected behavior, bounded actual error excerpt
Scope: the required correction and unaffected contracts; distinguish hypotheses
Evidence: full private log location and any omitted/truncated details
```

Bind results to the files actually tested; later edits invalidate affected results.
If the prior task is terminal, finish its disposition/collection and final chat
answer, then register a new ID/token in that same retained chat. Do not reuse closed
authority or resubmit an uncertain attempt. No automated follow-up registration,
command execution, acceptance, retry-until-green or global test rerun is introduced.

### Bounded Node test feedback

For a project's authorized `node --test` workflow, the installed
`scripts/test-feedback.mjs` is an optional second reporter:

```text
node --test --test-reporter=tap --test-reporter="<reporter-file-url>" --test-reporter-destination=stdout --test-reporter-destination="<private-dir>/test-feedback.jsonl" <owned-test-file>
```

Use the reporter's absolute `file:` URL as `<reporter-file-url>` (for example,
`file:///C:/path/to/webgpt/scripts/test-feedback.mjs` on Windows). Generate it with
Node's `pathToFileURL(absoluteReporterPath).href` so spaces, Unicode and reserved
characters are encoded correctly; a bare Windows drive path is not an ESM URL.

The parent creates/selects a private output directory and preserves the original
command status and normal log. Use a new output path per run; Node's reporter
destination is not an evidence-preserving append store. Read/review the small JSONL
file and supply its text in a named `inputs` value for the next task; the worker
uses `read_input`. Do not supply a parent-local path as though the web worker can
read it without a grant. Other test frameworks keep their own native reports.

The reporter emits unexpected failed `test:complete` events (`details.passed:false`),
with test location, error/cause message, stack and Node/platform/architecture.
Completion order lets a later parallel failure appear while an earlier test is
still running. Declaration-order `test:fail` mirrors are ignored, not stored for
deduplication; distinct completions with identical names remain distinct evidence.
Untyped hook failures are the exception: root `after()` hooks can emit only
`test:fail`, so those events are retained. Early Node 22 also omits type metadata
for ordinary test hooks; their failures use `test:fail` instead of `test:complete`
and therefore retain declaration-order timing. Typed test/suite hook failures use
completion order. This avoids name/path guesses, version checks and duplicate caches.
It retains at most 12 failure events and 32 KiB total, marks clipped fields and counts omitted failures.
It does not parse unstable TAP presentation, buffer passing-test output, capture
stdout/stderr/environment variables, or run anything. Nested suite/file completion
events may describe the same failure cause; `observedFailures` is **not a test count**.
In particular, a file-completion summary can add an event that Node suppresses in
its declaration-order output. Counts and entry order can differ from older reports;
use TAP/process evidence for the run verdict, not this event counter.
The test name/file/line identify its declaration; the stack may identify the actual
assertion. TODO/skip failures are excluded, not relabeled passing checks. Empty
string reasons still mark those outcomes; explicit false does not. The repository's
installed-suite summary retains TODO counts separately alongside passed, failed,
cancelled and skipped counts, so a successful process does not hide pending tests.

Failure entries are written as they arrive, inside one bounded JSON document,
not buffered until the last test finishes. Normal stream exhaustion still produces
one version-1 JSONL record with the same fields and final counters (including the
existing `evidence:node-test-failure-events` label); consumers must parse the complete
document rather than depend on object-key or chunk order.
If the stream throws, stalls or its process is killed, an already emitted prefix
may survive but lacks final counters and closing syntax. Treat it as incomplete
failure evidence, not a JSON report; do not append guessed totals or closing braces.
The reporter cannot expose events Node has not delivered, force pipe/file flushing,
or guarantee crash durability. Actual exit status, teardown and full logs remain
separate evidence. Interrupted output may still contain private assertion text.

An empty/missing report is **not PASS**: startup crashes, interruption or other
process failures may emit no test events. `processExitCode` and `revision` are
intentionally null; attach the parent's real process and tested-revision evidence.
The report is not automatically redacted: names, paths, assertions and stacks can
contain private data. Review before sharing and retain the full private log when
fields were clipped or events omitted. Nothing is automatically posted to a chat
or PR. WebGPT's repository runner adds this reporter beside TAP, preserving its
phase ordering, concurrency, exit handling and installed-layout checks. Each installed
test-file runner also loads the reporter from the copied skill, not the repository.
On failure, its existing `stderr tail` includes that file's bounded failure events,
even when later TAP diagnostics have displaced the assertion from `stdout tail`.
A synchronous progress-output exception stops that reporting slot without retry.
The runner retains the completed file outcome and both errors, waits for the other
active slot, and keeps its existing conservative cleanup policy. Output failure
after a passing file still fails the run; async stream errors are not handled by
this synchronous callback guard.
The outer installed-layout summary may still name only the harness: inspect the
matching `[installed] FAIL` detail first, rather than rerunning just to recover an
early assertion. Limits apply per test-file process, not to the whole installation;
omitted events, startup/timeout failures and other missing evidence still need the
ordinary logs. A missing/broken installed reporter fails the check, with no fallback.
Healthy runs keep the existing START/DONE progress and add no failure report.

## 2. Send only a small, exact edit when appropriate

For full-file creation/replacement, the existing `write_file` contract is unchanged:
read the entire file before replacing it; null `expectedSha256` creates a new file.
For a small change in an existing file, use the optional **`oldText`** argument:

```json
{
  "token": "<current private task token>",
  "path": "src/example.mjs",
  "expectedSha256": "<whole-file SHA-256 from read_file>",
  "oldText": "const retries = 2;",
  "text": "const retries = 3;"
}
```

Here `text` is the literal replacement, not the full body. Read enough relevant
context to justify the change; a bounded `read_file` window can supply the exact
old text and whole-file SHA. The worker requires exactly one nonempty literal
match (including overlapping occurrences); absent/ambiguous matches, no-ops,
malformed text and a stale hash reject before mutation evidence is created.
There is no regex, fuzzy patch, normalization, replacement-string expansion or
"replace all". Empty replacement text removes the matched span. Include unchanged
context to disambiguate; do not guess a repeated occurrence. Use a full replacement
for broad changes rather than many tiny calls and recovery journals.

The service constructs the new full text from its validated current snapshot, then
uses the **same** backup, whole-file conflict recheck, permissions-preserving write
and recovery receipt. Unrelated bytes, BOM and newline style are retained. The result
must fit 10 MiB, as must each supplied `text` and `oldText` value when encoded as UTF-8;
NUL/binary files remain unsupported. For small changes in larger files, use the needed
read windows and a small, unambiguous old span. This reduces transferred text, not server
hashing, snapshot reads or recovery cost. The MCP request-body ceiling is 128 MiB to
allow JSON escaping; it does not expand the decoded-text or 1 MiB result limits.
A failed/uncertain response is not authorization to repeat a write.

### Pin subsequent read windows

After the first `read_file`, pass its whole-file `sha256` as optional
`expectedSha256` along with the same path and the next offset. A changed or deleted
file rejects instead of returning a page from a different revision. No cache or
snapshot session is retained; each call still checks the whole bounded file.
`expectedSha256` alone preserves a full-file response. `read_input` and directory
cursors keep their existing contracts. A mismatch means inspect/restart reading,
not retry a write with a newly substituted hash.

Use these arguments only when the actual installed connector advertises them.
Update matching scripts through the existing stopped-worker process and refresh
its schema when needed; do not silently drop `oldText` on an older worker (that
would turn replacement text into a whole-file overwrite). Existing callers need
no migration. When required binary, >10 MiB or native CLI evidence exists only on
the parent's host, use the optional parent-only [artifact input helper](artifact-inputs.md):
fingerprint the approved source once, select bounded text/hex windows, review the
new evidence and pass its text in named `inputs`. First reuse adequate evidence
already accessible to the worker; do not make the parent extract it again. The
helper adds no worker tool, command queue, upload or permission expansion. It does
not authorize native execution or large/binary writes on the parent's host.

## 3. Keep the healthy route short

Reuse the unchanged session's setup evidence, the `review` result and sufficient
revision-bound worker/CI checks. Additional parent tests need a concrete risk,
missing evidence, changed files or environment gap, not a blanket duplicate suite.
Keep per-task grants, per-send checks, parent acceptance and fresh `collect` checks.
Do not add `ready`, full reconciliation, a connection probe, a full directory walk
or this page to every healthy iteration. Read the affected recovery guide only for
an actual interruption/conflict/notice. Batch real findings, not extra diagnostics.
