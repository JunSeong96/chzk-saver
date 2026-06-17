# 치직 세이버

치지직 다시보기와 클립을 브라우저에서 직접 MP4로 저장하는 Chromium 계열 Manifest V3 확장 프로그램입니다.

서버를 거치지 않고 현재 브라우저의 치지직 로그인 세션으로 API/CDN에 접근합니다. DRM 또는 암호화된 HLS는 지원하지 않습니다.

이 레포는 네이버 또는 치지직과 관계없는 비공식 오픈소스 프로젝트입니다.

## 요구 사항

- Node.js 20+
- Naver Whale 또는 Chrome 계열 브라우저

## 설치와 빌드

```powershell
npm install
npm run verify:extension
```

브라우저에 로드할 폴더:

```text
C:\Users\lian\Documents\chzzk_donwloader\dist-extension
```

Whale은 `whale://extensions`, Chrome은 `chrome://extensions`에서 개발자 모드를 켠 뒤 `압축해제된 확장 프로그램 로드`로 위 폴더를 선택합니다.

## 개발 명령

```powershell
npm run typecheck:extension
npm run build:extension
npm run validate:extension
```

Whale 자동 검증:

```powershell
npm run smoke:extension:whale
npm run smoke:extension:whale -- --metadata-url https://chzzk.naver.com/video/13734087
npm run smoke:extension:whale -- --metadata-url https://chzzk.naver.com/video/13734087 --playback-check
npm run smoke:extension:whale -- --metadata-url https://chzzk.naver.com/video/13734087 --download-check
npm run smoke:extension:whale -- --metadata-url https://chzzk.naver.com/video/13659163 --metadata-url https://chzzk.naver.com/video/13741031 --metadata-url https://chzzk.naver.com/video/13734087 --metadata-url https://chzzk.naver.com/video/13688683 --performance-check --download-duration 20 --download-quality-height 1080
```

## 구조

```text
.
├─ manifest.json
├─ popup.html
├─ downloader.html
├─ offscreen.html
├─ rules.json
├─ src/
│  ├─ background.ts
│  ├─ popup.ts
│  ├─ downloader.ts
│  ├─ offscreen.ts
│  ├─ types.ts
│  └─ styles/
│     ├─ popup.css
│     └─ downloader.css
├─ public/
│  ├─ assets/
│  │  ├─ icon16.png
│  │  ├─ icon32.png
│  │  ├─ icon48.png
│  │  ├─ icon128.png
│  │  └─ logo.png
│  └─ vendor/
│     ├─ hls.min.js
│     └─ mux-mp4.min.js
├─ scripts/
│  ├─ validate-extension-build.mjs
│  └─ smoke-extension-whale.mjs
├─ package.json
├─ package-lock.json
├─ tsconfig.extension.json
└─ vite.extension.config.ts
```

`dist-extension/`은 빌드 산출물이므로 Git에는 올리지 않습니다.

## Git에 올릴 파일

- 루트의 확장 엔트리 파일: `manifest.json`, `popup.html`, `downloader.html`, `offscreen.html`, `rules.json`
- TypeScript/CSS 소스: `src/`
- 정적 파일: `public/`
- 검증 스크립트: `scripts/`
- 프로젝트 설정: `package.json`, `package-lock.json`, `tsconfig.extension.json`, `vite.extension.config.ts`, `.gitignore`, `README.md`

## Git에 올리지 않을 파일

- `node_modules/`
- `dist-extension/`
- 로그 파일
- 다운로드 결과물
