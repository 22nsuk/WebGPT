# Revision-bound worker handoff and local feedback

Use this optional aid when a manual transfer, changed assignment, dependent worker
or parent-only validation gap would otherwise require rebuilding a long brief.
It is not a mandatory step for small tasks or a replacement for direct Files access.
Reuse sufficient evidence; split work only when independent review or parallel work
outweighs briefing, review and integration costs. Keep one worker for a small stable
change. Separate specification, implementation and execution permission when those
boundaries matter, not according to model names alone.

## Establish the route once

Record observed facts and missing capabilities in the existing private task ledger.
Use `available`, `unavailable` or `unknown`, with the environment and evidence for
each fact; availability does not confer permission. Do not infer one row from another.

| Required fact | Useful evidence | If unavailable or unknown |
| --- | --- | --- |
| Parent can read the authoritative project | Exact host, root, current relevant files and actual read | Use an already authorized host with access, or stop dependent preparation |
| Browser control exists in this parent session | Supported browser tool, selected browser/profile/tab | Use supported control of an existing signed-in browser, or prepare manual delivery |
| Selected worker is signed in and has the required mode | Current UI observation | User login through the normal supported flow; no security downgrade or recovery-key workaround |
| Worker can consume the actual input | Required Files read, named input, attachment or connected object | Identify the missing route; do not send only a parent-local path |
| Worker can edit and submit a saved result | Actual tools/grant and task contract | Limit the outcome explicitly; manual attachments do not imply MCP registration or collection |
| Checks can run in the required environment | Actual sandbox/CI/local executor capability and permission | Complete independent work and name the specific parent-only validation gap |

`dispatch preflight` verifies only the ordinary Node helper, not these browser or
worker facts. A connected PC, Files tool inventory or successful login proves none
of the other rows. Investigate a missing capability once at the responsible boundary;
do not keep retrying automatic dispatch when no browser-control route exists.
Manual delivery remains subject to the user's requested outcome and transfer permission:
state the change of route and resulting limitations rather than silently claiming
an automated delegation. See [file uploads](file-uploads.md) for the actual upload path.
Files has no shell; separate sandbox/GitHub capabilities still require actual discovery.

## Freeze a small, complete input contract

The parent first reads current authoritative state and the relevant implementation,
test contracts and direct dependencies. A plan alone can omit current constraints.
Separate current decisions/constraints, required implementation inputs and background.
Enumerate only necessary files; do not send models or entire datasets by default.
List known omitted dependencies and their effect on design, implementation or validation.
An empty list of declared gaps is not proof that dependency discovery was complete.

Keep assignment ID and revision independent of model selection and the controller's
task ID/token. The brief contains scope, permitted changes, output location, completion
criteria, specification changes and how to report unrun checks. A changed model alone
does not change this contract. A changed contract requires a new revision and a short
change note. Require the worker to echo the exact applied assignment revision and
input identity in its result; compare them before acceptance.

When a predecessor specification was accepted, carry its actual files and a short
parent acceptance record into the next assignment. Include accepted hashes/version,
acceptance scope, open checks and changed conditions. Specification acceptance,
implementation acceptance and permission to execute remain separate. A recorded
acceptance decision is evidence to review, not new authority from this helper.

## Generate the optional inventory

Create a private UTF-8 JSON specification, then use ordinary Node:

```text
node "<skill>/scripts/client.mjs" handoff "<absolute-private-spec.json>"
```

The command prints one JSON packet to stdout. Preserve it in the existing private
task evidence using your host's UTF-8 file tools, then review before sharing.
It never writes files, reads service configuration, contacts a controller, executes
commands, uploads, registers tasks or changes acceptance. Source paths must be
absolute native paths on the executing host; changing a WSL/Windows/cloud path string
does not transfer bytes. Invalid input produces a generic path-redacted diagnostic.

This example is a specification template, not a dispatch request. Replace all paths
with authorized files readable by the parent. `delivery` describes the intended actual
worker access route, not a verification receipt. The helper includes no file contents.
Send the brief and required files by that route, or reuse existing direct access.

```json
{
  "assignment": {"id": "analysis-implementation", "revision": "rev2"},
  "assignee": "pro",
  "files": [
    {"label": "brief", "role": "brief", "source": "/absolute/brief-rev2.txt", "requiredFor": ["design", "implementation", "validation"], "delivery": "named input: brief"},
    {"label": "implementation", "role": "source", "source": "/absolute/project/analyzer.py", "requiredFor": ["implementation", "validation"], "delivery": "workspace: analyzer.py"},
    {"label": "accepted-spec", "role": "reference", "source": "/absolute/spec.json", "requiredFor": ["implementation", "validation"], "delivery": "named input: accepted-spec"},
    {"label": "spec-acceptance", "role": "acceptance", "source": "/absolute/spec-acceptance.txt", "requiredFor": ["implementation"], "delivery": "named input: spec-acceptance"},
    {"label": "runtime-data", "role": "source", "unavailableReason": "Not authorized for transfer; local execution remains separate", "requiredFor": ["validation"], "delivery": "not delivered"}
  ],
  "checks": []
}
```

