---
title: MyBrowse Pi RPC 실행기
summary: 검증한 Pi 런타임을 공통 실행기 계약에 연결합니다.
created: 2026-10-14
updated: 2026-10-14
note_type: spec
status: draft
language: ko
render_target: github
---
# MyBrowse Pi RPC 실행기

이 명세는 [Pi 공유 런타임](pi-shared-runtime.md)의 실행기 구현을 정합니다.
실행 캐시와 실제 제공자 검증은 별도 통합 조건입니다.
드라이버 파일만으로 Pi를 기본 엔진에 등록하지 않습니다.

## 생성과 공통 계약

`PiDriver({runtime, cwd, spawnProcess, timeout})`를 제공합니다.
runtime에는 `node`, `entry`, `version`, `agentDir`, `sessionDir`, `provider`, `model`이 있습니다.
node, entry, agentDir와 sessionDir는 검증한 절대 경로여야 합니다.
provider와 model은 명시한 값이어야 합니다.
다른 제공자나 Pi 기본 모델로 자동 전환하지 않습니다.
버전별 캐시와 실행 허용 검사는 호출자가 통합 전에 처리합니다.

`start(session, callbacks)`와 `stop()` 및 `steer(text)`는 기존 실행기 계약을 따릅니다.
드라이버는 자체 queue를 자동 소비하지 않습니다.
MyBrowse 서비스가 `agent_settled` 이후 예약 지시를 전달합니다.
브라우저 capability는 초기 구현에서 false입니다.

Pi는 JSONL을 사용합니다.
stdout은 LF 기준으로 나누고 UTF-8 문자가 청크 사이에서 잘려도 복원합니다.
한 레코드 상한은 2MiB입니다.
요청에는 고유 ID를 붙이고 응답의 `id`, `command`, `success`를 확인합니다.
유효하지 않은 응답, 종료와 시간 초과는 대기 요청을 끝냅니다.
진단용 stderr는 UI와 로그에 그대로 전달하지 않습니다.

## 시작과 결과

`node entry --mode rpc --session-dir ... --provider ... --model ...`을 실행합니다.
일반 도구, 자동 확장, 스킬, 프롬프트 템플릿과 테마를 비활성화합니다.
기존 Pi agentDir는 환경으로 지정합니다.
제공자 인증 값은 명령행 인수와 모델 프롬프트에 넣지 않습니다.
부모의 API 키·프록시·라우터 환경은 임의로 상속하지 않습니다.
Pi 인증은 명시한 agentDir를 통해 사용합니다.
저장된 실제 Pi 세션 ID가 있으면, `--session`으로 재개합니다.

`get_state`와 `get_available_models`로 명시한 모델의 준비 상태를 확인합니다.
준비 상태가 아니면, `pi_provider_unavailable`을 보고하고 모델 요청을 하지 않습니다.
`get_state`의 실제 sessionId만 `onId`로 전달합니다.
sessionId는 제어 문자나 경로 구분자를 포함하지 않아야 합니다.
실제 Pi가 반환한 ID와 일치하지 않으면 자동으로 새 세션을 만들지 않습니다.

이벤트 수신을 등록한 뒤 `prompt`를 보냅니다.
`message_update`의 `text_delta`는 `assistant_delta`로 변환합니다.
완료된 assistant 메시지는 `assistant_message`로 변환합니다.
`agent_end`만으로 완료를 선언하지 않습니다.
`agent_settled`를 받은 뒤 완료 또는 오류를 판정합니다.
프롬프트를 전송한 뒤 결과를 모르면 `uncertain`으로 보고합니다.
불확실한 변이 요청을 다시 보내지 않습니다.

## 종료와 개입

시작 중 AbortSignal이 발생하면, 모델 요청을 보내지 않습니다.
stop은 새 지시를 차단하고 `clear_queue`로 대기 지시를 제거합니다.
그다음 `abort`를 한 번 요청합니다.
이후 입력 EOF로 Pi를 종료하고 소유한 자식의 종료를 기다립니다.
필요하면 해당 자식만 SIGTERM과 SIGKILL로 종료합니다.
종료 요청은 멱등이어야 합니다.
완료 callback은 자식 정리가 끝난 뒤 한 번만 전달합니다.
종료 이후 늦은 이벤트는 무시합니다.
steer는 실행 중인 작업에만 보냅니다.
브라우저 도구는 아직 드라이버에 직접 연결하지 않습니다.

## 검증

가짜 Pi 프로세스는 실제 JSONL의 응답과 이벤트 구조를 사용합니다.
정상 메시지, `agent_end` 뒤 추가 이벤트와 `agent_settled`를 검사합니다.
잘린 UTF-8, 다중 레코드, 잘못된 응답과 크기 상한을 검사합니다.
모델 미준비, 시작 중 stop, 실제 sessionId와 재개를 검사합니다.
프롬프트 전송 후 응답 유실과 자식 종료를 검사합니다.
이 검사는 실제 계정·제공자·캐시·브라우저 왕복을 대신하지 않습니다.
