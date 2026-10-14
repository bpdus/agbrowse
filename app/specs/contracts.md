---
title: MyBrowse 구현 계약
summary: Chromium 통합 전후의 완료 기준과 실행기·세션·화면 경계를 고정합니다.
created: 2026-10-13
updated: 2026-10-14
note_type: spec
status: draft
language: ko
render_target: github
---
# MyBrowse 구현 계약

입력 출처: ../plan.json. 작업 ID: 2026-10-13-mybrowse-architecture.

## 제품 수락 기준

사용자는 앱 내부의 웹페이지와 대화를 같은 창에서 선택합니다. 좌측 목록은 실제 탭과 작업을 표시합니다. 홈페이지는 Search/Ask 입력과 최근 작업을 표시합니다. 독립 Chromium 앱에서 Bitwarden을 스토어로 설치해야 브라우저 완료로 판정합니다.

2026-10-14에 MacBook의 전체 Xcode 27.0과 SDK 27.0을 확인했습니다. iMac의 마지막 검사에서는 Command Line Tools만 확인했습니다. Node 실행 경로와 일반 브라우저의 화면 프리뷰는 Chromium 앱 완료에 포함하지 않습니다. Chromium·WebUI·Mojo·확장 통합은 실제 빌드와 실행 증거로 판단합니다.

## 실행 경로와 인터페이스

Node 24.15 이상, ESM, 내장 node:sqlite/node:http/node:test를 사용합니다. 네트워크 의존 패키지 없이 핵심을 검증합니다.

Store(databasePath, hostId): create(input), get(id), list(), update(id, patch), appendEvent(id,type,data), events(id,afterSeq), close(). Session에는 id, host, client_id, request_id, prompt, engine, mode(chat|browser), status, revision, engine_session_id, result, queue, created_at, updated_at를 저장합니다. 생성은 host/client/request 범위에서 원자적으로 중복을 막습니다. 같은 키와 다른 요청 본문은 409 conflict입니다. SQLite 재실행 후 running은 uncertain으로 바뀝니다. 작업을 자동 재실행하지 않습니다.

SessionService({store, engines, broker, browserReady=false}): create(input), list(), get(id), command(id,{action,text,expected_revision,request_id}), events(id,afterSeq), subscribe(id,listener), close(). engine map은 {codex:driver,claude:driver}입니다. driver.start(session,{onEvent(type,data),onId(id),onEnd({status,result}),onWaiting(reason)})는 Promise<handle>을 반환합니다. handle에는 async stop()와 optional async steer(text)가 있습니다. 동기 callback, 시작 중 stop, 늦은 callback도 처리해야 합니다. 엔진 실행은 서비스가 소유합니다. HTTP 연결 해제는 엔진을 멈추지 않습니다.

create는 즉시 Session을 반환합니다. mode=browser이고 browserReady=false이면 waiting_user와 browser_not_integrated 이벤트만 반환합니다. chat이면 실제 CLI를 시작합니다. 지원하지 않는 engine/mode는 400입니다. 시작 실패는 failed, 인증 부족은 waiting_user, 중단은 paused입니다. queue는 현재 턴 종료 후 새 턴에서 전달합니다. queue_boundary=turn_end를 공개합니다. steer는 handle 지원 여부를 확인합니다. 미지원이면 409 unsupported이며 revision은 바뀌지 않습니다. stop은 broker 차단 후 engine.stop 순서입니다. resume는 paused/done/waiting_user 상태에서만 명시적으로 실행합니다. uncertain은 사용자 확인이 필요한 상태로 유지합니다.

Broker: acquire(sessionId,resource), release(sessionId), block(sessionId), allow(sessionId), dispatch({sessionId,resource,revision,currentRevision,tool,run}). resource는 host/profile/tab을 포함합니다. 겹치는 제어권은 거부합니다. dispatch는 호출 직전에 block/revision/lease를 확인합니다. chrome_evaluate와 알려지지 않은 도구는 mutation입니다. 전송 후 응답을 알 수 없으면 uncertain입니다. 이미 전송한 행동의 취소는 보장하지 않습니다. 현재 broker는 단독 경계 모듈입니다. 실제 MCP 파이프에 붙기 전에는 browserReady를 활성화하지 않습니다.

