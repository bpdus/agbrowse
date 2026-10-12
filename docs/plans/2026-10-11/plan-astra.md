권장안은 **iMac에 agbrowse 기반 게이트웨이를 두고, 각 CLI와 grokbot-box가 인증된 MCP 클라이언트로 접속하는 구조**다. 최초 기기 등록 이후에는 서명 challenge로 짧은 접속 토큰을 자동 발급한다. 구매·결제·전송·게시 권한은 접속 권한과 분리하고, 정재의 승인으로 발급한 일회성 토큰을 실행 코드에서 검사한다.

다만 **임의의 웹사이트에서 자유로운 클릭을 허용하면서 모든 결제·전송을 완벽히 식별하는 것은 보장할 수 없다.** 강제 승인 요구를 충족하려면 원격 도구를 제한하고, 쓰기 작업은 검증한 사이트별 동작으로 제공해야 한다. 지원하지 않는 흐름은 사람에게 넘긴다.

아래 내용은 설계 초안이다. 파일 생성·수정, 설치, 실행 검증은 하지 않았다. 제공된 Aside 보고서는 설계 참고로만 사용했다.

**1. 먼저 정정하거나 확인할 전제**

| 항목 | 확인 결과와 계획 반영 |
|---|---|
| agbrowse 버전 | 조회된 공개 main의 `package.json`은 **0.2.1**이다. 의뢰의 0.1.18과 다르므로, vendor 미러·태그·공개 main의 SHA를 비교한 뒤 포크 기준을 고정해야 한다. |
| upstream 중단 여부 | 이번 확인으로 중단을 확정할 수 없다. “upstream 정지”를 전제로 설계하지 않는다. 최근 커밋·릴리스·유지보수 상태는 확인 필요다. |
| 기존 MCP 기능 | 현재 README에는 `browser_snapshot`, `browser_click_ref` 등을 포함한 제한된 MCP 표면이 기술돼 있다. 기존 구현을 조사한 뒤 재사용 범위를 정한다. |
| 제외할 upstream 기능 | README에는 TLS 지문 모방과 별도 렌더링 경로도 기술돼 있다. 이번 게이트웨이에서는 탐지 회피와 관련된 모듈·자동 fallback을 노출하거나 호출하지 않는다. |
| 라이선스 | 공개 main의 LICENSE는 MIT다. 다만 README에는 LICENSE 부재라는 상충 설명이 남아 있다. 선택한 **동일 SHA의 실제 파일**을 기준으로 다시 확인한다. |
| 로컬 미러 | 작업 폴더 밖의 `bpdus-kit/vendor/agbrowse`는 읽지 않았다. 실제 버전·패치·라이선스 상태는 확인 필요다. |

