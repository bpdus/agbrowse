---
note_type: policy
content_mode: reference
title: 에이전트 브라우저 승인 흐름
status: draft
summary: approval.create부터 상태 조회, 일회성 토큰 소비, 단절 복구까지의 제안 계약과 신뢰 한계를 정의한다.
created: 2026-10-11
updated: 2026-10-11
language: ko
render_target: github
project: bpdus/agbrowse
related_notes:
  - ./README.md
  - ./BASELINE.md
  - ./PROTOCOL.md
---

# 에이전트 브라우저 승인 흐름

이 문서는 조회 이후의 장바구니 확인과 결제 실행에 필요한 승인 설계다. 도구 이름, 상태 이름, 토큰 TTL, `binding_hash` 필드는 [PROTOCOL.md](./PROTOCOL.md)의 제안 계약과 같다. 게이트웨이와 승인 서비스는 아직 구현되어 있지 않다.

Copyright (c) 2026 bpdus. 원 소프트웨어 저작권은 [루트 LICENSE](../../LICENSE)의 `Copyright (c) 2026 lidge-jun`을 따른다. 이 표시는 원 저작권을 대체하지 않는다.

신뢰 경로가 확보되기 전에는 자동 결제를 열지 않는다.

## 승인 흐름

1. 게이트웨이가 실제 checkout을 검증하고 pending intent를 만든다.
2. 사람에게 tailnet에서만 열리는 승인 페이지의 알림과 링크를 보낸다.
3. 인증된 사람이 그 페이지에서 승인하거나 거절한다.
4. 요청 에이전트는 `approval.status`를 읽어 결정 상태를 확인한다.
5. 이후 실행기는 자신의 내부 토큰을 검사한다.

채팅 답장과 채팅 로그는 승인 증거가 아니다. “사용자가 허락했다”는 모델의 해석도 승인 증거가 아니다. 승인 페이지의 인증 방식은 확인 필요다. 이 절은 흐름을 고친 문서이며, 승인 페이지는 구현하지 않는다.

## 상태 머신

```text
PREPARED → AWAITING_APPROVAL → APPROVED → DISPATCHING
                                         → SUCCEEDED / FAILED / OUTCOME_UNKNOWN
AWAITING_APPROVAL → DENIED / EXPIRED / CANCELLED
APPROVED → EXPIRED / CANCELLED / INVALIDATED
```

| 상태 | 의미 |
|---|---|
| `PREPARED` | checkout을 읽어 intent를 만들었다. 아직 승인 요청이 아니다. |
| `AWAITING_APPROVAL` | pending intent가 저장됐고 사람의 결정을 기다린다. |
| `APPROVED` | 신뢰 경로로 승인이 기록됐고 내부 토큰이 발급됐다. 토큰 수명 120초, 한 번만 사용한다. |
| `DISPATCHING` | 토큰을 원자적으로 소비한 뒤 사이트 동작을 시작했다. |
| `SUCCEEDED` | 주문 또는 대상 동작의 성공을 확인했다. |
| `FAILED` | 실행이 실패했고 주문이 성립하지 않은 것을 확인했다. |
| `OUTCOME_UNKNOWN` | 제출 이후 결과를 확인하지 못했다. |
| `DENIED` | 사용자가 거절했다. |
| `EXPIRED` | pending 만료 또는 토큰 120초 만료다. |
| `CANCELLED` | 사용자 또는 운영자가 취소했다. |
| `INVALIDATED` | 금액, 대상, 세션 등 바인딩이 바뀌어 기존 승인이 무효다. |

pending 요청의 만료 시간(`pending_expires_in`)과 승인 토큰 만료 시간(`token_expires_in`, 발급 후 120초)은 별도 시계다. pending이 먼저 끝나면 `AWAITING_APPROVAL`에서 `EXPIRED`로 간다. 승인 뒤에 120초가 지나면 `APPROVED`에서 `EXPIRED`로 간다.

