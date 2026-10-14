**REVISE**

수정은 하지 않았고 테스트도 실행하지 않았습니다. 아래는 코드를 읽고 얻은 결과입니다.

1. **dirty 검사가 시간 초과 때 통과로 처리됨** (`build.mjs:inspectSource` 451-454, `defaultRunner` 321)
   - 모든 probe에 15초 타임아웃이 걸려 있습니다. Chromium `git status --porcelain`이 15초를 넘기면 SIGTERM으로 끝나고 `st.ok=false`가 됩니다.
   - 그 결과 `info.dirty=null`이 되고, `requireExistingSourceSafe`의 `if (src.dirty)`는 null을 통과시킵니다. 수정된 소스에서도 sync가 진행될 수 있습니다.
   - 수정안은 `checkDirty` 호출에 한해 타임아웃을 10분 정도로 늘리고, `dirty===null`이면 `fail(EXIT.PRECONDITION, 'cannot determine dirty state')`로 막는 것입니다. 이 검사에는 `ctx.run`에 timeout 옵션을 추가해야 합니다.

2. **중단된 sync를 재개할 수 없음** (`build.mjs:stepSync` 644-648, `requireExistingSourceSafe` 578)
   - 재개 로직(`resumed`)이 있지만, 그 앞의 `requireExistingSourceSafe`가 `headMatches`를 요구합니다.
   - 첫 sync가 중간에 끊기면 `src/.git`은 있는데 HEAD가 없거나 lock과 다를 수 있습니다. 이때 "Rerun sync to resume" 메시지와 달리 PRECONDITION으로 막힙니다. 수동 개입이 필요해집니다.
   - 테스트 `interrupted or failed sync…`는 중단 뒤 `src`가 없는 경우만 만들기 때문에 이 경로를 잡지 못합니다.
   - 수정안은 `state.sync.status`가 `running`, `interrupted`, `failed` 중 하나이고 origin이 일치하면 HEAD 불일치를 허용하는 것입니다. 이때 dirty 검사는 유지합니다. 그리고 "src가 있지만 HEAD가 미완료인 재개" 테스트를 추가합니다.
   - gclient가 이런 상태에서 정말 재개하는지는 upstream 동작이라 **미검증**입니다.

3. **SIGHUP을 처리하지 않음** (`defaultRunner` 298, 319-320)
   - 자식은 `detached:true`로 별도 프로세스 그룹에서 실행됩니다. SIGINT와 SIGTERM만 전달하므로, 터미널을 닫아 SIGHUP이 오면 node만 죽습니다.
   - 장시간 `gclient`나 `autoninja`는 고아로 계속 돌고, `finally`가 실행되지 않아 `.build-driver.lock`과 state `running`이 남습니다.
   - 수정안은 `SIGHUP`도 `interrupt('SIGTERM')`로 연결하고 `process.off`로 해제하는 것입니다.
   - `defaultRunner`의 신호 전달은 테스트가 전혀 없습니다. 가짜 자식이나 `sleep`으로 한 건만 검증하길 권합니다.

4. **`prepare --clone-depot-tools`가 어느 경로로도 성공하지 못함** (`stepPrepare` 606-614, `requireDepotTools` 560)
   - 실제 실행: clone은 최신 tip을 받습니다. `checkout`은 `FORBIDDEN_TOKENS`에 있어서 lock 커밋으로 맞출 수 없고, 직후 `requireDepotTools`가 HEAD 불일치로 실패합니다. 미고정 clone만 남습니다.
   - `--dry-run`: `depotToolsMissing`를 다시 호출하므로, depot_tools가 없으면 항상 TOOL_MISSING으로 끝납니다. 테스트 `missing depot_tools…`는 가짜 clone이 lock 커밋을 돌려주도록 만들어서 이 문제를 가립니다.
   - 이미 depot_tools를 고정해 두셨다면 이번 빌드에는 영향이 없습니다. 수정안은 이 플래그를 제거하거나 "수동 clone 후 SHA 확인" 안내로 바꾸는 것입니다.

5. **`DEPOT_TOOLS_UPDATE=0`일 때 첫 gclient 부트스트랩** (`childEnv` 288) — **미검증**
   - 처음 clone한 depot_tools에서 업데이트를 끄면, cipd 클라이언트나 번들 python이 설치되지 않을 수 있습니다. 이때 gclient가 시스템 `python3`로 대체되거나 실패할 수 있습니다.
   - 저는 upstream 동작을 확인하지 못했습니다. 실제 sync 전에 사용자 쪽에서 `DEPOT_TOOLS_UPDATE=0 depot_tools/gclient --version` 같은 읽기 전용 호출로 확인하길 권합니다. 이는 코드 수정이 아니라 사전 점검입니다.

**미검증 upstream 동작**
- `--no-history`와 `--revision src@<SHA>`의 조합이 고정 커밋을 shallow로 가져오는지
- `managed:False`일 때 `--revision`이 src를 이동시키는지
- `use_system_xcode` 인자가 해당 커밋에 존재하는지
- 타깃 `chrome`의 산출물이 `Chromium.app`인지

**환경 확인**
- Xcode 27.0과 SDK 27.0은 `compareVersions`로 26.5 이상이라 통과합니다.
- arm64에서는 Rosetta 검사가 통과하고, APFS와 323GiB도 임계값(120GiB)을 넘습니다.
- 경로 문자 검사(`SAFE_PATH`)는 현재 work 경로에서 문제가 없습니다.