---
note_type: spec
content_mode: reference
title: Agent Browser Gateway Protocol draft v0
status: draft
summary: 구현된 paired-device-v1 인증·브라우저 MCP·fail-closed cart 계약과 미구현 승인 제안을 구분한다.
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
  - ./SERVE.md
---

# Agent Browser Gateway Protocol draft v0

이 문서는 에이전트와 iMac 브라우저 게이트웨이 사이의 통신 표준 **draft v0**이다. 도메인 버전은 `0.1.0`이다. `paired-device-v1` 인증과 읽기 전용 MCP 브리지, 네이버 cart 도구 계약이 구현되어 있다. 승인 상태 머신은 아직 제안이다. 네이버 cart 도구는 fixture 계약만 검증했으며, 실제 네이버 레이아웃과 쓰기 경로는 검증되지 않아 운영 브라우저에서 `SITE_UNSUPPORTED`로 닫힌다. 정식 명칭은 확인 필요다.

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

구현된 인증은 `paired-device-v1`이다. 이것을 MCP 표준 OAuth로 표현하지 않는다. OAuth, DPoP, 키 회전은 후속이다.

모듈을 import해도 수신 소켓은 열리지 않는다. `start()`만 `127.0.0.1`에 붙는다. 다른 주소는 거부한다. 포그라운드 진입은 `node skills/browser/agent-gateway.mjs --port 7420`이다. 기본 포트는 7420이다. 인증 없는 `GET /healthz`는 `{"ok":true}`만 반환한다. 선택적 tailnet 공개는 [SERVE.md](./SERVE.md)를 따른다.

인증 HTTP 경로는 다음뿐이다. `GET /healthz`는 위에서 적었다.

| 메서드와 경로 | 결과 |
|---|---|
| `POST /auth/pair` | 열린 페어링 창 안의 pending 등록 |
| `POST /auth/challenge` | 활성 기기의 challenge |
| `POST /auth/token` | proof가 맞으면 접속 토큰 |

인증된 MCP 경로는 `/mcp`다. 승인·checkout·payment 경로는 없다. 페어링 창을 열고 닫기, 확인 코드 대조, 폐기는 프로세스 안 운영자 API다. 인증되지 않은 HTTP 관리 엔드포인트로 열지 않는다. 확인 코드는 응답 데이터로만 돌아가며 라이브러리 로그에 찍지 않는다.

Tailscale 신원 헤더는 믿지 않는다. Host는 허용 목록과 정확히 같아야 한다. Origin이 있으면 허용된 값만 받는다. CORS 헤더는 붙이지 않는다. 본문은 JSON만 받고 16 KiB를 넘기면 거부한다. `aud`와 `resource`는 서버 설정값에 묶이며 요청 Host로 정하지 않는다.

### 서명

Compact JWS만 쓴다. `alg`는 `ES256`으로 고정하고, 서명은 64바이트 IEEE-P1363이다. 다른 알고리즘, 원격 키 참조, 개인 키 JWK 필드, P-256이 아닌 곡선은 거부한다.

challenge proof 헤더는 다음 바이트와 같다.

```text
{"alg":"ES256","typ":"paired-device-v1+challenge"}
```

접속 토큰 헤더는 다음 바이트와 같다.

```text
{"alg":"ES256","typ":"paired-device-v1+access"}
```

payload는 아래 순서로 고정한 canonical UTF-8 JSON이다. JWS 서명 입력은 ASCII인 `base64url(header).base64url(payload)`다. scope 배열은 중복을 제거한 뒤 오름차순으로 두며, 시각은 정수 epoch 초다. proof의 payload 바이트는 서버가 저장한 challenge 바이트와 같아야 한다.

challenge payload 순서: `protocol_version`, `purpose`, `gateway_id`, `aud`, `device_id`, `challenge_id`, `nonce`, `resource`, `requested_scopes`, `iat`, `exp`, `expires_in`.

`protocol_version`은 `"0.1.0"`, `purpose`는 `"paired-device-v1"`이다. `nonce`는 32바이트를 base64url로 둔 값이다. `exp`는 `iat + 30`이고 `expires_in`은 30이다. `now >= exp`이면 만료다.

접속 토큰 claim 순서: `iss`, `aud`, `sub`, `device_id`, `scope`, `iat`, `exp`, `jti`, `device_epoch`.

