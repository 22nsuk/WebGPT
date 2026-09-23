# CI dependency maintenance

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
