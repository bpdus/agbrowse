---
note_type: spec
content_mode: reference
title: Agent Browser Gateway Protocol draft v0
status: draft
summary: MCP 전송, paired-device-v1 인증, 요청·결과 스키마, snapshot/ref, 승인 이벤트, 오류 코드, 버전 협상의 제안 계약이다.
created: 2026-10-11
updated: 2026-10-11
language: ko
render_target: github
project: bpdus/agbrowse
target_system: agent-browser-gateway
version: "0.1.0"
related_notes:
  - ./README.md
  - ./BASELINE.md
  - ./APPROVAL-FLOW.md
---

# Agent Browser Gateway Protocol draft v0

이 문서는 에이전트와 iMac 브라우저 게이트웨이 사이의 통신 표준 **draft v0**이다. 제안 도메인 버전은 `0.1.0`이다. 아래 도구 이름, 필드, JSON 예시는 **제안 계약**이며 현재 코드에 구현되어 있지 않다. 정식 명칭은 확인 필요다.

Copyright (c) 2026 bpdus. 원 소프트웨어 저작권은 [루트 LICENSE](../../LICENSE)의 `Copyright (c) 2026 lidge-jun`을 따른다. 이 표시는 원 저작권을 대체하지 않는다.

승인 상태 머신, 토큰 TTL, `binding_hash` 구성 요소는 [APPROVAL-FLOW.md](./APPROVAL-FLOW.md)와 같다.

## 범위

도메인 프로토콜은 인증된 클라이언트가 허용된 관찰, 조회, 장바구니, 승인된 실행을 요청하는 메시지 계약을 정한다. CDP는 iMac 내부에만 두고, 게이트웨이만 tailnet HTTPS로 연다. Funnel은 쓰지 않는다.

비밀번호, OTP, 쿠키, Authorization 헤더, 저장소 원문, 실제 승인 토큰은 도구 결과, 로그, argv, 모델 문맥에 넣지 않는다. 호출자 신원은 인증 문맥에서 얻는다. 요청 인자에 적힌 사용자 ID나 기기 ID만 믿지 않는다.

알 수 없는 프로토콜 버전과 지원하지 않는 작업은 거부한다. 결과가 불명한 쓰기 작업은 자동 재시도하지 않는다.

## 전송

기본 전송은 tailnet HTTPS 위의 MCP Streamable HTTP다. CLI에는 로컬 stdio 브리지를 제안한다. 브리지가 기기 키와 접속 토큰을 보관하고 게이트웨이에는 HTTPS로 붙는다.

