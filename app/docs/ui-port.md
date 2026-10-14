# 화면 구현과 pi-gui 차용 범위

현재 화면은 좌측 북마크·대화·탭과 중앙 입력·최근 작업을 제공합니다.
세션 목록과 대화 결과는 실제 데몬 API에서 읽습니다.
웹 탭과 MCP 설정은 아직 연결되지 않았습니다.
현재 화면은 일반 브라우저에서 확인하는 프리뷰입니다. 독립 Chromium 앱의 WebUI는 아닙니다.

pi-gui의 대화 목록, 입력, SessionDriver 분리 구조를 참고했습니다.
현재 구현은 새 vanilla JavaScript 코드입니다. 상류 React 코드를 이식했다고 주장하지 않습니다.
상류 Electron/Pi 런타임을 가져오면 공식 CLI와 별도 인증·판단 루프가 생깁니다.
최종 포팅은 최소 MyBrowseBridge에 필요한 대화 화면만 가져오는 방식입니다.
fork/tree/compact와 Git 프로젝트 화면은 가져오지 않습니다.

모델 출력과 페이지 제목은 textContent로 표시합니다.
프리뷰는 같은 origin의 REST 브리지를 사용합니다. 토큰은 메모리에만 둡니다.
최종 WebUI는 브라우저 프로세스가 Mojo와 로컬 IPC를 소유해야 합니다.
외부 사이트는 WebContents에 표시합니다. iframe으로 웹사이트를 흉내 내지 않습니다.

출처: [pi-gui 고정 소스](https://github.com/minghinmatthewlam/pi-gui/tree/572c0c6de8ffd3a245c224b912bb8752ca200780).
