// Regression checks for this repository's deliberately simple, one-line uses mappings.
// Not a YAML parser or a pre-execution security gate: Actions run before these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../../../.github/workflows/test.yml', import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
const allowedActions = ['actions/checkout', 'actions/setup-node'];
function assertPinnedActions(text) {
  const lines = text.split(/\r?\n/).filter(line => /^\s*(?:-\s*)?uses\s*:/.test(line));
  assert.equal(lines.length, allowedActions.length, 'review changes to the CI action allowlist');
  const names = lines.map(line => {
    const match = line.match(/^\s*(?:-\s*)?uses:\s+([^\s@]+)@([a-f0-9]{40})\s+#\s+v\d+\.\d+\.\d+\s*$/);
    assert.ok(match, 'use an unquoted full commit SHA with a release-version comment');
    return match[1];
  });
  assert.deepEqual(names.sort(), [...allowedActions].sort());
}

test('CI actions are pinned to full SHAs with maintainable release comments', () => {
  assertPinnedActions(workflow);
});

const pinnedFixture = allowedActions.map(name => `- uses: ${name}@${'a'.repeat(40)} # v7.0.0`).join('\n');
for (const ref of ['v7', 'v7.0.1', 'main', '3d3c42e']) {
  test(`CI pin guard rejects ${ref} references`, () => {
    const changed = pinnedFixture.replace(/(actions\/checkout@)[a-f0-9]{40}/, `$1${ref}`);
    assert.notEqual(changed, pinnedFixture);
    assert.throws(() => assertPinnedActions(changed));
  });
}

test('CI pin guard rejects an unreviewed action repository', () => {
  assert.throws(() => assertPinnedActions(pinnedFixture.replace('actions/checkout@', 'other/checkout@')));
});

test('CI preserves its least-privilege, uncached test-only configuration', () => {
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  assert.match(workflow, /^          persist-credentials: false\s*$/m);
  assert.match(workflow, /^          package-manager-cache: false\s*$/m);
  assert.match(workflow, /^    timeout-minutes: 10\s*$/m);
  assert.match(workflow, /^  cancel-in-progress: true\s*$/m);
  assert.match(workflow, /^        run: node --test --test-reporter=tap\s*$/m);
  assert.doesNotMatch(workflow, /pull_request_target:|workflow_run:|write-all|id-token:|secrets\.|self-hosted/);
});