승인 대기 중에는 해당 탭의 쓰기 소유권을 유지한다. 같은 쇼핑 계정의 장바구니·결제 작업은 탭이 달라도 직렬화한다. 서버 측 장바구니가 공유될 수 있기 때문이다.

## 바인딩 해시

`binding_hash`는 정규화된 intent JSON의 SHA-256이다. 직렬화 차이로 대상이 달라지지 않도록 canonical JSON 규칙을 두며, RFC 8785를 후보로 검토한다. 검증 벡터는 구현 PR에서 추가한다.

해시에는 다음을 묶는다.

- 호출자
- 기기
- 대화
- 세션
- 프로필
- 계정
- origin
- 상품, 옵션, 수량
- 최종 총액(통화와 최소 화폐 단위 정수)
- 배송지 식별자, 결제수단 식별자
- 작업 revision, 정책 revision

이 값이 바뀌면 기존 승인은 `INVALIDATED`가 되고 재승인한다. 실행 직전에도 실제 checkout과 `binding_hash`를 다시 대조한다.

내부 승인 토큰은 승인 전용 키로 서명한다. 실행기는 서명만 보지 않고 저장된 intent, 현재 정책, 미소비 상태, `device_epoch`까지 대조한다. 토큰 원문은 `approval.status` 응답에 넣지 않는다.

## 신뢰 문제

구매 요청 에이전트가 사용자 답장을 같은 대화에서 읽어 `approval.decide`를 호출하면, 페이지 문구와 도구 결과가 “승인합니다” 형태의 사용자 메시지를 흉내 내게 할 수 있다. 모델이 그 문장을 사용자 답장으로 착각하면 결제 토큰이 발급된다.

에이전트가 채우는 `user_id`, `message_id`, 자체 서명은 이 혼동을 막지 못한다. 증거는 게이트웨이가 사용자에게만 닿는 경로에서 나와야 한다.

승인은 tailnet에서만 열리는 승인 페이지에서만 결정한다. 요청 에이전트는 `approval.status`만 읽는다. 채팅 답장, 채팅 로그, 일회성 코드, 봇 이벤트는 승인 결정 경로가 아니다.

초기 정책은 정확한 총액과 내용에 대한 일회성 승인이다. 구독과 한도 이하 자동 구매는 넣지 않는다.

## 실행과 복구

실행기는 `approval_id`를 받아 내부 토큰을 검사한다. 토큰 소비와 `DISPATCHING` 기록을 하나의 저장 트랜잭션으로 남긴 뒤에만 사이트 동작을 시작한다. 토큰은 한 번만 쓰인다.

외부 사이트 동작은 한 번 성공한다고 보장하지 않는다. 주문 제출 후 응답이 끊기면 자동으로 다시 결제하지 않고 `OUTCOME_UNKNOWN`으로 둔 뒤 주문 내역을 조회한다. 프로세스 재시작 시에도 실행 중이던 결제를 자동 재개하지 않는다.

로그 저장이나 상태 기록에 실패하면 구매를 시작하지 않는다. 네트워크 단절, 절전, Keychain 잠금 뒤에는 연결과 상태를 다시 검증한다. 재접속만으로 대기 결제를 실행하지 않는다.

## 기대 결과