HTTP: createHttpServer({service,token,hostId,uiDir?}) -> node:http.Server. localhost 127.0.0.1만 listen합니다. /health는 호스트·capabilities만 반환합니다. 나머지 /v1 API는 Authorization: Bearer 인증입니다. POST /v1/sessions, GET /v1/sessions, GET /v1/sessions/:id, POST /v1/sessions/:id/commands, GET /v1/sessions/:id/events?after_seq=N (SSE). 대상 host가 다르면 409입니다. request_id와 client_id는 비어 있지 않은 문자열입니다. 명령도 request_id를 사용하여 재전송을 중복 실행하지 않습니다. expected_revision 충돌은 409입니다. JSON 본문은 64KiB 이하입니다. Origin이 있으면 서버 자신의 localhost origin만 허용합니다. CORS wildcard는 없습니다. SSE 이벤트에는 id: seq와 JSON data를 보냅니다. 재접속 시 after_seq와 Last-Event-ID를 지원합니다. 토큰은 URL이나 로그에 넣지 않습니다.

## 실행기 인증과 권한

Codex는 app-server stdio JSON-RPC를 사용합니다. initialize -> initialized -> account/read -> thread/start 또는 thread/resume -> turn/start 순서입니다. ChatGPT 인증을 확인합니다. 실제 thread.id만 저장합니다. turn/steer에는 실제 active turn.id와 expectedTurnId를 사용합니다. stop은 turn/interrupt와 소유한 프로세스 종료로 처리합니다. RPC에 시간 제한과 프로세스 종료 처리를 둡니다. 서버 승인 요청은 자동 승인하지 않습니다. waiting_user를 남기고 거부합니다.

Claude는 claude -p --output-format stream-json --verbose --tools '' --strict-mcp-config --mcp-config '{"mcpServers":{}}'를 사용합니다. 공식 claude.ai 인증 여부를 확인합니다. --bare나 권한 우회 옵션을 사용하지 않습니다. --resume에는 실제 session_id만 전달합니다. 초기 capabilities는 steer=false, queue=turn_end입니다. 프로세스 종료는 해당 자식만 대상으로 합니다.

두 엔진은 공식 인증 저장소를 유지합니다. API 키와 제공자 base URL·라우터·프록시 환경은 허용 목록에서 제외합니다. HOME/PATH 및 macOS 사용자 런타임 값만 전달합니다. 전역 MCP 설정은 수정하지 않습니다. 초기 chat 경로는 MCP와 명령 실행 도구를 비활성화합니다. 지정한 브라우저 MCP가 연결되기 전에는 브라우저 작업을 실행할 수 없습니다. opencodex는 제공자·base URL·인증·fallback이 명시된 별도 검증 전까지 capability=false입니다.

## 화면과 Chromium 경계

화면 프리뷰는 실제 세션 REST와 fetch 기반 SSE를 사용합니다. 토큰은 사용자가 입력하며 sessionStorage나 파일에 저장하지 않습니다. 제목·모델 출력은 textContent로 렌더링합니다. innerHTML, eval, 인라인 JS, iframe 웹 임베딩을 쓰지 않습니다. CSP는 default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'입니다. 탭·Search·MCP 미통합은 화면에 사실대로 표시합니다.

최종 화면은 chrome://mybrowse WebUI로 이동합니다. 좌측 고정 목록은 브라우저 Views가 실제 탭 모델과 연결합니다. 웹사이트는 별도 WebContents입니다. 브라우저 프로세스만 Mojo와 데몬 IPC를 소유합니다. UI 프리뷰용 REST 브리지와 최종 privileged Mojo 브리지는 같은 제품 API의 별도 transport입니다. pi-gui의 SessionDriver 개념만 참고합니다. 현재 코드를 이식했다고 주장하지 않습니다. Electron 셸은 사용하지 않습니다. 설치된 Pi와 제공자 공유 경로는 [Pi 공유 런타임 명세](pi-shared-runtime.md)를 따릅니다. Pi 구현은 아직 추가하지 않았습니다.

## Chromium 게이트

1a: 두 Mac의 아키텍처와 OS, 빌드 Mac의 전체 Xcode·SDK·디스크를 확인합니다. 대상 Mac에서 앱만 실행한다면 Xcode가 필요하지 않습니다.
1b: 정확한 Chromium 커밋을 고정한 뒤 원본 chrome 타깃을 빌드하고 실행합니다.
1c: 스토어 Bitwarden 설치·재실행·업데이트를 확인합니다.
1d: Codex 확장·MyBrowse 전용 Native Messaging·MCP를 확인합니다.
1e: 브랜딩·WebUI·Mojo 이후 1c/1d를 다시 확인합니다.

