[cli-relay · ask · turn 01]

읽을 입력은 stage로 복사된 mybrowse-plan.json, mybrowse-plan-2026-10-13.md, types.ts, pi-addon-extensions.ts, constants.js입니다. 먼저 폴더 목록에서 정확한 복사 위치를 확인하세요. 파일을 수정하지 마세요. 다른 CLI나 하위 에이전트를 호출하지 마세요.

사용자는 독립 Chromium Mac 앱 안에 웹페이지와 AI 대화를 표시하고, 좌측에 북마크·대화·탭을 두는 제품을 요구합니다. Electron 앱을 완성 브라우저로 대신할 수 없습니다. Chrome Web Store에서 Bitwarden 설치가 필수입니다. 자율 루프는 Codex CLI 또는 Claude CLI이고 opencodex는 제공자 프록시입니다. pi-gui의 화면·설정·MCP 코드 차용을 허용했습니다. Muse는 고수준 작업 요청과 결과만 담당합니다. 두 Mac을 지원해야 합니다.

현재 구현 승인은 받았습니다. 아직 제품 소스는 없습니다. 로컬 Mac은 arm64, macOS 26.6.2, RAM 24 GiB, 여유 디스크 339 GiB, Node 24.15.0입니다. xcode-select는 CommandLineTools이고 /Applications/Xcode.app 및 Xcode-beta.app가 없습니다. Full Chromium 빌드는 환경 제약이 있습니다. 원격 Mac 상태는 미확인입니다.

독립적으로 계획의 치명적인 설계 누락과 검증 순서를 확인하세요. 특히 자체 Chromium NativeMessaging와 상류 Chrome/Edge 대상, WebUI 보안·React 이식, CLI 루프/인증 공유, 큐 의미와 취소 경계, 스토어 호환, 구현 가능한 독립 모듈을 구분하세요. 현재 근거 없이 빌드 성공이나 제공자 정책을 단정하지 마세요.

답변은 한국어로 최대 5개 핵심 항목을 쓰세요. 각 항목에 문제, 근거 파일/영역, 구체적 스펙 수정, 확인 방법을 제시하세요. 이어서 지금 구현 가능한 최소 완결 경로와 full Xcode 없이는 완료할 수 없는 경로를 분리해 설명하세요. 최종 판정은 READY / REVISE 중 하나입니다. 이 질문은 검토만 요청하며 쓰기는 금지합니다.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261013-234244-claude-mybrowse-plan-review/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261013-234244-claude-mybrowse-plan-review/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 이번 요청은 질문이다. 파일을 만들거나 수정하지 않는다. 답변은 최종 메시지로만 한다.
