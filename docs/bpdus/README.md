---
note_type: guide
content_mode: concept
title: bpdus agbrowse 문서 안내
status: draft
summary: 기준선과 프로토콜 문서, 구현된 paired-device-v1 인증, 선택적 Serve 절차, 승인 결정을 안내한다.
created: 2026-10-11
updated: 2026-10-11
language: ko
render_target: github
project: bpdus/agbrowse
related_notes:
  - ./BASELINE.md
  - ./LICENSE-NOTES.md
  - ./PROTOCOL.md
  - ./APPROVAL-FLOW.md
  - ./SERVE.md
  - ./WORKER.md
---

# bpdus agbrowse 문서 안내

이 디렉터리는 `bpdus/agbrowse` 포크의 설계 문서와, PR 2에서 구현한 루프백 인증 계약을 담는다. 구현된 것은 paired-device-v1의 페어링, 접속 토큰, 반복 갱신, 즉시 폐기다. MCP 브리지, 브라우저 도구, 승인 페이지, OAuth, DPoP, 키 회전은 아직 없다.

Copyright (c) 2026 bpdus. 원 소프트웨어 저작권은 [루트 LICENSE](../../LICENSE)의 `Copyright (c) 2026 lidge-jun`을 따른다. 이 표시는 원 저작권을 대체하지 않는다.

## 문서 목록

| 문서 | 내용 |
|---|---|
| [BASELINE.md](./BASELINE.md) | 포크 기준 SHA, 기존 기능, 제외 경로, 위협 모델, 환경 조사의 미확인 항목 |
| [LICENSE-NOTES.md](./LICENSE-NOTES.md) | 루트 MIT LICENSE 고지 보존, 포크 문서 저작권, README 불일치, 의존성 조사 범위 |
| [PROTOCOL.md](./PROTOCOL.md) | 구현된 paired-device-v1 인증 계약과, 아직 구현하지 않은 도메인 제안 |
| [APPROVAL-FLOW.md](./APPROVAL-FLOW.md) | 승인 페이지에서 결정하고 `approval.status`로 읽는 흐름 |
| [SERVE.md](./SERVE.md) | 선택적 Tailscale Serve 추가와 해당 포트만 되돌리는 절차 |
| [WORKER.md](./WORKER.md) | 전용 Chrome 프로필을 쓰는 포그라운드 워커 |

프로토콜과 승인 문서의 도구명, 상태 이름, 토큰 TTL, `binding_hash` 필드는 서로 같게 둔다.

## PR 0 범위

PR 0은 문서 다섯 개만 추가한다. 코드, 설정, 루트 `README.md`, 루트 `LICENSE`는 바꾸지 않는다. 제외 경로의 파일을 삭제하지 않는다. 테스트, 브라우저 실행, 설치, 배포는 이 PR의 수락 조건이 아니다.

되돌리기는 문서 PR 철회 또는 이 문서 커밋의 revert다. 운영 영향은 없다.

PR 0 당시의 동작 표면은 기존 `agbrowse` CLI와 좁은 MCP 도구였다. PR 2는 여기에 루프백 paired-device-v1 인증만 더한다. 승인 페이지와 도메인 MCP 도구는 아직 없다.

## 확정 결정

2026-10-11에 확정한 내용은 다음과 같다.

1. 구현 기준 저장소는 GitHub `bpdus/agbrowse`다. upstream은 `lidge-jun/agbrowse`다.
2. 포크 기준 커밋은 `a5350886c23c91ce717b07fc27bc10d2b77d4454`다. 기준일 `2026-08-18`, 패키지 버전 `0.2.1`, 태그 `v0.2.1`은 제공된 기준 사실로 기록한다.
3. 첫 지원 사이트는 네이버다. 순서는 조회, 장바구니, 승인 결제다.
4. 결제 단계까지 iMac의 `jjbyun` 계정 하나로 운영한다. 에이전트 전용 Chrome 프로필은 분리한다.
5. 승인은 tailnet에서만 열리는 승인 페이지에서 받는다. 요청 에이전트는 `approval.status`를 읽고, 이후 실행기는 내부 토큰을 검사한다. 채팅 답장은 승인 증거가 아니다. 승인 페이지 인증은 확인 필요이며 아직 구현하지 않는다.
6. CDP는 iMac 내부에만 둔다. 게이트웨이만 tailnet에 공개한다. Funnel은 금지한다.
7. 탐지 회피, TLS/JA3 지문 모방, stealth·지문 정규화 렌더링은 향후 게이트웨이에서 노출하거나 자동 호출하지 않는다.
8. 비밀번호, OTP, 쿠키, 토큰은 도구 결과, 로그, argv에 넣지 않는다. 실제 승인 토큰도 모델에 반환하지 않는다.

## 확인 필요

다음 항목은 조사하거나 제품 기능을 확인하기 전에는 확정하지 않는다.

- bpdus-kit `vendor/agbrowse` 미러와 이 포크 기준 SHA의 전체 diff, 패치, 라이선스 비교. 미러 HEAD 기록은 `a03de27a28900a45569ec6324d6fd8a7fcd10544`, npm `0.1.18`이다. 비교를 완료했다고 쓰지 않는다.
- iMac 런타임(CPU, macOS, Chrome, Tailscale, Node), Tailscale Serve·herdr 설정, 재부팅 후 GUI 로그인과 Keychain 접근.
- 운영 기기 키의 Keychain 또는 OS 자격증명 저장. 파일 키 저장소는 개발용으로 명시할 때만 쓰며, 자동 폴백은 없다.
- MCP 전송 채택 버전. 도메인 버전 `0.1.0`과 구분하며, 클라이언트 호환성을 확인한 뒤에 고정한다.
- 네이버 조회·장바구니·결제의 구체적인 화면 흐름과 지원 가능 여부.
- Grok Bot이 검증 가능한 사용자 이벤트 서명을 제공하는지, 일회성 확인 코드의 전달·검증 방식.
- 포함 자산과 직접·간접 의존성의 고지 의무.
- 통신 표준의 정식 명칭. 현재 문서는 draft v0으로 둔다.
- OAuth 호환 프로필. 후속 작업이며 자체 `paired-device-v1`을 MCP 표준 OAuth로 표현하지 않는다.

## 설계와 구현의 경계

[PROTOCOL.md](./PROTOCOL.md)의 paired-device-v1 인증은 현재 checkout에 구현되어 있다. 관찰, 장바구니, 승인 도구와 상태 머신은 아직 제안이다. 승인 페이지도 없다. 기존 `browser_snapshot`, `browser_click_ref`는 재사용 후보이며, 게이트웨이 승인 표면이 아니다. Serve로 여는 절차는 [SERVE.md](./SERVE.md)에 있다.

신뢰 경로가 확보되기 전에는 자동 결제를 열지 않는다. 구매 요청 에이전트와 답장 중계 에이전트가 같으면 프롬프트 주입으로 승인 메시지를 위조할 수 있다. 이 문제는 에이전트가 주장하는 사용자 ID, 메시지 ID, 자체 서명만으로 해결되지 않는다. 상세는 [APPROVAL-FLOW.md](./APPROVAL-FLOW.md)를 따른다.
