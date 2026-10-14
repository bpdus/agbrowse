**PASS**

이전 필수 수정 4건은 코드에서 모두 확인했습니다. 실행을 막는 오류는 새로 찾지 못했습니다. 테스트는 직접 돌리지 않았고, 33개 통과는 보고하신 내용 그대로입니다.

- **dirty 검사:** `inspectSource`가 `git status`에 60초 제한을 둡니다(`build.mjs:449`). 결과가 `null`이면 `requireExistingSourceSafe`가 거부합니다(572행).
- **sync 재개:** `ownedIncomplete`는 같은 lock 커밋이고, `sourceCreatedByDriver===true`이며, 상태가 `running`, `interrupted`, `failed` 중 하나일 때만 참입니다(635행). 허용되는 경우는 `head===null`뿐입니다(576행). 비어 있지 않은 다른 HEAD는 계속 거부합니다.
  - 루트가 만든 clone은 `before.exists`가 참이고 이전 상태 기록이 없어서 `sourceCreatedByDriver`가 거짓입니다. 그래서 재개 대상이 되지 않습니다.
- **SIGHUP:** `sighup`이 자식 그룹에 SIGTERM을 보내고, `close`에서 SIGINT, SIGTERM과 함께 해제됩니다(314, 317, 324행).
- **`--clone-depot-tools`:** 소스에서 제거됐고, 테스트가 `unknown option`을 확인합니다(test 227행). `requireDepotTools`는 고정 SHA와 origin을 사전 조건으로 검사합니다(549-559행).

**남은 위험(차단은 아님)**
1. **`running` 상태에서 재개할 때 소유 여부:** 상태 파일이 `running`이면 `ownedIncomplete`가 참이 됩니다. 이 상태는 driver가 중단됐을 때도 남습니다. 그 사이에 사용자가 다른 `.git`을 `src`에 넣었더라도, HEAD가 없고 origin이 맞고 dirty가 아니면 통과합니다. 가능성은 낮고, origin과 dirty 검사가 막아 줍니다. 이번에는 수정하지 않아도 됩니다.
2. **중간에 끊긴 clone을 gclient가 이어받는지:** HEAD가 없는 `src`에서 `gclient sync --no-history --revision src@<SHA>`가 정상 재개되는지는 upstream 동작이라 **미검증**입니다. 실제 sync에서 확인해야 합니다.

**아직 검증되지 않은 것**
- 실제 Chromium sync와 hooks, `gn gen`, 빌드, 앱 실행, Store 검증은 실행 전입니다.
- 앞서 미검증으로 표시한 `use_system_xcode`, 산출물 이름 `Chromium.app`, `--no-history`와 SHA 조합도 그대로입니다.
- `UPDATE=0` 부트스트랩은 보고하신 종료 코드 0까지만 확인된 것으로 둡니다. 전체 sync 성공은 아직 아닙니다.