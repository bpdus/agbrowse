[cli-relay · task · turn 01]

## Objective
Implement a small reproducible macOS icon packaging utility in apply-icon.mjs.
## Scope
Create only apply-icon.mjs and README.md in relay work. icon-source.png is read-only. Do not access or modify real app/source. Root will apply.
## Context
Node ESM builtins only. Mac has sips, iconutil, xcrun actool. PNG has alpha,1254x1254. Chromium copies chrome/app/theme/chromium/mac/app.icns and Assets.car verbatim into app Contents/Resources. CFBundleIconFile=app.icns,CFBundleIconName=AppIcon; both formats must be replaced. No need modify plist. Preserve supplied artwork/alpha. No models,image modification, installs, git, signing, profile edits or full rebuild.
## Deliverable
Utility usage: node apply-icon.mjs --output DIR [--chromium-src DIR] [--app APP_PATH]. Source PNG next to script. Generate iconset sizes16,32,64,128,256,512,1024 with sips,iconutil app.icns. Generate Assets.xcassets/AppIcon.appiconset for 16,32,128,256,512 1x/2x; compile xcrun actool --compile DIR --platform macosx --minimum-deployment-target 11.0 --app-icon AppIcon --output-partial-info-plist DIR/icon-info.plist DIR/Assets.xcassets. Include asset root Contents.json. Output should be fresh; fail if exists rather than deleting. Generate assets entirely before modifying target. Validate real source and app expected file paths exist, regular files, no symlinks; app suffix.app. Copy only app.icns,Assets.car into source branding dir and app Resources. Store prior target files in output backups plus manifest JSON hashes (source PNG, output artifacts,target before/after); do not delete. Make README concise usage and limitations. No giant abstraction or tests for trivial code; run node --check apply-icon.mjs. No external environment reads apart from executable tools. Use spawnSync argv (no shell). Throw for failed commands. Avoid overwrite target until all generate/validation steps succeed.
## Acceptance
Utility has strict unknown flags/path validation, native tools only, supplied PNG preserved, AppIcon asset naming matches plist. Backup first, rollback on a target copy failure. No unsigned app resign requirement: current app adhoc linker-signed no sealed resources. Root must verify native UI after applying.

---
규칙:
- 작업 폴더는 /Users/jjbyun/SynologyDrive/bpbrowser/work/cli-relay/20261014-142813-claude-browser-icon/work 이다. 이 폴더 밖의 파일을 읽거나 쓰지 않는다. 필요한 파일이 없으면 요청하는 질문으로 남긴다.
- 커밋, push, 설치, 배포를 하지 않는다.
- 다른 CLI(codex, claude, grok)나 하위 에이전트를 호출하지 않는다.
- /Users/jjbyun/SynologyDrive/bpbrowser/work/cli-relay/20261014-142813-claude-browser-icon/work/_relay/ 는 연계 파일 폴더다. 지시한 보고 파일 외에는 수정하지 않는다.
- 작업이 끝나면 아래 두 파일을 반드시 쓴다.
  1. /Users/jjbyun/SynologyDrive/bpbrowser/work/cli-relay/20261014-142813-claude-browser-icon/work/_relay/turn-01/result.json — 다음 JSON 형식만 사용한다:
     {"status": "DONE|PARTIAL|BLOCKED", "summary": "한두 문장", "changed_files": ["work 기준 상대경로"],
       "verification": [{"command": "실행한 확인 명령 또는 절차", "result": "결과"}], "questions": ["남은 질문"]}
     changed_files에는 _relay/ 아래 보고 파일을 넣지 않고, 만들거나 고치거나 지운 파일을 모두 넣는다.
  2. /Users/jjbyun/SynologyDrive/bpbrowser/work/cli-relay/20261014-142813-claude-browser-icon/work/_relay/turn-01/report.md — 무엇을 했는지, 확인한 방법, 남은 위험을 짧게 쓴다.
- 최종 메시지에는 result.json의 status와 summary만 쓴다.