MCP 채택 버전은 클라이언트 호환성 **확인 필요**이며 도메인 버전 `0.1.0`과 구분한다. 상호운용 검토 후보는 MCP 명세 `2025-11-25`다. 채택했다고 쓰지 않는다. [MCP 전송 명세](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

Host와 Origin을 검증한다. 임의 CORS를 허용하지 않는다. Tailscale 사용자 헤더만으로 앱 인증을 대체하지 않는다.

## 인증 프로필 `paired-device-v1`

MVP 인증은 프로젝트 확장 프로필 `paired-device-v1`이다. 자체 challenge 방식을 MCP 표준 OAuth로 표현하지 않는다. OAuth 호환 프로필은 후속이다.

제안 절차는 다음과 같다.

1. 정재가 iMac 관리 화면에서 제한 시간 동안 페어링을 연다.
2. 클라이언트가 기기별 P-256 키를 만들고 공개키를 제출한다.
3. 양쪽에 지문과 일회성 확인 코드를 보여 정재가 기기를 확인한다.
4. 게이트웨이가 `device_id`, 공개키, 권한, `device_epoch`를 저장한다.
5. 클라이언트가 challenge를 요청하면 서버는 32바이트 난수와 30초 만료의 challenge를 발급한다.
6. 클라이언트는 프로토콜 구분값, 서버 식별자, 기기 ID, challenge ID, nonce, 요청 권한, resource를 P-256으로 서명한다.
7. 서버가 등록 상태, 서명, 만료, 권한을 검사하고 challenge를 원자적으로 소비한 뒤 5분 접속 토큰을 발급한다.
8. 브리지는 약 4분에 새 challenge로 갱신한다. 폐기는 `device_epoch` 증가로 즉시 적용한다.

macOS Keychain 접근 방식과 박스의 키 저장 방식은 확인 필요다. 잠금 상태에서 키에 닿지 못하면 평문 파일로 바꾸지 않고 중단한다.

접속 토큰 제안 필드: `iss`, `aud`, `sub`, `device_id`, `scope`, `iat`, `exp`, `jti`, `device_epoch`. 토큰에 적힌 권한과 현재 서버 정책의 교집합만 허용한다.

## 요청 공통 필드

모든 도메인 요청은 다음 필드를 포함한다. 쓰기와 승인 관련 호출에는 `operation_id`와 `idempotency_key`를 둔다.

| 필드 | 의미 |
|---|---|
| `protocol_version` | 도메인 버전. 현재 제안값은 `"0.1.0"`이다. |
| `request_id` | 호출 단위 ID. 로그와 오류 상관에 쓴다. |
| `session_id` | 브라우저 세션 ID. 인증된 세션 소유권과 대조한다. |
| `operation_id` | 장바구니·승인·실행처럼 상태가 있는 작업 ID. |
| `idempotency_key` | 같은 쓰기 요청의 중복 제출을 합친다. |

인자의 `device_id`, `user_id`, `conversation_id`는 힌트일 수 있다. 권한 결정은 인증 문맥의 기기와 등록된 권한으로 한다.

## 제안 JSON 예시

서명 값과 ID는 설명용이다. 스키마는 제안 계약이다.

### challenge

```json
{
  "protocol_version": "0.1.0",
  "challenge_id": "ch_01",
  "purpose": "paired-device-v1",
  "gateway_id": "gw_imac",
  "device_id": "dev_grokbot",
  "nonce": "<base64url-32-random-bytes>",
  "resource": "https://<gateway-host>/mcp",
  "requested_scopes": ["browser:read", "cart:write"],
  "expires_in": 30
}
```

### proof

```json
{
  "protocol_version": "0.1.0",
  "request_id": "req_auth_01",
  "challenge_id": "ch_01",
  "device_id": "dev_grokbot",
  "proof": "<compact-JWS-over-the-complete-challenge>"
}
```

서버는 요청자가 지정한 임의 키 URL이나 `alg` 값을 신뢰하지 않는다. 허용 알고리즘 목록은 서버가 고정한다.

### MCP `tools/call` 관찰

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "tools/call",
  "params": {
    "name": "browser.observe",
    "arguments": {
      "protocol_version": "0.1.0",
      "request_id": "req_obs_18",
      "session_id": "bs_01",
      "tab_id": "tab_01",
      "frame_id": "frame_main",
      "base_snapshot_id": null,
      "max_nodes": 120
    }
  }
}
```

### snapshot full

`base_snapshot_id`가 없거나 서버가 diff를 만들 수 없으면 `kind`는 `"full"`이다.

```json
{
  "protocol_version": "0.1.0",
  "request_id": "req_obs_18",
  "session_id": "bs_01",
  "tab_id": "tab_01",
  "frame_id": "frame_main",
  "document_epoch": 7,
  "snapshot_id": "snap_18",
  "kind": "full",
  "base_snapshot_id": null,
  "page": {
    "origin": "https://shopping.naver.com",
    "url": "https://shopping.naver.com/products/example",
    "title": "상품 상세"
  },
  "content_trust": "untrusted",
  "nodes": [
    {
      "ref": "r_18_03",
      "frame_id": "frame_main",
      "role": "button",
      "name": "장바구니 담기",
      "allowed_actions": ["cart.add"]
    }
  ],
  "redactions": ["password_fields", "otp_fields", "account_identifiers"],
  "truncated": false
}
```

### snapshot diff

```json
{
  "protocol_version": "0.1.0",
  "request_id": "req_obs_19",
  "session_id": "bs_01",
  "tab_id": "tab_01",
  "frame_id": "frame_main",
  "document_epoch": 8,
  "snapshot_id": "snap_19",
  "kind": "diff",
  "base_snapshot_id": "snap_18",
  "content_trust": "untrusted",
  "added": [
    {
      "ref": "r_19_11",
      "frame_id": "frame_main",
      "role": "status",
      "name": "장바구니에 담았습니다",
      "allowed_actions": []
    }
  ],
  "updated": [],
  "removed": ["r_18_03"],
  "redactions": ["password_fields", "otp_fields", "account_identifiers"],
  "truncated": false
}
```

페이지 본문은 비신뢰 콘텐츠다. `content_trust`는 `"untrusted"`로 표시한다. `allowed_actions`는 서버 정책과 사이트 어댑터가 계산하며 페이지가 선언할 수 없다.

### `approval.create`

요청 에이전트가 호출한다. 게이트웨이는 실제 checkout을 검증한 뒤 pending intent를 저장하고 `approval_id`, `binding_hash`, 사람이 읽을 요약을 반환한다. 실제 승인 토큰은 이 결과에 넣지 않는다.

```json
{
  "jsonrpc": "2.0",
  "id": 72,
  "method": "tools/call",
  "params": {
    "name": "approval.create",
    "arguments": {
      "protocol_version": "0.1.0",
      "request_id": "req_72",
      "session_id": "bs_01",
      "operation_id": "op_72",
      "idempotency_key": "idem_op_72"
    }
  }
}
```

제안 결과:

```json
{
  "protocol_version": "0.1.0",
  "request_id": "req_72",
  "session_id": "bs_01",
  "operation_id": "op_72",
  "state": "AWAITING_APPROVAL",
  "approval_id": "ap_72",
  "binding_hash": "sha256:<canonical-intent-hash>",
  "summary": {
    "action": "purchase",
    "origin": "https://shopping.naver.com",
    "items": [
      {
        "product_id": "sku_123",
        "option": "기본형",
        "quantity": 1
      }
    ],
    "total": {
      "currency": "KRW",
      "minor_units": 32900
    },
    "delivery_label": "등록 배송지 1",
    "payment_label": "등록 결제수단 1"
  },
  "pending_expires_in": 300
}
```

`pending_expires_in`은 pending 요청의 만료 초다. 승인 토큰 만료(발급 후 120초)와 구분한다. `binding_hash`는 정규화된 intent의 SHA-256이다. 묶는 필드는 [APPROVAL-FLOW.md](./APPROVAL-FLOW.md)의 바인딩 절과 같다.

### `approval.status`

요청 에이전트가 결정 상태를 직접 읽는 경로다. 채팅 전달만으로 승인을 확인하지 않는다. 실제 승인 토큰은 반환하지 않는다.

```json
{
  "jsonrpc": "2.0",
  "id": 73,
  "method": "tools/call",
  "params": {
    "name": "approval.status",
    "arguments": {
      "protocol_version": "0.1.0",
      "request_id": "req_73",
      "session_id": "bs_01",
      "approval_id": "ap_72"
    }
  }
}
```

승인된 뒤의 제안 결과. `token_expires_in`은 토큰 발급 시각부터의 남은 초이며 최대 120이다.

```json
{
  "protocol_version": "0.1.0",
  "request_id": "req_73",
  "session_id": "bs_01",
  "operation_id": "op_72",
  "approval_id": "ap_72",
  "state": "APPROVED",
  "binding_hash": "sha256:<canonical-intent-hash>",
  "decision": "approve",
  "pending_expires_in": 0,
  "token_expires_in": 120
}
```

실행 요청은 `approval_id`를 참조한다. 실행기가 내부 토큰을 검사한다.

### 제한된 `approval.decide` 이벤트

`approval.decide`는 신뢰된 채팅 어댑터, 또는 사용자 메시지를 중계하는 에이전트만 호출하는 제한된 결정 경로다. 일반 구매 에이전트의 승인 발급 도구로 노출하지 않는다. 버튼 선택이나 명시적 답장은 그 에이전트 대화의 사용자 메시지로 돌아온다. 별도 callback, webhook, 서명 API를 이 초안에 두지 않는다.

```json
{
  "jsonrpc": "2.0",
  "id": 88,
  "method": "tools/call",
  "params": {
    "name": "approval.decide",
    "arguments": {
      "protocol_version": "0.1.0",
      "request_id": "req_decide_88",
      "session_id": "bs_01",
      "approval_id": "ap_72",
      "event_id": "ae_88",
      "decision": "approve",
      "binding_hash": "sha256:<canonical-intent-hash>"
    }
  }
}
```

중계 경로가 넣는 설명용 이벤트 본문:

```json
{
  "type": "approval.decide",
  "protocol_version": "0.1.0",
  "event_id": "ae_88",
  "approval_id": "ap_72",
  "decision": "approve",
  "binding_hash": "sha256:<canonical-intent-hash>",
  "actor": {
    "platform": "<configured-platform>",
    "user_id": "<registered-user-id>",
    "conversation_id": "<bound-conversation-id>",
    "message_id": "<original-user-message-id>"
  }
}
```

에이전트가 주장하는 `user_id`, `message_id`, 자체 서명은 독립된 승인 증거가 아니다. 구매 요청자와 답장 중계자가 같은 에이전트이면 프롬프트 주입으로 이 이벤트를 위조할 수 있다. 신뢰 증거가 부족하면 `TRUST_EVIDENCE_INSUFFICIENT`로 거부한다. 완화 선택지는 [APPROVAL-FLOW.md](./APPROVAL-FLOW.md)에 있다.

### 오류 결과

도구 수행 실패는 MCP `isError`와 구조화된 본문으로 표현한다. JSON-RPC 문법 오류와 구매 결과 불명을 같은 코드로 쓰지 않는다.

```json
{
  "protocol_version": "0.1.0",
  "request_id": "req_72",
  "session_id": "bs_01",
  "is_error": true,
  "error": {
    "code": "STALE_REF",
    "message": "ref가 현재 snapshot에 속하지 않습니다.",
    "snapshot_id": "snap_19",
    "document_epoch": 8
  }
}
```

거절 예시:

```json
{
  "protocol_version": "0.1.0",
  "request_id": "req_73",
  "session_id": "bs_01",
  "approval_id": "ap_72",
  "state": "DENIED",
  "binding_hash": "sha256:<canonical-intent-hash>",
  "decision": "deny"
}
```

바인딩 불일치 예시:

```json
{
  "protocol_version": "0.1.0",
  "request_id": "req_80",
  "session_id": "bs_01",
  "is_error": true,
  "error": {
    "code": "BINDING_MISMATCH",
    "message": "checkout 총액이 승인 intent와 다릅니다.",
    "approval_id": "ap_72",
    "binding_hash": "sha256:<canonical-intent-hash>"
  }
}
```

## snapshot과 ref

snapshot은 세션, 탭, 프레임, `document_epoch`, `snapshot_id`를 포함한다. 페이지에서 온 문자열은 비신뢰로 표시한다. 비밀 필드는 redaction 목록에 넣고, 크기 제한에 걸리면 `truncated`를 true로 둔다. 잘린 스냅샷의 ref로 실행하지 않는다.

ref는 그 snapshot에 종속된다. 새 snapshot, 탐색, 새로고침, 관련 DOM 변화 뒤에는 `STALE_REF` 또는 `STATE_CHANGED`로 거부한다. 비슷한 버튼으로 자동 대체하지 않는다. 실행 직전에 실제 요소와 의미를 다시 확인한다.

로그인·결제 인증 화면의 스크린샷은 차단하거나 검증된 영역만 제공한다. 입력 칸을 가렸다고 모든 비밀이 제거된 것은 아니다.

## 오류 코드

| 코드 | 의미 | 처리 |
|---|---|---|
| `AUTH_EXPIRED` | 접속 토큰이 만료됐다. | 브리지가 갱신한 뒤 같은 `idempotency_key`로 재요청한다. |
| `DEVICE_REVOKED` | 기기가 폐기됐다. | 연결을 닫고 자동 복구하지 않는다. |
| `DOMAIN_DENIED` | origin이 허용 목록 밖이다. | 작업을 중단한다. |
| `ACTION_DENIED` | 도구 또는 동작이 권한 밖이다. | 작업을 중단한다. |
| `STALE_REF` | ref가 현재 snapshot에 속하지 않는다. | 다시 관찰한다. |
| `STATE_CHANGED` | 문서나 checkout이 바뀌었다. | 다시 관찰한다. 승인과 다르면 재승인한다. |
| `APPROVAL_REQUIRED` | 쓰기에 승인이 필요하다. | `AWAITING_APPROVAL`과 `approval_id`를 반환한다. |
| `APPROVAL_EXPIRED` | pending 또는 토큰이 만료됐다. | 해당 승인으로 실행하지 않는다. |
| `APPROVAL_CONSUMED` | 토큰이 이미 쓰였다. | 해당 승인으로 실행하지 않는다. |
| `APPROVAL_DENIED` | 사용자가 거절했다. | 상태 `DENIED`. 실행하지 않는다. |
| `BINDING_MISMATCH` | 세션, 금액, 대상 등 intent 필드가 다르다. | 기존 승인을 `INVALIDATED`로 두고 재승인한다. |
| `TRUST_EVIDENCE_INSUFFICIENT` | 중계 경로의 사용자 증거가 부족하다. | 토큰을 발급하지 않는다. |
| `HUMAN_REQUIRED` | 로그인, MFA, 캡차 등 사람 조작이 필요하다. | 자동화로 우회하지 않는다. |
| `SITE_UNSUPPORTED` | 검증하지 않은 흐름이다. | 사람에게 넘긴다. |
| `OUTCOME_UNKNOWN` | 쓰기 결과를 확인하지 못했다. | 자동 재시도하지 않고 주문·전송을 조회한다. |
| `VERSION_UNSUPPORTED` | 프로토콜 버전을 모른다. | 호환 버전 정보를 돌려주고 거부한다. |

인증 실패는 HTTP 401로 둘 수 있다. 권한 부족은 적절한 HTTP 권한 오류와 위 코드로 함께 표현한다.

## 버전 협상

클라이언트는 매 요청에 `protocol_version`을 넣는다. 서버는 지원 목록과 비교한다. `"0.1.0"`만 이 draft의 제안 값이다. 비어 있거나 알 수 없는 값, 상위 주 버전은 `VERSION_UNSUPPORTED`로 거부한다. 지원하지 않는 도구 이름과 capability도 거부하며, 무시하고 실행하지 않는다.

MCP 전송 버전 협상은 MCP 채택 버전이 정해진 뒤에 별도로 적는다. 도메인 버전 합의가 MCP 버전 합의를 대신하지 않는다.

## 재시도와 비밀

읽기 관찰은 새 `request_id`로 다시 호출할 수 있다. 장바구니 추가, 승인 소비, 결제는 `idempotency_key`가 같더라도 결과가 `OUTCOME_UNKNOWN`이면 자동 재시도하지 않는다. 재시작 직후 실행 중이던 결제를 다시 누르지 않는다.

감사 로그에는 호출자, 기기, 대화, 세션, 사이트, 동작, 정책 판단, `approval_id`, 결과를 남긴다. Authorization, Cookie, 서명 proof, 승인 토큰, 비밀번호, OTP는 제거한다.
