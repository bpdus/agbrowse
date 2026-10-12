---
note_type: guide
content_mode: how_to
title: bpdus agbrowse macOS LaunchAgents 운영
status: draft
summary: iMac의 GUI 사용자 세션에서 worker와 gateway를 실행하고 SSH로 관리하는 절차를 설명한다.
created: 2026-10-12
updated: 2026-10-12
language: ko
render_target: github
project: bpdus/agbrowse
related_notes:
  - ./SERVE.md
  - ./WORKER.md
  - ./README.md
---

# bpdus agbrowse macOS LaunchAgents 운영

worker와 gateway는 `jjbyun` 사용자의 GUI 세션에서 각각 LaunchAgent로 실행한다. 코드는 `~/.agbrowse-bpdus/src`, 상태와 키는 `~/.agbrowse-bpdus/state`와 `~/.agbrowse-bpdus/keys`, 로그는 `~/.agbrowse-bpdus/logs`에 둔다. worker의 Chrome은 전용 프로필 `~/.agbrowse-bpdus/agent-profile`을 사용한다.

## 전제 조건

macOS에서 GUI 로그인 세션이 활성화되어 있어야 한다. 로그인 keychain에 접근할 수 있어야 Chrome이 쿠키 암호화 키를 사용할 수 있다. 사용자 LaunchAgent는 로그인한 사용자 세션에서 동작하므로, 재부팅 뒤에는 GUI 로그인이 있어야 자동 시작한다. 자세한 배경은 [Apple launchd 문서](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)를 참고한다.

## herdr 서비스에서 이전

1. 기존 `agbrowse` herdr tab에서 worker와 gateway에 각각 `Ctrl-C`를 보내고 두 프로세스가 정상 종료할 때까지 기다린다.
2. Chrome이 완전히 종료되고 `agent-profile`과 `~/.agbrowse-bpdus/profile.lock`에 잠금이 없는지 확인한다. lock 파일을 지우지 않는다.
3. 외부 launcher `~/.agbrowse-bpdus/bin/start-in-herdr.sh`를 보관 또는 제거해 이후 중복 실행하지 않도록 한다.
4. 저장소에서 아래 명령으로 LaunchAgents를 설치한다. 기존 state, keys, profile은 교체하지 않는다.

```bash
cd ~/.agbrowse-bpdus/src
bin/bpdus/install-launchagents.sh install \
  --host 127.0.0.1 --port 7420 \
  --gateway-id imac-bpdus \
  --audience https://jjbyuns-imac.tail8f1886.ts.net:8443/mcp \
  --allowed-host jjbyuns-imac.tail8f1886.ts.net:8443 \
  --allowed-host jjbyuns-imac.tail8f1886.ts.net \
  --allowed-host 127.0.0.1:7420 \
  --allowed-origin https://jjbyuns-imac.tail8f1886.ts.net:8443
```

gateway는 계속 loopback `127.0.0.1`에만 바인딩한다. 설치기는 GUI 도메인과 소유 사용자, Node, 소스 파일, 설정을 확인하고 두 plist를 검증한 뒤 설치한다. 설치 전 출력만 확인하려면 `install --dry-run all`을 사용한다. `worker` 또는 `gateway`를 지정하면 해당 plist 하나만 출력한다.

5. 설치 직후 `bin/bpdus/install-launchagents.sh status`로 두 서비스 상태와 gateway health를 확인한다.
6. `bin/bpdus/login-mode.sh start`로 전용 worker의 로그인 모드를 시작한다. MCP의 `login.*` 도구로 로그인 화면을 확인하고 조작한 뒤 `login.end`를 호출한다. 새 일반 세션을 열고 `naver.login_status`를 확인한다. 로그인 도중 사람이 Chrome을 종료하지 않는다.
7. 로그를 보려면 `bin/bpdus/logs-in-herdr.sh`를 실행한다. `agbrowse` tab은 서비스가 아니라 `tail -F` 로그 뷰어다. 기존 같은 이름의 tab이 있으면 먼저 닫는다.

기존 Chrome 쿠키는 새 keychain 동작에서 다시 로그인이 필요할 수 있다. 이전에 저장된 쿠키의 암호화를 자동 변환한다고 가정하지 않는다. gateway의 파일 기반 key 저장소와 Chrome 쿠키 암호화는 서로 다른 저장 경로다.

## SSH 운영

GUI 로그인 세션이 유지되는 동안 SSH에서 아래 명령을 실행할 수 있다.

```bash
cd ~/.agbrowse-bpdus/src
bin/bpdus/install-launchagents.sh status
bin/bpdus/install-launchagents.sh restart worker
bin/bpdus/install-launchagents.sh restart gateway
bin/bpdus/install-launchagents.sh restart all
```

