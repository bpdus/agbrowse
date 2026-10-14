# mybrowse 계획 독립 검토

**결론: REVISE.** 계획은 핵심 설계 방향은 맞습니다. 다만 다섯 가지 계약이 비어 있고, 모든 작업이 Xcode가 필요한 1단계 뒤에 한 줄로 묶여 있어 지금 바로 구현할 수 없습니다.

확인한 파일: stage 폴더 바로 아래에 있는 `mybrowse-plan.json`, `mybrowse-plan-2026-10-13.md`, `types.ts`, `pi-addon-extensions.ts`, `constants.js`. 파일은 수정하지 않았고, 빌드·로그인·네트워크 확인도 하지 않았습니다.

## 핵심 항목 5개

### 1. 자체 Chromium의 Native Messaging 경로와 브리지 식별이 Chrome·Edge 전제에 묶여 있음
- **문제:** 어댑터는 Chrome·Edge만 지원합니다. 등록 파일 경로는 `<브라우저 프로필 디렉터리>/NativeMessagingHosts`로 정해집니다. 브리지 소켓은 `/tmp/codex-browser-use/codex-control-chrome-mcp*` 하나를 모든 브라우저가 공유합니다.
  - 공식 Codex 확장은 Chrome과 MyBrowse에서 같은 확장 ID와 같은 호스트 이름(`com.openai.codexextension`)을 씁니다. 그래서 두 브라우저가 동시에 실행되면 MCP가 어느 브라우저의 소켓에 붙었는지 구분할 수 없습니다.
  - 계획은 이 문제를 "실제 빌드에서 확인"으로만 미뤘습니다.
  - 계획은 제품 데이터를 `~/Library/Application Support/MyBrowse/`에 둡니다. 브랜드를 바꾼 Chromium의 기본 user-data-dir과 이 경로가 겹칠 수 있습니다. 그러면 프로필, 작업 DB, NativeMessagingHosts가 한 루트에 섞입니다.
- **근거:** `constants.js` 6–8행(소켓), 17행(`SUPPORTED_BROWSERS`), 24–55행(프로필·manifest 경로), 60–70행(브라우저별 설정 파일 이름). 계획 MD 144–151행, 275행.
- **스펙 수정:**
  - `SUPPORTED_BROWSERS`에 `mybrowse`를 추가합니다. 프로필·manifest 경로는 고정 Chromium 커밋에서 도출한 값으로 정합니다.
  - 브라우저 데이터(user-data-dir)와 데몬 데이터(DB·산출물)를 서로 다른 디렉터리로 분리합니다.
  - MyBrowse용 Native Messaging 호스트 실행 파일은 앱 번들 안의 별도 래퍼로 둡니다. 소켓은 사용자 전용 디렉터리(0700)에 `mybrowse-<프로필 ID>`처럼 브라우저를 구분하는 이름으로 만듭니다.
  - 브리지가 연결되면 실제 부모 프로세스의 번들 ID와 프로필 ID를 확인합니다. Chrome에서 온 연결은 거부합니다.
  - 기존 Chrome 등록 파일을 "자동 재등록(self-heal)"하는 기능은 MyBrowse 모드에서 끕니다.
- **확인 방법:**
  - 등록 파일 경로가 기본 user-data-dir 기준인지, `--user-data-dir` 옵션 값 기준인지 고정 커밋의 `chrome_paths` 코드에서 확인합니다.
  - Chrome과 MyBrowse를 동시에 띄운 상태에서 MCP 탭 목록에 MyBrowse 탭만 나오는지 봅니다.
  - Chrome manifest의 해시가 변하지 않았는지 확인합니다.