`iss`는 gateway ID, `sub`와 `device_id`는 기기 ID, `exp`는 `iat + 300`이다. 서버 서명 키는 기기 키와 따로 둔다. 발급 응답의 토큰 자체가 인증된 결과다. 서명, 발급자, audience, 기기 바인딩, 시각, epoch를 검사한다. 유효 scope는 토큰 scope와 현재 기기 정책의 교집합이다. `iat`가 현재보다 30초를 넘겨 미래이면 거부한다. 그 여유로 만료 시각을 늘리지 않는다.

지문은 `{"crv":"P-256","kty":"EC","x":"...","y":"..."}`의 SHA-256을 base64url로 둔 값이다.

### 한도

페어링 창 기본 TTL은 120초다. pending 등록은 32개까지다. 확인 코드 시도는 pending마다 5회다. 기기마다 60초에 challenge 30회까지 발급한다. 메모리에 두는 미사용 challenge는 32개까지다. 재시작하면 페어링 창과 challenge는 사라진다. 등록, 서버 신원, 폐기 목록은 남는다. 다시 페어링하면 새 `device_id`를 만들고, 폐기된 항목은 그대로 둔다.

클라이언트는 페어링 때 gateway ID, audience, 서버 공개 키를 고정한다. 토큰은 메모리에만 둔다. 발급 뒤 240초가 되면 사람 입력 없이 새 challenge와 토큰을 받는다. 동시에 온 갱신은 진행 중인 하나를 공유한다. 갱신이 실패하면 만료된 토큰을 돌려주지 않는다. 폐기는 epoch를 올리고 곧바로 challenge, proof, 이미 발급한 토큰을 거부한다.

운영 전송은 HTTPS와 일반 인증서 검증을 요구한다. 테스트만 루프백 HTTP를 명시적으로 넣을 수 있다. Keychain 연동은 확인 필요이며 구현되어 있지 않다. `createDevFileKeyStore`는 개발용으로 명시해서 고른다. 운영 저장소가 없다고 파일로 자동 전환하지 않는다.

상태 파일은 버전 1 JSON이다. gateway 신원과 공개 키, 기기, 부여 scope, epoch, 폐기 목록을 담는다. 개인 키는 키 저장소에만 둔다. 디렉터리는 `0700`, 파일과 임시 파일은 `0600`이다. 심볼릭 링크, 다른 소유자, 느슨한 권한, 읽을 수 없는 상태, 지원하지 않는 버전은 실패로 닫는다. 쓰기는 임시 파일, flush, rename, 디렉터리 flush 순서다. 상태 디렉터리의 쓰기 잠금은 하나이며, 잠긴 이유를 추정해 빼앗지 않는다. 저장이 실패하면 등록이나 폐기 성공을 보고하지 않는다. 신원을 자동으로 다시 만들거나 깨진 상태를 덮어쓰지 않는다.

## 요청 공통 필드

모든 도메인 요청은 다음 필드를 포함한다. 쓰기와 승인 관련 호출에는 `operation_id`와 `idempotency_key`를 둔다. MCP 전송의 `request_id`는 각 호출을 식별하지만, 장바구니 중복 처리는 이 값을 사용하지 않는다.

| 필드 | 의미 |
|---|---|
| `protocol_version` | 도메인 버전. 현재 제안값은 `"0.1.0"`이다. |
| `request_id` | 호출 단위 ID. 응답과 오류를 상관시키며 로그에는 기록하지 않는다. |
| `session_id` | 브라우저 세션 ID. 인증된 세션 소유권과 대조한다. |
| `operation_id` | 장바구니·승인·실행처럼 상태가 있는 작업 ID. |
| `idempotency_key` | 같은 쓰기 요청의 중복 제출을 합친다. |

인자의 `device_id`, `user_id`, `conversation_id`는 힌트일 수 있다. 권한 결정은 인증 문맥의 기기와 등록된 권한으로 한다.

## 네이버 로그인 상태 도구

`naver.login_status`는 `browser:read` scope만 요구한다. `protocol_version`, `request_id`, `session_id`만 받고, 현재 세션 탭을 고정 주소 `https://www.naver.com/`로 이동한다. 이 호출 중에만 해당 주소와 페이지 표시를 위한 `https://ssl.pstatic.net`, `https://s.pstatic.net` 정적 호스트의 GET/HEAD 요청을 허용한다. 리다이렉트도 같은 정책으로 검사하며, 쓰기 요청과 WebSocket은 계속 차단한다. 로그인 주소를 따라가거나 로그인 동작을 수행하지 않는다.

