---
note_type: research
content_mode: reference
title: bpdus agbrowse PR 0 기준선
status: draft
summary: 포크 기준 SHA, 기존 기능, 제외 경로, 위협 모델, 환경 조사의 미확인 항목을 기록한다.
created: 2026-10-11
updated: 2026-10-11
language: ko
render_target: github
project: bpdus/agbrowse
research_topic: agbrowse fork baseline for a local agent browser gateway
confidence: medium
related_notes:
  - ./README.md
  - ./LICENSE-NOTES.md
  - ./PROTOCOL.md
  - ./APPROVAL-FLOW.md
---

# bpdus agbrowse PR 0 기준선

이 문서는 게이트웨이를 구현하기 전의 기준 사실을 기록한다. 게이트웨이와 승인 기능은 아직 없다. 아래 표의 SHA, 버전, 태그는 제공된 기준 사실이다.

Copyright (c) 2026 bpdus. 원 소프트웨어 저작권은 [루트 LICENSE](../../LICENSE)의 `Copyright (c) 2026 lidge-jun`을 따른다. 이 표시는 원 저작권을 대체하지 않는다.

## 기준표

| 항목 | 기록 값 | 상태 |
|---|---|---|
| 포크 저장소 | GitHub `bpdus/agbrowse` | 확정 |
| upstream | `lidge-jun/agbrowse` | 확정 |
| 포크 기준 SHA | `a5350886c23c91ce717b07fc27bc10d2b77d4454` | 제공된 기준 사실 |
| 기준일 | `2026-08-18` | 제공된 기준 사실 |
| 패키지 버전 | `0.2.1` | 제공된 기준 사실. 현재 `package.json`도 `0.2.1`이다. |
| 태그 | `v0.2.1` | 제공된 기준 사실 |
| bpdus-kit 미러 upstream HEAD | `a03de27a28900a45569ec6324d6fd8a7fcd10544` | 기록만. 전체 비교는 확인 필요 |
| bpdus-kit 미러 npm | `0.1.18` | 기록만. 전체 비교는 확인 필요 |
| 첫 사이트 | 네이버. 조회 → 장바구니 → 승인 결제 | 확정 |
| 실행 계정 | iMac `jjbyun` 단일 OS 계정, 전용 Chrome 프로필 | 확정 |
| 공개 범위 | 게이트웨이만 tailnet. CDP는 iMac 내부. Funnel 금지 | 확정 |

bpdus-kit 미러의 전체 diff, 적용 패치, 라이선스 비교는 확인 필요하다. 이 문서는 그 비교를 완료했다고 쓰지 않는다.

## 기존 기능과 향후 재사용 후보

현재 checkout은 상주 게이트웨이가 아니라 짧은 Node 프로세스가 로컬 Chrome DevTools Protocol에 다시 붙는 CLI다. 기본 CDP 포트는 `9222`이고, 프로필은 `BROWSER_AGENT_HOME` 아래 유지된다.

동작이 확인된 기존 표면 가운데 게이트웨이 후보로 남길 수 있는 것은 다음과 같다.

| 후보 | 현재 위치 | 향후 게이트웨이에서의 취급 |
|---|---|---|
| 로컬 Chrome 수명 주기 | `skills/browser/browser-lifecycle.mjs`, `skills/browser/browser-core.mjs` | 워커가 iMac 안에서만 CDP를 쓰도록 재사용할 수 있다. |
| 접근성 snapshot과 ref | `browser_snapshot`, CLI `agbrowse snapshot` | 스냅샷·ref 수명 규칙을 [PROTOCOL.md](./PROTOCOL.md)에 맞춰 다시 계약한다. |
| ref 클릭 | `browser_click_ref`, CLI `agbrowse click` | 자유로운 클릭은 승인 우회 경로다. 사이트 어댑터의 허용 동작으로만 감싼다. |
| 전용 프로필 | `BROWSER_AGENT_HOME`, `skills/browser/profile-lock.mjs` | 일상 프로필과 분리한 에이전트 프로필의 출발점으로 둔다. 쿠키를 복사하지 않는다. |
| 탭 수명 주기 | `skills/browser/tab-lifecycle.mjs`, `tab-manager.mjs` | 호출자·대화·세션에 탭을 묶는 방향으로 재사용을 검토한다. |
| 좁은 MCP stdio 서버 | `web-ai/mcp-server.mjs`, 등록 도구 `browser_snapshot`, `browser_click_ref`, `web_ai_*` | 전송 뼈대 후보다. 승인 도구와 사이트 동작을 그대로 노출하지 않는다. |
| 정책·trace 스키마 | `web-ai` 정책·trace 모듈, 소스 감사 게이트 | 감사 로그 형식의 참고 후보다. 비밀 원문을 남기지 않는 규칙은 새로 강제한다. |

기존 MCP 표면은 프로덕션 게이트웨이 계약이 아니다. `browser_type_ref`, `browser_navigate` 등 더 넓은 브라우저 도구는 현재 저장소에서 deferred다.

재사용하지 않거나 원격 표면에서 막아야 하는 기존 능력은 다음 절과 우회 경로에 적는다. web-ai 전송(`web-ai send` 계열)은 무승인 전송 우회 후보다.

## 제외 경로

탐지 회피와 지문 모방은 이번 게이트웨이 범위 밖이다. 실제 제외 경로는 다음과 같다.

