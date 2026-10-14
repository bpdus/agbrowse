# turn-03 보고

- pi.mjs: 제공자 미준비 분기가 shutdown을 먼저 기다린 뒤, 성공이고 취소가 아닐 때만 onWaiting을 호출합니다. 정리 실패는 onEnd failed(pi_cleanup_failed)로 보고하며 onWaiting과 prompt는 없습니다. finished는 EOF 전에 이미 설정되어 close 이벤트의 중복 완료가 없습니다.
- 테스트: close 성공이면 waiting만, close 실패이면 failed 완료만 호출하고 이후 stop은 reject하는 검사를 추가했습니다.
- 확인: node --test 두 파일 48/48 통과.
- 남은 위험: 실제 Node의 close 타이밍은 가짜 프로세스로만 검사했습니다.