`restart`는 기본적으로 `all`을 대상으로 한다. 로드된 job은 `kickstart -k`로 다시 시작하고, 설치되어 있지만 unload된 job은 bootstrap한다. gateway 설정을 바꾸려면 같은 `install` 명령에 새 설정을 전달해 두 plist를 다시 생성한다. 설정은 plist 인자로 저장되므로 SSH restart 때 반복 입력할 필요가 없다.

SSH에서 로그인 모드는 기존 worker socket에 요청한다. 이 CLI는 Chrome이나 GUI 프로세스를 시작하지 않는다.

```bash
bin/bpdus/login-mode.sh status
bin/bpdus/login-mode.sh start
# MCP: login.snapshot / login.screenshot / login.click / login.type / login.press
bin/bpdus/login-mode.sh end
```

운영자는 한 번만 아래 명령으로 기존 paired device에 `login:operate`를 부여한다. gateway LaunchAgent를 잠시 내리고 writer 소유권이 끝난 뒤 저장한다. 현재 부여된 다른 scope와 device identity는 유지하며 epoch를 올린다. gateway가 원래 로드되어 있었으면 작업 뒤 다시 로드한다. 클라이언트는 `--scope browser:read,login:operate`를 선택해 토큰을 갱신할 수 있다. 기본 pairing scope는 계속 `browser:read`다.

```bash
bin/bpdus/grant-login-scope.sh DEVICE_ID
```

`login.start`는 일반 컨텍스트를 닫고 같은 전용 프로필을 로그인 모드로 다시 연다. `login.end`는 Chrome singleton 잠금이 `lstat` 기준으로 사라질 때까지 기다린 다음 같은 프로세스 안에서 일반 모드를 연다. worker 소유 잠금은 모드 전환 중에도 유지한다. 전환이 실패하면 `status`가 `transitioning`을 보고한다. Chrome singleton 잠금 파일을 직접 삭제하지 않는다. `worker.restart`는 응답을 먼저 보낸 뒤 정상 종료하며 worker plist의 무조건 `KeepAlive`가 다시 시작한다. 설정된 plist가 이전 버전이면 `install-launchagents.sh install worker`로 재설치한다.

복구가 필요하면 SSH에서 다음 명령을 사용한다.

```bash
launchctl kickstart -k gui/$(id -u)/me.bpdus.agbrowse.worker
```

정재는 GUI로 로그인한 iMac의 터미널에서 `bin/bpdus/credentials-token.sh`를 실행한다. 명령은 15분 유효한 일회용 토큰을 로컬 `0600` 파일에 기록하고 터미널에만 표시한다. 표시된 토큰을 복사해 `https://jjbyuns-imac.tail8f1886.ts.net:8443/admin/naver-credentials`를 열고 토큰, Naver ID, 비밀번호를 제출한다. 성공 응답은 `saved`뿐이며 값은 Naver Keychain의 `agbrowse.naver` 항목으로 저장된다. 실패하면 새 토큰을 발급한다. 게이트웨이 LaunchAgent에는 위 설치 예시처럼 정확한 `--allowed-origin` 값이 있어야 한다.

에이전트 로그인 순서는 `login.start` → `login.fill_credentials` → `login.submit` → `login.check_progress` 반복 확인이다. `fill_credentials`는 신뢰된 Naver 로그인 페이지의 실제 ID·비밀번호 입력란을 채우지만 제출하지 않는다. 로그인 페이지가 아닌 경우 `login.submit`은 실패한다. `needs_human`은 캡차가 감지된 상태이며 자동 해결하지 않는다. `needs_phone_approval`은 휴대폰·새 기기 승인 상태이므로 사람이 승인해야 한다. 확인이 끝나면 `login.end`로 로그인 모드를 종료하고 새 일반 세션에서 `naver.login_status`를 호출한다.

로그인 모드의 탐색 허용 호스트는 `nid.naver.com`, proper subdomain인 `*.pstatic.net`, 정확히 `ncpt.naver.com`과 `nca.naver.com`뿐이며 HTTPS 기본 포트만 허용한다. `nid.naver.com/nidlogin.logout`은 모든 모드에서 차단한다. 로그인 모드에서 차단한 요청은 경로·쿼리 없이 호스트, 메서드, 리소스 유형만 worker 로그에 남기며 세션당 최대 200줄로 제한한다. 로그인 도구는 한 worker 소유 페이지에만 동작한다. snapshot ref는 페이지 이동과 모드 종료 뒤 무효가 된다. 비밀번호 필드의 snapshot label은 숨기며 스크린샷에서는 마스킹한다. Keychain 비밀번호는 도구 응답·로그·오류에 포함하지 않는다.

`login-naver.sh`는 기존 수동 절차를 위한 legacy fallback으로 남아 있다. 새 로그인 흐름에는 사용하지 않는다.

## 제거

```bash
cd ~/.agbrowse-bpdus/src
bin/bpdus/install-launchagents.sh uninstall
```

설치기는 이 두 label만 unload하고 두 plist만 제거한다. 로그, profile, state, keys는 남긴다. 로그 뷰어 tab은 herdr에서 별도로 닫는다.
