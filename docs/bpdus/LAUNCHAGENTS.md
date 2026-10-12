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
  --allowed-host 127.0.0.1:7420
```

gateway는 계속 loopback `127.0.0.1`에만 바인딩한다. 설치기는 GUI 도메인과 소유 사용자, Node, 소스 파일, 설정을 확인하고 두 plist를 검증한 뒤 설치한다. 설치 전 출력만 확인하려면 `install --dry-run all`을 사용한다. `worker` 또는 `gateway`를 지정하면 해당 plist 하나만 출력한다.

5. 설치 직후 `bin/bpdus/install-launchagents.sh status`로 두 서비스 상태와 gateway health를 확인한다.
6. `bin/bpdus/login-naver.sh --stop-worker`로 Naver 로그인을 한 번 수행한다. Chrome을 완전히 종료하고 스크립트가 worker 복구를 마칠 때까지 기다린다. 이어서 `naver.login_status`를 확인한다.
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

worker 수동 로그인이 필요하면 `login-naver.sh --stop-worker`를 사용한다. 일반 실행은 worker LaunchAgent가 로드되어 있거나 worker가 동작 중이면 거부한다. 로그인 스크립트는 Launch Services를 통해 Chrome을 열고 해당 Chrome 프로세스가 종료되며 프로필 lock이 사라진 다음에만 중단한 worker를 복구한다. 스크립트가 실패하거나 중단되어 worker가 unload 상태로 남으면 Chrome과 profile lock이 사라진 것을 확인한 뒤 아래 명령을 실행한다.

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/me.bpdus.agbrowse.worker.plist
```

이미 unload 상태였던 worker는 로그인 작업 뒤에도 unload 상태로 둔다. 이때 스크립트가 출력하는 bootstrap 명령으로 직접 복구한다. gateway는 수동 로그인 중에도 계속 실행된다.

## 제거

```bash
cd ~/.agbrowse-bpdus/src
bin/bpdus/install-launchagents.sh uninstall
```

설치기는 이 두 label만 unload하고 두 plist만 제거한다. 로그, profile, state, keys는 남긴다. 로그 뷰어 tab은 herdr에서 별도로 닫는다.