Exactly one readable `brief` is required. Labels and assignment ID/revision use
1–64 ASCII letters, digits, dots, underscores or hyphens. Roles are `brief`, `source`,
`reference`, `acceptance`, `evidence`, `package`. Each file declares `requiredFor`
(any subset of `design`, `implementation`, `validation`, including empty) and a
nonempty `delivery` description. Use either `source` or `unavailableReason`, never
both. An optional lowercase `expectedSha256` detects changed inputs; a mismatch
remains visible as an input gap, and a missing/mismatched brief rejects the packet.
Unknown fields and duplicate labels reject rather than silently losing information.
Every list must have an explicitly supplied own entry at each index. Sparse arrays
and inherited entries reject before selected source reads; JSON `null` is not a
placeholder for a missing list entry.

Limits: specification 64 KiB; 64 selected files; 256 MiB per regular, single-link
source using the existing [artifact reader](artifact-inputs.md); 512 MiB aggregate
observed bytes (checked after each source); output 128 KiB. No directory traversal,
automatic dependency graph or archive extraction occurs. A missing source is recorded;
unsupported files, permission errors and detected changes abort without a packet.
Sequential observations are not an atomic project snapshot. Do not mutate inputs
during preparation; preserve immutable copies when actual execution needs them.

The result records brief SHA and `inputIdentitySha256` over assignment ID/revision
and sorted non-evidence/non-package file identities, roles and declared requirements.
Assignee, delivery text and check logs do not change that input identity. This is
not the packet's byte hash, archive hash, signature or remote delivery proof. It
does not detect omitted dependencies or verify the truth of the brief. Keep versions
and results private; free-text labels/descriptions/commands are not auto-redacted.

## Return only the relevant local failures

First use authorized worker checks where available. For a genuine parent-host gap,
the parent reviews source changes, dependencies, hooks and side effects before running
only the agreed checks. Record exact command/cwd/environment, allowed resources,
time/output bounds and full private log destination before execution. A command-name
allowlist alone is not isolation: a test or interpreter can execute arbitrary code.
GPU/model/integration execution remains separate from CPU fake-input checks.

Bind evidence to the bytes actually tested: use a stable copy or record and verify
the relevant before/after source identities and any concurrent changes. A later hash
scan alone does not prove what the process read. Add the preserved log as a file of
role `evidence`, then add check records to the specification, for example:

```json
{
  "id": "missing-receipt",
  "requirement": "Absent completion proof remains unknown",
  "command": "python -m unittest tests.test_evidence",
  "environment": "Ubuntu; Python 3.12; CPU fake inputs; reviewed working directory",
  "status": "FAIL",
  "exitCode": 1,
  "signal": null,
  "reason": "Expected PARTIAL, observed INVALID. Config boundary mocked; bounded excerpt in named input failure-details.",
  "testedFiles": [{"label": "implementation", "sha256": "<actual-tested-64-lowercase-hex-sha>"}],
  "evidenceLabels": ["test-log"]
}
```

Replace the placeholder hash; it is intentionally not a valid digest. This object
belongs in `checks`; add `test-log` to `files` with a real source and delivery route.
Up to 32 uniquely named checks are supported. Each record names the requirement,
command, environment, `status`, actual `exitCode` and `signal`, `testedFiles` and
`evidenceLabels`. PASS requires zero exit/no signal; PASS/FAIL require tested hashes
and evidence labels. FAIL/UNVERIFIED require a reason. NOT_RUN requires a reason and
null exit/signal and may use empty tested/evidence arrays. Each evidence label must
refer to a declared evidence file. These structural checks do not validate log contents.

Output `reportedStatus` is caller-reported. `applicability` compares the supplied
tested hashes with current observations: `stale` for a mismatch, `unknown` for missing
sources/logs or no tested files, otherwise `current`. Current means only matching
listed identities, not that the test ran, had adequate coverage or covered every
dependency. Preserve stale PASS as historical evidence; do not count it as current
validation. Empty/missing reporter output, a disconnected session or a missing log
does not establish PASS or confirmed execution failure. Use process and native test
results; reporter event counts are not test counts.

Send the small packet plus the relevant failure excerpts through existing named
inputs/attachments; metadata alone cannot replace the actual logs or specification.
Map each correction to its requirement, failing-before/passing-after evidence,
mocked boundaries and NOT_RUN checks. Keep before/after attempt records distinct,
deduplicate only by actual attempt identity, and do not add retries to improve counts.
Use the existing [terminal follow-up lifecycle](development-loop.md): reconcile any
uncertain attempt; finish disposition/collection and final chat answer before a
genuine follow-up gets its new token in the same chat. No automatic resend is added.

## Accept the actual delivered result

Confirm final submission, required deliverables and the applied revision before
review. A Library listing or partial download is not complete retrieval. Verify
that the consuming environment can read each required file, distinguish original
and corrected artifacts, and use only supported transfer alternatives after a
delivery failure. Do not drop platform metadata/security requirements as a workaround.

Hash a final archive separately with role `package` if available; this only proves
observed container bytes. Verify its required member set and member bytes using
appropriate authorized archive tooling. Individual-file hashes do not verify the ZIP;
a ZIP hash does not prove its member contents match. Record unperformed archive checks
as NOT_RUN. Likewise, submitted, retrieved, integrity-checked, tested and accepted are
different facts. Compare final claims with evidence, record accepted/partial/rejected
scope, then follow existing collection and final-answer completion rules. Neither
this packet nor collection itself makes an acceptance or execution decision.
