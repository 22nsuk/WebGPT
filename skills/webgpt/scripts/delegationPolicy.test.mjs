import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Documentation regression checks, not a model-behavior evaluation or runtime authorization.
// Relative installed paths deliberately require no surrounding repository or live service.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
const skill = read('../SKILL.md');
const parent = read('../references/parent-workflow.md');
const development = read('../references/development-loop.md');
const github = read('../references/github-workflow.md');

test('delegation assigns complete authorized work rather than implementation-only parent handback', () => {
  assert.match(skill, /Minimize parent model work, intervention and context/);
  assert.match(skill, /worker owns the complete authorized outcome/);
  assert.match(development, /worker owns the available checks and corrective iterations/);
  assert.doesNotMatch(skill, /parent owns scope, permissions, integration and verification/);
  assert.doesNotMatch(parent, /이 배정은 로컬 구현까지이며 테스트·빌드·Git 통합은 부모가 담당합니다/);
});

test('worker capability discovery cannot expand publication or local execution authority', () => {
  assert.match(skill, /They grant no shell, Git\/PR\/push or process-control authority/);
  assert.match(development, /a listed tool does not authorize its use/);
  assert.match(github, /Review-only or local-edit permission is not publication permission/);
  assert.match(github, /never create a PR merely to obtain CI/);
  assert.match(github, /PR creation does not authorize merging, deployment, branch deletion or permission changes/);
});

test('remote-only work avoids unnecessary parent checkout work without losing local inputs', () => {
  assert.match(github, /remote task branch as the authoritative work surface/);
  assert.match(github, /Omit an unnecessary local workspace grant/);
  assert.match(github, /local dirty files or unpushed commits are task inputs/);
  assert.match(github, /remote HEAD is not a substitute/);
  assert.match(github, /Do not claim local integration complete merely because a PR exists/);
  assert.match(parent, /원격 HEAD로 로컬 입력을 대체/);
});

test('worker finishes available checks and corrections before terminal submission', () => {
  assert.match(skill, /before `submit_result`; an initial patch is not completion/);
  assert.match(development, /within the same active assignment before `submit_result`/);
  assert.match(github, /final-head CI inspection and review corrections/);
  assert.match(github, /new project or GitHub mutation after submission requires a genuine follow-up assignment/);
});

test('parent-only assistance is concrete and preserves actual environment and check evidence', () => {
  assert.match(development, /why that environment is needed, the exact proposed check, expected evidence and tested revision/);
  assert.match(development, /sandbox\/CI PASS is not local-installation PASS/);
  assert.match(development, /Use only inputs authorized for that environment; never transfer credentials or bypass approvals/);
  assert.match(development, /actual exit code\/signal, PASS\/FAIL\/NOT_RUN/);
  assert.match(development, /There is no live execution request queue/);
  assert.match(development, /new ID\/token in that same retained chat/);
});

test('acceptance reuses sufficient evidence but retains additional checks for concrete gaps', () => {
  assert.match(skill, /Reuse sufficient worker\/CI evidence/);
  assert.match(skill, /explicit risk, missing evidence, changed revision or environment gap/);
  assert.match(skill, /collection still freshly verifies bytes, recovery and retirement/);
  assert.match(skill, /Integrity is not correctness or proof of reported tests/);
  assert.match(parent, /미충족 필수 수용 기준은 미해결로 남긴다/);
});

test('compact handoff does not erase the requested deliverable or claim unmeasured savings', () => {
  assert.match(skill, /compact acceptance summary: outcome, revision, changes, check evidence, limitations/);
  assert.match(skill, /do not truncate a requested full report/);
  assert.match(skill, /not a goal to consume quota or skip necessary checks/);
  assert.match(parent, /부모가 못 읽는 sandbox 경로만 근거로 넘기지 않는다/);
  assert.match(parent, /필수 검사를 생략해 줄인 개입은 개선으로 계산하지 않는다/);
  assert.match(parent, /토큰·비용·시간 절감은 측정하지 않았다면 미측정/);
});

test('delegation still preserves user mode, uncertain attempts, collection and chat completion', () => {
  assert.match(skill, /never silently substitute/);
  assert.match(skill, /`sending`\/`uncertain`\/`submitted` block resends/);
  assert.match(skill, /Do not start a nested parent workflow/);
  assert.match(skill, /Retain task chats by default/);
  assert.match(skill, /Continue observing that owned chat separately until the final answer is complete/);
  assert.match(skill, /Delete a chat only when the user explicitly requests deletion/);
});
