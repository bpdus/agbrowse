**판정: REVISE.** 방향은 맞습니다. 다만 일부 안전 조건이 수락 기준으로 아직 확정되지 않았습니다.

**수정할 점 (4개)**

1. **공유 agent dir의 쓰기 정책을 정하세요.**
   - 현재 문서는 "MyBrowse는 `auth.json`과 opencodex 블록을 직접 덮어쓰지 않는다"고만 씁니다. 그러면서 "OAuth 갱신은 Pi가 처리한다"고 합니다.
   - 같은 `<agent-dir>`를 쓰면 Pi 자식 프로세스가 인증 갱신이나 설정 저장으로 `auth.json`과 `settings.json`을 정상적으로 쓸 수 있습니다. 이 쓰기는 "직접 overwrite 금지"와 별개입니다.
   - 따라서 "MyBrowse 코드가 직접 쓰는 것"과 "Pi가 자기 규칙으로 쓰는 것"을 구분해 적으세요.
   - 두 Mac이나 TUI Pi와 동시에 실행될 때의 동시성(락, 마지막 쓰기 우선)도 적어야 합니다.
   - 설정 변경은 Pi 공개 경로(`/settings`, 지원되는 RPC)로만 하고, 모델 요청 전에 쓰기가 일어나지 않는지 검사 항목에 넣으세요.

2. **호환성 검사를 구체화하세요.**
   - "RPC 명령·이벤트·도구 경계 검사"가 아직 추상적입니다. 제가 읽은 0.87.1 문서는 `get_state`, `get_commands`, `get_available_models`, `agent_settled`를 정의합니다.
   - 허용 버전 범위(허용 목록)와 필수 명령·이벤트 목록을 명시하세요.
   - `get_available_models`는 모델 호출 없이 확인되는지, 아니면 인증 상태를 건드리는지 먼저 확인해야 합니다. 이 검사가 부작용 없이 가능한지는 이 문서들로 단정할 수 없습니다.
   - pi-gui `^1.0.0`은 SDK 의존이고 설치된 Pi는 0.87.1입니다. 이미 "호환 가정 금지"로 처리했고 방향은 옳습니다. 다만 pi-gui 코드를 차용할 때 SDK 타입을 직접 import하지 않는지는 별도 수락 항목으로 두세요.

3. **세션 경계와 업데이트 중 작업 유지를 정확히 쓰세요.**
   - 세션 저장소가 `--session-dir` 또는 `PI_CODING_AGENT_SESSION_DIR`로 분리된다는 점은 문서에 근거가 있습니다. 이를 계약에 명시하세요.
   - 실행 파일을 업데이트하면 `agent_settled` 전까지는 기존 프로세스가 유지되어야 합니다. 이를 시험하세요.
   - 업데이트 시 파일이 교체되면 실행 중 프로세스가 영향을 받는지 확인하는 항목을 더하세요.
   - 새 Pi가 이전 세션 파일 형식을 읽는지도 재개 전에 검사하세요. "자동 승계 가정 금지"는 이미 있습니다.

4. **구현 상태 표기를 더 분명히 하세요.**
   - `plan.json`의 `preferred_engine: pi`는 현재 구현과 다릅니다. 코드는 codex/claude만 지원합니다. `pi-shared-runtime.md`는 이를 인정하지만, 계획 상태가 `READY`입니다.
   - `preferred_engine` 필드는 `planned`와 `implemented`를 나눠 쓰세요.
   - opencodex는 엔진이 아니라 Pi 제공자로 적은 부분이 맞습니다. `contracts.md`의 "opencodex capability=false"와 이 표현을 통일하세요.
   - MCP와 제공자 분리는 문서에 있습니다. 거부 시 `waiting_provider`로 멈추고 유료 fallback을 막는 조건도 이미 있습니다. 다만 `waiting_provider`가 `contracts.md`의 상태 목록(`waiting_user`, `failed`, `paused` 등)에는 없으니 추가하세요.

**실제 확인한 근거**
- 읽은 파일은 `plan.json`, `pi-shared-runtime.md`, `contracts.md`와 같은 폴더의 `rpc.md`, `configuration.md`, `cli.md`, `models.md`입니다.
- 이 문서들에서 확인한 내용은 다음과 같습니다.
  - RPC는 JSONL이고, `get_state`와 `agent_settled`가 있습니다.
  - `PI_CODING_AGENT_DIR`이 agent dir를 정하고, `auth.json`과 `models.json`이 그 안에 있습니다.
  - 세션 디렉터리를 별도로 지정할 수 있습니다.
  - RPC는 `@file`을 거부합니다.
- 계획 문서의 비밀 값 비노출, 자동 업데이트 설치 금지, 유료 fallback 금지는 확인했습니다.

**실행하지 않은 검사**
- 실제 Pi 0.87.1 실행과 RPC 왕복
- 실제 `auth.json`, `models.json` 읽기
- 업데이트 중 프로세스 동작
- 두 Mac 동시 실행
- `rpc-commands.md`는 폴더에 없어서 읽지 못했고, 개별 명령의 응답 형식은 검증하지 못했습니다.
- 위 문서가 실제 설치된 0.87.1 문서와 같은지는 확인하지 못했습니다. 폴더의 사본을 근거로 했을 뿐입니다.

따라서 "무조건 호환된다"고 쓸 수 없습니다. 위 항목을 모두 반영한 뒤 실제 Pi로 검증하기 전까지는 계획 단계로 남겨야 합니다.