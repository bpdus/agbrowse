# turn-02 보고

## 변경
- `pi-rpc.mjs`: 전송 계층이 `exit`로는 아무것도 끝내지 않고 `close`에서만 최종 실패를 판정합니다. exit 뒤에 오는 마지막 stdout 프레임을 받을 수 있습니다. `reapChild`는 spawn 시점부터 close를 추적해 close까지 기다립니다(이미 close된 자식도 지원). 이미 exit한 프로세스에는 신호를 보내지 않고, 끝내 close되지 않으면 `false`를 반환하고 stdio를 destroy합니다.
- `pi.mjs`: `shutdown`이 close 실패 시 `pi_cleanup_failed`로 reject합니다. 완료 경로는 `failed`(prompt 불명 상태는 `uncertain` 유지)로 보고하고, `stop()`은 같은 오류로 reject합니다. AbortSignal 경로는 `.catch`로 감싸 unhandled rejection이 없습니다. abort listener는 shutdown 끝에서 제거합니다. session ID는 `^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$`만 허용합니다(저장 ID, Pi 반환 ID 모두). 마지막 `auto_retry_end`가 실패이면 이전의 정상 assistant 메시지가 있어도 `failed`입니다. `termMs`, `killMs` 생성자 옵션을 추가했습니다(기본 1500).
- 테스트: 가짜 자식이 close도 emit하게 수정했고, 다음을 추가했습니다. exit 뒤 close 지연 중 완료 차단, exit 뒤 최종 stdout 보존, close되지 않는 자식의 failed와 stop reject, AbortSignal 경로의 unhandled rejection 없음, 종료·stop·시작 실패 뒤 listener 제거, 옵션 형태/경로 형태 ID 거부와 UUID 허용, retry 실패 뒤 done 차단.

## 확인
`node --test test/pi-rpc.test.mjs test/pi-engine.test.mjs`: 47/47 통과, 2회 연속. 실제 Pi, 네트워크, 인증은 사용하지 않았습니다.

## 남은 위험
- close가 영영 오지 않는 자식은 정리 대기가 grace+term+kill(기본 약 5초) 걸립니다.
- 시작 중 stop은 여전히 첫 `get_state` 응답을 기다리지 않고 EOF로 정리하며, 이후 prompt는 보내지 않습니다.
- 가짜 프로세스 검사이므로 실제 Node의 exit/close 간격은 루트의 실환경 검사로만 확인됩니다.
