---
title: MyBrowse 내부 화면과 에이전트 IPC 계약
summary: Chromium 브라우저 프로세스와 로컬 에이전트 데몬의 연결 경계를 정합니다.
created: 2026-10-14
updated: 2026-10-14
note_type: spec
status: draft
language: ko
render_target: github
---
# MyBrowse 내부 화면과 에이전트 IPC 계약

입력은 `plan.json`의 작업 5와 작업 6입니다.
이 명세는 내부 대화와 세션 관리를 먼저 연결합니다.
실제 브라우저 MCP 연결 전에는 `browserReady=false`를 유지합니다.

## 연결 구조

`chrome://mybrowse`는 Mojo로 브라우저 프로세스에 요청합니다.
브라우저 프로세스는 Unix 소켓으로 Node 데몬에 요청합니다.
외부 사이트는 일반 Chromium WebContents에서 열립니다.
외부 사이트에는 Mojo 인터페이스를 등록하지 않습니다.
화면에는 데몬 토큰이나 소켓 경로를 전달하지 않습니다.

기존 localhost HTTP API는 CLI와 개발 화면에서 유지합니다.
내부 화면은 HTTP 프록시나 토큰 입력에 의존하지 않습니다.
두 연결은 같은 SessionService를 사용합니다.
HTTP 연결이나 소켓 연결이 끊겨도 실행 중인 에이전트는 유지합니다.

## 소켓과 인증

데몬은 `/private/tmp/mybrowse-<uid>-<난수>/daemon.sock`을 생성합니다.
데몬은 새 디렉터리를 생성하며, 기존 디렉터리를 회수하지 않습니다.
디렉터리 권한은 0700이고 소켓 권한은 0600입니다.
macOS의 Unix 소켓 경로는 UTF-8 기준 103바이트 이하로 제한합니다.
데몬은 소켓과 디렉터리가 준비된 뒤 연결 정보를 공개합니다.
종료 시 데몬은 private 디렉터리를 임시 이름으로 이동합니다.
이 이동은 Node의 자동 경로 삭제가 대체 파일을 지우지 않도록 막습니다.
데몬은 같은 inode의 소켓과 빈 디렉터리만 제거합니다.
다른 파일이 있으면 데몬은 디렉터리와 파일을 보존합니다.
원래 이름이 사용 중이면 데몬은 임시 이름을 유지합니다.
디렉터리 신원을 확인하지 못하면 데몬은 정리를 거부합니다.

Agent 데이터 폴더의 `connection.json`은 0600으로 저장합니다.
데몬은 정상 종료 시 자신이 저장한 connection.json만 제거합니다.
다른 파일로 바뀌었거나 내용이 바뀌면 보존합니다.
기존 endpoint와 host에 `ipc: {version: 1, socket_path: string}`을 추가합니다.
인증 토큰은 기존 0600 `token` 파일에만 저장합니다.
로그, URL, 모델 입력, renderer에는 토큰을 넣지 않습니다.

브라우저 프로세스는 파일 소유자와 권한을 검사합니다.
브라우저 프로세스는 심볼릭 링크를 거부합니다.
브라우저 프로세스는 `getpeereid`로 데몬의 UID를 검사합니다.
Node는 비공개 소켓 권한과 요청 토큰으로 접근을 제한합니다.
Node의 기본 net API가 peer UID를 검증한다고 주장하지 않습니다.
토큰 비교는 고정 길이 해시와 timingSafeEqual을 사용합니다.

## 프레임과 요청

한 연결은 한 요청과 한 응답만 처리합니다.
프레임은 4바이트 big-endian 길이와 UTF-8 JSON 본문으로 구성합니다.
본문의 상한은 요청과 응답 모두 1MiB입니다.
길이 0, 잘못된 UTF-8, JSON 오류, 추가 프레임은 거부합니다.
클라이언트는 요청을 쓴 뒤 쓰기 방향을 종료합니다.
서버는 쓰기 방향의 종료를 확인한 뒤 요청을 실행합니다.
추가 프레임이 있으면 첫 요청도 실행하지 않습니다.
요청 수신 시간은 15초로 제한합니다.
연결별 버퍼는 1MiB와 헤더 길이로 제한합니다.
동시 연결은 32개로 제한합니다.
상한을 넘은 연결은 응답 없이 즉시 닫습니다.

요청 형식은 다음과 같습니다.

```json
{"version":1,"id":"요청 식별자","token":"비공개 인증 값","op":"health","payload":{}}
```

id는 1~128자의 영문, 숫자, 밑줄, 하이픈 문자열입니다.
op는 아래 여섯 값만 허용합니다.
쉘 코드, JavaScript 실행, 임의 파일 경로를 받지 않습니다.