| 경로 | 역할 | 기준 SHA에서 확인한 위치 |
|---|---|---|
| `skills/browser/adaptive-fetch/tls-fetch.mjs` | TLS/JA3 지문 모방 | curl-impersonate로 JA3/TLS 지문을 흉내 내는 주석과 구현이 있다. |
| `skills/browser/adaptive-fetch/camoufox-session.mjs` | stealth·지문 정규화 렌더링 | Camoufox stealth-browser fallback으로 지문을 정규화한다. |
| `skills/browser/adaptive-fetch/index.mjs` | 위 경로를 부르는 fallback | 약 216행 TLS fallback, 약 393행 Camoufox fallback 호출 경로. |

향후 게이트웨이는 위 경로를 MCP 도구로 노출하지 않고, 조회·장바구니·결제 흐름에서 자동 호출하지 않는다. PR 0에서는 코드를 삭제하지 않는다. 로컬 CLI 진단용으로 파일이 남아 있어도, 게이트웨이 프로필의 에이전트는 그 경로에 닿지 않아야 한다.

캡차 해결, 차단 후 자동 우회, 자격 증명 채워 넣기도 제외한다. 사이트 부담을 줄이는 속도 제한은 탐지 회피로 구현하지 않는다.

## 위협 모델과 승인 우회 경로

신뢰 경계는 tailnet 접속, 기기 인증, 모델 출력, 웹페이지, 채팅 수신, iMac OS 계정으로 나눈다. 같은 tailnet에 있다는 이유만으로 브라우저 권한을 주지 않는다. 도구 인자, 페이지 문구, 접근성 라벨은 정책이나 승인 증거가 될 수 없다.

코드 경로로 승인을 건너뛸 수 있는 우회는 적어도 다음이다.

| 우회 경로 | 설명 |
|---|---|
| 임의 JavaScript 실행 | 페이지에서 결제·전송을 직접 호출할 수 있다. |
| raw CDP | 게이트웨이 정책을 거치지 않고 입력, 쿠키, 네트워크, 대상 전환이 가능하다. |
| 자유로운 클릭·입력 | 이름이 조회인 버튼이 구매일 수 있고, Enter·onchange가 전송을 일으킬 수 있다. |
| 쿠키·저장소·헤더 추출 | 로그인 세션을 모델 문맥이나 다른 기기로 옮길 수 있다. |
| 무승인 전송 | 기존 `web-ai send`처럼 게시·전송을 수행하는 진입점이다. |
| TLS/Camoufox fallback | 제외 경로를 게이트웨이가 다시 부르면 탐지 회피가 원격 도구가 된다. |
| 제한 없는 `browser_click_ref` | 승인 없이 임의 요소를 누른다. |

동일 OS 계정의 로컬 에이전트는 CDP, 프로필 파일, 프로세스에 접근할 수 있다. 루프백 바인딩만으로는 이 접근을 막지 못한다. 게이트웨이 밖 우회까지 차단한다고 보장하지 않는다. 코드 강제 승인의 범위를 로컬 CLI까지 넓히려면 별도 macOS 실행 계정과 프로세스 접근 제한이 필요하며, 그 격리는 확인 필요다.

구매 요청 에이전트와 답장 중계 에이전트가 같으면, 페이지나 도구 결과가 승인 문장을 주입해 중계 경로를 속일 수 있다. 상세와 완화 선택지는 [APPROVAL-FLOW.md](./APPROVAL-FLOW.md)에 둔다.

CDP를 Serve 대상에 넣거나 Funnel로 열면 브라우저 세션이 tailnet 밖 또는 공개 인터넷에 노출된다. 시작 점검에서 공개 노출이나 예상 밖 바인딩이 보이면 브라우저 작업을 중단한다.

## 환경 조사 미확인 항목

| 항목 | 이유 |
|---|---|
| iMac 런타임 | CPU, macOS, Chrome, Tailscale, Node, LaunchAgent, 재부팅 후 GUI 로그인 여부를 이 checkout에서 확인하지 않았다. |
| Tailscale Serve | 실제 도메인, herdr와 경로 충돌, grants/ACL, 루프백 바인딩은 확인 필요다. |
| Keychain | Secure Enclave 사용, 잠금 상태 서명, 무인 갱신 가능 여부는 iMac 모델과 계정에 따라 확인 필요다. |
| 박스 키 저장 | grokbot-box의 서비스 계정 자격증명 저장소는 확인 필요다. |
| 네이버 흐름 | 목록, 상세, 옵션, 장바구니, 주문서, 결제 수단, 결과 조회 화면은 확인 필요다. |
| Grok Bot 채팅 | 버튼 위젯, 원본 사용자 이벤트 조회, 검증 가능한 서명 여부는 확인 필요다. |
| MCP 클라이언트 | Streamable HTTP 채택 버전과 Grok Bot·CLI 호환성은 확인 필요다. |
| 미러 비교 | bpdus-kit vendor 트리의 패치와 라이선스 차이는 확인 필요다. |

첫 운영 전제는 정재가 전용 Chrome 프로필에서 네이버에 직접 로그인한 뒤, 에이전트가 그 세션으로 조회부터 시작하는 것이다. 사이트 로그인은 게이트웨이 접속 토큰 갱신과 별개다.
