# Agent Notes

- 답변과 작업 요약은 한국어로 작성한다.
- Windows PowerShell 환경을 기준으로 명령을 작성하고, 한글이 포함된 파일은 UTF-8로 읽고 쓴다.
- 구현 전에 [docs/AGENT_CONTEXT.md](docs/AGENT_CONTEXT.md)를 먼저 확인한다. 이 문서에는 확장 프로그램 구조, 주요 기능 로직, 최근 버그와 수정 내역이 정리되어 있다.
- 변경 후 기본 검증은 `npm run verify:extension`이다.
- `chzzk-saver-extension.zip`이 필요한 작업이면 `dist-extension` 빌드 산출물을 기준으로 다시 압축한다.
- push는 사용자가 명시적으로 요청할 때만 한다.
