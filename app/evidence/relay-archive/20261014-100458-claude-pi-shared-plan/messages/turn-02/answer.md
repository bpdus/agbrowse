**판정: PASS (계획 단계 한정).** 이전 네 지적은 문서에 반영됐습니다. 계획이 READY여도 구현이 끝난 것은 아닙니다. Pi는 시작 RPC만 확인했고, 모델 실행은 허용하지 않았습니다.

**확인한 근거**
- `pi-shared-runtime.md`, `plan.json`, `contracts.md`, `pi-rpc-probe.json`을 읽었습니다.
- `auth-storage.js`에는 `proper-lockfile` 잠금이 있습니다. `settings-manager.js`의 잠금은 grep에 잡히지 않아서 이번에는 확인하지 못했습니다. 문서는 둘 다 확인했다고 적었으니 이 부분은 `settings-manager.js`를 직접 확인하세요.
- `rpc-mode.js`에서 `get_available_models`는 `getAvailableSnapshot()`을 반환합니다. 즉 메모리의 snapshot이며, 문서의 설명과 맞습니다.
- 프로브 JSON은 세 명령의 `success: true`와 EOF 뒤 `exit_code: 0`을 보여줍니다. `real_credentials_read`와 `model_prompt_sent`는 false입니다.
- `available_model_count`가 0이므로 격리된 임시 디렉터리에서 모델이 비어 있었고, 실제 제공자 목록은 확인되지 않았습니다.
- `plan.json`은 `planned_preferred_engine`과 `implemented_engines`를 나눴고, `execution_allowed_versions`는 빈 배열입니다.
- `contracts.md`는 `waiting_provider`와 `waiting_user`를 구분하고 opencodex를 엔진이 아닌 Pi 제공자로 둡니다.

**남은 중요 사항**
1. **버전별 캐시 수락 기준을 보강하세요.** 캐시에 보관하는 것은 "검증한 런타임"입니다. 그런데 캐시가 외부에서 변조되지 않았는지, 정리와 용량을 어떻게 하는지가 없습니다. 프로브 JSON에 있는 `entry_sha256`을 캐시 검증에 쓴다고 적으세요. 그러면 실행 전 해시 확인이 가능합니다. 캐시를 쓸 때 사용자 설정(auth/models)이 복사되지 않는다는 검사도 수락 표에 넣으세요.
2. **`get_state`의 안전성을 확인하세요.** 격리 환경에서는 통과했지만 실제 agent dir에서 시작하면 설정을 읽거나 쓸 수 있습니다. 프로세스 시작 자체가 무부작용이 아니라고 문서가 이미 인정합니다. 실제 agent dir에서 처음 시작할 때 파일 변경 여부를 전후 비교하는 항목을 추가하세요. 값은 읽지 않고 변경 시각이나 해시만 비교하면 됩니다.
3. **실행 허용 전환의 문턱을 적으세요.** `execution_allowed_versions`를 비어 있지 않게 만드는 조건이 아직 문장으로 정해지지 않았습니다. 예를 들어 "가짜 제공자의 run 이벤트 검증, `prompt`/`abort`/`steer` 검사, 사용자 승인, 이 순서를 모두 통과"처럼 적고, 버전 추가는 사용자 승인으로만 하게 하세요. 그래야 자동 허용으로 오해되지 않습니다.

**실행하지 않은 검사**
- 실제 Pi 실행과 프로브 재현. 프로브 결과는 JSON 기록을 믿고 읽은 것입니다.
- 실제 인증 파일 읽기와 모델 요청
- TUI Pi와 앱의 동시 실행
- 캐시 교체 시험과 세션 재개 시험
- `rpc-commands.md` 전체 대조