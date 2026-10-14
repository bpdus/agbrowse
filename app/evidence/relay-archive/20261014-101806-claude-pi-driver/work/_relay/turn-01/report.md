# turn-01 보고

## 한 일
- `src/engines/pi-rpc.mjs`: `PiRpc`(LF+UTF-8 JSONL, 바이트 단위 분할, 2MiB 상한, 고유 요청 ID, 응답 id/command/success 검증, 중복·미지 응답은 치명적 프로토콜 오류, unref 타임아웃, 스폰 오류·자식 종료 처리, 오류의 `sent` 플래그)와 `reapChild`(EOF 대기, 이후 해당 자식만 SIGTERM, SIGKILL).
- `src/engines/pi.mjs`: `PiDriver`. 런타임 검증, 고정 인수와 최소 환경(`cliEnvironment` + `PI_CODING_AGENT_DIR`), `get_state`/`get_available_models` 준비 검사(요청 provider/id와 실제 상태 모델 일치 확인), 실제 sessionId만 `onId`, 재개 ID 불일치 시 새 세션 없이 중단, `agent_settled` 이후에만 완료, 마지막 assistant `message_end`만 결과, prompt 전송 후 결과 불명은 `uncertain`(재전송 없음), stop은 `clear_queue`, `abort` 1회, EOF, 자식 종료 대기 순서, 콜백 예외 격리.
- 테스트 2개 파일(39개). 파일 헤더에 실제 계정·LLM 왕복을 대신하지 않는다고 명시했습니다.

## 확인
`node --test test/pi-rpc.test.mjs test/pi-engine.test.mjs`: 39/39 통과, 연속 2회 동일.
외부 프로세스, 네트워크, 전역 Pi, 인증 파일을 사용하지 않았습니다.

## 남은 위험
- 실제 Pi를 실행하지 않았으므로 CLI 플래그(`--no-tools` 등)와 실제 응답 모양은 공개 자료 기준 추정입니다.
- 실행 전체의 시간 제한은 없습니다. 타임아웃은 명령 응답에만 적용됩니다.
- 프로토콜 오류는 치명적으로 처리합니다. prompt 이후면 `uncertain`입니다.
- 모델 미준비·불일치는 `onWaiting('pi_provider_unavailable')`만 호출하고 `onEnd`는 호출하지 않습니다(Codex의 로그인 필요와 동일).
- stop 뒤에는 `onEnd`가 오지 않습니다(Codex와 동일).
- 루트의 engines.test.mjs, codex.mjs 등은 읽기만 했고 수정하지 않았습니다. 새 테스트는 `test/`에 두었습니다.
- 자식이 'close' 없이 'exit'만 알리면 한 틱 뒤 종료 처리합니다. 실제 파이프에 남은 출력의 유실 가능성은 실환경에서 확인이 필요합니다.
