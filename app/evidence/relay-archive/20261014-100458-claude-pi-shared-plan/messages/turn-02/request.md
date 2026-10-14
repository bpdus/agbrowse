[cli-relay · ask · turn 02]

독립 계획 재검토입니다. 파일을 읽기만 합니다. 편집, 다른 CLI 호출, 실제 모델 요청과 인증 파일 읽기는 금지합니다.

이전 네 지적을 반영했습니다. Pi 자신의 auth/settings 쓰기와 MyBrowse 직접 쓰기를 구분했습니다. 공유 파일의 Pi 잠금을 공개 소스에서 확인했으며 동시 실행 검사는 수락 기준에 남겼습니다. 버전별 코드 캐시는 진행 중 패키지 교체의 영향을 막고, 기존 Pi 제공자 설정은 캐시에 복사하지 않습니다. --session-dir과 세션 재개 호환을 명시했습니다.

시작 RPC와 모델 실행 허용을 구분했습니다. 실제 0.87.1을 PI_OFFLINE=1, 별도 임시 HOME/agent directory, no tools/extensions/skills/templates/themes에서 실행했습니다. get_state/get_commands/get_available_models 세 명령과 입력 EOF 후 exit0을 확인했습니다. 실제 인증과 모델 요청은 하지 않았습니다. startup_verified_versions=[0.87.1], execution_allowed_versions=[]입니다. 응답과 결과는 pi-rpc-probe.json에 있습니다. get_available_models의 구현은 snapshot 반환이며, 프로세스 시작 전체의 무부작용은 가정하지 않습니다. 그래서 시작 검사를 별도 dir에서 합니다.

현재 구현 엔진과 계획 선호 엔진을 분리했습니다. Pi 및 waiting_provider는 아직 계획이며 현 코드에 구현했다고 쓰지 않습니다. 새로 staged rpc-commands.md와 공개 소스는 설치 패키지의 사본입니다.

판정 PASS/REVISE, 남은 중요 사항 최대 세 개와 검사 범위를 짧게 보고하세요. 계획 READY는 구현 완료가 아닙니다.

---
규칙:
- 작업 폴더는 /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-100458-claude-pi-shared-plan/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/Documents/Codex/2026-10-13/https-github-com-morluto-rea-https/work/cli-relay/20261014-100458-claude-pi-shared-plan/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 이번 요청은 질문이다. 파일을 만들거나 수정하지 않는다. 답변은 최종 메시지로만 한다.
