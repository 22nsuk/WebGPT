# Focused development without a remote shell

Use the normal [parent workflow](parent-workflow.md): one coherent assignment,
`review` → parent checks/disposition → `collect`. This page is for code/test work,
not another preflight checklist. The seven tools, project grant, 1 MiB UTF-8 file
limit, recovery evidence and separate acceptance/collection remain the boundary.

## 1. Send one useful validation handoff

Before dispatch, agree on the owned change and the project's existing focused
checks. The worker supplies changed paths/receipts, rationale, expected behavior
and proposed checks; a proposed command is evidence, not permission to execute it.
The parent reviews executable changes and runs authorized checks in its local
host. Where separately connected GitHub tools are available and publication/CI is
assigned, the worker can inspect those actual remote results directly instead of
asking the parent to copy them. This does not provide local execution through MCP.

Run the relevant independent checks together before one focused correction, rather
than opening a new task for every assertion. Stop a dependent check if its required
build/setup failed and record NOT_RUN, not a speculative result. Return:

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

The reporter emits only unexpected `test:fail` events, with test location,
error/cause message, stack and Node/platform/architecture. It retains at most 12
failure events and 32 KiB total, marks clipped fields and counts omitted failures.
It does not parse unstable TAP presentation, buffer passing-test output, capture
stdout/stderr/environment variables, or run anything. Nested suite/file failure
events may describe the same cause; `observedFailures` is **not a test count**.
The test name/file/line identify its declaration; the stack may identify the actual
assertion. TODO/skip failures are excluded, not relabeled passing checks.

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
must still fit 1 MiB; NUL/binary files remain unsupported. This reduces request text,
not server hashing, snapshot reads or recovery cost. The 8 MiB wire-body ceiling also
remains. A failed/uncertain response is not authorization to repeat a write.

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
no migration. Binary, >1 MiB and CLI-centric tasks remain parent/native work or
explicitly scoped analysis, not a reason to widen this connector's authority.

## 3. Keep the healthy route short

Reuse the unchanged session's established setup evidence and the `review` result;
keep per-task grants, per-send checks, parent acceptance and fresh `collect` checks.
Do not add `ready`, full reconciliation, a connection probe, a full directory walk
or this page to every healthy iteration. Read the affected recovery guide only for
an actual interruption/conflict/notice. Batch real findings, not extra diagnostics.
