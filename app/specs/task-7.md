# Spec: Task 7 — 스토어·Bitwarden과 두 Mac의 설치를 검증한다

입력 출처: /Users/jjbyun/SynologyDrive/bpbrowser/app/plan.json
작업 ID: 2026-10-13-mybrowse-architecture
작성일: 2026-10-13

## 수락 기준

실제 앱에서 스토어 설치·유지·업데이트·자동 입력과 두 Mac 실행을 확인한다. 원본 Chrome 설정을 보존한다. 사용자에게 실제 동작과 미지원 상태를 구분해 표시합니다.

## 인터페이스 계약

[공통 계약](contracts.md)의 해당 모듈 계약을 따릅니다. 대상 파일: docs/extension-compatibility.md, browser/build, daemon/onboarding.

## 경계 사례

공통 계약의 인증·재시작·호스트·취소 경계를 적용합니다. Chromium 관련 항목은 게이트 증거 없이 통과 처리하지 않습니다.

## 테스트 기준

방법: functional. 위험: high. 테스트 결정: omit.
실제 대상에서 기능을 확인해야 한다.
절차: 스펙의 수락 기준과 지정 명령을 실행하고 실제 증거를 기록한다.
통과 기준: 실행한 검사가 통과하고 미실행 항목은 완료로 표시하지 않는다.

## 통합 지점

선행 작업: 6. 대상: 스토어·Bitwarden과 두 Mac의 설치를 검증한다. 공통 계약의 수직 실행 경로에 연결합니다.

## 가정과 미해결 질문

MacBook의 Xcode 준비를 확인했습니다. iMac의 Xcode와 실제 브라우저·확장 검증은 남았습니다. 상세 경계는 공통 계약에 기록했습니다.