버전 근거는 [package.json](https://raw.githubusercontent.com/lidge-jun/agbrowse/main/package.json), 기능과 문서 불일치 근거는 [README](https://github.com/lidge-jun/agbrowse#readme), 라이선스 근거는 [LICENSE](https://github.com/lidge-jun/agbrowse/blob/main/LICENSE)다. 조회한 main은 변경될 수 있으므로 구현 명세에는 커밋 SHA를 기록해야 한다.

**2. 전체 구성과 신뢰 경계**

```mermaid
flowchart TB
    U["정재"]

    subgraph CLIENT["클라이언트 영역"]
        CLI["iMac / MacBook CLI"]
        BR["로컬 MCP 브리지<br/>기기 키 보관·자동 갱신"]
        BOT["grokbot-box<br/>모델 도구 호출 루프"]
        CHAT["채팅 수신 어댑터<br/>발신자·대화·원본 이벤트 검증"]
        CLI --> BR
    end

    MODEL["클라우드 모델 API"]
    BOT <--> MODEL
    U --> CHAT
    CHAT --> BOT

    subgraph IMAC["iMac · jjbyuns-imac · 100.79.8.49"]
        TS["Tailscale Serve<br/>tailnet 전용 HTTPS"]
        GW["게이트웨이<br/>MCP · 인증 · 권한 · 세션 큐"]
        AP["승인 서비스<br/>승인 의도 저장·토큰 서명"]
        DB["상태 저장소<br/>기기 등록·승인 소비·감사 기록"]
        WORK["agbrowse 워커<br/>사이트별 동작·ref 검증"]
        CHROME["에이전트 전용 Chrome<br/>분리된 로그인 프로필"]

        TS --> GW
        GW <--> AP
        GW <--> DB
        AP <--> DB
        GW --> WORK
        WORK -->|"로컬 CDP만 사용"| CHROME
    end

    BR -->|"tailnet HTTPS / MCP"| TS
    BOT -->|"tailnet HTTPS / MCP"| TS
    CHAT -->|"검증한 사용자 승인 이벤트"| TS
    U -->|"최초 페어링·로그인·긴급 중지"| AP
    CHROME --> SITE["허용된 사이트<br/>페이지 내용은 비신뢰 데이터"]
```

핵심 구성은 다음과 같다.

| 구성 요소 | 책임 |
|---|---|
| MCP 브리지 | CLI에는 stdio MCP를 제공하고, 게이트웨이에는 HTTPS로 연결한다. 키와 접속 토큰을 모델 문맥에서 분리한다. |
| 게이트웨이 | 인증, 기기 폐기 검사, 도메인·도구 권한, 세션 소유권, 요청 제한을 처리한다. |
| 승인 서비스 | 실행할 내용을 확정하고, 검증된 사용자 승인 이벤트에만 일회성 승인 토큰을 발급한다. 모델이 호출하는 승인 발급 도구는 두지 않는다. |
| agbrowse 워커 | Chrome 관찰과 허용된 동작을 수행한다. 승인 검사는 최종 실행 직전에도 적용한다. |
| 상태 저장소 | 기기 공개키, 정책, 세션, 승인 상태, 일회성 토큰 소비 기록을 보존한다. 단일 iMac에서는 SQLite부터 시작할 수 있다. |
| Chrome | 별도 프로필에서 정재가 직접 로그인한다. 기존 일상 프로필의 쿠키를 복사하지 않는다. |

데이터 흐름은 `인증 → 권한 검사 → 세션 큐 → 관찰 또는 동작 준비 → 필요 시 승인 → 실행 직전 재검증 → 실행 → 결과 확인·감사 기록` 순서다.

신뢰 경계는 다음처럼 잡는다.

- **tailnet은 접속 경계다.** 같은 tailnet에 있다는 이유만으로 브라우저 권한을 부여하지 않는다. 기기별 앱 인증을 추가한다.
- **모델 출력과 웹페이지는 비신뢰 입력이다.** 도구 인자, 페이지 텍스트, 접근성 라벨이 정책이나 승인 증거가 될 수 없다.
- **채팅 수신 어댑터는 사용자 신원에 대한 신뢰 구성 요소다.** 모델 실행 프로세스와 자격증명·관리 인터페이스를 분리한다.
- **iMac의 OS 관리자와 게이트웨이 실행 계정은 신뢰 기반에 포함된다.** 이 계정이 탈취되면 루프백 CDP와 브라우저 세션도 위험하다.

특히 iMac에서 실행하는 CLI 에이전트가 게이트웨이와 같은 계정의 파일·프로세스에 자유롭게 접근할 수 있으면, 게이트웨이를 우회할 수 있다. **코드 강제 승인의 범위에 로컬 CLI까지 포함하려면 별도 macOS 실행 계정과 프로세스 접근 제한이 필요하다.** 루프백 바인딩만으로는 로컬 프로세스를 격리하지 못한다.

Chrome의 디버깅 연결은 별도 사용자 데이터 디렉터리를 전제로 설계한다. Chrome 136부터 기본 데이터 디렉터리에 대한 원격 디버깅 스위치 동작도 제한됐다. [Chrome 공식 설명](https://developer.chrome.com/blog/remote-debugging-port)

**3. 연결 경로와 Tailscale 구성**

| 경로 | 판단 | 조건 |
|---|---|---|
| iMac/MacBook CLI → 로컬 MCP 브리지 → iMac | 기본 경로 | 브리지가 기기 인증·갱신을 담당한다. iMac 내부에서도 동일한 정책을 적용한다. |
| grokbot-box → iMac MCP | **Grok Bot 권장 경로** | 박스의 도구 호출 루프가 MCP 클라이언트를 실행한다. Node22·agbrowse 설치 없이 기존 런타임이나 경량 브리지로 구현한다. |
| xAI 원격 MCP 커넥터 → iMac HTTPS URL | 조건부 검토 | 실제 접속 주체가 tailnet에 접근할 수 있어야 한다. HTTPS URL만 등록해서 해결되지 않는다. |

xAI 공식 문서의 원격 MCP는 xAI 측이 서버 연결을 관리하는 방식이다. 따라서 박스가 tailnet에 있다는 사실만으로 xAI 서버가 iMac에 접근할 수는 없다. 사설망 접속 기능이 확인되지 않는 한 이 경로는 사용하지 않고, 박스가 도구 호출을 수행한다. 공개 터널로 바꾸지 않는다. 또한 현재 문서상 `require_approval`은 지원되지 않으므로 승인 강제는 자체 게이트웨이에서 구현해야 한다. [xAI Remote MCP 문서](https://docs.x.ai/developers/tools/remote-mcp), [접속 주체 설명](https://docs.x.ai/cookbook/examples/database-over-mcp)

Tailscale 구성안은 다음과 같다.

- 외부 주소는 `https://jjbyuns-imac.<tailnet-domain>.ts.net/...` 형태로 한다. 실제 도메인은 확인 필요다.
- 기존 herdr Serve 설정을 조사한 뒤 별도 HTTPS 포트 또는 충돌 없는 경로를 배정한다. 기존 설정을 초기화하지 않는다.
- 게이트웨이 백엔드는 루프백에만 바인딩한다.
- CDP는 Serve 대상에 넣지 않는다. 가능하면 파이프 연결을 검토하고, 불가능하면 루프백 포트를 사용한다.
- Tailscale grants/ACL로 박스와 승인된 기기만 게이트웨이에 접근하게 한다.
- Host·Origin을 검증하고, 임의 CORS를 허용하지 않는다. Serve의 사용자 헤더만으로 앱 인증을 대체하지 않는다.
- Funnel은 사용하지 않는다. 시작 점검에서 공개 노출이나 예상 밖 바인딩이 발견되면 브라우저 작업을 중단한다.

Serve는 tailnet 내부 서비스 공유를 지원하며 접근 제어 규칙이 적용된다. 정확한 라우팅 방식은 설치된 Tailscale 버전과 현재 herdr 구성에서 검증한다. [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [Serve 예시](https://tailscale.com/docs/reference/examples/serve)

**4. 최초 페어링과 토큰 자동 갱신**

권장 인증 프로필은 두 가지다.

| 프로필 | 대상과 동작 |
|---|---|
| `paired-device-v1` | 자체 브리지와 Grok Bot용. 등록된 기기의 서명 challenge로 5분 접속 토큰을 발급한다. 매일 입력하는 토큰이나 장기 bearer refresh token은 필요 없다. |
| OAuth 호환 프로필 | 일반 원격 MCP 클라이언트용. OAuth discovery, Authorization Code + PKCE, refresh token 회전·재사용 탐지를 구현한다. 클라이언트별 호환성 검증 후 개방한다. |

자체 challenge 방식은 **프로젝트 확장**이다. 이를 구현했다고 일반 MCP 클라이언트의 OAuth 인증까지 자동 호환된다고 설명하지 않는다. MVP에서는 stdio 브리지가 그 차이를 처리한다. HTTP MCP의 표준 인증 경로에는 resource metadata, authorization server discovery, 대상 resource 검증 등을 반영한다. [MCP 인증 명세](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

키와 저장 위치는 다음처럼 분리한다.

| 항목 | 권장 방식 | 저장 위치 |
|---|---|---|
| 기기 인증 키 | 기기·클라이언트 설치별 P-256 서명 키 | Mac은 Keychain. 박스는 서비스 전용 OS 자격증명 저장소 또는 암호화 저장소 |
| 접속 토큰 발급 키 | 기기 키와 별도인 P-256 키 | iMac Keychain, 인증 서비스만 접근 |
| 승인 토큰 발급 키 | 접속 토큰 키와 별도인 P-256 키 | iMac Keychain, 승인 서비스만 접근 |
| 채팅 어댑터 인증 키 | 브라우저 호출 기기 키와 별도 | 채팅 수신 서비스만 접근 |
| 접속 토큰 | 수명 5분, 권한·대상 제한 | 브리지 메모리 |
| 승인 토큰 | 수명 2분, 한 작업에 한 번 | 승인 서비스와 실행기 사이에서 전달, 모델에 반환하지 않음 |

Keychain은 macOS의 비밀 저장 기반으로 사용한다. Secure Enclave 사용 가능 여부와 무인 서명 시 사용자 확인 요구는 iMac 모델·계정·구현에 따라 확인해야 한다. 잠금 상태에서 키 접근이 불가능하면 안전하게 중단하며, 평문 파일로 자동 전환하지 않는다. [Apple Keychain 문서](https://developer.apple.com/documentation/security/keychain-services)

최초 등록 절차:

1. 정재가 iMac의 관리 화면에서 제한 시간 동안 페어링을 연다.
2. 클라이언트가 자체 키를 생성하고 공개키·기기 이름·요청 권한을 제출한다.
3. 양쪽에 공개키 지문과 확인 코드를 표시한다. 코드는 일회성이며 시도 횟수와 유효시간을 제한한다.
4. 정재가 기기를 확인하고 프로필·도메인·권한 범위를 선택한다.
5. 게이트웨이가 `device_id`, 공개키, 등록 상태, 선택적 만료일을 저장한다.
6. 클라이언트는 게이트웨이의 HTTPS 주소와 공개 신원 정보를 저장한다.

자동 발급·갱신 절차:

1. 클라이언트가 challenge를 요청한다.
2. 서버는 32바이트 난수와 30초 만료시간을 발급한다.
3. 클라이언트는 프로토콜 구분값, 서버 식별자, 기기 ID, challenge ID, nonce, 요청 권한·resource를 함께 서명한다.
4. 서버는 등록 상태·서명·만료·권한을 검증하고 challenge를 원자적으로 소비한다.
5. 서버가 5분 접속 토큰을 발급한다.
6. 클라이언트는 약 4분에 새 challenge로 갱신한다. 여러 요청이 동시에 갱신하지 않도록 하나로 합친다.

서버는 클라이언트 서명을 검증하고, 클라이언트는 HTTPS 서버 신원과 발급 응답의 서명을 검증한다. 시간 오차 허용치는 초기안으로 30초를 둔다.

접속 토큰에는 `iss`, `aud`, `sub`, `device_id`, `scope`, `iat`, `exp`, `jti`, `device_epoch`를 넣는다. 토큰에 적힌 권한과 **현재 서버 정책의 교집합**만 허용한다. 모든 호출과 민감 동작 실행 직전에 등록 상태를 확인하므로, 폐기는 토큰 만료를 기다리지 않고 적용된다.

Bearer 토큰은 유출 시 만료 전까지 악용될 수 있다. 자체 브리지에는 후속 강화로 DPoP를 적용할 수 있지만, 일반 MCP 클라이언트의 지원을 가정하지 않는다. DPoP를 사용한다면 공개키 바인딩과 요청별 proof를 함께 검증해야 한다. [RFC 9449](https://www.rfc-editor.org/info/rfc9449/)

복구·폐기 정책:

- **기기 폐기:** 등록 비활성화 → `device_epoch` 증가 → 연결·대기 작업·미사용 승인 취소.
- **정기 키 교체:** 기존 키와 새 키의 소유 증명을 검증한다. 침해 의심 시 기존 키로 교체를 승인하지 않고 재페어링한다.
- **박스 재설치:** 새 키를 생성하고 재페어링한다. 같은 Tailscale 이름·IP를 신원 증거로 사용하지 않는다. 이전 기기는 폐기한다.
- **iMac 복구:** 암호화된 상태 백업과 키 복구를 검증한다. 백업 시점의 소비 기록만 믿지 않고 복구 epoch를 올려 기존 접속·승인 토큰을 모두 무효화한다.
- **사이트 로그인 만료:** 게이트웨이 인증 갱신과 별개다. 정재가 Chrome에서 로그인·MFA를 완료해야 한다.

**5. 통신 표준 초안**

가칭은 `Agent Browser Gateway Protocol`, 버전은 `0.1.0`으로 한다. 정식 명칭은 확인 필요다.

표준 문서 목차는 다음과 같이 구성한다.

1. 범위, 용어, 위협 모델, 지원하지 않는 기능
2. 프로토콜 버전과 capability 협상
3. MCP 매핑 및 HTTPS 전송 규칙
4. 페어링·인증 프로필·토큰 갱신·폐기
5. 사용자·기기·대화·프로필·브라우저 세션 식별
6. 관찰·조회·장바구니·민감 동작의 메시지 스키마
7. 스냅샷·diff·ref 수명과 민감정보 제거
8. 동작 의도 생성과 승인 상태 전이
9. 승인 토큰 형식·서명·소비 규칙
10. 요청 중복 방지·취소·재시작 복구
11. 오류 코드와 재시도 정책
12. 감사 이벤트·보존·호환성·검증 벡터

MCP 전송은 Streamable HTTP를 기본으로 하고, 로컬 CLI에는 stdio 브리지를 제공한다. MCP 버전과 도메인 프로토콜 버전은 별도로 관리한다. 초기 상호운용 시험 기준으로 `2025-11-25` 명세를 검토하되, 채택 버전은 실제 클라이언트 지원을 확인해 고정한다. [MCP 전송 명세](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

다음 JSON은 제안 스키마다. 서명·ID 값은 설명용이다.

페어링된 기기에 발급하는 challenge:

```json
{
  "protocol_version": "0.1.0",
  "challenge_id": "ch_01",
  "purpose": "abgp.device-auth.v1",
  "gateway_id": "gw_imac",
  "device_id": "dev_grokbot",
  "nonce": "<base64url-32-random-bytes>",
  "resource": "https://<gateway-host>/mcp",
  "requested_scopes": ["browser:read", "cart:write"],
  "expires_in": 30
}
```

클라이언트의 서명 응답:

```json
{
  "challenge_id": "ch_01",
  "device_id": "dev_grokbot",
  "proof": "<compact-JWS-over-the-complete-challenge>"
}
```

서명 알고리즘은 서버가 고정한 허용 목록으로 제한한다. 요청자가 지정한 임의 키 URL이나 `alg` 값을 신뢰하지 않는다.

MCP 관찰 요청:

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "tools/call",
  "params": {
    "name": "browser_observe",
    "arguments": {
      "protocol_version": "0.1.0",
      "session_id": "bs_01",
      "tab_id": "tab_01",
      "base_snapshot_id": null,
      "max_nodes": 120
    }
  }
}
```

스냅샷 본문:

```json
{
  "protocol_version": "0.1.0",
  "session_id": "bs_01",
  "tab_id": "tab_01",
  "document_epoch": 7,
  "snapshot_id": "snap_18",
  "kind": "full",
  "base_snapshot_id": null,
  "page": {
    "origin": "https://shop.example",
    "url": "https://shop.example/products",
    "title": "상품 목록"
  },
  "content_trust": "untrusted",
  "nodes": [
    {
      "ref": "r_18_03",
      "frame_id": "frame_main",
      "role": "link",
      "name": "상품 A",
      "allowed_actions": ["open_product"]
    }
  ],
  "redactions": ["password_fields", "account_identifiers"],
  "truncated": false
}
```

이 본문은 MCP `structuredContent`로 반환하고, 필요한 호환용 텍스트도 제공한다. 해당 형태는 MCP의 구조화된 도구 결과와 연결한다. [MCP 도구 명세](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

스냅샷 규칙은 다음과 같다.

- ref는 세션·탭·프레임·문서 epoch·스냅샷에 종속된다.
- 새 스냅샷, 탐색, 새로고침, 관련 DOM 변화 후 이전 ref는 거부한다.
- diff는 `base_snapshot_id`와 추가·수정·삭제 노드를 명시한다. 기준이 없으면 전체 스냅샷을 반환한다.
- 실행 직전에 실제 요소와 의미를 다시 확인한다. 비슷한 버튼으로 자동 대체하지 않는다.
- 비밀번호·OTP·쿠키·Authorization 헤더·저장소 원문은 결과에 포함하지 않는다.
- 로그인·결제 인증 화면에서는 스크린샷도 차단하거나 검증된 영역만 제공한다. 입력 필드 가림만으로 모든 비밀이 제거된다고 가정하지 않는다.
- `allowed_actions`는 서버 정책과 어댑터가 계산한다. 페이지가 이를 선언할 수 없다.

구매 준비 결과는 승인 대기 상태를 반환한다.

```json
{
  "protocol_version": "0.1.0",
  "operation_id": "op_72",
  "state": "awaiting_approval",
  "approval_id": "ap_72",
  "intent_digest": "sha256:<canonical-intent-hash>",
  "summary": {
    "action": "purchase",
    "merchant": "판매처 A",
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
    "delivery_label": "등록 배송지 1"
  },
  "expires_in": 300
}
```

승인 이벤트는 일반 모델 도구와 분리된 인증 경로로 수신한다.

```json
{
  "type": "approval.decision",
  "event_id": "ae_88",
  "approval_id": "ap_72",
  "decision": "approve",
  "intent_digest": "sha256:<canonical-intent-hash>",
  "actor": {
    "platform": "<configured-platform>",
    "user_id": "<registered-user-id>",
    "conversation_id": "<bound-conversation-id>",
    "message_id": "<verified-original-message-id>"
  },
  "adapter_proof": "<signed-event-envelope>"
}
```

핵심 오류 코드는 다음과 같이 분리한다.

| 코드 | 처리 |
|---|---|
| `AUTH_EXPIRED` | 브리지가 갱신한 뒤 재요청한다. 쓰기 요청은 동일 중복 방지 키를 유지한다. |
| `DEVICE_REVOKED` | 자동 복구하지 않고 연결을 닫는다. |
| `DOMAIN_DENIED` / `ACTION_DENIED` | 정책 위반으로 중단한다. |
| `STALE_REF` / `STATE_CHANGED` | 다시 관찰한다. 승인 내용이 달라졌으면 재승인한다. |
| `APPROVAL_REQUIRED` | 승인 대기 상태와 ID를 반환한다. |
| `APPROVAL_EXPIRED` / `APPROVAL_CONSUMED` | 해당 승인으로 실행하지 않는다. |
| `HUMAN_REQUIRED` | 로그인·MFA·캡차 등 사람의 조작을 기다린다. |
| `SITE_UNSUPPORTED` | 검증하지 않은 흐름이므로 중단한다. |
| `OUTCOME_UNKNOWN` | 재실행을 금지하고 주문·전송 결과를 조회한다. |
| `VERSION_UNSUPPORTED` | 호환 버전 정보를 반환한다. |

인증 실패는 HTTP 401, 권한 부족은 적절한 HTTP 권한 오류로 처리한다. 도구 수행 실패는 MCP `isError`와 구조화된 오류 본문으로 표현한다. JSON-RPC 문법 오류와 구매 결과 불명 상태를 같은 오류로 취급하지 않는다.

**6. agbrowse 포크에서 변경할 부분**

브라우저 엔진은 기존 Chrome을 사용하고, agbrowse의 관찰·ref·CDP 처리 코드를 기반으로 한다. **상주 게이트웨이를 추가하되 CLI를 얇은 클라이언트로 정리하는 방향**을 권장한다.

| 변경 영역 | PR에 포함할 내용 |
|---|---|
| 실행 코어 | CLI 입출력과 브라우저 동작 코어를 분리한다. 원격 요청을 셸 명령 문자열로 조립하지 않는다. |
| 상주 서비스 | macOS LaunchAgent, 상태 저장, 정상 종료, 크래시 복구, 세션 큐를 추가한다. 재부팅 후 GUI 로그인·Keychain 접근 조건은 검증한다. |
| MCP 표면 | 관찰, 허용된 조회, 작업 상태, 취소, 장바구니, 승인된 실행 도구를 명시적으로 등록한다. |
| 세션 관리 | 호출자·대화·프로필·탭을 연결한다. 전역 활성 탭 선택에 의존하지 않는다. |
| 스냅샷 | 구조화된 노드, ref 수명, diff 기준, 민감정보 제거, 크기 제한을 표준화한다. |
| 정책 집행 | 모든 실행 진입점이 같은 권한 검사와 승인 검사 경로를 통과하게 한다. |
| 사이트 어댑터 | 조회·장바구니·주문 준비·최종 실행·결과 확인을 분리한다. |
| 감사·복구 | 승인 소비 기록, 요청 중복 방지, 결과 불명 상태와 복구 조회를 구현한다. |

원격 표면에서 제외할 기능:

- 임의 JavaScript 실행, raw CDP, 임의 네트워크 요청.
- 좌표 클릭과 제한 없는 키 입력·폼 제출.
- 쿠키·localStorage·인증 헤더 추출.
- 임의 로컬 파일 업로드·다운로드 경로 지정.
- 브라우저 설정·확장·비밀번호 관리자 접근.
- 탐지 회피, TLS 지문 모방, 캡차 해결, 차단 후 자동 우회 경로.
- 기존 `web-ai send`처럼 전송을 수행하는 기능의 무승인 호출.

관리자가 로컬 진단 기능을 유지하더라도, 게이트웨이용 프로필에서는 에이전트가 그 경로를 호출할 수 없어야 한다. 게이트웨이 앞에 검사만 추가하고 뒤에 무제한 실행 API를 남기면 승인 강제를 충족하지 못한다.

라이선스 확인 항목:

1. 기준 SHA의 LICENSE·저작권 표시·파일별 예외를 확인한다.
2. 0.1.18 미러와 선택한 upstream 사이의 라이선스 변경을 비교한다.
3. 직접·간접 의존성 및 포함 자산의 고지 의무를 정리한다.
4. 배포물에 필요한 MIT 고지를 보존한다.
5. 기존 Chrome을 사용한다. 브라우저 바이너리 재배포 여부는 별도 판단한다.
6. Aside 코드·번들·문구·자산을 복사하지 않고 설계 참고 경위를 기록한다.

MIT 파일은 수정·배포를 허용하면서 고지 보존을 요구한다. 최종 판단은 선택한 배포물 전체를 기준으로 한다. [agbrowse LICENSE](https://github.com/lidge-jun/agbrowse/blob/main/LICENSE)

**7. 구두 허가에서 일회성 실행까지**

“정재가 허락했다”는 모델의 해석은 승인 증거로 받지 않는다. **등록된 사용자에게서 온 원본 채팅 이벤트와, 그 사용자가 확인한 작업 의도를 연결해야 한다.**

```mermaid
sequenceDiagram
    participant Agent as Grok Bot
    participant Gateway as 게이트웨이
    participant Browser as Chrome
    participant Approval as 승인 서비스
    participant Chat as 채팅 어댑터
    participant User as 정재

    Agent->>Gateway: purchase_prepare
    Gateway->>Browser: 주문 내용·총액·대상 확인
    Gateway->>Approval: 확정 의도와 digest 저장
    Approval->>Chat: 승인 요약·요청 ID
    Chat->>User: 상품·금액·배송지·일회성 승인 요청
    User->>Chat: 해당 요청에 명시적으로 승인
    Chat->>Approval: 검증한 원본 이벤트와 사용자 신원
    Approval->>Gateway: 서명된 일회성 승인 토큰
    Gateway->>Browser: 실행 직전 상태 재확인
    Gateway->>Gateway: 토큰 검증·원자적 소비
    Gateway->>Browser: 해당 동작 한 번 실행
    Gateway->>Browser: 주문 결과 확인
    Gateway-->>Agent: 성공·실패·결과 불명
    Approval-->>Chat: 사용자에게 결과 전달
```

승인 대상은 서버가 작성한 불변 `intent`다. 다음 정보를 묶는다.

- 실제 호출자, 기기, 대화, 브라우저 세션, 프로필, 사이트 계정.
- 작업 종류, 사이트 origin, 판매자 또는 수신자.
- 상품·옵션·수량 또는 전송·게시할 본문과 첨부파일의 digest.
- 통화, 배송비·세금 등을 포함한 최종 결제액.
- 배송지·결제수단의 내부 식별자와 가려진 표시.
- 정기결제 여부, 동의 항목, 사이트 어댑터·정책 버전.
- 유효시간, 고유 작업 ID, 상태 revision.

금액은 최소 화폐 단위의 정수로 표현한다. JSON 정규화 후 SHA-256 digest를 만들고, 직렬화 차이 때문에 승인 대상이 달라지지 않도록 규칙과 검증 벡터를 둔다. [RFC 8785](https://www.rfc-editor.org/info/rfc8785/)

승인 토큰의 설명용 payload:

```json
{
  "iss": "gw_imac.approval",
  "aud": "gw_imac.executor",
  "sub": "owner_jj",
  "jti": "grant_72",
  "operation_id": "op_72",
  "approval_id": "ap_72",
  "device_id": "dev_grokbot",
  "session_id": "bs_01",
  "profile_id": "profile_agent",
  "conversation_id": "conv_12",
  "action": "purchase",
  "origin": "https://shop.example",
  "intent_digest": "sha256:<canonical-intent-hash>",
  "total": {
    "currency": "KRW",
    "minor_units": 32900
  },
  "policy_version": "policy_4",
  "recovery_epoch": 3,
  "iat": 1791705600,
  "exp": 1791705720
}
```

실제 토큰은 승인 전용 키로 서명한다. 실행기는 서명만 검사하지 않고 서버에 저장된 의도·현재 정책·미소비 상태까지 대조한다.

채팅 승인 규칙은 다음과 같다.

- 등록된 사용자 ID와 허용된 대화만 인정한다. 표시 이름은 신원으로 사용하지 않는다.
- 원본 이벤트를 플랫폼 인증 방식으로 확인한다. 해당 플랫폼에 서명된 이벤트가 없다면 인증된 수신 연결이나 서버 API 조회로 검증해야 한다. 실제 방식은 확인 필요다.
- 기본 입력은 해당 승인 메시지에 대한 명시적 답장 또는 확인 버튼으로 한다.
- “그거 해”, “응”처럼 여러 요청에 대응할 수 있는 표현은 승인으로 처리하지 않는다.
- 자연어를 허용하더라도 요청 ID·작업·금액을 확정할 수 있는 제한된 규칙을 사용한다. LLM 단독 판정으로 서명하지 않는다.
- 음성 입력은 전사문만으로 승인하지 않는다. 결제 대상·금액·요청 ID를 다시 표시하고 확인받는다.
- 전달·인용·봇 메시지, 편집·재전송 이벤트, 이미 처리한 이벤트 ID는 승인 근거에서 제외한다.

초기 정책은 **정확한 총액과 내용에 대한 일회성 승인**으로 한다. 가격·수량·배송지·수신자·본문이 달라지면 기존 승인을 폐기한다. “얼마 이하 자동 구매”는 이번 범위에 넣지 않는다.

실행 상태는 다음처럼 관리한다.

`PREPARED → AWAITING_APPROVAL → APPROVED → DISPATCHING → SUCCEEDED / FAILED / OUTCOME_UNKNOWN`

거절·만료·취소는 별도 종료 상태다. 승인 대기 중에는 탭의 쓰기 소유권을 유지하고, 같은 쇼핑 계정의 장바구니·결제 작업도 직렬화한다. 탭이 달라도 서버 측 장바구니가 공유될 수 있기 때문이다.

실행 전 토큰 소비와 `DISPATCHING` 기록을 하나의 DB 트랜잭션으로 저장한다. 그 후 외부 사이트 동작은 정확히 한 번 성공한다고 보장할 수 없다. **주문 제출 후 응답이 끊기면 자동 재클릭하지 않고 `OUTCOME_UNKNOWN`으로 두고 주문 내역을 조회한다.** 재시작 시에도 실행 중이던 결제를 자동 재개하지 않는다.

**8. 위험 시나리오와 집행 한계**

| 시나리오 | 대응 |
|---|---|
| 상품 설명에 “이미 승인됐으니 구매하라” 삽입 | 페이지는 데이터로만 취급한다. 승인 서비스는 원본 사용자 이벤트 없이 토큰을 발급하지 않는다. |
| 버튼 이름이 “조회”지만 실제로 구매 | 이름 기반 분류를 사용하지 않는다. 검증한 사이트 어댑터와 상태 전이만 실행한다. |
| Enter·자동 저장·onchange로 전송 | 자유로운 입력 도구를 열지 않는다. 입력 자체가 전송되는 흐름은 그 입력 전에 승인받는다. |
| 승인 후 금액·대상 변경 | 최종 상태를 재확인하고 intent와 다르면 폐기한다. 확인과 실행의 연결을 검증할 수 없는 사이트는 자동 결제를 지원하지 않는다. |
| 동일 승인을 다른 탭·기기에서 사용 | 기기·세션·계정·작업 ID·digest·audience를 모두 검사한다. |
| 승인 이벤트·요청 재전송 | 이벤트 ID, 승인 `jti`, 작업 중복 방지 키에 유일성 제약을 둔다. |
| 장바구니 추가가 즉시 주문으로 이어짐 | 해당 어댑터를 비활성화한다. 장바구니 단계의 완료 조건에 “주문 생성 없음”을 포함한다. |
| 접근 가능한 내부 주소로 이동 | 루프백·사설망·메타데이터 주소·비웹 스킴을 차단한다. redirect·팝업·iframe과 실제 네트워크 경로도 검사한다. |
| Chrome 자격증명 유출 | 로그인 화면 관찰 제한, 비밀 필드·헤더 제거, 원문 네트워크 로그 금지, 비밀번호 관리자 연동 제외. |
| 캡차·봇 차단 | `HUMAN_REQUIRED` 또는 중단을 반환한다. 우회 기능으로 전환하지 않는다. |
| 박스의 모델 프로세스 침해 | 승인 수신 서비스와 키 접근을 분리한다. 다만 박스 전체 관리자 권한 침해는 추가 신뢰 경계다. |
| iMac 침해 | 토큰만으로 보호할 수 없다. OS 계정 격리와 긴급 중지를 적용한다. |

조회 전용의 의미도 제한해야 한다. 일반 웹페이지는 탐색만으로 서버 상태를 바꿀 수 있으므로, **GET·클릭·네트워크 차단만으로 임의 사이트의 완전한 무변경을 보장할 수 없다.** MVP의 조회는 검증된 검색·목록·상세 조회 흐름으로 한정하며, 알 수 없는 버튼은 누르지 않는다.

도메인 허용 목록은 탐색 대상과 부속 리소스용 목록을 구분한다. 결제사·로그인 제공자 추가는 명시적인 정책 변경으로 처리한다. 속도 제한은 사이트 부담을 줄이기 위한 기능이며 탐지 회피 기능으로 구현하지 않는다.

**9. 운영·감사·비밀 관리**

감사 이벤트에는 누가, 어떤 기기·대화·세션에서, 어떤 사이트의 어떤 동작을 요청했는지와 정책 판단·승인 ID·결과를 남긴다.

비밀 원문은 남기지 않는다.

- Authorization·Cookie·서명 proof·승인 토큰은 로그에서 제거한다.
- URL 쿼리·요청 본문·오류 객체도 허용 필드만 기록한다.
- 비밀을 argv에 전달하지 않는다. OS 저장소나 제한된 IPC로 전달한다.
- 스크린샷·주문 의도 원문은 일반 감사 로그와 분리하고 접근과 보존기간을 제한한다.
- 승인 기록의 hash만으로 충분하지 않은 경우, 원문은 암호화된 제한 저장소에 보관한다.
- 로그 저장 실패나 DB 쓰기 실패 시 구매·전송·게시를 실행하지 않는다.

초기 보존 제안은 감사 메타데이터 90일, 승인 상세 30일, 스크린샷 기본 미보존이다. 실제 기간은 정재가 결정한다.

iMac에는 “모든 원격 작업 중지”와 “쓰기 기능만 중지” 기능을 둔다. 네트워크 단절·절전·Keychain 잠금 후에는 연결과 상태를 다시 검증한다. 재접속했다고 대기 결제를 자동 실행하지 않는다.

**10. 단계별 마일스톤·PR·검증·되돌리기**

계획과 리뷰는 Codex, 구현은 Grok Build CLI가 맡는다. 실제 PR 대상 저장소는 아래 결정 항목을 확정한 뒤 정한다.

| 단계 | PR 범위 | 통과 기준과 테스트 | 되돌리기 |
|---|---|---|---|
| 준비 | **PR 0:** 기준 SHA·라이선스·기능 목록·위협 모델·프로토콜 초안 | 0.1.18 미러와 upstream 비교, iMac/Serve/런타임 조사, 제외 모듈과 승인 우회 경로 식별 | 문서 PR 철회. 운영 변경 없음 |
| 조회 MVP | **PR 1:** 실행 코어 분리·전용 프로필·로컬 워커 | 다른 프로필 연결 거부, 전역 탭 의존 제거, CDP 외부 접근 실패, 종료·재시작 시험 | 워커 중지. 기존 일상 Chrome에 영향 없음 |
| 조회 MVP | **PR 2:** 기기 페어링·자동 갱신·폐기·Serve 연결 | challenge 재사용·다른 서버용 서명·만료·폐기 거부, 다회 자동 갱신, herdr 회귀 확인 | 신규 Serve 항목만 제거, 기기 등록 폐기 |
| 조회 MVP | **PR 3:** MCP 브리지·스냅샷·사이트 1개 조회 어댑터 | iMac CLI와 박스 호출, stale ref·다른 세션 접근 거부, 비밀 제거, 조회 흐름에 주문·전송 없음 | 조회 capability 비활성화 |
| 장바구니 | **PR 4:** 상품·옵션·수량 지정과 장바구니 확인 | 주문 생성 없는 추가·수정 시험, 계정 단위 직렬화, 중복 요청·가격 변경·DOM 변경 시험 | `cart:write` 회수. 이미 담긴 상품은 별도 확인 후 처리 |
| 승인 기반 실행 | **PR 5:** 승인 서비스·채팅 연계·일회성 토큰 | 위조 사용자·대화 혼동·인용·중복 이벤트·금액 변경·만료·동시 소비 거부 | 승인 발급과 commit 비활성화, 미사용 승인 전부 폐기 |
| 승인 결제 | **PR 6:** 사이트 1개 주문 준비·최종 실행·결과 조회 | 테스트 상점에서 결제 흐름, 제출 직후 크래시·응답 유실·중복 호출 시험, 별도 승인한 소액 실거래 검증 | 결제 capability 중지. 이미 성립한 주문은 코드 rollback으로 취소되지 않음 |
| 확장 | **PR 7:** OAuth 일반 클라이언트·추가 사이트·전송/게시 어댑터 | 클라이언트 인증 호환성, 수신자·본문·첨부파일 바인딩, 사이트별 독립 회귀 시험 | 클라이언트·사이트·행동 단위로 비활성화 |

조회 MVP 완료 조건은 **정재가 전용 Chrome에서 로그인한 뒤, iMac CLI와 grokbot-box가 토큰 수동 입력 없이 허용된 목록·상세를 조회하는 것**이다. MacBook도 같은 브리지로 후속 검증한다.

테스트는 세 층으로 나눈다.

1. **오프라인 계약 테스트:** 서명, 스키마, 상태 전이, ref, 폐기, 중복 방지, 로그 제거.
2. **통제된 테스트 사이트:** 악성 페이지 문구, DOM 변경, 자동 제출, redirect, 크래시와 응답 유실.
3. **iMac 실제 환경:** 로그인 지속성, Keychain, tailnet 연결, 실제 사이트의 지원 가능한 흐름.

실제 사이트가 자동화를 차단하거나 주문 조건을 안정적으로 확인할 수 없으면 해당 단계는 사람의 조작으로 종료한다. 성공률을 위해 우회 기능을 추가하지 않는다.

릴리스는 커밋 SHA와 DB 스키마 버전을 고정한다. 되돌릴 때는 미사용 승인을 무효화하고, 구버전이 새 정책을 이해하지 못하면 실행을 거부하게 한다. 소비 기록을 과거 백업으로 되돌려 승인 토큰을 재사용 가능하게 만들어서는 안 된다.

**11. 정재가 결정하거나 제공할 항목**

| 항목 | 권장안 또는 필요한 정보 |
|---|---|
| 포크 이름·위치 | 확인 필요. GitHub 소유자·저장소명·iMac 작업 경로 |
| “원본 저장소에 PR”의 의미 | 개인 포크가 구현의 기준인지, `lidge-jun/agbrowse` upstream에 직접 기여할 것인지 확인 필요. 개인 설정·비밀은 PR에서 제외 |
| 포크 기준 | 0.1.18 vendor SHA와 공개 main을 비교한 뒤 검증 가능한 SHA 선택 |
| Grok Bot 구조 | 채팅 플랫폼, 실행 런타임, MCP 호출 위치, 원본 사용자 이벤트를 검증할 API 확인 필요 |
| 기본 연결 방식 | 박스가 직접 MCP 호출하는 경로 권장 |
| iMac 환경 | CPU·macOS·Chrome·Tailscale 버전, herdr Serve 설정, 재부팅 후 로그인 운영 방식 확인 필요 |
| 로컬 계정 격리 | 게이트웨이·Chrome을 CLI 에이전트와 분리된 계정으로 운영하는 안 권장 |
| 최초 대상 사이트 | 네이버 또는 쿠팡 중 1개와 구체적인 조회·장바구니·구매 흐름 선정 |
| 승인 입력 | 해당 요청에 대한 명시적 답장 또는 버튼 권장. 음성 단독 승인은 제외 |
| 구매 조건 | 정확한 총액·대상에 대한 1회 승인 권장. 구독·정기결제·주문 취소는 별도 지원 여부 결정 |
| 데이터 보존 | 감사 90일·상세 승인 30일·스크린샷 기본 미보존 제안 |
| 복구 수단 | 박스 재설치 시 iMac에서 재페어링, iMac 암호화 백업과 긴급 중지 담당자 지정 |

가장 먼저 확정할 항목은 **포크와 PR 대상, Grok Bot의 실제 채팅·실행 구조, iMac 계정 격리 방식, 최초 지원 사이트**다. 이 네 가지가 정해지면 조회 MVP의 구현 명세와 승인 경계까지 구체화할 수 있다.