MCP 결과는 `{"status":"logged_in|logged_out|unknown","evidence":"logout_link|login_link|none"}` 두 필드뿐이다. 문서 어디에서든 `nid.naver.com/nidlogin.logout` 링크 대상이 있으면 `logged_in`이다. 없고 `nid.naver.com/nidlogin.login` 링크 대상이 있으면 `logged_out`이다. 둘 다 있으면 `logged_in`이 우선하며, 대상 링크가 없으면 `unknown`이다. 이름, 이메일, URL, DOM 텍스트, 쿠키를 결과에 포함하지 않는다.

## 네이버 장바구니 도구

네이버 장바구니 읽기와 변경 준비는 서로 다른 scope를 요구한다. 상품·장바구니 조회는 `browser:read`만 요구한다. `naver.cart.prepare`와 `naver.cart.set`은 `browser:read`와 `cart:write`를 함께 요구한다. `cart:write`는 사람이 페어링 과정에서 명시적으로 승인해야 한다. 기존 기기에는 자동으로 추가하지 않는다. `cart:write`를 회수하려면 해당 기기를 폐기한 뒤 이 scope 없이 다시 페어링한다.

| 도구 | 전용 인자 | 동작 |
|---|---|---|
| `naver.product.read` | 없음 | `browser:read`. 현재 열려 있는 지원 상품 페이지에서 상품·옵션·가격·재고와 상태 지문을 읽는다. |
| `naver.cart.read` | 없음 | `browser:read`. 현재 열려 있는 지원 장바구니에서 opaque line ref, 상품·variant ID, 수량·단가와 상태 지문을 읽는다. |
| `naver.cart.prepare` | `product_ref`, `option_ids`, `quantity`, `expected_unit_price`, `dry_run` | `browser:read`와 `cart:write`. 정확한 옵션 조합을 확인하고 절대 목표 수량을 5분 유효 intent에 묶는다. `dry_run` 기본값은 `true`다. |
| `naver.cart.set` | `intent_id`, `idempotency_key`, `dry_run` | `browser:read`와 `cart:write`. 준비된 intent를 적용하거나 기본값인 inspection-only 예측 결과를 반환한다. `dry_run` 기본값은 `true`다. |

네 도구의 입력 스키마는 추가 속성을 허용하지 않는다. 모든 호출은 `protocol_version: "0.1.0"`, bounded `request_id`, 현재 브라우저 `session_id`를 포함한다. `quantity`는 1부터 99까지의 정수이며, 해당 상품과 variant의 **절대 목표 수량**이다. 다른 수량을 더하는 값이 아니다. 품절, 모호한 variant, 구독형 상품, 임의 옵션 조합은 거부한다.

현재 checkout에는 실제 네이버 상품·장바구니 DOM이나 변경 endpoint를 확인할 수 있는 위생 처리된 증거가 없다. 테스트는 별도의 synthetic fixture 표식만 읽는다. 운영 runtime에는 live 호환성 capability가 없으므로 네이버 페이지가 fixture와 비슷해 보여도 cart 작업을 수행하지 않는다. 제품·장바구니 조회, 준비, 실행은 로그인/사람 확인 화면을 제외하면 `SITE_UNSUPPORTED`로 닫힌다. live 지원을 추가하려면 sanitized layout evidence와 cart-only 응답·readback 검증을 확인하고 별도 변경에서 capability를 명시적으로 구현해야 한다.

기본 dry-run은 기존 DOM을 읽기만 한다. 탐색, 옵션 선택, 입력, 클릭, 제출, mutation permit은 사용하지 않으며 `DRY_RUN`, `site_changed: false`, `order_created: false`, `verification_basis: "no_mutation_dispatched"`를 반환한다. 실행 intent는 기기와 epoch, MCP/browser session, worker incarnation, 전용 프로필 account key, 상품/variant, 수량, 가격, layout 및 cart fingerprint에 묶인다. 가격이나 관련 상태가 바뀌거나 5분이 지나면 다시 준비해야 한다.

