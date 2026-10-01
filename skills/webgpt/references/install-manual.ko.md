# 직접 설치 — 파일 범위 제한 WebGPT

[English](install-manual.md) · **한국어** · [에이전트 절차](setup.md)

이 안내는 업스트림 터미널 워커가 아니라 `22nsuk/WebGPT`를 설치합니다.
사용자가 직접 실행할 수 있으며, 로컬 에이전트는 [SKILL.md](../SKILL.md)와
[setup.md](setup.md)도 읽어야 합니다. 문서를 읽었다는 사실 자체가 설치·네트워크·
계정·프로젝트 권한을 부여하지는 않습니다. 먼저 해당 사용자의 승인을 확보하세요.

## 1. 실행 호스트를 정하고 기존 상태 확인하기

Node.js 22 이상, Git, 로그인된 ChatGPT 계정이 있는 로컬 Codex 호스트를 사용합니다.
에이전트가 위임을 진행하려면 지원되는 브라우저 도구도 필요합니다.
Node와 Git은 [Node.js](https://nodejs.org/en/download), [Git](https://git-scm.com/downloads)
공식 배포나 이미 신뢰하는 OS 패키지 관리자로 설치하세요. 검토하지 않은 원격 셸
설치문을 실행하지 마세요. 워커를 실행할 동일 호스트에서 `node --version`과
`git --version`을 확인합니다. 이 포크에는 npm 의존성이나 네이티브 PTY 빌드가 없습니다.

[현재 Codex 스킬 문서](https://developers.openai.com/codex/skills/)의 사용자 로컬 스킬
경로는 `$HOME/.agents/skills`이며 아래 예제도 이를 사용합니다. 먼저 실제 호스트의
스킬 탐색 경로를 확인하세요. 사용자 지정·구형 설치본이 있다고 중복 `webgpt` 스킬을
추가해도 되는 것은 아닙니다. 새 세션이나 재시작이 필요할 수 있습니다.
폴더 전체를 복사해야 하며 `SKILL.md`만 복사하거나 편집 중인 소스 체크아웃에
링크하는 방식은 이 설치 예제가 아닙니다.

| 용도 | 신규 설치 예제 |
| --- | --- |
| 소스 체크아웃 | `$HOME/webgpt-source` |
| 설치 스킬 | `$HOME/.agents/skills/webgpt` |
| 비공개 설정 | `$HOME/.config/webgpt/config.json` |
| 비공개 런타임·키·결과 | `$HOME/.local/share/webgpt` |
| 배정 프로젝트 | 별도 프로젝트 디렉터리; 홈·설정·런타임·설치본 제외 |

Windows의 `$HOME`은 Node를 실행하는 계정의 홈이며 WSL의 홈과 다를 수 있습니다.
워커·클라이언트·설정은 **Windows 네이티브 또는 WSL 중 하나**로 일관되게 운영하세요.
브라우저 식별과 업로드 경로는 별개입니다. WSL에서 읽히는 파일이라고 Windows
브라우저 도구가 업로드할 수 있는 것은 아닙니다. 부수적인 문제 해결을 이유로
기존 설치의 호스트를 옮기지 마세요.

신규 설치 명령 전 기존 스킬 사본, `WEBGPT_CONFIG` / `WEBGPT_DATA_DIR`, 설정·런타임
디렉터리, 소유한 서비스와 포트를 확인하세요. 설치가 있다면 아래 명령 대신
[업데이트 절차](operations-windows.md#parent-resume-transition-and-rollback)를 따릅니다.
실행 중인 설치본 덮어쓰기, 잠금 삭제, 소유자를 모르는 포트 프로세스 종료,
업스트림 터미널 상태와 파일 워커 상태의 혼용은 하지 마세요.

## 2. 리비전을 확정하고 스킬 전체 복사하기

다음 명령은 **새 대상 경로**를 전제로 합니다. 내려받은 `main`의 커밋을 기록하고
정확히 그 리비전에 detach한 뒤 복사합니다. 출력된 커밋과 설치 경로를 비공개
설치 기록에 보관하세요. 실행 전 소스를 검토합니다. 다운로드나 폴더 복사는
전체 설치가 완료되었다는 증거가 아닙니다.

### macOS / Linux / WSL — POSIX 셸

<!-- recipe:copy-posix -->
```sh
(
  set -eu
  node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
  git --version
  SOURCE="$HOME/webgpt-source"
  SKILL="$HOME/.agents/skills/webgpt"
  for path in "$SOURCE" "$SKILL"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      printf 'Already exists; inspect instead of overwriting: %s\n' "$path" >&2
      exit 1
    fi
  done
  git clone --branch main --single-branch https://github.com/22nsuk/WebGPT.git "$SOURCE"
  REVISION=$(git -C "$SOURCE" rev-parse HEAD)
  git -C "$SOURCE" checkout --detach "$REVISION"
  mkdir -p "$HOME/.agents/skills"
  cp -R "$SOURCE/skills/webgpt" "$SKILL"
  printf 'Installed %s at %s\n' "$REVISION" "$SKILL"
)
```

### Windows — PowerShell

<!-- recipe:copy-windows -->
```powershell
$ErrorActionPreference = 'Stop'
node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22+ is required' }
Get-Command git -ErrorAction Stop | Out-Null
$Source = Join-Path $HOME 'webgpt-source'
$Skill = Join-Path $HOME '.agents\skills\webgpt'
foreach ($Path in @($Source, $Skill)) {
    if (Test-Path -LiteralPath $Path) { throw "Already exists; inspect first: $Path" }
}
git clone --branch main --single-branch https://github.com/22nsuk/WebGPT.git $Source
if ($LASTEXITCODE -ne 0) { throw 'Clone failed; preserve and inspect the partial directory' }
$Revision = git -C $Source rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve revision' }
git -C $Source checkout --detach $Revision
if ($LASTEXITCODE -ne 0) { throw 'Cannot select the recorded revision' }
New-Item -ItemType Directory -Force -Path (Split-Path $Skill) | Out-Null
Copy-Item -LiteralPath (Join-Path $Source 'skills\webgpt') -Destination $Skill -Recurse
Write-Output "Installed $Revision at $Skill"
```

설치 폴더에는 `SKILL.md`, `agents/`, `references/`, `scripts/`, `deploy/`와 모든
런타임·PowerShell 헬퍼가 있어야 합니다. `worker.mjs`나 `client.mjs`만 교체하지 마세요.
소스 체크아웃은 검토·개발용이며 아래 실행 명령은 별도로 복사한 설치본을 사용합니다.

## 3. 비공개 설정과 저장소 만들기

아래 명령은 기존 WebGPT 디렉터리나 환경변수 재정의가 있으면 의도적으로 중단됩니다.
**개인 계정의 신규 설치**용이며 공유 서비스 계정의 배포 절차가 아닙니다.
일부만 완료되었다면 기존 디렉터리를 삭제하고 재시작하지 말고 상태를 확인하세요.
설치 작업 여러 개를 동시에 실행하지 마세요.

### macOS / Linux / WSL

<!-- recipe:config-posix -->
```sh
(
  set -eu
  if [ "${WEBGPT_CONFIG+x}" = x ] || [ "${WEBGPT_DATA_DIR+x}" = x ]; then
    printf 'Existing overrides; inspect the effective configuration first\n' >&2
    exit 1
  fi
  CONFIG_DIR="$HOME/.config/webgpt"
  DATA_DIR="$HOME/.local/share/webgpt"
  for path in "$CONFIG_DIR" "$DATA_DIR"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      printf 'Existing runtime/configuration: %s; use the update guide\n' "$path" >&2
      exit 1
    fi
  done
  umask 077
  mkdir -p "$CONFIG_DIR" "$DATA_DIR"
  chmod 700 "$CONFIG_DIR" "$DATA_DIR"
  (set -C; printf '%s\n' '{"publicMcp":true}' > "$CONFIG_DIR/config.json")
  chmod 600 "$CONFIG_DIR/config.json"
  ls -ld "$CONFIG_DIR" "$DATA_DIR"
)
```

소유한 두 디렉터리는 `0700`, 설정 파일은 `0600`이어야 합니다. 상위 디렉터리 접근과
기존 권한도 확인하세요. POSIX 권한 값만으로 Windows ACL의 비공개성을 입증할 수 없습니다.

### Windows — PowerShell

<!-- recipe:config-windows -->
```powershell
$ErrorActionPreference = 'Stop'
if ((Test-Path Env:WEBGPT_CONFIG) -or (Test-Path Env:WEBGPT_DATA_DIR)) {
    throw 'Existing overrides: inspect the effective configuration first'
}
$ConfigDir = Join-Path $HOME '.config\webgpt'
$DataDir = Join-Path $HOME '.local\share\webgpt'
foreach ($Path in @($ConfigDir, $DataDir)) {
    if (Test-Path -LiteralPath $Path) { throw "Existing runtime/configuration: $Path" }
}
$Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($Path in @($ConfigDir, $DataDir)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    icacls $Path /inheritance:r /grant:r "*${Sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F'
    if ($LASTEXITCODE -ne 0) { throw 'Cannot establish private directory permissions' }
    icacls $Path
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect directory permissions' }
}
'{"publicMcp":true}' | Set-Content -LiteralPath (Join-Path $ConfigDir 'config.json') -Encoding UTF8
```

ACL 명령은 **새로 만든 디렉터리에만** 상속 권한을 제거하고 현재 계정과 Local System에
접근을 부여합니다. 시작 전에 `icacls` 출력에 예상 밖의 명시적 권한이 없는지 확인하세요.
다른 서비스 계정은 별도의 계정·ACL 검토가 필요합니다. 기존 공유 디렉터리에 이 ACL을
그대로 적용하지 마세요.

최소 설정 내용은 다음과 같습니다.

<!-- recipe:config-example -->
```json
{"publicMcp":true}
```

생략한 값은 MCP `127.0.0.1:43137`, 컨트롤러 `127.0.0.1:43139`, 런타임
`$HOME/.local/share/webgpt`입니다. `publicMcp:true`는 **공개 전달 전에** 필요한
비밀 MCP 경로를 활성화하며 컨트롤러를 외부에 바인딩하지 않습니다.
사용자 지정 포트·저장소는 서로 다른 미사용 포트와 해당 OS의 절대 `dataDir` 경로를
사용하세요. `WEBGPT_CONFIG`는 절대 설정 파일 경로를, `WEBGPT_DATA_DIR`는 데이터
디렉터리만 재정의합니다. 워커와 클라이언트에 동일한 유효 설정을 사용하세요.
[설정 세부 사항](setup.md)을 참고하세요.

JSON은 UTF-8로 저장하며 맨 앞의 UTF-8 BOM 하나는 허용합니다. PowerShell 5.1의
`Set-Content -Encoding UTF8`은 지원하지만 기본 `>` 출력은 UTF-16이므로 지원하지
않습니다. Windows 경로를 JSON에 넣을 때 역슬래시를 이스케이프하거나 슬래시를
사용하세요. 실행 중인 서비스의 설정을 바꾸지 마세요.

## 4. 워커를 시작하고 설치본 확인하기

설정된 두 포트가 비어 있는지, 또는 정확히 기존 WebGPT 소유자인지 먼저 확인합니다.
다른 프로세스가 점유했다면 공통 설정에서 미사용 포트를 선택하고 그 프로세스를
종료하지 마세요. 첫 워커는 소유한 터미널에서 실행해 유지합니다.
아래의 따옴표로 감싼 `$HOME` 명령은 위 경로를 사용하는 POSIX 셸과 PowerShell에서
모두 실행할 수 있습니다.

<!-- recipe:worker -->
```sh
node "$HOME/.agents/skills/webgpt/scripts/worker.mjs"
```

동일 설정을 사용하는 두 번째 터미널에서 실행합니다.

<!-- recipe:checks -->
```sh
node "$HOME/.agents/skills/webgpt/scripts/client.mjs" status
node "$HOME/.agents/skills/webgpt/scripts/client.mjs" ready
node "$HOME/.agents/skills/webgpt/scripts/client.mjs" tasks
node "$HOME/.agents/skills/webgpt/scripts/client.mjs" dispatch preflight
```

`listening`과 MCP `/health`는 생존 상태만 나타냅니다. `ready`는 인증되어야 하며
저장소·상태·복구·프로젝트 경고를 무시하지 말고 확인합니다.
`dispatch preflight`는 부모의 Node 헬퍼 실행 환경 검사이지 브라우저 접근 검사가 아닙니다.
설치 디렉터리에서 설치본 테스트를 실행하세요.

POSIX 셸:

<!-- recipe:installed-tests-posix -->
```sh
(cd "$HOME/.agents/skills/webgpt" && node --test --test-concurrency=2 --test-reporter=tap)
```

PowerShell:

<!-- recipe:installed-tests-windows -->
```powershell
Push-Location (Join-Path $HOME '.agents\skills\webgpt')
try {
    node --test --test-concurrency=2 --test-reporter=tap
    if ($LASTEXITCODE -ne 0) { throw 'Installed tests failed' }
} finally { Pop-Location }
```

테스트는 임시 파일과 로컬 프로세스를 사용하며 로그인된 ChatGPT나 공개 포트 전달이
필요하지 않습니다. 통과해도 브라우저·커넥터 준비 상태가 입증되지는 않습니다.
소스 개발 시에는 소스 루트에서 `node tests/run.mjs`를 실행하여 저장소와 독립 설치본
검사를 함께 수행하세요.

포그라운드 워커는 터미널·세션이 종료되면 중단됩니다. 지속 운영에는 소유한 서비스·
재시작 방법이 필요하며 자식 프로세스를 한 번 시작했다는 사실로 입증할 수 없습니다.
첫 실제 검증 성공 후 별도 승인을 받아 설정하세요. [Windows 운영](operations-windows.md)은
선택적 제한 재시도 supervisor, 예약 작업 헬퍼, 종료 절차와 배포 한계를 다룹니다.

## 5. MCP 리스너만 승인된 HTTPS로 전달하기

가능하면 검증된 기존 연결과 터널을 재사용합니다. 신규 연결에서는 `publicMcp:true`에
따라 워커가 비공개 `mcp-path.key`를 만듭니다. 유효 MCP 경로는 **`/mcp`가 아니라**
`/mcp/<key>`입니다. 전달 전에 로컬의 잘못된 키 경로와 기본 경로가 404를 반환하는지,
유효 initialize가 성공하는지, 잘못된 작업 토큰으로 도구를 호출할 수 없는지 확인하세요.
프로토콜 검사는 [setup.md](setup.md)에 명시되어 있습니다. 단일 health 응답이나
다른 런타임에서 통과한 테스트로 대신 판단하지 마세요.

Cloudflare Quick Tunnel은 선택 가능한 개발용 경로입니다.
[공식 배포](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)에서
cloudflared를 설치한 뒤 다른 소유 터미널에서 실행합니다. 사용자 지정 MCP 포트가
있다면 바꿔서 실행하세요.

<!-- recipe:forward -->
```sh
cloudflared tunnel --url http://127.0.0.1:43137
```

출력된 HTTPS origin에 `/mcp/<key>`를 붙여 연결 URL을 만듭니다.
키는 `$HOME/.local/share/webgpt/mcp-path.key` 또는 설정한 런타임에서 비공개로 읽고,
완성된 URL은 로그인된 ChatGPT 연결 폼에만 입력하세요. 키를 공유 로그에 출력하거나
전체 URL을 작업 요청문에 넣거나 브라우저로 직접 방문하거나 화면에 캡처하지 마세요.
`controller.key`는 로컬에 유지하며 ChatGPT 연결 자격 증명이 아닙니다.
43139번 포트, supervisor 제어 포트, 프로젝트 폴더, 일반 파일 서버를 전달하지 마세요.

Quick Tunnel은 Cloudflare 계정이 필요 없지만 origin이 바뀔 수 있고 가동 시간 SLA가
없으며 SSE를 지원하지 않습니다. 이 워커는 JSON HTTP 응답을 사용합니다.
전달 사업자가 HTTPS를 종료하므로 사설망이 아니라 공개 전달입니다.
프로세스를 유지하고 origin 변경 후 기존 ChatGPT 연결 URL을 수정하세요.
[Cloudflare 제한 사항](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)을
확인하세요. 고정 주소·서비스는 별도 배포 작업이지 암묵적인 유료 계정 요구가 아닙니다.
무관한 cloudflared 설정과 터널은 보존합니다.

## 6. 실제 ChatGPT 연결을 설정하고 선택하기

기존 로그인 브라우저를 사용하세요. 계정에서 필요하고 이용 가능하다면 현재
[OpenAI Developer mode 안내](https://developers.openai.com/api/docs/guides/developer-mode)의
**Settings → Security and login → Developer mode**에서 활성화합니다.
Plugins에서 의도한 WebGPT 연결을 생성하거나 수정하고, 비공개 HTTPS 전체 엔드포인트의
URL 연결과 **OAuth 인증 없음**을 선택합니다. OAuth가 없다고 무보호 상태인 것은
아닙니다. 비밀 경로와 독립적인 작업 토큰이 워커 접근을 검사합니다. 플러그인을 공개하지 마세요.

익숙한 연결 이름만 보지 말고 실제 엔드포인트·도구 스키마·권한을 확인하세요.
`get_task`, `read_input`, `list_files`, `read_file`, `write_file`, `delete_file`,
`submit_result`의 7개 도구가 있어야 합니다. 워커·클라이언트의 일관된 업데이트 후
낡은 스키마를 새로고침합니다. 스킬을 다시 복사했다는 이유로 호환되는 연결을
교체하거나 무관한 권한을 넓히지 마세요.

소유한 ChatGPT 채팅에서 실제 연결과 요청 모드를 선택합니다. `xh`는 Extra High,
`p`는 Pro입니다. 메시지에 커넥터 이름만 쓰는 것은 연결을 선택하는 행위가 아닙니다.
로그인, 확장 프로그램 승인, 필수 도구 확인은 사용자·플랫폼 단계로 남습니다.
에이전트는 문서화된 브라우저 제어를 사용하고 쿠키 복사나 격리된 대체 프로필을
사용하지 않습니다. 계정 접근이 없으면 보고하고 우회하거나 API 모델로 바꾸지 마세요.

## 7. 일회용 작업 하나를 종단 간 검증하기

설치된 파일 연결에는 기존 `connection` 검증을 사용하세요. 같은 목적의 과제를 따로
작성하거나 모든 검증 시나리오를 실행할 필요는 없습니다. 설치 확인용이며 정상 작업마다
반복할 선행 조건이나 유용한 위임 성과의 벤치마크가 아닙니다. 시험 파일·결과 형식·검수
기준은 [검증 절차](verification.md)를 따릅니다.

런타임·설정·설치 스킬 바깥의 **기존 비공개 상위 폴더 아래에 새 절대 실행 경로**를
정하세요. 아래 따옴표 안의 자리표시자를 바꿉니다. `<skill>`은 실제 설치 스킬 경로이고,
`<absolute-run-dir>`은 `prepare`가 만든 동일한 폴더입니다. Windows·POSIX에서 공백이
있는 경로도 처리하도록 따옴표를 유지하세요. Pro를 요청했다면 `xhigh` 대신 `pro`를
사용하고 실제 채팅에서도 같은 모드를 선택합니다.

<!-- recipe:probe-prepare -->
```text
node "<skill>/scripts/verification.mjs" prepare connection "<new-absolute-run-dir>" xhigh
```

`prepare`는 고유 작업 ID와 `verification.json`, `request.json`, `measurements.json`,
`project/seed.txt`를 만듭니다. 등록·브라우저 열기·메시지 전송은 하지 않습니다.
생성된 요청에서 일회용 `project/`에만 편집 권한이 있는지 확인하고 요청과 배정 명세는
변경하지 마세요. 일부만 준비된 경우를 포함해 기존 실행 경로는 거부합니다. 불확실한
시도를 다시 시작하려고 덮어쓰거나 증거를 삭제하지 말고 보존해 확인하세요. Windows에서는
비공개 상위 폴더의 ACL도 확인합니다. POSIX 생성 권한만으로 비공개성이 입증되지는 않습니다.

동일한 Node 호스트와 유효 설정에서 생성된 요청을 한 번 등록합니다. 이후 모든
`<task-id>`에는 생성된 `taskId`와 같은 값인 `request.json`의 `id`를 사용하세요.

<!-- recipe:probe-register -->
```text
node "<skill>/scripts/client.mjs" register "<absolute-run-dir>/request.json"
```

등록 응답에는 작업 토큰이 있으므로 비공개로 보관합니다. 소유 ChatGPT 대화에는 선택한
커넥터·한정된 검증 요청과 **해당 작업 토큰만** 전달하고, 컨트롤러 키나 전체 연결 URL은
전달하지 마세요. 생성된 요청은 컨트롤러 입력이지 통째로 업로드할 파일이 아닙니다.
`<absolute-run-dir>/dispatch.json`을 비공개 기록으로 삼아 [전송 절차](dispatch.md)에 따라
전송 의도를 저장하고 실제 새 사용자 메시지가 하나인지 확인하세요. 등록만으로 재전송이
허용되는 것은 아닙니다.

워커가 `get_task`의 배정에 따라 seed의 정확한 구간 수정, 현재·오래된 SHA 읽기,
오래된 SHA 쓰기 거부, 임시 파일 생성·읽기·삭제와 `submit_result`를 수행하게 합니다.
동일 작업을 관측하며 백업 확인 시점·중단·복구 알림을 완료 결과로 간주하지 마세요.

<!-- recipe:probe-check -->
```text
node "<skill>/scripts/client.mjs" wait "<task-id>"
node "<skill>/scripts/verification.mjs" check "<absolute-run-dir>"
```

각 보고서를 비공개로 보존합니다. `check`는 최종 한글·이모지 바이트, 배정 권한,
순서가 정해진 세 변경 영수증, 원본 백업·복구와 저장 결과 JSON을 검증하며 수집하지
않습니다. **로컬 `PASS`·종료 0은 실제 연결 수용이나 수집 승인이 아닙니다.**
성공 여부 불리언 네 개는 `unverifiedClaims`에 남습니다. `parentMustVerify`와 실제 도구
호출·응답을 확인하고 인용된 오류나 모델 요약으로 대신하지 마세요. `PENDING`·`FAIL`·
`BLOCKED`이면 새 등록·자동 재시도·정리 대신 기존 증거를 확인합니다.

| 확인 단계 | 필요한 증거 |
| --- | --- |
| 브라우저·전송 | 실제 선택 모드·커넥터, 소유 채팅·탭, 확인된 단일 사용자 메시지 |
| 입력·읽기 | 실제 `get_task`·`read_input`, 현재 SHA 고정 읽기, 오래된 SHA 읽기 거부 |
| 파일 작업·충돌 | seed 구간 수정, 추가 변경 없는 오래된 SHA 쓰기 거부, 임시 파일 생성·읽기·삭제·부재 |
| 저장 결과·복구 | 로컬 검수 보고서, 전체 저장 결과·SHA, 순서가 정해진 세 영수증과 원본 백업 |
| 수집·권한 종료 | 무결성 확인 수집, 미처리 소유 작업 없음, 종료된 토큰의 거부 |
| 채팅 정리 | 보존한 채팅 URL, 최종 답변 완료, 소유 탭만 닫힘 |

**로컬 검사와 실제 도구·브라우저 증거를 수용한 뒤에만** 동일 작업을 수집하고 수집 후
보고서도 보존합니다.

<!-- recipe:probe-collect -->
```text
node "<skill>/scripts/client.mjs" collect --resume "<task-id>"
node "<skill>/scripts/verification.mjs" check "<absolute-run-dir>"
node "<skill>/scripts/client.mjs" tasks
```

`collect --resume`는 바이트를 검증하고 수집 가능한 미수집 결과를 승인할 수 있으므로
항상 읽기 전용은 아닙니다. 테스트 재실행이나 작업 재전송은 하지 않습니다. `tasks`와
검수기는 종료된 토큰을 직접 호출하지 않으므로, 원래 토큰으로 거부 여부를 별도로 한 번
확인하세요. 결과 콜백과 별개로 최종 채팅 답변이 끝날 때까지 확인합니다. 채팅은 기본
보존하며 소유 탭 닫기는 채팅 삭제가 아닙니다.

리비전·경로, 워커·터널 소유권, 시작·종료 방법, 연결 이름, 단계별 결과와 비공개 증거
참조를 하나의 비공개 설치 기록에 유지하세요. `PASS`·`FAIL`·`NOT_RUN`으로 구분하고
공유 보고서에 자격 증명을 넣지 않습니다. 중단된 실행을 보존하고 `ready`, 작업별
`reconcile`, 원래 채팅·기록으로 **동일 작업**을 재개하세요. 불확실한 전달은 재전송
승인이 아닙니다. 포기한 등록은 증거를 보존한 뒤에만 명시적으로 취소합니다. 실행 폴더·
복구 기록·채팅은 보존하며, 이들의 삭제는 검증 성공과 별개의 작업입니다.

파일 연결 검증은 OS 재부팅·로그오프, 터널 복구, 서비스 계정 ACL이나 브라우저 파일
업로드를 시험하지 않습니다. 별도 승인된 유지보수는 [Windows 운영](operations-windows.md)을
따르세요. 다른 [검증 시나리오](verification.md)는 해당 확인 목적이 있을 때만 사용하고,
유용한 실제 작업의 평가는 [부모 수용 안내](parent-acceptance.md)를 따릅니다.
로컬 `PASS`를 실제 `PASS`로 바꾸어 보고하지 마세요. 사람이 직접 커넥터를 사용했어도
브라우저 제어가 없다면 에이전트 위임 경로까지 입증된 것은 아닙니다.

## 8. 증거를 보존하며 운영·업데이트·제거하기

일반 검토에는 `read`, 승인된 변경에만 `edit`를 부여합니다. 파일 도구는 파일당 최대
10 MiB의 UTF-8 텍스트를 다루며 임의 바이너리나 셸 명령을 제공하지 않습니다.
[Workspace](workspace.md)에 페이지 나누기, 전체 파일 해시, 보호 경로가 명시되어
있습니다. 이 경계가 모든 프로젝트 비밀을 거르거나 적대적 로컬 프로세스를 격리하지는
않습니다. 원격 PR은 [별도 GitHub 도구](github-workflow.md)를 이용합니다.

업데이트는 진행·미수집 작업 확인 → 새 전송 중지 → 기존 작업 처리 → 소유 워커와
재시작 담당 종료 → 실제 종료 확인 → 일관된 백업 → 같은 리비전의 설치 파일 전체
교체 → 의도한 계정·설정으로 재시작 → 기존 터널·연결 및 실제 검증 순으로 진행합니다.
코드만 바꿀 때 정상 연결을 유지하고, 오류를 없애려고 상태나 잠금을 삭제하지 마세요.
구형 버전 한계를 포함한 [전환·롤백](operations-windows.md#parent-resume-transition-and-rollback)과
[복구 무결성](recovery-integrity.md) 절차를 따릅니다.

제거하려면 먼저 결과를 보존·수집하고 식별한 워커, 재시작 담당, 단독 소유 터널만
종료하세요. 의도한 스킬 사본·등록과 폐기할 ChatGPT 연결만 제거합니다.
공유 터널을 끄거나 다른 도구의 설정을 지우지 마세요. 런타임 데이터, 키, 영수증,
복구 사본, 보존한 채팅은 **자동으로 삭제하지 않습니다**. 자격 증명 폐기와 데이터
삭제는 스킬 파일 제거와 별개의 명시적 작업입니다.

업로드 실패는 [첨부 안내](file-uploads.md), 준비 상태·복구 오류는
[진단](diagnostics.md)과 [백업 안전](backup-safety.md)을 참고하세요.
포괄적인 "설치됨" 또는 "권한 없음" 대신 실패 단계와 실제 관측한 한계를 보고합니다.
