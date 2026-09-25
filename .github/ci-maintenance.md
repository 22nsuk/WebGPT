# CI dependency maintenance

## Test execution budget

CI and local repository validation use `node tests/run.mjs`. The runner discovers
all shipped and repository `*.test.mjs` files without shell globs, runs repository
tests first, then the standalone installation test. The installation test still
copies the complete skill and runs every shipped test with no surrounding repo.
The repository command uses `--test-concurrency=2`. The installation harness
discovers every shipped test file, including nested files, and runs independent
Node test commands from the copied skill with at most two active files. This avoids
overlapping whole-suite runs and host-CPU-dependent fan-out without changing
concurrency scenarios inside tests, retrying failures or skipping checks.

The installation deadline is per active file: 120 seconds on Windows and 60 seconds
elsewhere. Previously the same deadline covered the entire growing shipped suite;
Windows/Node 22 completed the equivalent repository phase in 149.8 seconds and
repeatedly exceeded the installed total limit. Applying the budget to a file makes
it independent of suite size. Existing individual test/request deadlines and the
ten-minute CI job limit remain unchanged; this is not a fixed speedup claim.

The harness logs each file's start, finish and elapsed time as it runs, retains a
bounded output tail for failures, and sums all TAP results. Normal failures do not
skip queued files. On a file deadline it terminates the tracked live runner's tree
on Windows or its process group on POSIX, then waits for stream closure. This is
test-fixture ownership, not containment of arbitrary detached descendants. If
termination cannot be confirmed, it fails and preserves the installation directory.
Cleanup uses bounded asynchronous retries and preserves the primary execution
failure when cleanup also fails. Async copying also avoids a reproduced Node 22
native crash in recursive `cpSync` from a Unicode checkout path.

For an installed skill alone, run
`node --test --test-concurrency=2 --test-reporter=tap` from its directory.
Bare `node --test` uses Node's CPU-dependent concurrency and can overlap the
repository's installation test with other files; use the runner above for CI parity.

### Avoid duplicate event runs, not coverage

All nine OS/Node combinations still run on each pull request, on pushes to `main`,
and on manual `workflow_dispatch`. Feature-branch pushes no longer start a second
matrix alongside the pull-request event. The two old event types used different
concurrency groups, so `cancel-in-progress` did not eliminate that duplication.

A branch without an open pull request now has no automatic push run. Open a PR,
use the manual workflow, or run `node tests/run.mjs` locally for that branch.
This removes one nine-job matrix per update to an open same-repository PR; it does
not halve every repository run or promise a fixed saving in billed CI time.
Event filtering leaves the repository and standalone coverage, assertions and
action pins unchanged. The installation deadline ownership is described above.

## Action dependencies

The test workflow pins executable actions to full 40-character commit SHAs.
Keep a release-version comment on the same line so reviews and Dependabot can
identify the release. Major and patch version tags alone are not fixed revisions.

For an action update, verify that the proposed SHA belongs to the official action
repository and its intended release, review the release notes and relevant changes,
and check the test matrix before merging. Dependabot proposes weekly GitHub Actions
version-update PRs (at most two open); this configuration does not enable auto-merge
or grant the test workflow permission to write to the repository. Version-update
PRs are not proof of a security audit or a guarantee of vulnerability alerts for
SHA-pinned dependencies.

Preserve `contents: read`, `persist-credentials: false`, disabled package-manager
caching, hosted runners, the ten-minute timeout and ordinary `pull_request` runs.
Do not add privileged triggers, deployment credentials or publication steps as a
workaround for testing an action update. Runner images and the selected Node major
versions intentionally continue to receive updates; action pinning does not make
the complete CI environment reproducible or remove downloads performed by an action.

`tests/ciPolicy.test.mjs` checks the current workflow's simple
one-line `uses` mappings and its safety controls. It catches accidental regressions;
it is not a general YAML security scanner, a tamper-proof policy, or a pre-execution
gate. The referenced actions execute before the tests. Adding an action or changing
the workflow structure requires reviewing and updating the checks as well. A
repository/organization SHA-pinning policy is a separate administrator setting,
not something this PR changes.

References:
- [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)
- [Dependabot configuration options](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)
