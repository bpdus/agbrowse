**판정: REVISE**

로컬 경로의 기본 골격은 제대로 동작합니다. 시작 중 stop 처리, revision과 재전송 처리, Host·Origin·Bearer 검사, 서버 측 SSE 재생은 코드로 확인했고 테스트도 통과합니다. 다만 대화 섞임, 전역 설정 격리, Codex 중단, 프로세스 종료 경쟁, 데몬 잠금에서 고쳐야 할 오류가 남아 있습니다. 브라우저·Chromium·MCP·스토어·Muse·opencodex는 제품이 이미 미완료로 표시했으므로 오류로 세지 않았습니다.

## 핵심 오류 5개

### 1. [높음·코드로 확인] 화면에서 서로 다른 대화가 섞임
**위치:** `ui/app.mjs` 함수 `openSession`(25행), `stream`(35–48행), `command`(56행)

**근거**
- `openSession`은 `stopStream()`을 먼저 호출하고 그다음에 `await api(get)`를 기다립니다. 사용자가 A를 누른 뒤 곧바로 B를 누르면 두 요청이 동시에 진행됩니다. 두 응답이 모두 `stream(id)`를 시작하므로 A의 controller는 `state.stream`에서 덮어써지고 영영 abort되지 않습니다.
- `stream`의 안쪽 읽기 루프(41–42행)는 `controller.signal.aborted`만 확인합니다. `state.active?.id===id`는 확인하지 않습니다. 따라서 남은 A 스트림이 계속 전역 `event()`를 호출합니다. 그러면 B의 타임라인에 A의 출력이 붙습니다. 또 공유 `state.seq`가 A의 seq로 올라가므로, 그보다 낮은 B의 이벤트는 `e.seq<=state.seq`에서 버려집니다. seq는 세션마다 1부터 시작하므로(`store.mjs` `#insertEvent`) 이렇게 서로 충돌합니다.
- 응답이 늦게 도착하는 경우도 문제입니다. A의 응답이 B보다 늦게 오면 화면이 A로 돌아갑니다. `command()`도 응답이 왔을 때 대상이 여전히 활성 세션인지 확인하지 않고 `updateSession(response.session)`을 호출합니다. 그래서 다른 대화로 옮긴 뒤에 이전 세션이 활성 세션으로 되돌아오고, B의 스트림 루프는 끝나 버립니다.

**수정**
- `openSession`마다 순번 토큰을 발급합니다. await가 끝난 뒤 그 토큰이 최신이 아니면 결과를 버립니다.
- `event(id, e)`처럼 세션 id를 받게 하고, 활성 세션과 다르면 무시합니다. seq는 스트림마다 따로 둡니다.
- 안쪽 루프에서도 `state.active?.id===id`를 확인합니다.
- `command`의 응답은 대상 id가 활성 세션과 같을 때만 반영합니다.

### 2. [높음·코드로 확인, CLI 동작은 추정] Claude가 사용자 전역 설정·hook·plugin·provider env를 그대로 이어받음
**위치:** `src/engines/claude.mjs` `start`의 args(21–23행), `checkAuth`(11–14행)

**근거**
- 프로세스 환경 변수는 `cliEnvironment`가 허용 목록으로 걸러 줍니다(확인).
- 그러나 `--setting-sources`나 `--settings`를 지정하지 않습니다. 그래서 `~/.claude/settings.json`의 `env`(예: `ANTHROPIC_BASE_URL`), `apiKeyHelper`, `hooks`, plugin, 사용자 CLAUDE.md가 그대로 적용될 것으로 봅니다. 이 부분은 Claude Code 동작에 근거한 추정이며 실제로 확인하지는 않았습니다.
- `--tools ''`와 `--strict-mcp-config`는 도구와 MCP만 막습니다. SessionStart 같은 hook은 셸 명령을 실행합니다. 이는 계약의 "명령 실행 도구 비활성화" 및 "전역 MCP 격리" 의도와 맞지 않습니다.
- `checkAuth`는 `authMethod==='claude.ai' && apiProvider==='firstParty'`만 확인합니다. settings의 env로 base URL을 바꾼 라우팅은 잡지 못할 수 있습니다.
- 작업 폴더 밖이라 사용자의 settings 파일은 읽지 않았습니다.

**수정**
- `--setting-sources project,local`을 추가합니다. cwd가 비어 있는 `engine-workspace`이므로 사용자 설정이 제외됩니다.
- `--settings '{"disableAllHooks":true}'`도 추가합니다.
- 실제 Claude로 hook이 실행되지 않는지, `ANTHROPIC_BASE_URL`이 무시되는지 확인하는 증거를 남깁니다.

