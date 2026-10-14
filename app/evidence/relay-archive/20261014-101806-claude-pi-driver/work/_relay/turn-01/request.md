[cli-relay · task · turn 01]

## Objective
Pi 0.87.1의 공식 JSONL RPC를 기존 MyBrowse 실행기 계약에 연결합니다. 안전한 오프라인 가짜 프로세스 검사만 합니다.

## Scope
새 파일만 작성합니다: src/engines/pi.mjs, src/engines/pi-rpc.mjs, test/pi-engine.test.mjs, test/pi-rpc.test.mjs.
그 밖의 파일은 읽기만 합니다. 전역 Pi와 실제 인증 파일, 외부 네트워크, 모델, 브라우저를 실행하지 않습니다.
패키지 설치, Git 작업, 다른 CLI와 하위 에이전트 호출을 하지 않습니다.

## Context
pi-driver.md가 구현 명세입니다. pi-shared-runtime.md는 장기 설계입니다.
rpc-commands.md, json.md는 설치된 Pi 공개 자료입니다.
src/engines/codex.mjs, environment.mjs, rpc.mjs와 engines.test.mjs를 기존 인터페이스 참고로 읽습니다.
기본 의존성은 Node 표준 라이브러리만 사용합니다. ESM 파일은 .mjs입니다.

공통 start(session,callbacks): session.prompt, session.engine_session_id; callbacks.signal, onId(id), onEvent(type,data), onWaiting(reason), onEnd({status,result}). 반환값은 {stop,steer}입니다.
명세의 런타임 경로/모델 검증, LF+UTF8 JSONL, 응답의 id/command/success, 레코드 상한, 스폰 오류, 타임아웃과 자식 종료를 구현합니다.
실제 상태의 모델이 요청한 provider/id와 일치하는지도 검사합니다. resume ID가 다르면 자동 새 세션을 만들지 않습니다.
모든 이벤트 콜백과 종료 콜백의 예외도 프로세스 정리를 방해하지 않도록 합니다.
가짜 프로세스는 PassThrough/EventEmitter로 구성합니다. 미완료 타이머가 테스트 종료를 지연시키지 않아야 합니다.
명령 응답을 성공으로 받아도 agent_settled 전에는 완료하지 않습니다.
message_end의 완성 메시지가 최종 결과입니다. 중간 assistant의 toolUse/재시도 메시지와 최종 응답을 중복 합치지 않습니다.
prompt가 전송된 후 응답을 잃으면 uncertain이며 자동 재전송하지 않습니다. 전송 전 오류는 failed입니다.
공개 자료에 따르면 abort는 queued steer를 이어갈 수 있습니다. stop에서 clear_queue를 먼저 요청한 뒤 abort는 한 번만 요청합니다. stop 상태에서는 들어오는 모든 새 지시를 막습니다. 이후 stdin EOF와 소유 자식 종료를 기다립니다.
서비스의 Pi 등록, 런타임 캐시, 제공자 적용과 MCP는 이번 범위가 아닙니다.

## Deliverable
네 새 파일, 실행한 검사 결과와 남은 한계를 보고합니다.

## Acceptance
node --test test/pi-rpc.test.mjs test/pi-engine.test.mjs를 실행합니다.
정상 완료, 낮은 agent_end 이후 추가 이벤트/settled, UTF8 분할, 다중 레코드, 프로토콜 오류와 상한, 잘못된/중복 응답, 모델 준비 실패, 실제 ID/재개, startup stop, active steer, clear_queue/abort/EOF stop, prompt 이후 응답 유실, 예외/자식 정리를 검사합니다.
테스트는 실제 계정과 LLM 왕복을 대신하지 않는다고 명시합니다.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-101806-claude-pi-driver/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-101806-claude-pi-driver/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-101806-claude-pi-driver/work/_relay/turn-01/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-101806-claude-pi-driver/work/_relay/turn-01/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
