# Spec: Task 3 — Pi 설정 공유와 공식 CLI를 연결한다

입력 출처: /Users/jjbyun/SynologyDrive/bpbrowser/app/plan.json
작업 ID: 2026-10-13-mybrowse-architecture
작성일: 2026-10-13

## 수락 기준

설치된 Pi의 JSONL RPC를 연결합니다. 같은 Mac의 제공자 설정과 인증은 Pi가 사용합니다. 자세한 계약은 [Pi 공유 런타임](pi-shared-runtime.md)을 따릅니다. 기존 Codex·Claude 경로를 유지합니다.

Codex app-server와 Claude stream-json에 연결한다. 인증은 공식 저장소를 읽고 API 환경 변수를 제거한다. 실제 세션 ID를 저장한다. 사용자에게 실제 동작과 미지원 상태를 구분해 표시합니다.

## 인터페이스 계약

[공통 계약](contracts.md)의 해당 모듈 계약을 따릅니다. 대상 파일: src/engines/codex.mjs, src/engines/claude.mjs, src/engines/environment.mjs, src/engines/pi.mjs, src/engines/pi-runtime.mjs, test/engines.test.mjs, test/pi-runtime.test.mjs.

## 경계 사례

공통 계약의 인증·재시작·호스트·취소 경계를 적용합니다. Chromium 관련 항목은 게이트 증거 없이 통과 처리하지 않습니다.

## 테스트 기준

방법: automated. 위험: high. 테스트 결정: add.
세션과 실행기 경계 회귀 검증이 필요하다.
절차: 스펙의 수락 기준과 지정 명령을 실행하고 실제 증거를 기록한다.
통과 기준: 실행한 검사가 통과하고 미실행 항목은 완료로 표시하지 않는다.

## 통합 지점

선행 작업: 2. 대상: Pi 설정 공유와 공식 CLI를 연결한다. 공통 계약의 수직 실행 경로에 연결합니다.

## 가정과 미해결 질문

MacBook의 Xcode 준비를 확인했습니다. iMac의 Xcode와 실제 브라우저·확장 검증은 남았습니다. 상세 경계는 공통 계약에 기록했습니다.
