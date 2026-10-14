# Spec: Task 6 — 자체 Chromium과 지정 MCP를 연결한다

입력 출처: /Users/jjbyun/SynologyDrive/bpbrowser/app/plan.json
작업 ID: 2026-10-13-mybrowse-architecture
작성일: 2026-10-13

## 수락 기준

고정 Chromium을 빌드한 뒤 WebContents와 WebUI·Mojo를 통합한다. 별도 Native Messaging 경로와 소켓을 실검증한다. Xcode 미충족 시 구현 완료로 표시하지 않는다. 사용자에게 실제 동작과 미지원 상태를 구분해 표시합니다.

## 빌드 단계 계약

1. `prepare`는 고정 커밋과 작업 경로를 검증하고 동기화 설정을 준비합니다. 기존 소스가 다르면 자동 초기화하지 않습니다.
2. `sync`는 고정 커밋의 DEPS를 내려받습니다. 중단된 다운로드는 같은 작업 폴더에서 재개합니다.
3. `gen`은 arm64 또는 x64 개발 빌드 설정을 만듭니다. 소스의 커밋과 Xcode·SDK·Metal Toolchain·가용 공간을 검사합니다.
4. `build`는 `chrome` 타깃을 제한된 병렬 작업 수로 빌드합니다. 종료 코드와 로그를 그대로 기록합니다.
5. `status`는 체크아웃, 의존성, 생성과 빌드 상태를 구분합니다. 앱 파일 존재만으로 실행 검증을 통과하지 않습니다.

소스·의존성·컴파일 캐시는 `work/chromium/`에 둡니다.
고정한 depot_tools는 `work/depot_tools/`에 둡니다.
셸 프로필과 원본 Chrome 프로필은 수정하지 않습니다.
초기 컴포넌트 빌드는 개발용입니다. 배포용 앱은 별도 비컴포넌트 빌드로 검사합니다.

## 앱 통합 단계 계약

먼저 수정하지 않은 Chromium을 전용 프로필로 실행합니다.
일반 웹사이트를 앱의 WebContents에서 열고, 스토어에서 Bitwarden을 설치합니다.
설치 후 앱을 다시 실행하여 확장 유지 여부를 확인합니다.
이 검사를 통과한 뒤 브랜딩과 내부 화면을 통합합니다.

`chrome://mybrowse`만 에이전트용 Mojo 인터페이스를 가집니다.
브라우저 프로세스가 데몬 연결과 인증 값을 소유합니다.
외부 웹페이지와 화면의 텍스트에는 인증 값을 전달하지 않습니다.
탭 열기·선택·닫기는 실제 TabStripModel을 사용합니다.
사용자가 연 웹사이트는 일반 Chromium 탐색 정책을 따릅니다.

MyBrowse Native Messaging manifest와 소켓은 자체 데이터 폴더를 사용합니다.
Chrome MCP는 현재 호스트·프로필 신원을 확인한 후 조작합니다.
Google Chrome의 기존 manifest를 덮어쓰지 않습니다.
MCP 조작은 세션 제어권과 중단 차단 검사를 거칩니다.
Computer MCP는 브라우저 MCP와 별도 프로세스로 연결합니다.

## 통과 증거

arm64 앱에서 웹페이지·확장·자율 작업·중단·재개의 실제 결과를 기록합니다.
x64 앱은 iMac에서도 같은 경로를 확인합니다.
교차 컴파일 성공은 iMac 실행 검사로 대신할 수 없습니다.
서명·공증·업데이트 검사는 개발 빌드와 별도 항목으로 기록합니다.

## 인터페이스 계약

[공통 계약](contracts.md)의 해당 모듈 계약을 따릅니다. 대상 파일: browser/chromium.lock.json, browser/patches, adapters/chrome, adapters/computer.

## 경계 사례

공통 계약의 인증·재시작·호스트·취소 경계를 적용합니다. Chromium 관련 항목은 게이트 증거 없이 통과 처리하지 않습니다.

## 테스트 기준

방법: automated. 위험: high. 테스트 결정: add.
빌드 드라이버의 경로·도구 고정·취소·실패 분기를 자동 검사합니다.
앱과 확장 호환은 실제 대상에서 확인합니다.
절차: 스펙의 수락 기준과 지정 명령을 실행하고 실제 증거를 기록한다.
통과 기준: 실행한 검사가 통과하고 미실행 항목은 완료로 표시하지 않는다.

## 통합 지점

선행 작업: 1. 대상: 자체 Chromium과 지정 MCP를 연결한다. 공통 계약의 수직 실행 경로에 연결합니다.

## 가정과 미해결 질문

MacBook의 Xcode 준비를 확인했습니다. MacBook에서 x64 교차 빌드를 만듭니다. 두 Mac의 실제 브라우저·확장 검증은 남았습니다. 상세 경계는 공통 계약에 기록했습니다.

내부 대화 transport는 [WebUI IPC 계약](webui-ipc.md)을 따릅니다.
네이티브 소켓 클라이언트는 [C++ 전송 계약](native-ipc-client.md)을 따릅니다.
