---
note_type: guide
content_mode: how_to
title: 선택적 Tailscale Serve 연결
status: draft
summary: 루프백 인증 게이트웨이를 tailnet HTTPS로 여는 선택 절차와, 그 포트만 되돌리는 절차를 적는다.
created: 2026-10-11
updated: 2026-10-11
language: ko
render_target: github
project: bpdus/agbrowse
related_notes:
  - ./README.md
  - ./PROTOCOL.md
  - ./WORKER.md
---

# 선택적 Tailscale Serve 연결

이 절차는 운영자가 선택하는 추가 단계다. 게이트웨이 코드를 가져오거나 단위 테스트를 실행할 때는 Tailscale 명령을 실행하지 않는다. 박스 단위 테스트는 herdr 회귀를 검증하지 않는다. 그 확인은 iMac 배포 단계에 남아 있다.

Copyright (c) 2026 bpdus. 원 소프트웨어 저작권은 [루트 LICENSE](../../LICENSE)의 `Copyright (c) 2026 lidge-jun`을 따른다. 이 표시는 원 저작권을 대체하지 않는다.

## 로컬 게이트웨이

저장소 루트에서 포그라운드 프로세스로만 켠다. 모듈을 import하는 것만으로는 수신 소켓이 열리지 않는다.

```bash
node skills/browser/agent-gateway.mjs --port 7420
```

기본 포트는 `7420`이다. 프로세스는 `127.0.0.1`에만 붙는다. 다른 `--host`는 거부한다. 인증 없는 `GET /healthz`는 `{"ok":true}`를 반환하며 비밀을 포함하지 않는다.

```bash
curl --fail --silent http://127.0.0.1:7420/healthz
```

기기 등록과 토큰 발급까지 쓰려면 상태 디렉터리, 키 디렉터리, gateway ID, audience를 함께 준다. 네 값 중 일부만 주면 시작하지 않는다. `GET /healthz`만 확인할 때는 이 인자를 생략한다.

```bash
node skills/browser/agent-gateway.mjs \
  --port 7420 \
  --state-dir /path/to/gateway-state \
  --key-dir /path/to/gateway-keys \
  --gateway-id gw_imac \
  --audience https://gw.example/mcp
```

MCP `initialize` 요청의 `params.protocolVersion`은 `"2025-11-25"`로 지정해야 한다.
게이트웨이의 `--audience`는 클라이언트가 접속하는 게이트웨이 origin에 `/mcp`를 붙인 값이어야 한다. 다른 값이면 클라이언트가 연결을 거부한다.

운영용 키 저장소는 macOS Keychain을 예정한다. Keychain 연동은 확인 필요이며 구현되어 있지 않다. `createDevFileKeyStore`는 개발할 때 명시적으로 고르는 파일 저장소다. 운영 저장소를 쓸 수 없다고 파일 저장소로 자동 전환하지 않는다. 이 프로세스는 Chrome을 켜지 않는다.

## 기존 Serve 설정 확인

추가하기 전에 현재 설정을 조회하고 그 출력을 남긴다.

```bash
tailscale serve status --json
```

포트 `8443`이 비어 있는지 확인한다. 기존 herdr 매핑을 기록하고, 지금 동작하는 herdr 확인을 한 번 실행해 결과도 남긴다. 기존 매핑을 바꾸거나 지우지 않는다.

## 포트 추가

herdr와 겹치지 않는 새 HTTPS 포트로, 루프백 게이트웨이만 덧붙인다. 아래 두 변경 명령의 정확한 플래그는 설치된 Tailscale 버전에서 확인 필요가 있다.

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:7420
```

`tailscale serve reset`은 쓰지 않는다. 기존 매핑을 교체하지 않는다. CDP를 노출하지 않는다. Funnel을 켜지 않는다.

추가한 뒤 같은 조회와 같은 herdr 확인을 다시 한다.

```bash
tailscale serve status --json
```

## 되돌리기

새로 연 `8443`만 끈다. 이 명령의 정확한 플래그도 설치된 Tailscale 버전에서 확인 필요가 있다.

```bash
tailscale serve --https=8443 off
```

롤백 뒤에 `tailscale serve status --json`과 같은 herdr 확인을 한 번 더 한다. 다른 포트나 경로의 매핑은 이 절차로 바꾸지 않는다.

## 후속

원격 기기를 페어링하려면 게이트웨이를 중지해야 한다. 페어링은 프로세스 내부 운영자 API이며, 실행 중인 게이트웨이가 상태 디렉터리의 쓰기 잠금을 보유한다.