### 3. [중상·코드로 확인] Codex stop에서 `turn/interrupt`가 전송되지 않고, 프로세스가 끝나기 전에 `stopped`가 기록됨
**위치:** `service.mjs` `#execute` stop 분기(251–260행), `codex.mjs` abort listener(20행), `handle.stop`(78–82행)

**근거**
- 서비스는 `run.controller.abort()`를 먼저 호출하고, 그다음 `await run.handle.stop()`을 호출합니다.
- abort listener가 먼저 `stopping=true`로 바꾸고 `terminateChild`를 기다리지 않은 채 실행합니다.
- 이어서 호출된 `handle.stop()`은 `if(stopping)return;`에서 바로 반환됩니다. 그 결과 계약에 있는 `turn/interrupt`는 한 번도 전송되지 않습니다. 또 `stopped` 이벤트가 app-server가 끝나기 전에 기록됩니다.
- stop 명령이 반환된 직후 resume하면, 아직 종료 중인 이전 app-server와 같은 thread에서 새 `thread/resume`이 동시에 실행될 수 있습니다.
- 시작 중 stop에서도 같은 문제가 있습니다. abort 경로가 종료를 기다리지 않습니다.
- `CodexDriver.start` 생명주기 자체에는 단위 테스트가 없습니다. engines 테스트에는 overrides와 `StdioRpc` 테스트만 있습니다. evidence에도 실제 Codex 왕복 기록이 없습니다. evidence에는 `live-cli-claude.log`만 있고, `plan.json`의 `both_mac_live_execution_verified`도 false입니다. 따라서 "Codex 실제 왕복 성공"은 이 폴더 안의 자료로는 확인할 수 없습니다.

**수정**
- abort listener는 플래그만 세우고 실제 종료는 `stop()` 하나로 모읍니다. 순서는 interrupt → terminate이며, 종료를 await하도록 합니다.
- 시작 중 abort도 종료 Promise를 보관하고 기다립니다.
- 가짜 child를 쓰는 Codex 생명주기 테스트를 추가합니다. 시작 중 abort, 승인 요청, `turn/completed`가 `turn/start` 응답보다 먼저 오는 경우를 포함합니다.
- 실제 Codex 왕복 로그를 남깁니다.

### 4. [중간·코드로 확인, 발생 여부는 추정] Claude 종료 경쟁과 이전 프로세스가 살아 있는 상태에서 다음 턴 시작
**위치:** `claude.mjs` `child.on('exit')`(45행), `service.mjs` `onEnd`→`#deliverQueue`(312–317행, 360–367행)

**근거**
- Node에서는 `exit` 이벤트가 stdout을 다 읽기 전에 발생할 수 있습니다. 이때 `lines.close()`가 호출되고 `!hasResult`이므로, 실제로는 성공한 턴이 `failed`("Claude exited without result")로 기록될 수 있습니다.
- 가짜 child 테스트는 `exit`를 microtask로 보내므로 이 경쟁을 재현하지 못합니다.
- queue가 있으면 `result` 줄이 도착하는 즉시 `onEnd(done)`이 호출되고, 바로 다음 턴이 시작됩니다. 이 다음 턴은 같은 `session_id`로 `--resume`하는 새 프로세스를 띄웁니다. 그런데 이전 claude 프로세스는 아직 세션 파일을 정리하는 중일 수 있습니다.
- Codex도 같습니다. `turn/completed`에서 `terminateChild`를 기다리지 않고 `finish`를 호출합니다.

**수정**
- `exit` 대신 `close` 이벤트를 사용합니다.
- 다음 턴은 이전 프로세스가 종료됐다는 Promise가 해결된 뒤에 시작합니다. 예를 들어 handle에 `exited`를 노출하고 서비스가 이를 기다리게 합니다.

### 5. [중간·코드로 확인] PID 잠금의 경쟁(TOCTOU)
**위치:** `src/instance-lock.mjs` `acquireInstanceLock`(8–12행)

**근거**
- 오래된(stale) 잠금 파일이 있을 때 데몬 A와 B가 동시에 시작한다고 가정합니다.
- A와 B 모두 ESRCH를 확인합니다. A가 `unlink`하고 `create`합니다. 이어서 B가 `unlink`하면 A가 방금 만든 잠금이 지워집니다. B도 `create`에 성공하므로 두 데몬이 같은 DB, 토큰, `connection.json`을 동시에 사용합니다.
- 추가로, PID가 재사용되면 다른 프로세스가 그 PID를 쓰고 있어서 영구적으로 "another daemon"이 됩니다. 이쪽은 시작을 막는 방향(fail-closed)이라 위험도는 낮습니다.
- 테스트는 단일 프로세스 경우만 확인합니다.

