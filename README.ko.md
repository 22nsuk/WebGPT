# WebGPT

[English](README.md) · **한국어**

로그인된 웹 ChatGPT에 결과의 완성을 맡깁니다. Git 프로젝트뿐 아니라 조사·일반 로컬
폴더·첨부 데이터·문서/미디어·연결된 앱 작업에도 적용됩니다. 요청 범위와 실제 도구 권한
안에서 웹 워커가 생성·검증·교정·전달까지 수행하고, 부모는 범위·권한·수용 판단과 필요한
보조만 담당합니다. [일반 작업 완료 지침](skills/webgpt/references/task-completion.md)을 참고하세요.

이 저장소는 [Nhahan/WebGPT](https://github.com/Nhahan/WebGPT)의 **파일 범위 제한 포크**입니다.
로컬 Codex 스킬과 작은 Node.js 워커로 구성되며, 모델 API 클라이언트나 브라우저
확장 프로그램이 아닙니다. 계정에서 사용 가능한 ChatGPT 모드를 이용하며,
구독을 제공하거나 사용량 제한을 우회하지 않습니다. 사용량 절감도 보장하지 않습니다.

## 설치 경로 선택

| 상황 | 시작할 문서 |
| --- | --- |
| 에이전트에게 설치와 검증을 맡기기 | [에이전트 설치](#에이전트-설치) |
| Windows·macOS·Linux에 직접 설치하기 | [직접 설치 안내](skills/webgpt/references/install-manual.ko.md) |
| 이미 정상 동작하는 설치가 있음 | 신규 설치 명령 대신 [업데이트와 복구](#업데이트와-복구) |
| 포크와 업스트림 비교하기 | [커밋 기준 상세 비교](skills/webgpt/references/upstream-review-2026-09-28.md) |

## 가능한 작업과 제공하지 않는 기능

| 기능 | 이 포크의 방식 |
| --- | --- |
| 조사·분석·글쓰기 | 웹 ChatGPT의 추론과 별도로 사용 가능한 승인된 도구 활용 |
| 로컬 폴더·프로젝트 검토 | 작업별 `read` 권한; Git 불필요 |
| 로컬 구현 | `edit` 권한으로 10 MiB 이하 UTF-8 파일 직접 생성·교체·정확한 구간 수정·삭제 |
| 수정 충돌 방지 | 전체 파일 SHA-256을 사전 조건으로 사용하고 오래된 수정 거부 |
| 완료와 복구 | 결과 저장, 읽기 전용 결과 검토, 무결성 검증 후 수집, 증거 보존 |
| 파일 워커를 통한 셸·로컬 Git·테스트 실행 | **MCP에서 제공하지 않음.** 별도 승인 도구를 활용하고 실제 호스트·기능 부족분만 부모 보조 |
| 원격 브랜치·커밋·PR 작업 | **별도로 연결한 GitHub 도구**와 해당 권한으로 가능 |
| 10 MiB 초과 파일·바이너리 및 네이티브 CLI 근거 | 실제 첨부·분석·앱 도구 활용; 부모 호스트 전용 입력은 [근거 준비](skills/webgpt/references/artifact-inputs.md). MCP 실행·바이너리 쓰기는 추가하지 않음 |
| 임의의 바이너리 파일·재귀 삭제 | 파일 도구에서 지원하지 않음 |

워커의 MCP 도구는 `get_task`, `read_input`, `list_files`, `read_file`,
`write_file`, `delete_file`, `submit_result`의 7개입니다. 제공된 텍스트·첨부·연결된 앱만
사용하는 작업은 workspace 권한을 생략할 수 있습니다. 브라우저만 사용하는 위임은 로컬 워커를
생략할 수 있지만, 워커 완료 이벤트와 저장 결과 수집은 제공되지 않습니다.

파일 권한은 Git 메타데이터, 실행 중인 설치본, 운영 설정, 비공개 런타임을
제외합니다. 그러나 **프로젝트 내부의 모든 비밀을 걸러 주지는 않습니다**.
허용한 루트의 `.env` 같은 일반 파일은 접근 가능할 수 있습니다.
공유해도 되는 프로젝트를 선택하고 홈 디렉터리 전체를 허용하지 마세요.

## 준비 사항

Node.js **22 이상**, 스킬을 인식하는 로컬 Codex 환경, 사용할 모드가 제공되는
로그인된 ChatGPT 계정이 필요합니다. 에이전트가 브라우저를 조작해 위임하려면
해당 로그인 브라우저에 연결된 지원 브라우저 제어 도구도 필요합니다.
이 스킬을 복사하는 것만으로 확장 프로그램이 설치되거나 브라우저 제어가
가능해지는 것은 아닙니다. 직접 설치 예제의 다운로드에는 Git을 사용하지만
위임 작업에 Git이 필요한 것은 아닙니다.

ChatGPT가 로컬 워커에 접근하려면 원격 MCP 연결을 설정할 수 있는 권한과
승인된 HTTPS 전달 서비스도 필요합니다. 정상적인 기존 연결을 우선 재사용하며,
직접 설치 안내에는 Cloudflare Quick Tunnel을 이용하는 방법도 포함되어 있습니다.
이 워커에는 OpenAI Platform API 키나 모델 API 과금이 필요하지 않습니다.
계정·워크스페이스 제한과 실행 시점의 필수 확인 절차는 그대로 적용됩니다.

파일 워커는 Node 기본 모듈을 사용합니다. **이 포크에는 `npm install`, `npm ci`,
`node-pty`, 네이티브 터미널 빌드가 필요하지 않습니다.** 업스트림의 터미널
설치 지침을 이 포크에 그대로 적용하지 마세요.

## 에이전트 설치

아래 요청문을 **로컬 Codex 에이전트**에 전달하세요. 아직 설치하지 않은 WebGPT
워커에게 설치를 맡기는 요청이 아닙니다. 보내기 전에 승인 범위를 읽고 필요에
맞게 줄이세요.

```text
https://github.com/22nsuk/WebGPT의 파일 범위 제한 WebGPT 스킬을 설치해줘.
main을 특정 커밋으로 확정하고 기록한 뒤, 동일한 리비전의 skills/webgpt 전체를
설치해줘. 변경 전에 SKILL.md, references/install-manual.ko.md,
references/setup.md를 읽어줘. 업스트림의 터미널 워커는 설치하지 마.

먼저 기존 설치, 사용자 지정 경로, 진행 중인 작업, 정상 연결을 확인하고 보존해줘.
실행 중인 설치본을 덮어쓰지 말고 정지 후 업데이트 절차를 따라줘.
신규 설치는 호스트가 지원하는 사용자 스킬 경로를 사용하고, 설치본·비공개
설정 및 런타임·편집 대상 프로젝트를 서로 분리해줘.

로컬 워커와 HTTPS 전달 설정, 비공개 연결 URL을 내 로그인된 ChatGPT 연결
설정에만 입력하는 작업, 내가 명시적으로 배정한 프로젝트의 읽기·생성·수정·삭제를
승인해. 지원되는 방식으로 누락된 준비 사항을 설치·설정해줘.
유료 서비스를 만들거나 플러그인을 공개하거나 컨트롤러를 노출하거나 셸 권한을
추가하지 마. 로그인·필수 승인 등 정말 내가 해야 하는 작업이나 해결되지 않은
중요 선택만 질문해줘. 이 승인은 도구의 실행 시점 필수 확인을 우회하지 않아.

설치본 테스트와 소유한 임시 프로젝트의 실제 브라우저·커넥터 검증을 수행해줘.
생성·읽기·수정·삭제, 실제 오래된 리비전 거부, 저장 결과 무결성, 수집 및 작업
권한 종료를 검증해줘. 테스트 채팅은 보존하고 최종 답변이 끝난 뒤 해당 작업이
소유한 탭만 닫아줘. 명시적 요청 없이 채팅을 삭제하거나 보관 처리하지 마.
설치 경로·커밋·시작 및 종료 방법·PASS/FAIL/NOT_RUN 증거를 자격 증명 없이
기록해줘. 파일 설치, 로컬 준비 상태, 브라우저 접근, 실제 종단 간 검증 결과를
구분하고 부분 성공을 전체 설치 완료로 보고하지 마.
```

에이전트 절차는 [setup.md](skills/webgpt/references/setup.md)에 있습니다.
기존 연결 재사용, 도구 탐색, 사용자만 가능한 승인, 중단된 **동일 설치 작업**의
재개를 다룹니다. 로컬 `/health` 응답만으로 브라우저 제어, ChatGPT 연결,
실제 위임 성공을 입증할 수는 없습니다.

## 직접 설치

[한글 설치 안내](skills/webgpt/references/install-manual.ko.md)와
[English manual](skills/webgpt/references/install-manual.md)에 POSIX 셸·PowerShell
명령, 준비 사항, 비공개 디렉터리 권한, UTF-8 설정, 워커 실행, HTTPS 연결,
실제 수용 검증이 포함되어 있습니다. 신규 설치와 업데이트 절차도 구분합니다.

한 리비전 다운로드·기록 → **스킬 전체** 복사 → 비공개 저장소 설정 → 워커 시작과
점검 → ChatGPT 연결 → 일회용 프로젝트 작업 검증 순서입니다.
파일 복사만 끝났다면 이 중 첫 단계만 완료한 것입니다.

## 사용법

스킬을 로드한 로컬 Codex 세션에서 다음과 같이 요청합니다.

```text
webgpt xh 첨부한 CSV를 분석하고 검증된 월별 집계 워크북을 만들어줘.
원본은 보존하고, 코드나 계획만이 아니라 실제 결과 파일과 분석을 전달해줘.
외부에 게시·발송하지 말고 실제로 막힌 단계만 부모에게 필요한 조치로 보고해줘.
```

```text
webgpt p 이 저장소의 오류 가능성을 검토하고 개선 우선순위를 정리해줘.
읽기 전용 권한을 사용하고 파일은 수정하지 마. 관련 경로와 근거를 제시해줘.
```

```text
webgpt xh 이 프로젝트에 검색 필터를 구현하고 관련 테스트를 수정해줘.
무관한 동작은 유지하고 가능한 검사·교정까지 마쳐줘. 부모 호스트에서만 가능한 부분은 구분해줘.
```

`xh` / `xhigh`는 **Extra High**이며 기본값이고, `p` / `pro`는 **Pro**입니다.
실제 UI에서 요청한 모드를 확인하며 임의로 다른 모드로 대체하지 않습니다.
업스트림의 `m`, `h`, `webgpt open` 경로는 이 포크 스킬에서 구현하지 않습니다.

하나의 일관된 결과물, 필요한 맥락, 담당 범위, 수용 기준을 배정하고 그 안의
조사·수정 방법은 워커가 선택하게 합니다. 병렬 작업은 쓰기 담당을 분리하세요.
정상적인 파일 접근을 대신하려고 저장소를 업로드하지 마세요. 꼭 필요한 이미지나
바이너리 첨부는 별도의 [첨부 절차](skills/webgpt/references/file-uploads.md)를 따릅니다.

게시까지 맡길 때는 대상 저장소와 PR 결과물을 명시하세요. 실제 GitHub 도구를
탐색한 뒤 누가 게시할지 결정해야 합니다. 파일 워커에 셸·Git이 없다는 사실은
원격 GitHub 쓰기가 불가능하다는 근거가 **아닙니다**. 게시 후 최종 커밋의 CI와
관련 리뷰까지 확인해야 합니다. [GitHub 작업 절차](skills/webgpt/references/github-workflow.md)를 참고하세요.

## 안전과 완료 기준

설치 테스트, 실패, 복구 작업을 포함한 작업 채팅은 기본적으로 보존합니다.
사용자가 해당 채팅의 삭제를 명시적으로 요청한 경우에만 삭제합니다.
작업 탭을 닫는 것과 채팅 삭제, 작업 토큰 종료는 각각 별개입니다.

소유한 단일 작업은 `client.mjs review <task-id>`로 대기하고 무결성을 확인한 저장
본문을 읽습니다. 아직 수집하지는 않습니다. [결과 검토](skills/webgpt/references/result-review.md)에 따라
null 결과나 복구 알림을 처리하고, 변경 검토·관련 검사·수용 판단 후
`client.mjs collect <task-id>`를 실행합니다. 수집은 무결성을 다시 확인하고 작업
입력과 토큰을 회수합니다. **무결성은 정확성이나 보고된 테스트의 실행 증거가 아닙니다**.
탭을 닫기 전에는 최종 채팅 답변의 완료도 별도로 확인합니다.
검토에는 `read` 권한을 사용하고 임의로 수정 권한으로 올리지 않습니다.

작업 토큰은 배정된 대화에만 비공개로 전달합니다. 전체 MCP URL, `mcp-path.key`,
`controller.key`, 서비스 자격 증명, 복구 사본을 공개하지 마세요.
MCP 리스너만 전달하고 **컨트롤러나 서비스 제어 포트는 절대 전달하지 않습니다**.
Quick Tunnel은 공개 개발용 전달 서비스이지 사설망이나 영구 주소가 아닙니다.
프로젝트 권한도 적대적인 프로세스에 대한 OS 격리를 제공하지는 않습니다.

## 업데이트와 복구

업데이트 전 `client.mjs tasks`를 확인하세요. `status` 이벤트 큐가 비었다고
유휴 상태인 것은 아닙니다. 미완료 작업을 수집하거나 명시적으로 처리하고,
식별한 워커와 **재시작을 담당하는 프로세스까지** 종료한 뒤 실제 종료를 확인합니다.
일관된 비공개 백업을 보존하고 설치본 전체를 같은 리비전으로 교체하세요.
코드만 업데이트할 때 정상적인 기존 터널과 연결은 유지합니다.
[전환 및 롤백 절차](skills/webgpt/references/operations-windows.md#parent-resume-transition-and-rollback)를 따르세요.

`<skill>`을 실제 설치 디렉터리로 바꿔 실행합니다.

```text
node <skill>/scripts/client.mjs ready
node <skill>/scripts/client.mjs tasks
node <skill>/scripts/client.mjs dispatch preflight
node <skill>/scripts/client.mjs reconcile <task-id>
node <skill>/scripts/client.mjs collect --resume <task-id>
```

각 명령의 목적은 다릅니다. `ready`는 인증된 로컬 준비 상태, `tasks`는 작업 목록,
`dispatch preflight`는 부모 헬퍼 실행 환경, `reconcile`은 보존된 증거를 확인합니다.
`collect --resume`는 수집 가능한 미수집 결과를 승인할 수 있어 항상 읽기 전용인
명령은 아닙니다. 어느 명령도 브라우저 메시지를 재전송하거나 실제 브라우저
준비 상태를 입증하지 않습니다. 불확실한 전송, 잠금, 저널, 결과 후보를 보존하고
PASS를 만들기 위해 상태를 초기화하지 마세요.

| 증상 | 먼저 구분할 사항 |
| --- | --- |
| 스킬을 찾지 못함 | 실제 호스트 스킬 경로, 중복 설치, 새 세션·재시작 필요 여부 |
| `/health`는 되지만 도구가 실패함 | 인증된 `ready`, 실제 엔드포인트, 선택한 커넥터, 작업 권한 |
| 파일 URL 접근을 켰는데 업로드가 실패함 | 선택한 확장·프로필과 실제 업로드 기능; 토글만으로 판단하지 않기 |
| 터널 재시작 후 연결이 끊김 | HTTPS origin 변경; 새 작업 전에 기존 연결 복구 |
| 중단 후 결과 파일만 남음 | 원래 작업을 대조·복구하고 무작정 재등록·재전송하지 않기 |
| 로컬 검사만 PASS | 실제 검증은 설치 성공이 아니라 `NOT_RUN`으로 보고 |

## 문서와 개발

| 주제 | 안내 |
| --- | --- |
| 직접 설치·에이전트 설정 | [English manual](skills/webgpt/references/install-manual.md) · [한국어](skills/webgpt/references/install-manual.ko.md) · [에이전트 설정](skills/webgpt/references/setup.md) |
| 실용 요청문과 작업 설계 | [사용법](skills/webgpt/references/usage.md) · [부모 작업 절차](skills/webgpt/references/parent-workflow.md) · [일반 작업 완료](skills/webgpt/references/task-completion.md) |
| 도구 계약과 제한 | [Workspace](skills/webgpt/references/workspace.md) |
| 코드 수정과 네이티브 근거 | [개발 절차](skills/webgpt/references/development-loop.md) (정확한 구간 수정·리비전 고정 읽기·실패 요약) · [대형·바이너리 근거 입력](skills/webgpt/references/artifact-inputs.md) |
| 개정된 배정서·수동 전달·검증 인계 | [입력 식별과 검증 피드백](skills/webgpt/references/worker-handoff.md) (`client.mjs handoff`, 명령 실행 없음) |
| 전송·첨부·정리 | [Dispatch](skills/webgpt/references/dispatch.md) · [첨부](skills/webgpt/references/file-uploads.md) · [채팅 생명주기](skills/webgpt/references/chat-lifecycle.md) |
| 결과·복구·배포 | [결과 검토](skills/webgpt/references/result-review.md) · [수집](skills/webgpt/references/collection-details.md) · [복구 무결성](skills/webgpt/references/recovery-integrity.md) · [백업 안전](skills/webgpt/references/backup-safety.md) · [Windows 운영](skills/webgpt/references/operations-windows.md) |
| 진단과 수용 검증 | [진단](skills/webgpt/references/diagnostics.md) · [검증](skills/webgpt/references/verification.md) · [부모 수용](skills/webgpt/references/parent-acceptance.md) |
| 구조와 업스트림 정책 | [Browser-use 비교](skills/webgpt/references/browser-use-comparison.md) · [포크 정책](skills/webgpt/references/fork-policy.md) · [업스트림 비교](skills/webgpt/references/upstream-review-2026-09-28.md) |

소스 체크아웃에서 다음을 실행합니다.

```sh
node tests/run.mjs
```

저장소 검사 후 독립된 설치 스킬 사본을 검사합니다. CI는 Windows·macOS·Linux와
Node 22·24·26을 대상으로 하지만, 로그인된 ChatGPT 수용 검증이 아니라 로컬
자동 검사입니다. [CI 유지보수](.github/ci-maintenance.md)를 참고하세요.
영문·한글 README와 설치 안내는 함께 갱신합니다. 문서 검사는 상대 링크·앵커와
설치 명령 블록의 일치를 확인하며 운영 서비스·브라우저 세션·공개 터널은 필요하지 않습니다.

## 원저작자와 라이선스

[Nhahan/WebGPT](https://github.com/Nhahan/WebGPT)를 기반으로 하며, 포크 참조 문서에
기록한 대로 [faithforone/WebGPT](https://github.com/faithforone/WebGPT)의 일부 아이디어를
선별 반영했습니다. [LICENSE](LICENSE)를 확인하세요. 업스트림과 이 포크는 권한과
채팅 보존 정책이 의도적으로 다르므로 실행 중인 런타임 상태를 혼용하지 마세요.