### 2. WebUI 보안 경계와 React 이식 범위가 정해지지 않음
- **문제:**
  - `chrome://mybrowse`에서 React를 쓸 수 있는지가 불확실합니다. WebUI의 CSP와 Trusted Types 아래에서 pi-gui의 markdown·도구 출력 렌더링이 동작하는지 검증한 근거가 없습니다.
  - 모델 출력과 웹페이지 제목은 프롬프트 인젝션 내용을 담을 수 있는데, 이것이 특권 WebUI 안에서 렌더링됩니다.
  - 좌측 목록이 탭 안의 WebUI인지, 브라우저 Views에 붙는 WebUI인지 정하지 않았습니다.
  - Mojo에서 데몬으로 가는 IPC를 누가 소유하는지도 정하지 않았습니다. WebUI 렌더러는 소켓을 직접 열 수 없습니다.
  - pi-gui의 `SessionDriver`는 Pi 전용 기능(fork, 트리 탐색, compact, 확장 플래그, 여러 `HostUiRequest`)을 요구합니다. CLI 어댑터는 이것을 구현할 수 없습니다.
- **근거:** `types.ts` 99–108행(Electron contextBridge 전제), 283–351행(HostUiRequest), 388–418행(SessionDriver). 계획 MD 63–67행. JSON `tasks[1].test_decision=omit`(보안 회귀 검사를 5번 작업으로 미룸).
- **스펙 수정:**
  - `MyBrowseBridge`를 처음부터 최소 인터페이스로 정의합니다: create, send, steer, queue, stop, resume, subscribe, capabilities, tabs.
  - pi-gui 코드는 이 인터페이스에 맞는 화면만 이식합니다. fork, tree, compact, extension 관련 UI는 뺍니다.
  - 브라우저 프로세스가 데몬 Unix 소켓을 단독으로 소유합니다. 연결할 때 peer UID를 확인하고 실행 시점에 받은 토큰을 검사합니다.
  - 모델·웹 유래 콘텐츠는 엄격한 sanitize를 거칩니다. 또는 `chrome-untrusted://` 프레임에서 렌더링합니다.
  - Mojo 인터페이스는 `chrome://mybrowse` origin의 WebUI에만 바인딩합니다.
  - 브리지 경계 검사는 2번 작업의 통과 조건으로 앞당깁니다.
- **확인 방법:**
  - React 번들을 엄격한 CSP와 Trusted Types 정책을 건 일반 HTML에서 먼저 띄워 위반 0건을 확인합니다. 그다음 WebUI에서 다시 확인합니다.
  - 외부 페이지, `chrome-untrusted`, 다른 대화에서 Mojo나 소켓을 호출하면 거부되는지 확인합니다.

### 3. CLI 루프의 인증·설정 공유 방식이 서로 모순됨
- **문제:**
  - 계획은 "공식 로그인 저장소 사용"과 "앱 전용 설정으로 전역 설정을 덮어쓰지 않음"을 동시에 요구합니다.
  - 앱 전용 홈 디렉터리를 쓰면 로그인이 공유되지 않습니다. 기본 홈 디렉터리를 쓰면 MCP 설정을 넣을 때 전역 설정을 수정할 위험이 있습니다.
  - API 키 환경변수가 있으면 구독 대신 API 키 경로로 실행될 수 있습니다. 실제 우선순위는 확인이 필요하며, 지금 단정하지 않습니다.
  - pi-gui의 제공자·OAuth·MCP 코드는 Pi 런타임(`mcp.json`, `createMcpExtension`)에 묶여 있습니다. 그래서 차용할 수 있는 것은 화면 껍데기뿐입니다.
- **근거:** `pi-addon-extensions.ts` 18–38행. 계획 MD 57–58행, 71행, 83행, 87–89행.
- **스펙 수정:**
  - 실행기별로 다음 네 가지를 표로 고정합니다.
    - 인증 저장소: 기본 위치를 그대로 사용합니다.
    - MCP 주입: 실행 단위 옵션만 사용합니다. 예를 들어 Codex 설정 오버라이드, Claude `--mcp-config`와 strict 계열 옵션의 존재와 동작을 확인한 뒤 씁니다.
    - 자식 프로세스 환경변수: API 키 계열은 기본으로 제거하는 허용 목록을 둡니다.
    - 실행 직전 인증 방식 조회: 결과가 구독이 아니면 `waiting_user`로 멈춥니다.
  - opencodex를 쓸 때는 실제 base URL, 제공자, 대체 경로를 세션 기록에 남깁니다.