중복 키는 기기와 worker-owned account key 조합 안에서 유일하다. digest는 transport `request_id`를 제외한 작업 내용으로 계산한다. 같은 키와 내용은 저장된 작업 결과를 돌려주고, 다른 내용은 `IDEMPOTENCY_CONFLICT`로 거부한다. worker는 첫 mutation보다 먼저 `DISPATCHING`을 저장한다. 재시작 뒤 이 상태가 남아 있으면 `OUTCOME_UNKNOWN`으로 바꾸며 자동 재전송하지 않는다. account의 불명 작업은 조정될 때까지 새 쓰기를 막는다.

실제 실행을 훗날 활성화할 때에도 정확한 cart-only 응답과 cart readback이 모두 일치해야 성공으로 기록할 수 있다. checkout/order/payment 경로, 승인 우회, 광범위한 Naver POST는 허용할 수 없다. 주문 생성 응답이나 차단된 주문 시도가 감지되면 adapter를 비활성화한다. 구매·결제 기능은 이 도구 범위에 포함되지 않는다.

### 장바구니 오류 코드

scope와 소유권 오류는 HTTP 403으로 반환한다. 동작 오류는 MCP `isError: true`와 고정 메시지를 사용한다.

| 코드 | 의미 |
|---|---|
| `LOGIN_REQUIRED` | 로그인 화면이 감지되어 사용자의 수동 로그인이 필요하다. 로그인 주소를 따라가거나 자격 증명을 읽고 입력하지 않는다. |
| `OPTION_INVALID` | 옵션 조합이 없거나 정확히 하나로 결정되지 않는다. |
| `QUANTITY_INVALID` / `OUT_OF_STOCK` | 수량이 허용 범위를 벗어나거나 재고보다 많다. |
| `PRICE_CHANGED` / `STATE_CHANGED` | 준비 뒤 가격 또는 관련 상태가 달라졌다. |
| `INTENT_EXPIRED` | intent가 만료되었거나 binding과 맞지 않는다. |
| `IDEMPOTENCY_CONFLICT` | 같은 기기/account 키를 다른 작업 내용에 재사용했다. |
| `CART_CONFIRMATION_FAILED` | cart-only 응답과 정확한 readback이 일치하지 않는다. |
| `ORDER_CREATION_DETECTED` | 주문·checkout 동작이 감지되어 차단했다. |
| `OUTCOME_UNKNOWN` / `ACCOUNT_BLOCKED` | dispatch 뒤 결과가 불명확해 계정 쓰기를 막았다. |

## 제안 JSON 예시

아래 challenge·token 예시는 구현된 인증 본문이다. 관찰과 snapshot 예시는 draft 계약이며, cart 도구의 현재 구현 경계는 위 절에 적었다. 인증 요청에 없는 필드를 넣으면 거부한다.

### `POST /auth/challenge` 응답의 서명 payload

```json
{
  "protocol_version": "0.1.0",
  "purpose": "paired-device-v1",
  "gateway_id": "gw_imac",
  "aud": "https://gw.example/mcp",
  "device_id": "dev_example",
  "challenge_id": "ch_example",
  "nonce": "<base64url-32-bytes>",
  "resource": "https://gw.example/mcp",
  "requested_scopes": ["browser:read", "cart:write"],
  "iat": 1700000000,
  "exp": 1700000030,
  "expires_in": 30
}
```

HTTP 응답은 이 객체의 UTF-8 바이트를 base64url로 둔 `payload`를 준다. 클라이언트는 그 바이트를 그대로 서명한다.

### `POST /auth/token`

```json
{
  "protocol_version": "0.1.0",
  "challenge_id": "ch_example",
  "device_id": "dev_example",
  "proof": "<compact-jws>"
}
```

