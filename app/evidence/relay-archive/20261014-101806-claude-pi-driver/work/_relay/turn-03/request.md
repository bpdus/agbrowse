[cli-relay · task · turn 03]

## Objective
제공자 미준비 경로에서도 자식 정리 실패를 명확하게 보고합니다.

## Scope
기존 네 Pi 파일만 수정합니다. 그 밖의 파일과 전역 설정은 읽거나 변경하지 않습니다.

## Context
turn-02의 close/재시도/세션 ID 수정은 루트가 코드에서 확인했습니다.
하지만 모델 미준비 분기는 onWaiting을 먼저 호출하고 shutdown().catch(noop)로 정리 실패를 숨깁니다. onWaiting은 자식 정리가 성공한 뒤 호출해야 합니다. 정리 실패이면 onEnd({status:'failed',result:'pi_cleanup_failed: ...'})로 보고하고 onWaiting은 호출하지 않습니다.
finished를 EOF 전에 표시하여 의도적인 close 이벤트가 실패 완료를 중복 호출하지 않도록 합니다. 취소 중에는 정상 기존 stop 규칙을 유지합니다.
AbortSignal 내부 stop().catch(noop)는 handle.stop의 rejection을 보존하므로 허용합니다. startup 취소 반환도 이후 handle.stop으로 오류를 관찰할 수 있으므로 그대로 둡니다.

## Deliverable
해당 분기의 작은 변경과 정리 실패 회귀 검사 하나를 추가합니다.

## Acceptance
node --test test/pi-rpc.test.mjs test/pi-engine.test.mjs를 실행합니다.
제공자 미준비+close 성공이면 waiting만 호출합니다. close 실패면 failed 완료만 호출하며 모델 prompt는 보내지 않습니다.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-101806-claude-pi-driver/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-101806-claude-pi-driver/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-101806-claude-pi-driver/work/_relay/turn-03/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-101806-claude-pi-driver/work/_relay/turn-03/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
