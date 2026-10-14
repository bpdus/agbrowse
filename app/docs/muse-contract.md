# Muse 작업 계약

Muse는 작업 Mac을 명시합니다. Mac의 CLI 실행기가 판단합니다.
Muse는 모델 로그인 토큰을 보내지 않습니다. Muse는 MyBrowse 작업 API 토큰만 사용합니다.

```json
{"host":"imac","client_id":"muse","request_id":"각 요청의 고유 UUID","prompt":"작업 지시","engine":"codex","mode":"browser"}
```

접수: `POST /v1/sessions`. 응답: `{ "session": { "id": "실제 발급 ID", "status": "..." } }`.
조회: `GET /v1/sessions/:id`.
출력: `GET /v1/sessions/:id/events?after_seq=0` (SSE).
개입: `POST /v1/sessions/:id/commands`.
모든 API 요청에 `Authorization: Bearer <MyBrowse 토큰>`을 넣습니다.
토큰을 쿼리 문자열에 넣으면 안 됩니다.

```json
{"action":"queue","text":"다음 지시","expected_revision":1,"request_id":"명령의 고유 UUID"}
```

같은 접수 request_id를 재전송하면 같은 작업을 반환합니다.
같은 키로 본문을 바꾸면 409입니다. 명령도 같은 규칙을 적용합니다.
revision이 다르면 최신 작업을 조회한 뒤 사용자의 의도에 맞게 다시 명령합니다.
자동으로 오래된 명령을 새 revision에 적용하면 안 됩니다.

`queue`는 현재 턴 종료 이후에 전달합니다. 도구별 경계 개입을 보장하지 않습니다.
`steer`는 실행 중인 Codex 턴에만 지원합니다. Claude에서는 미지원입니다.
`stop`은 새 도구를 먼저 차단합니다. 이미 보낸 조작의 취소를 보장하지 않습니다.
`uncertain`은 결과를 확인하기 전 재실행할 수 없습니다.
출력 연결을 끊어도 작업은 계속됩니다. SSE 순번으로 재접속합니다.

현재 서버는 127.0.0.1에만 바인딩합니다.
Tailscale Serve의 HTTPS 연결과 Muse VM 왕복은 아직 설치·실검증하지 않았습니다.
CLI는 명시한 `https://*.ts.net` 주소를 허용합니다.
실제 원격 배포 전에는 두 Mac의 호스트 ID와 토큰을 각각 설정해야 합니다.
일반 외부 IP로 서버를 노출하지 않습니다.

현재 `mode=browser`는 `waiting_user`를 반환합니다.
독립 Chromium·지정 MCP가 연결되기 전에는 실제 브라우저 작업을 했다고 표시하지 않습니다.
`mode=chat`은 실제 CLI와 연결됩니다.