MyBrowse 데이터는 Browser/와 Agent/로 분리합니다. 브리지 소켓 디렉터리는 0700입니다. 공식 native host 이름은 유지하되 Chrome의 등록 파일을 덮어쓰지 않습니다. peer UID·실제 브라우저 신원 확인은 C++ 통합 게이트입니다. 공개 CDP 포트를 제품 기본 경로로 쓰지 않습니다. 임의 상류 HEAD를 빌드 스크립트에서 자동 선택하지 않습니다. Bitwarden 생체 잠금 해제는 별도 검증입니다.

## 테스트와 미해결 항목

자동 검사는 SQLite 재접속, 생성·명령 재전송, host 불일치, stale revision, stop/start 경쟁, 늦은 출력, queue 순서, 승인 거부, RPC 종료·시간 제한, SSE 재생, 외부 Origin·토큰 거부를 확인합니다. 가짜 엔진 검사는 실제 LLM 검증과 구분합니다. 실제 Claude/Codex로 짧은 text-only 왕복을 확인합니다. 실제 Chromium·확장·Muse VM 연결·opencodex·서명·업데이트는 미검증으로 기록합니다.

## 구현 후 확인한 세부 계약

Session의 task는 최초 지시를 보존합니다. prompt는 현재 턴의 지시입니다. queue는 text/request_id/created_at 객체 배열입니다. events 응답의 세션은 URL 경로로 식별합니다. 엔진 이벤트 이름에는 engine. 접두사를 붙입니다. 서비스의 get은 없는 세션에 404를 반환합니다. create는 신규와 중복 모두 HTTP 200입니다.

드라이버 callback에는 AbortSignal을 전달합니다. stop은 소유한 자식 프로세스 종료를 기다립니다. Codex는 interrupt 후 프로세스를 종료합니다. 완료 callback은 이전 프로세스 정리 뒤 전달합니다. Claude는 stdout을 모두 읽은 close 이벤트에서 완료를 선언합니다. UI는 요청 토큰과 세션 ID로 늦은 응답을 버립니다. SSE 순번은 각 연결에서 관리합니다.

현재 PID 잠금은 자동 회수하지 않습니다. 충돌이나 오래된 잠금이 있으면 시작을 막습니다. 비정상 종료 후에는 해당 PID와 잠금 파일을 먼저 확인해야 합니다. queue는 failed/stop 뒤에도 남습니다. resume로 실행한 턴이 완료되면 남은 queue를 순서대로 전달합니다.

Claude의 restricted 옵션은 사용자·프로젝트 설정을 무시합니다. 명시적으로 disableAllHooks도 설정합니다. 관리자가 지정한 설정의 영향은 배포 환경에서 추가 확인해야 합니다. Codex는 확인하지 않은 복잡한 전역 설정 형식을 거부합니다. opencodex를 자동 사용하지 않습니다.

CLI의 --request 명령 재전송에는 최초 --revision도 필요합니다. 완료 외 상태는 종료 코드 1 또는 2입니다. 현재 직접 조작 명령은 browser_not_integrated 오류입니다. iMac의 기존 Node 22는 개발 요구 버전보다 낮습니다. 최종 앱은 Node 24 이상을 포함해야 합니다.

## Pi 실행기 추가 계획

[Pi 공유 런타임 명세](pi-shared-runtime.md)는 설치된 Pi의 RPC와 같은 제공자 설정을 사용합니다. Pi 업데이트는 다음 새 작업의 호환 검사 뒤에 반영합니다. 현재 서비스와 IPC는 codex/claude만 지원합니다. Pi 지원 전에는 실행기 검증, 저장 계약, 화면 선택과 도구 중계기를 함께 수정합니다. 실제 Pi 모델 왕복과 두 Mac의 확인 전에는 Pi capability를 켜지 않습니다.

Pi 추가 계획의 `waiting_provider`는 제공자 또는 런타임 호환이 확인되지 않은 상태입니다. 현재 Codex·Claude 경로의 `waiting_user`와 구분합니다. Pi 구현 때 서비스 전이와 UI 상태를 함께 검증합니다. 현재 opencodex는 구현된 엔진이 아니며, Pi 제공자로 연결할 예정입니다. 현재 제공자 capability는 비활성입니다.
