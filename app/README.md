# MyBrowse 개발 소스

현재 구현은 로컬 AI 대화 데몬, CLI, 세션 제어와 화면 프리뷰입니다.
현재 Mac의 Xcode, 고정 Chromium 소스와 의존성을 확인했습니다. GN 생성 후 arm64 컴파일을 시작했습니다.
실제 앱 빌드와 실행은 아직 확인하지 않았습니다.
브라우저 작업, 스토어·Bitwarden, 지정 MCP, opencodex와 Muse 원격 왕복은 미완료입니다.

## 실행

Node.js 24.15 이상과 공식 Codex/Claude CLI 로그인이 필요합니다.
API 키를 자동 사용하지 않습니다. 별도 npm 의존성 설치는 필요하지 않습니다.

```sh
cd /절대/경로/mybrowse
npm test
npm run check
npm start
```

데몬은 `http://127.0.0.1:47371`에서 실행합니다.
데이터는 실행 폴더의 `.mybrowse-data/`에 저장합니다.
`MYBROWSE_DATA_DIR`, `MYBROWSE_HOST`, `MYBROWSE_PORT`로 개발 실행을 조정할 수 있습니다.
한 데이터 폴더에서는 데몬 하나만 실행해야 합니다.

화면 프리뷰 주소: `http://127.0.0.1:47371/ui/`.
화면의 연결 설정에서 아래 명령으로 확인한 토큰을 입력합니다.
토큰을 공유하거나 URL에 붙이지 마세요.

```sh
node src/cli.mjs auth token
node src/cli.mjs exec "짧게 인사해줘" --mode chat --engine claude
node src/cli.mjs session list
node src/cli.mjs session log <실제 ID>
node src/cli.mjs session stop <실제 ID>
node src/cli.mjs session queue <실제 ID> "다음 턴에서 할 일"
node src/cli.mjs session resume <실제 ID> "이어 할 일"
```

기본 `exec` 모드는 브라우저 작업입니다. 현재 연결되지 않아 대기 상태를 반환합니다.
Claude의 중간 지시는 미지원입니다. 예약 지시는 현재 턴이 끝난 뒤 전달합니다.
재시작 때 실행 중이던 작업은 uncertain입니다. 조작을 자동 반복하지 않습니다.

## 검증과 다음 통합

[계획](plan.json), [정확한 계약](specs/contracts.md), [Chromium 게이트](docs/chromium-gates.md),
[Muse API](docs/muse-contract.md), [화면 포팅 범위](docs/ui-port.md)를 참고하세요.
자동 검사에서 사용하는 가짜 엔진과 실제 LLM 확인은 별도 증거로 기록합니다.

pi-gui의 UI와 실행기 분리 방식을 참고했습니다.
현재 화면은 새 코드이며 pi-gui React 소스를 아직 포팅하지 않았습니다.
브라우저 커밋 후보와 지정 어댑터는 고정했지만 통합 완료를 의미하지 않습니다.
Chromium 통합 뒤 WebUI/Mojo 경계와 실제 스토어 설치를 반드시 다시 확인해야 합니다.

## Chromium 빌드 준비

[빌드 명세](browser/build-spec.md)에 고정 도구·경로·중단·재개 기준을 기록했습니다.
빌드 캐시는 `--work-root`로 제품 소스 폴더와 분리할 수 있습니다.
드라이버 검사는 아래 명령으로 실행합니다.

```sh
npm run test:browser-build
```

실제 Chromium 앱의 완료 여부는 [통합 게이트](docs/chromium-gates.md)와 빌드 증거를 함께 확인합니다.

개발 데이터 폴더에 오래된 `daemon.lock`이 있으면 시작을 막습니다.
자동 삭제하지 않습니다. 해당 PID가 실행 중인지 먼저 확인해야 합니다.
예약 지시는 중단·실패 뒤에도 유지됩니다. 이어하기를 완료하면 남은 예약 지시를 전달합니다.
명령을 같은 `--request`로 재전송하려면 처음 사용한 `--revision`도 지정합니다.
완료 외 상태는 CLI 종료 코드 1 또는 2입니다.
iMac의 현재 Node 22는 요구 버전보다 낮습니다. 최종 앱에는 Node 24 런타임을 묶어야 합니다.

## 현재 열어 둔 프리뷰

이번 작업의 시험 데몬은 `../../work/mybrowse-dev-data/`를 사용합니다.
아래 명령은 이 README가 있는 폴더에서 실행합니다.

```sh
MYBROWSE_DATA_DIR=../../work/mybrowse-dev-data node src/cli.mjs auth token
```

데몬은 개발용 프로세스입니다. LaunchAgent 설치나 앱 배포는 하지 않았습니다.
시험에 쓴 고정 토큰은 폐기하고 새 난수 토큰으로 바꿨습니다.

## 2026-10-14 네이티브 연결 준비

Xcode 27.0, SDK 27.0과 Metal Toolchain 준비를 확인했습니다.
고정 Chromium의 DEPS와 GN 생성이 완료됐고, arm64 기반 앱 빌드와 기본 실행 검사를 완료했습니다. 제품 overlay 적용은 남았습니다.

내부 화면용 Node Unix IPC와 macOS C++ 클라이언트를 구현했습니다.
현재 Mac의 실제 Codex IPC 왕복과 iMac의 x64 소켓 검사도 성공했습니다.
아직 이 코드를 Chromium WebUI에 연결하지 않았습니다.
[내부 화면 명세](specs/native-webui.md)와 [검토 결과](evidence/native-ipc-review-resolution.md)를 참고하세요.

## 다음 세션

현재 상태와 작업 순서는 [2026-10-14 인수인계](docs/handoff-2026-10-14.md)를 참고하세요.
현재 기본 경로에서 전체 npm test를 실행하기 전 CHORE-02의 IPC fixture를 수정해야 합니다.
새 아이콘의 재적용 도구는 browser/branding/apply-icon.mjs에 있습니다.
