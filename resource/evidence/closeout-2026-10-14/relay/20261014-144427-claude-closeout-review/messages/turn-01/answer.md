## 판정: PASS

검토 범위에서 병합을 막을 HIGH 결함은 찾지 못했습니다. 미완성 통합은 모두 막혀 있습니다. 브라우저 모드는 `waiting_user`, Pi는 미등록, `browserReady`는 `false`입니다. 핸드오프와 계약 문서도 이 상태를 정확히 적고 있습니다.

아무 파일도 수정하지 않았습니다. 테스트, 외부 요청, 계정이 필요한 서비스는 실행하지 않았습니다. 정적 검토와 PNG의 SHA-256 계산만 했습니다.

### 확인한 안전 기본값
- **HTTP**: 127.0.0.1에서만 받습니다(`src/http.mjs:141-156`). 토큰은 Bearer 헤더로 받아 길이와 무관한 시간에 비교합니다(`:167-172`). Host와 Origin을 검사하고(`:227-232`), URL에 실린 토큰은 거부합니다(`:234`). UI에는 CSP를 적용합니다.
- **IPC**: 0700 디렉터리 안에 0600 소켓을 만듭니다(`src/ipc.mjs:300-382`). 요청마다 토큰을 검사하고, 1 MiB 프레임 상한, 동시 연결 상한, 수신 제한 시간을 둡니다.
- **엔진**:
  - Codex는 읽기 전용 샌드박스로 실행하고 승인 요청은 모두 거부해 `waiting_user`로 보냅니다(`src/engines/codex.mjs:35-38, 62`). 전역 설정에 사용자 지정 openai 제공자가 있으면 실행하지 않습니다(`environment.mjs:16-19`).
  - Claude는 `--tools ''`, 빈 MCP 설정, 훅 비활성으로 실행합니다. `tool_use`가 나오면 대기 상태로 바꾸고 종료합니다(`claude.mjs:21-24, 41`).
  - 하위 프로세스 환경 변수는 허용 목록만 넘깁니다(`environment.mjs:5-9`).
- **세션**: 실행 중에 데몬이 죽으면 재시작 때 `uncertain`으로 바꾸고 다시 실행하지 않습니다(`store.mjs:127-140`). `uncertain`은 재개할 수 없습니다(`service.mjs:19`).
- **아이콘 도구**: 셸 없이 `spawnSync`로 인자 배열을 넘깁니다. 출력 폴더 재사용과 심볼릭 링크를 거부하고, 백업을 해시로 검증하며, 실패하면 되돌립니다. README 설명은 코드와 일치합니다(크기 16–1024 px, 백업, rollback). 원본 PNG는 1254×1254 RGBA이고 SHA-256은 `01b61c43…6614191`입니다.

### 병합 전 확인할 질문 1건
1. **`src/main.mjs:14`**: 데이터 폴더 기본값이 현재 작업 폴더 기준 `.mybrowse-data`입니다. 이 폴더에 `token`, `sessions.db`, `connection.json`이 생깁니다. `app/`에서 `npm start`를 실행하면 저장소 안에 만들어집니다. 작업 폴더 밖의 `.gitignore`는 읽을 수 없었으므로, `.mybrowse-data/`가 무시 목록에 있는지와 스테이징에 들어가지 않았는지 확인해 주세요. 무시 목록에 없다면 병합 전에 추가해야 합니다.

### 병합을 막지 않는 항목: 다음 작업에서 다룰 미완성 통합
2. **`native-webui.md:79` ↔ `src/main.mjs:14`**: 명세는 기본 Agent 폴더를 `~/Library/Application Support/MyBrowse/Agent/`로 정합니다. 데몬 기본값은 작업 폴더 기준 `.mybrowse-data`입니다. 명세는 draft이고 overlay도 적용하지 않았지만, FEAT-01에서 기본 경로를 통일해야 합니다.
3. **`muse-contract.md:33-34` ↔ `src/http.mjs:228`**: 서버는 Host 헤더가 `127.0.0.1:<port>` 또는 `localhost:<port>`일 때만 받습니다. Tailscale Serve가 원래의 `*.ts.net` Host를 그대로 넘기면 421로 거부됩니다. 이 경우 CLI가 ts.net 주소를 허용해도(`cli.mjs:22`) 원격 왕복은 실패합니다. 계약 문서가 "미검증"이라고 적고 있으므로 FEAT-03 확인 항목으로 남기면 됩니다.
4. **`src/cli.mjs:23`**: `MYBROWSE_ENDPOINT`를 원격 ts.net으로 지정하고 `MYBROWSE_TOKEN`을 비워 두면 로컬 데몬 토큰을 원격 호스트로 보냅니다. 원격 엔드포인트일 때는 `MYBROWSE_TOKEN`을 필수로 하는 편이 안전합니다. 정도는 낮습니다.
5. **`src/instance-lock.mjs:5-6`**: SIGKILL이나 전원 차단 뒤에는 lock 파일이 남아 수동으로 지워야 다시 시작할 수 있습니다. 오류 문구가 이를 안내하므로 개발 단계에서는 허용할 만합니다.

### 핸드오프 정확도
- **일치하는 항목**:
  - 서비스에 Codex와 Claude만 등록하고 Pi는 미등록입니다(`main.mjs:25` ↔ handoff:40).
  - `mode=browser`는 `waiting_user`를 반환합니다(`service.mjs:92-97`).
  - steer는 Codex만 지원합니다(`claude.mjs`의 handle에는 `steer`가 없어 409를 반환합니다).
  - stop은 새 도구 호출부터 차단합니다(`service.mjs:264`).
  - IPC op 6개가 명세와 같습니다(`ipc.mjs:16` ↔ native-webui:46).
  - 토큰 형식은 64자리 hex입니다(`main.mjs:20` ↔ native-webui:84).
  - 본문 상한은 64 KiB로, 1 MiB IPC 상한보다 작습니다.
  - 검사 수 102+20=122(1개 제외, 전체 123)가 `summary.json`과 일치합니다.
- **확인하지 못한 항목**: overlay 30개 파일, 패치 16개, C++ 클라이언트는 이번 입력에 포함되지 않았습니다(handoff:7, 18). 다음 세션 프롬프트가 `docs/handoff-2026-10-14.md`를 가리키므로(handoff:64), 이 문서가 실제로 그 경로에 커밋되는지 확인해 주세요.

정리하면 1번만 병합 전에 확인하면 됩니다. 2–5번은 이미 문서화된 미완성 통합이거나 정도가 낮은 개선 사항입니다.