- **확인 방법:**
  - 실행 전후로 `~/.codex`, `~/.claude` 설정 파일의 해시가 같은지 비교합니다.
  - 가짜 API 키 환경변수를 넣고 실행해도 구독 경로가 유지되는지, 아니면 거부되는지 확인합니다.
  - LaunchAgent 데몬에서 Keychain 기반 인증이 읽히는지 확인합니다.

### 4. queue·steer·stop의 의미와 취소 경계가 실행기 계약에 매핑되지 않음
- **문제:**
  - pi-gui의 `followUp`은 실행 종료 후에 전달됩니다. 계획의 `queue`는 "도구 하나가 끝난 경계"에서 전달됩니다. 이식한 `queued-messages` UI가 의미를 잘못 표시하게 됩니다.
  - 도구 중계기는 다음 도구 호출만 막을 수 있습니다. 모델의 다음 판단 앞에 메시지를 끼워 넣을 수는 없습니다.
  - 보류한 MCP 호출이 CLI 쪽에서 타임아웃되면 모델이 같은 조작을 재시도할 수 있습니다.
  - 공식 확장은 수정할 수 없으므로, 확장 내부에서는 revision을 다시 검사할 수 없습니다.
  - JS 평가 도구가 관찰인지 조작인지 분류가 없습니다.
- **근거:** `types.ts` 26–35행(`steer|followUp`), 219–222행. 계획 MD 189–192행, 224–230행. JSON `session_contract.queue_boundary`.
- **스펙 수정:**
  - 매핑 표를 둡니다.
    - steer: Codex는 `turn/steer`. Claude는 stream 입력 지원을 확인한 뒤 쓰고, 안 되면 interrupt 후 resume.
    - queue: 1순위는 도구 경계 hold와 steer 조합. 그다음은 followUp, 그다음은 미지원 표시.
    - stop: 중계기 차단을 먼저 걸고, 그다음 interrupt나 프로세스 종료.
  - 보류된 호출은 나중에 실행하지 않습니다. 결정적인 `not_executed: superseded(rev)` 결과를 반환합니다.
  - "전송 후 응답 없음" 상태는 모두 `uncertain`으로 처리합니다.
  - 도구마다 관찰·조작 분류표를 둡니다. evaluate는 조작으로 분류합니다.
  - `request_id`의 고유 범위는 host와 client 기준으로 정합니다.
- **확인 방법:**
  - 가짜 MCP 서버로 결정적 테스트를 만듭니다. 대상은 도구 실행 중 stop, hold 중 타임아웃, 오래된 revision, 중복 `request_id`, interrupt와 도구 완료가 경쟁하는 경우입니다.
  - 실제 Codex와 Claude에서는 각 명령의 전달 시점을 이벤트 로그로 대조합니다.

### 5. 스토어 호환 검증 순서와 독립 모듈 분리가 빠짐
- **문제:**
  - 1번 작업 하나에 다음이 모두 묶여 있습니다: Xcode 확인, 빌드, 브랜드 변경, 스토어 설치, Bitwarden, Codex 확장, Native Messaging, MCP.
  - 작업 2부터 8까지는 `depends_on`이 일렬로 이어집니다. 그래서 Xcode 없이 할 수 있는 데몬·세션 작업까지 모두 막힙니다.
  - 아키텍처 확인이 8단계에 있습니다. 원격 Mac 상태를 모르므로 빌드 대상을 처음에 정할 수 없습니다.
  - Bitwarden의 생체 잠금 해제는 데스크톱 앱이 Chrome 경로에 등록하는 Native Messaging에 기대는 기능입니다. 이것이 MyBrowse 통과 기준에 들어가는지 정해지지 않았습니다.