성공 응답은 `token`, `token_type` `"Bearer"`, `expires_in` 300을 포함한다. 서버는 원격 키 URL이나 다른 `alg`를 받지 않는다.

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
      "operation_id": "op_72",
      "idempotency_key": "idem_decide_88",
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
  "decision": "deny",
  "error": {
    "code": "APPROVAL_DENIED",
    "message": "사용자가 승인을 거절했습니다."
  }
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
| `PAIRING_CLOSED` | 페어링 창이 없거나 닫혔다. | 등록하지 않는다. |
| `PAIRING_EXPIRED` | 페어링 창이나 pending이 만료됐다. | 등록하지 않는다. |
| `AUTH_INVALID` | 서명, audience, 기기, epoch, 형식이 맞지 않는다. | 토큰을 발급하거나 수락하지 않는다. |
| `AUTH_EXPIRED` | challenge 또는 접속 토큰이 만료됐다. | 만료된 토큰을 돌려주지 않는다. |
| `CHALLENGE_USED` | challenge를 이미 소비했다. | 두 번째 proof는 거부한다. |
| `DEVICE_REVOKED` | 기기가 폐기됐다. | challenge, proof, 기존 토큰을 거부한다. |
| `SCOPE_DENIED` | 요청 scope가 허용 밖이다. | 그 권한으로 발급하지 않는다. |
| `VERSION_UNSUPPORTED` | 상태 또는 프로토콜 버전을 지원하지 않는다. | 상태를 덮어쓰지 않고 거부한다. |
| `RATE_LIMITED` | pending, challenge 저장, 발급 속도를 넘겼다. | 새로 만들지 않는다. |
| `STATE_UNSAFE` | 경로, 권한, 잠금, 상태 내용이 안전하지 않다. | 성공으로 보고하지 않는다. |
| `KEY_UNAVAILABLE` | 서명 키를 쓸 수 없다. | 파일 저장소로 자동 전환하지 않는다. |
| `DOMAIN_DENIED` | origin이 허용 목록 밖이다. | 작업을 중단한다. |
| `ACTION_DENIED` | 도구 또는 동작이 권한 밖이다. | 작업을 중단한다. |
| `STALE_REF` | ref가 현재 snapshot에 속하지 않는다. | 다시 관찰한다. |
| `STATE_CHANGED` | 문서나 cart가 바뀌었다. | 다시 관찰하고 cart intent를 준비한다. |
| `APPROVAL_REQUIRED` | 쓰기에 승인이 필요하다. | `AWAITING_APPROVAL`과 `approval_id`를 반환한다. |
| `APPROVAL_EXPIRED` | pending 또는 토큰이 만료됐다. | 해당 승인으로 실행하지 않는다. |
| `APPROVAL_CONSUMED` | 토큰이 이미 쓰였다. | 해당 승인으로 실행하지 않는다. |
| `APPROVAL_DENIED` | 사용자가 거절했다. | 상태 `DENIED`. 실행하지 않는다. |
| `BINDING_MISMATCH` | 세션, 금액, 대상 등 intent 필드가 다르다. | 기존 승인을 `INVALIDATED`로 두고 재승인한다. |
| `TRUST_EVIDENCE_INSUFFICIENT` | 중계 경로의 사용자 증거가 부족하다. | 토큰을 발급하지 않는다. |
| `HUMAN_REQUIRED` | 로그인, MFA, 캡차 등 사람 조작이 필요하다. | 자동화로 우회하지 않는다. |
| `SITE_UNSUPPORTED` | 검증하지 않은 흐름이다. | 사람에게 넘긴다. |
| `OUTCOME_UNKNOWN` | dispatch 뒤 쓰기 결과를 확인하지 못했다. | 자동 재시도하지 않는다. 계정 쓰기를 막고 작업자가 상태를 확인한다. |

인증 실패는 HTTP 401로 둘 수 있다. 권한 부족은 적절한 HTTP 권한 오류와 위 코드로 함께 표현한다.

## 버전 협상

클라이언트는 매 요청에 `protocol_version`을 넣는다. 서버는 지원 목록과 비교한다. `"0.1.0"`만 이 draft의 제안 값이다. 비어 있거나 알 수 없는 값, 상위 주 버전은 `VERSION_UNSUPPORTED`로 거부한다. 지원하지 않는 도구 이름과 capability도 거부하며, 무시하고 실행하지 않는다.

MCP 전송 버전 협상은 MCP 채택 버전이 정해진 뒤에 별도로 적는다. 도메인 버전 합의가 MCP 버전 합의를 대신하지 않는다.

## 재시도와 비밀

읽기 관찰은 새 `request_id`로 다시 호출할 수 있다. 장바구니 추가, 승인 소비, 결제는 `idempotency_key`가 같더라도 결과가 `OUTCOME_UNKNOWN`이면 자동 재시도하지 않는다. 재시작 직후 실행 중이던 결제를 다시 누르지 않는다.

현재 MCP와 worker 로그에는 허용 목록의 도구/operation, 고정 코드, 처리 시간과 생성된 correlation ID만 남긴다. caller `request_id`, 기기·세션 정보, 사이트 주소, payload, DOM, headers, 토큰, raw exception은 기록하지 않는다.