**수정**
- 회수할 때는 읽은 nonce가 여전히 같은지 확인한 다음 원자적으로 교체합니다. 임시 파일에 쓰고 `linkSync`/`renameSync`로 교체하는 방식입니다.
- 또는 `create` 직후 파일을 다시 읽어 자신의 nonce인지 확인하고, 아니면 종료합니다.
- 잠금 파일에 프로세스 시작 시각을 함께 기록하면 PID 재사용도 구분할 수 있습니다.

## 부차 문제 (5개 밖)

- **CLI 오류 처리**
  - `cli.mjs` 15행 `auth token`과 19행 `throw`는 try 밖에 있습니다. 그래서 오류가 사용자 메시지가 아니라 스택 트레이스로 출력됩니다.
  - `waiting_user`(인증 필요)·`paused`·`uncertain`도 종료 코드 0입니다. 1이 되는 것은 `failed`뿐입니다.
  - `--request`로 같은 명령을 재전송해도 `expected_revision`을 새로 읽어서 해시에 넣습니다. 그래서 정상적인 재전송이 409 `request_conflict`로 끝납니다.
  - `follow`는 0.5초 상태 polling으로 abort합니다. 이 때문에 마지막 이벤트를 읽기 전에 출력이 끊길 수 있습니다(추정).
- **queue 정리:** stop이나 failed 뒤에도 queue가 남습니다. 이후 resume한 턴이 done이 되면 예전 지시가 자동으로 전달됩니다. 계약상 의도인지 명시가 필요합니다.
- **화면 렌더링**
  - Claude가 한 턴에 text 블록을 여러 개 보내면 `assistant_message`가 bubble을 매번 덮어써서 앞부분이 사라집니다.
  - `/health`가 실패하면 `state.health.host`에서 TypeError가 납니다.
- **steer:** 실패해도 revision이 이미 올라간 상태로 남습니다. 계약 위반은 아니지만 클라이언트가 재시도할 때 혼란을 줍니다.

## 문제없음을 확인한 부분 (코드 읽기)

- **시작 중 stop:** `run.stopped`, `stopOnArrival`, `owns()` 덕분에 늦게 도착한 handle은 stop되고 활성화되지 않습니다. 늦은 callback도 무시됩니다.
- **Codex provider 고정:** thread 파라미터 `modelProvider:'openai'`와 `-c`로 provider를 고정합니다. 전역 MCP는 이름별 `enabled=false`로 끕니다. 전역 파일은 수정하지 않습니다. 승인 요청은 거부하고 `waiting_user`로 바꿉니다.
- **HTTP:** Bearer는 digest를 `timingSafeEqual`로 비교합니다. Host·Origin을 loopback으로 고정해 DNS rebinding과 CORS를 막습니다. URL에 담긴 토큰은 거부합니다. 본문은 64KiB로 제한합니다.
- **서버 SSE:** replay 전에 구독해서 놓치는 이벤트가 없고, seq로 중복을 제거합니다. Last-Event-ID도 지원합니다.
- **Store:** 재시작하면 running이 uncertain으로 바뀌고 자동 재실행은 없습니다. 생성은 원자적으로 중복을 막습니다.

## 실행한 검사와 미검증

- **실행:** `node --test test/*.test.mjs`(Node v24.15.0) → 41개 통과, 실패 0.
- **읽은 파일:** `plan.json`, `specs/contracts.md`, `README.md`, `src/**/*.mjs`, `ui/app.mjs`, 테스트 목록, evidence 로그.
- **미검증**
  - 실제 Claude·Codex 실행은 하지 않았습니다(다른 CLI 호출 금지).
  - 따라서 Claude가 user settings·hooks를 적용하는지, `--restricted` 플래그가 실제로 있는지, `codex app-server --stdio -c`가 받아들여지는지는 확인하지 못했습니다.
  - 사용자 `~/.claude`·`~/.codex` 설정은 작업 폴더 밖이라 읽지 않았습니다.
  - 브라우저 화면은 실행하지 않았습니다. 1번의 대화 섞임은 코드 경로를 분석한 결과입니다.
- **증거 평가**
  - 가짜 엔진, 가짜 child, 가짜 socket 테스트는 실제 브라우저나 실제 LLM 검증으로 인정하지 않았습니다.
  - 실제 왕복 증거는 Claude 1건(`evidence/live-cli-claude.log`)뿐입니다. Codex 실제 왕복 증거는 이 폴더에 없습니다.