- **근거:** JSON `tasks[0].change`, `tasks[*].depends_on`, `tasks[7]`. 계획 MD 171–173행, 287–293행.
- **스펙 수정:**
  - 1번 작업을 단계별 증거 게이트로 나눕니다.
    - 1a: full Xcode와 SDK, 디스크, 두 Mac의 아키텍처를 기록합니다.
    - 1b: 브랜드를 바꾸지 않은 고정 커밋 Chromium을 빌드하고 실행합니다.
    - 1c: 스토어에서 Bitwarden을 설치합니다. 재실행 후 유지되는지, 업데이트 확인 요청이 성공하는지 봅니다.
    - 1d: Codex 확장을 설치하고 MyBrowse 경로에 Native Messaging을 등록해 MCP 왕복을 확인합니다.
    - 1e: 브랜드·경로 패치를 적용한 뒤 1c와 1d를 다시 검증합니다.
  - 데몬, 프로토콜, 실행기, 중계기, CLI, 어댑터 경로 모듈은 1번과 독립된 트랙 B로 분리합니다.
  - Bitwarden 생체 잠금 해제는 제외하거나 별도 항목으로 둡니다.
- **확인 방법:**
  - 각 게이트는 증거 파일을 남겨야 다음 단계로 넘어갑니다. 증거는 스크린샷, 확장 버전, 업데이트 요청 로그입니다.
  - 압축 해제 상태로 로드한 확장은 통과 증거로 인정하지 않습니다.

## 지금 구현 가능한 최소 완결 경로 (CLT + Node 24)

수직 경로는 `mybrowse exec` → 로컬 API → 데몬 → 실행기 → 도구 중계기 → 이벤트·결과입니다.

1. **`protocol/`:** 세션 상태 8개, 명령, 이벤트 순번, capabilities, 브리지 인터페이스를 타입으로 정의합니다.
2. **`daemon/`:** SQLite 저장소, `request_id` 중복 방지, SSE의 `after_seq`, control·lease, `uncertain` 처리를 만듭니다. 원격 접속은 loopback으로만 받습니다.
3. **`adapters/tool-broker`:** 가짜 MCP 하류로 revision·제어권 검사와 superseded 결과를 구현합니다. 이어서 `test:session-control`과 `test:bridge-boundary`의 소켓 peer·토큰 검사를 만듭니다.
4. **`engines/codex`, `engines/claude`:** 실제 로그인된 CLI에 연결해 steer·interrupt·resume 동작과 인증 방식을 기록합니다. 환경변수 제거와 전역 설정 해시 불변 테스트도 넣습니다.
5. **`adapters/chrome`:** 브라우저 대상 추가, 소켓 분리, self-heal 끄기를 경로 fixture 단위로 테스트합니다. 브라우저 대상 실검증은 아직 하지 않습니다.
6. **`ui/` React 이식:** 일반 브라우저 페이지에서 mock 브리지, 엄격한 CSP, Trusted Types로 띄워 봅니다. 이것은 WebUI 통합 완료가 아닙니다.

선택 사항으로, 상류 Chrome을 MCP 계약 확인용 개발 장치로 쓸 수 있습니다. 결과에는 "비제품"이라고 표시하고 수락 기준에는 넣지 않습니다.

## full Xcode 없이는 완료할 수 없는 경로
- Chromium `chrome` 타깃 빌드와 브랜드·경로 패치. 정확한 Xcode·SDK 요구는 고정 커밋 문서로 확인해야 하며, 지금 빌드 성공을 단정할 수 없습니다.
- `chrome://mybrowse` WebUI, Mojo 브리지, 통합 좌측 목록과 탭 모델 연결.
- MyBrowse 안에서의 스토어·Bitwarden 설치·업데이트, Codex 확장과 Native Messaging·MCP 실검증.
- MyBrowse 번들 ID를 대상으로 한 Computer Use 검증, 앱 서명·공증·업데이트, 두 Mac별 산출물.
- 원격 Mac은 아키텍처, OS, Xcode 상태를 아직 모릅니다. 1a 게이트에서 먼저 확인해야 합니다.

## 최종 판정: **REVISE**
위 다섯 계약을 반영하고 작업 의존성을 트랙 A(Xcode 게이트)와 트랙 B(지금 구현 가능)로 나누면 READY로 바꿀 수 있습니다.