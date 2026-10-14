[cli-relay · task · turn 03]

## Objective
독립검토의 list 대용량문제와 listen직후검사실패정리문제를수정한다.

## Scope
수정가능src/ipc.mjs, src/store.mjs, src/service.mjs, test/ipc.test.mjs. main은읽기만한다. 다른CLI/에이전트/설치/배포금지.

## Context
최신루트src와test와specs/webui-ipc.md를다시stage했다. root는closePromise재사용, mkdir700명시, 테스트연결slot해제대기와aftercleanup을추가했다. 전체70검사통과, C++16검사통과, 실제Codex IPC 왕복성공했다. 독립검토는list전체응답1MiB초과시UI목록영구실패와listen후lstat실패시socketIdnull경로의listener누수를찾았다.

## Deliverable
최신specs/webui-ipc.md의목록페이지계약을구현한다. Store.listSummaries(beforeRowid,limit)와SessionService.listSummaries(...)를추가한다. SQL은host스코프/rowid내림차순/선택rowid<?/LIMIT limit+1/substr(task,1,240) 제목만읽는다. fullresult/prompt/queue를읽지않는다. 결과는 sessions summary id/host/title/engine/mode/status/revision/created_at/updated_at, next_before_rowid, has_more. IPC list는payload limit1..200 기본100, 선택before_rowid 양수safeInteger만허용한다. HTTP기존Store.list()/SessionService.list()변경금지. 기존 oversized list 테스트는 새페이지가유한하며큰프롬프트결과원문을안전송하는지검사로바꾼다. 별도 get의거대한result는여전히response_too_large 검사필요.
listen성공을별도로기록한다. 성공후lstat/socketmode검사가실패해도owned directory를rename하는shutdown과server.close를실행해야한다. socketId없으면파일은삭제하지않으며private폴더보존가능한실패경로를보고한다. listen자체실패도불필요한listener없도록정리한다. 파일회수/외부삭제금지.

## Acceptance
list 200+개세션페이지중복/누락없이읽힘, title240자, 큰result포함안됨, 잘못된cursor/limit거부. 이전20테스트유지, root가실제실행. main connectioncleanup은root별도ownership이므로수정금지. 보고와변경파일정확히일치한다.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-085855-claude-mybrowse-ipc/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-085855-claude-mybrowse-ipc/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-085855-claude-mybrowse-ipc/work/_relay/turn-03/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-085855-claude-mybrowse-ipc/work/_relay/turn-03/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
