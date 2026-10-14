[cli-relay · task · turn 02]

## Objective
루트 검토에서 확인한 Pi 자식 정리 계약을 보완합니다.

## Scope
수정 가능: src/engines/pi.mjs, src/engines/pi-rpc.mjs, test/pi-engine.test.mjs, test/pi-rpc.test.mjs.
나머지 파일은 읽기만 합니다. 전역 Pi/인증/모델과 외부 네트워크를 사용하지 않습니다.

## Context
루트가 39개 테스트를 다시 실행했고 모두 통과했습니다. 실제 설치 Pi 0.87.1에서도 no-tools 등 명세의 플래그와 로컬 시험 제공자 RPC 응답, 같은 세션 재개, steer, clear_queue/abort 및 EOF 종료를 확인했습니다. 서비스는 stop 자체가 상태를 기록하므로 stop의 onEnd 미호출은 맞습니다.
하지만 루트의 추가 회귀 검사는 onEnd_before_child_close=true를 재현했습니다. reapChild는 exitCode와 exit만 확인하고 close를 기다리지 않습니다. 실제 Node는 exit 이후에도 stdout 데이터가 남을 수 있습니다.

## Deliverable
다음 문제를 작은 변경으로 수정하고 의미 있는 회귀 검사만 추가합니다.
1. transport는 child exit만으로 stdout을 중단하지 않습니다. close에서 최종 종료를 판정합니다. exit 뒤 마지막 stdout 프레임을 받을 수 있어야 합니다.
2. reaper는 close까지 확인합니다. exit는 process 종료이며 close는 stdio 정리 경계입니다. exit 이후 close가 지연돼도 onEnd가 먼저 호출되면 안 됩니다. 이미 close된 자식도 지원합니다. 가짜 자식도 close를 emit하게 수정합니다.
3. reaper가 최종 정리 실패를 반환하면 완료로 보고하지 않습니다. shutdown/stop에 정리 오류를 보존하고 성공 completion을 막습니다. stop은 소유 child의 close를 기다리거나 명확한 cleanup 오류로 reject합니다. AbortSignal 내부의 void stop은 unhandled rejection을 만들지 않아야 합니다.
4. abort listener는 종료 뒤 제거합니다. Pi startup 중 stop은 계속 prompt를 막아야 합니다.
5. session ID는 실제 ID 형식처럼 alphanumeric으로 시작하고 alphanumeric/_/- 문자만 허용하여 --session의 값에 옵션 문자열을 전달하지 않습니다. 실제 UUID는 유지합니다.
6. retryFailure가 남아 있으면 과거 정상 assistant 메시지로 done을 보고하지 않습니다.

## Acceptance
node --test test/pi-rpc.test.mjs test/pi-engine.test.mjs 통과.
exit 뒤 close 지연 중 완료 차단, exit 뒤 최종 stdout 보존, close되지 않는 자식의 명확한 실패와 stop reject, 종료 이후 AbortSignal listener 정리를 검사합니다.
커밋, 설치, 배포, 다른 에이전트 호출은 하지 않습니다.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-101806-claude-pi-driver/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-101806-claude-pi-driver/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-101806-claude-pi-driver/work/_relay/turn-02/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-101806-claude-pi-driver/work/_relay/turn-02/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