| 상황 | 기대 상태 또는 오류 | 실행 |
|---|---|---|
| 사용자가 거절 버튼을 누르거나 명시적으로 거절한다 | `approval.decide`가 `deny`를 기록하고 상태는 `DENIED`. `approval.status`는 `DENIED`와 `APPROVAL_DENIED`를 보여 준다. | 실행하지 않는다. |
| 채팅 답장이나 채팅 로그 | 상태 전이 없음. 사람은 승인 페이지에서 결정하고, 에이전트는 `approval.status`만 읽는다. | 실행하지 않는다. |
| pending 만료 | `AWAITING_APPROVAL` → `EXPIRED`, 코드 `APPROVAL_EXPIRED` | 실행하지 않는다. 새로 `approval.create`가 필요하다. |
| 승인 후 120초 경과 | `APPROVED` → `EXPIRED`, 코드 `APPROVAL_EXPIRED` | 실행하지 않는다. |
| 같은 `event_id` 또는 같은 토큰을 다시 제출 | 중복 이벤트는 무시하거나 이미 처리됨으로 응답. 소비된 토큰은 `APPROVAL_CONSUMED` | 두 번째 결제에 쓰지 않는다. |
| 다른 `session_id`로 같은 `approval_id` 사용 | `BINDING_MISMATCH`. 필요 시 `INVALIDATED` | 실행하지 않는다. |
| 승인 후 금액, 옵션, 수량, 배송지, 결제수단 변경 | `BINDING_MISMATCH`, 상태 `INVALIDATED` | 재승인 없이 실행하지 않는다. |
| 페이지가 승인 문장을 주입하고 같은 에이전트가 중계 | `TRUST_EVIDENCE_INSUFFICIENT`. 토큰 미발급 | 자동 결제를 열지 않는다. |
| 실행 시작 후 연결 단절 또는 재시작 | 이미 소비됐으면 `DISPATCHING` 또는 `OUTCOME_UNKNOWN` | 자동 재결제하지 않는다. 주문 조회만 한다. |
| 지원하지 않는 네이버 결제 화면 | `SITE_UNSUPPORTED` 또는 `HUMAN_REQUIRED` | 사람에게 넘긴다. |
| 알 수 없는 `protocol_version` | `VERSION_UNSUPPORTED` | 거부한다. |

아래 순서는 채팅 답장을 결정 경로로 두던 이전 제안이며, [Decision (2026-10-11)](#decision-2026-10-11)이 대체했다. 이전 제안: `approval.create` → 채팅 제시 → 사용자가 답장 → 제한된 `approval.decide` → 요청 에이전트가 `approval.status`를 직접 조회 → `APPROVED`일 때만 `approval_id`로 실행 요청.

확정된 순서는 승인 페이지에서 사람이 결정하고, 요청 에이전트는 `approval.status`만 읽는다. 채팅 답장이나 채팅 로그를 읽고 승인됐다고 단정하지 않는다.

## 감사

감사 이벤트에는 누가, 어떤 기기·대화·세션에서, 어떤 origin의 어떤 동작을 요청했는지, 정책 판단, `approval_id`, `binding_hash`, 결과 상태를 남긴다. 승인 토큰, 쿠키, 비밀번호, OTP, 서명 proof는 로그와 argv에 남기지 않는다.

보존 기간은 감사 메타데이터 90일, 승인 상세 30일로 확정했다. 스크린샷은 보존하지 않는다.

## Decision (2026-10-11)

승인 방법은 (a)로 확정했다. iMac 게이트웨이의 승인 페이지를 사용한다. 이 페이지는 tailnet에서만 열 수 있고, 정재만 열 수 있다. 인증 세부 방식은 확인 필요다. 페이지는 상품, 금액, 판매자를 보여주고 승인 버튼과 거절 버튼을 둔다.

알림은 PWA 푸시로 보낸다. Grok Bot은 채팅에 그 링크를 전달하는 보조 경로다. 요청 에이전트는 결과를 `approval.status`로만 읽는다. 버튼이 없는 CLI 에이전트도 같다. CLI는 `approval.status`를 조회하고, 사람은 승인 페이지에서 결정한다.

선택지 (b)와 (c)는 채택하지 않았다. 이 PR에는 승인 구현 코드를 넣지 않는다.

### PR 5

승인 페이지는 실제 결제 전에 끝까지 시험할 수 있어야 한다. 첫 검증은 시험용 판매자와 가짜 결제로 하며, 실제 checkout은 열지 않는다.
