import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Static installed-guidance regressions only: no model execution, app access or
// artifact delivery is simulated. These files must work without a surrounding Git repo.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
const guide = () => read('../references/task-completion.md');

test('worker-first scope explicitly includes non-Git tasks before parent-only routing', () => {
  const skill = read('../SKILL.md');
  const shared = skill.split('## Route the request')[0];
  for (const kind of ['non-Git local folders', 'provided text', 'uploaded data', 'documents/media', 'connected-app work']) {
    assert.ok(shared.includes(kind), kind);
  }
  assert.match(shared, /Git, a remote repository, a commit and CI are not prerequisites/);
  assert.match(shared, /a requested review, plan or draft remains that narrower outcome/);
});

test('installed general guide is reachable by worker and parent without assuming worker access to parent paths', () => {
  const skill = read('../SKILL.md');
  const worker = skill.split('**Assigned worker:**')[1].split('**Repository maintenance')[0];
  assert.ok(worker.includes('(references/task-completion.md)'));
  for (const file of ['parent-workflow.md', 'usage.md']) {
    assert.ok(read('../references/' + file).includes('(task-completion.md)'), file);
  }
  assert.match(guide(), /Put the relevant outcome, input access, destination and constraints in the actual assignment/);
  assert.match(guide(), /do not send a local guide path as though the worker can open it/);
});

test('task routes preserve ordinary folders and native sources rather than inventing a Git prerequisite', () => {
  const text = guide();
  for (const kind of ['Non-Git local folder', 'Provided text or public research', 'Uploaded CSV/XLSX',
    'Documents, PDF, slides, images', 'Connected document, spreadsheet or record', 'Git repository/PR']) {
    assert.ok(text.includes('| ' + kind), kind);
  }
  assert.match(text, /No `git init`, commit, push or CI requirement/);
  assert.match(text, /Do not force an entire multi-source task into one repository/);
  assert.match(text, /do not demand a commit SHA or invent a hash\/version/i);
  assert.match(text, /they do not provide a shell or transport binary artifacts/);
});

test('non-Git completion requires appropriate checks and real delivery without fabricating local placement', () => {
  const text = guide();
  assert.match(text, /formulas and calculated outputs for a workbook/);
  assert.match(text, /Reopen or render the final artifact when supported and materially useful/);
  assert.match(text, /not require a test command, exit code or CI for work with no execution/);
  assert.match(text, /an invented link or a sandbox path alone is not delivery/);
  assert.match(text, /Report creation, validation and local placement separately/);
  assert.match(text, /`submit_result` saves the textual deliverable\/evidence, not attachments or app objects/);
  assert.match(text, /must not depend solely on access through a token that collection will retire/);
});

test('maximum in-scope completion preserves explicit limits and isolates genuine blockers', () => {
  const text = guide();
  assert.match(text, /Unless the user narrows the assignment, the worker owns all feasible in-scope/);
  assert.match(text, /a requested plan, review or draft is the complete deliverable/i);
  assert.match(text, /creating a requested file does not authorize sending it to other people/);
  assert.match(text, /Never bypass a denial through another route/);
  assert.match(text, /If one step is blocked, finish independent work/);
  assert.match(text, /After submission, new edits\/app writes need a genuine follow-up assignment/);
  assert.match(text, /not claims that a model has been tested/);
});

test('Korean usage offers finished non-Git outputs rather than default parent execution', () => {
  const text = read('../references/usage.md');
  for (const marker of ['Git 없는 로컬 폴더', '첨부 데이터', 'XLSX', 'DOCX', '연결된 문서']) {
    assert.ok(text.includes(marker), marker);
  }
  assert.doesNotMatch(text, /네이티브 실행·대형\/바이너리 수정은 부모 담당/);
  assert.doesNotMatch(text, /필요한 로컬 테스트·빌드는 Codex가 담당합니다/);
  assert.match(text, /실행 방법이나 코드만이 아니라 실제로 받을 수 있는 결과 파일/);
  assert.match(text, /부모가 내용을 다시 만들지 않고 승인된 경로로 옮기도록/);
  assert.match(text, /원본 수정·발송·공유로 범위를 넓히지 않습니다/);
});
