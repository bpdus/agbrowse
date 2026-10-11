---
note_type: policy
content_mode: reference
title: bpdus agbrowse 라이선스 고지
status: draft
summary: 루트 MIT LICENSE의 고지 보존 의무, 포크 문서 저작권, README 불일치, 의존성 조사 범위를 기록한다.
created: 2026-10-11
updated: 2026-10-11
language: ko
render_target: github
project: bpdus/agbrowse
related_notes:
  - ./README.md
  - ./BASELINE.md
---

# bpdus agbrowse 라이선스 고지

이 문서는 기준 SHA `a5350886c23c91ce717b07fc27bc10d2b77d4454`의 실제 루트 [LICENSE](../../LICENSE)를 기준으로 고지 의무를 적는다. 루트 `LICENSE`와 루트 `README.md`는 수정하지 않는다.

Copyright (c) 2026 bpdus. 원 소프트웨어 저작권은 [루트 LICENSE](../../LICENSE)의 `Copyright (c) 2026 lidge-jun`을 따른다. 이 표시는 원 저작권을 대체하지 않는다.

## 루트 LICENSE

루트 파일은 MIT License다. 저작권 표시는 `Copyright (c) 2026 lidge-jun`이다. `package.json`의 `"license": "MIT"`와 같다.

MIT 조건에 따라, 소프트웨어와 관련 문서의 사본 또는 상당 부분을 배포할 때에는 원 저작권 고지와 허가 고지를 포함한다. 포크와 이후 배포물은 루트 `LICENSE` 파일을 보존한다.

허가 범위는 사용, 복사, 수정, 병합, 게시, 배포, 서브라이선스, 판매를 포함한다. 소프트웨어는 보증 없이 제공된다. 최종 판단은 선택한 배포물 전체를 기준으로 하며, 이 문서는 법률 자문이 아니다.

## 새 문서의 포크 저작권 표시

`docs/bpdus/`에 추가하는 문서에는 `Copyright (c) 2026 bpdus`와 루트 LICENSE 상대 링크를 둔다. 이 표시는 bpdus가 작성한 설계 문서에 대한 추가 고지다. `Copyright (c) 2026 lidge-jun`을 지우거나 대체하지 않는다.

원 코드와 원 문서를 포함한 배포에는 두 고지가 함께 남아야 한다. Aside 보고서의 코드, 문구, 자산은 복사하지 않았고, 설계 참고 경위만 계획 입력에 남긴다.

## README 불일치

루트 `README.md` 약 191행은 패키지 메타데이터는 MIT인데 이 저장소에는 독립 루트 `LICENSE` 파일이 없다고 적는다. 기준 SHA에는 루트 `LICENSE`가 있으므로 이 문장은 오래된 설명이다.

PR 0은 루트 README를 고치지 않는다. 불일치를 고치는 작업은 별도 문서로 남긴다.

## vendor·의존성 고지 조사 범위

다음 조사는 확인 필요이며 이 PR에서 완료하지 않았다.

1. 기준 SHA의 파일별 라이선스 예외, 제3자 고지, 헤더 저작권.
2. bpdus-kit `vendor/agbrowse` 미러(`a03de27a28900a45569ec6324d6fd8a7fcd10544`, npm `0.1.18`)와 이 포크 기준 SHA 사이의 라이선스 변경. 전체 diff·패치 비교도 같은 확인 항목이다.
3. npm 직접·간접 의존성의 LICENSE, NOTICE, SPDX.
4. `assets/`, 문서 이미지, 벤치마크 픽스처 등 포함 자산의 출처와 재배포 조건.
5. curl-impersonate, Camoufox, yt-dlp처럼 선택적 외부 바이너리의 고지. 게이트웨이는 해당 경로를 호출하지 않더라도, 저장소에 파일이 남아 있으면 배포 고지 범위를 별도로 정해야 한다.
6. 기존 Chrome을 실행기에서 사용하는 방식. 브라우저 바이너리를 재배포하는지는 별도 판단이다.

배포물에 MIT 고지를 빠뜨리지 않는 점검 목록은 위 조사가 끝난 뒤에 확정한다.