| op | payload | 응답 data |
| --- | --- | --- |
| health | 빈 객체 | host, capabilities |
| list | 선택 before_rowid, limit | sessions 요약, next_before_rowid, has_more |
| get | id | session |
| create | 기존 생성 본문 | session |
| command | id, 기존 명령 본문 | session |
| events | id, after_seq, 선택 limit | events, next_seq, has_more |

create와 command는 기존 host 일치 검사를 유지합니다.
command는 request_id와 expected_revision 검사를 유지합니다.
지원하지 않는 필드는 거부합니다.
각 op는 필수 필드와 자료형을 검사합니다.
서버 내부 오류는 일반 internal_error로 반환합니다.
응답에는 토큰, 스택, 로컬 파일 경로를 넣지 않습니다.

성공 응답은 `{version:1,id,ok:true,data}`입니다.
실패 응답은 `{version:1,id,ok:false,error:{status,code,message}}`입니다.
응답이 1MiB를 넘으면 response_too_large 오류를 반환합니다.
완료 여부가 불명확하면 클라이언트는 변경 요청을 자동 재실행하지 않습니다.
사용자가 재요청하면 기존 중복 방지 키를 유지합니다.

## 목록 페이지

list는 전체 대화 내용이나 결과를 전송하지 않습니다.
list는 id, host, title, engine, mode, status, revision과 생성·수정 시각만 반환합니다.
title은 최초 지시의 앞 240자로 제한합니다.
원문은 get 요청으로 읽습니다.
기본 limit은 100이며 범위는 1~200입니다.
before_rowid는 선택한 양의 안전한 정수입니다.
Store는 호스트를 제한하고 rowid 내림차순으로 SQL LIMIT을 적용합니다.
next_before_rowid는 마지막 반환 행 번호이며, 빈 목록에서는 null입니다.
has_more가 true이면 클라이언트는 해당 cursor로 다음 페이지를 읽습니다.
이 페이지는 생성 순서를 유지하며, 세션 갱신으로 순서가 바뀌지 않습니다.
기존 HTTP list 계약은 유지합니다.

## 이벤트 페이지

IPC events의 기본 limit은 100이며 범위는 1~200입니다.
after_seq는 0 이상의 안전한 정수입니다.
Store는 SQL LIMIT으로 필요한 이벤트만 읽습니다.
HTTP SSE의 기존 전체 재생 계약은 바꾸지 않습니다.
SessionService.events의 선택 limit은 IPC에서만 사용합니다.

페이지는 순번을 유지하고 누락 없이 반환합니다.
응답 상한에 맞는 이벤트까지만 포함합니다.
has_more는 남은 이벤트가 있으면 true입니다.
next_seq는 마지막 반환 순번이며, 빈 페이지에서는 after_seq입니다.
첫 이벤트 하나가 상한을 넘으면 event_too_large 오류를 반환합니다.
큰 이벤트를 조용히 건너뛰지 않습니다.

## 네이티브 화면 계약

Mojo에는 허용된 동작을 나타내는 enum을 사용합니다.
브라우저 프로세스는 IO 작업을 ThreadPool에서 처리합니다.
UI 스레드에서 파일 읽기나 소켓 대기를 하지 않습니다.
각 요청은 제한된 대기 시간과 ScopedFD를 사용합니다.
WebUI가 사라지면 결과 callback을 폐기합니다.
실행 중인 에이전트는 WebUI 수명과 분리합니다.

탭 목록과 탐색은 별도 네이티브 인터페이스로 제공합니다.
해당 창과 프로필에서만 탭을 선택하고 닫습니다.
브라우저 창을 찾지 못하면 다른 창으로 대체하지 않습니다.
외부 URL은 http/https로 제한합니다.
이 제한은 에이전트의 탭 생성 인터페이스에만 적용합니다.
주소창의 일반 Chromium 탐색 정책은 그대로 유지합니다.

## 수락 기준과 검증

먼저 실제 Unix 소켓에서 인증, 프레임 분할, 중복 요청과 이벤트 재생을 검사합니다.
큰 본문, 잘못된 UTF-8, 추가 프레임과 종료 정리도 검사합니다.
잘못된 요청은 SessionService의 변경 메서드를 호출하지 않아야 합니다.
유효한 browser 요청도 MCP 연결 전에는 waiting_user를 반환해야 합니다.

이후 실제 Chromium에서 Mojo 왕복과 창별 탭 제어를 확인합니다.
C++ 코드를 작성했다는 이유로 앱 실행 검증을 통과하지 않습니다.
Bitwarden과 Codex 확장 호환 검사는 별도 게이트로 유지합니다.
