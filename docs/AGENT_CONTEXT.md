# 치직 세이버 Agent Context

이 문서는 후속 agent가 프로젝트의 기능, 구현 방식, 상태 관리 로직, 과거 버그와 수정 이유를 빠르게 파악하기 위한 내부 참고 문서다. 사용자용 README가 아니라 유지보수용 맥락 문서이므로, 구현 세부와 주의점을 함께 기록한다.

## 프로젝트 개요

치직 세이버는 치지직 다시보기와 클립을 Chromium 계열 브라우저에서 직접 MP4로 저장하는 Manifest V3 확장 프로그램이다.

- 서버를 거치지 않고 사용자의 브라우저 세션과 쿠키로 치지직/Naver API 및 CDN에 접근한다.
- 주요 UI는 `downloader.html` + `src/downloader.ts`이다.
- 백그라운드 서비스 워커는 `src/background.ts`, 실제 다운로드 작업은 offscreen document인 `src/offscreen.ts`에서 처리한다.
- 콘텐츠 스크립트는 치지직 페이지의 플레이어 제어와 품질 제어를 보조한다.
- 빌드는 Vite + `@crxjs/vite-plugin`으로 수행하며 산출물은 `dist-extension/`에 생성된다.
- 배포용 zip은 Git 추적 대상이 아니며, 필요할 때 `dist-extension` 내용을 `chzzk-saver-extension.zip`으로 다시 압축한다.

기본 검증:

```powershell
npm run verify:extension
```

## 주요 파일

- `manifest.json`: MV3 권한, host permissions, content scripts, background service worker 정의.
- `rules.json`: `api.chzzk.naver.com` 요청의 `origin` 헤더 제거 규칙. 확장 context에서 API 요청이 막히는 경우를 줄이기 위한 DNR 규칙이다.
- `popup.html`, `src/popup.ts`: 팝업에서 현재 URL 또는 입력 URL을 downloader 화면으로 전달한다.
- `downloader.html`, `src/downloader.ts`, `src/styles/downloader.css`: 편집기, 미리보기, 구간 선택, 항목 목록, 옵션, 디버그 로그 UI.
- `offscreen.html`, `src/offscreen.ts`: HLS 세그먼트 다운로드, 복호화, transmux, 임시 파일 작성, 브라우저 다운로드 저장.
- `src/background.ts`: 메시지 라우팅, offscreen 생성, 원본 탭 수집/열기, player command 실행, context fetch, downloads API 저장.
- `src/content/chzzkPlayerBridge.ts`: 치지직 페이지 DOM 안에서 플레이어 재생/일시정지/seek/품질 자동 설정 등을 수행하는 content bridge.
- `src/content/qualityTargetTracker.ts`: 페이지 main world에서 video track/quality target 접근 가능성을 높이기 위한 보조 추적 스크립트.
- `src/itemOptions.ts`: 옵션 메뉴의 항목별 자동 다운로드/탭 닫기/완료 후 삭제 설정을 localStorage와 `chrome.storage.local`에 저장한다.
- `scripts/validate-extension-build.mjs`: 빌드 산출물 유효성 검사.
- `scripts/smoke-extension-whale.mjs`: Whale 기반 smoke/performance/download 검증.

## 런타임 구성

### 메시지 흐름

확장 프로그램은 크게 downloader UI, background service worker, offscreen document, content script 네 영역으로 나뉜다.

1. 사용자가 downloader UI에서 항목을 추가하거나 자동 감지로 항목이 추가된다.
2. `src/downloader.ts`가 치지직 API/CDN 정보를 fetch해서 영상 메타데이터와 저장 가능한 format 목록을 만든다.
3. 다운로드 요청은 `DOWNLOAD_QUEUE_JOB` 메시지로 background에 전달된다.
4. background는 offscreen document를 만들고, `OFFSCREEN_QUEUE_JOB`으로 실제 다운로드 작업을 넘긴다.
5. offscreen은 HLS playlist를 읽고 선택 구간의 segment만 추려 MP4로 transmux한다.
6. offscreen은 진행률을 background로 보내고, background가 downloader UI로 `DOWNLOAD_JOB_UPDATE`를 전달한다.
7. 완료된 Blob URL은 background의 downloads API를 통해 브라우저 기본 다운로드 폴더에 저장된다.

### 원본 치지직 탭과의 연결

다운로더는 열린 치지직 다시보기/클립 탭을 자동 감지해서 편집기 항목에 연결한다.

- background가 `EDITOR_COLLECT_CHZZK_TABS`, `CHZZK_TAB_DISCOVERED`, `CHZZK_TAB_REMOVED`, `EDITOR_OPEN_SOURCE_TAB`, `EDITOR_FOCUS_TAB`류의 메시지를 처리한다.
- downloader의 원격 제어 영역은 선택된 편집기 항목의 `sourceTabId`를 사용한다.
- 재생/일시정지, seek, 현재 위치로 구간 시작/종료 설정은 `CHZZK_PLAYER_COMMAND`를 통해 background/content script/main world injection 순서로 시도된다.
- 클립 페이지는 일반 다시보기와 플레이어 DOM/동작이 달라서 media element 직접 제어와 UI 클릭 fallback을 모두 유지한다.

## 편집기 항목 모델

`src/downloader.ts` 내부의 주요 상태:

- `N`: 편집기 항목 Map. key는 editor item id.
- `M`: 다운로드 작업 Map.
- `D`: 현재 선택된 editor item id.
- `f`: 현재 선택된 영상 메타데이터.
- `p`: 현재 선택된 format.
- `w`, `T`: 현재 구간 선택의 start/end.
- `editorRangeStore`: 항목 id와 URL key 양쪽으로 구간을 보관하는 in-memory 보조 저장소.
- `_i`, `vi`: 자동 감지된 치지직 탭의 URL/tabId 매핑.

주요 함수:

- `Qe(payload, options)`: URL을 편집기 항목으로 추가하거나 기존 항목을 재사용한다.
- `$e(url)`: 같은 URL의 중복 항목을 정리하고 대표 항목을 반환한다.
- `tt(item)`: 편집기 카드 DOM을 생성하고 버튼 이벤트를 연결한다.
- `nt(item)`: 메타데이터 fetch를 수행하고 `video`, `format`, `formatId`를 채운다.
- `rt(item)`: 항목을 선택하고 미리보기/구간 UI를 적용한다.
- `ut(item)`: 항목 카드의 다운로드 버튼 처리. 선택된 항목이면 현재 구간, 선택되지 않은 항목이면 전체 다운로드.
- `Tt(item, options)`: 실제 다운로드 job 생성.
- `Dt(jobPayload)`: 다운로드 작업을 만들고 queue에 전달한다.
- `Lt(update)`, `gt(item, update)`: 다운로드 진행률과 상태를 UI에 반영한다.
- `collapseEditorItem(item)`: 다운로드 중인 항목을 접고 편집 UI를 숨긴다.

## 영상 정보 로드

입력 URL은 `K()`와 `q()`로 정규화한다.

- 다시보기: `https://chzzk.naver.com/video/{id}`
- 클립: `https://chzzk.naver.com/clips/{id}`

다시보기와 클립은 API와 재생정보 구조가 다르다.

- 다시보기는 service v3/v1 API와 playback 정보를 조합한다.
- 클립은 `/service/v1/play-info/clip/{clipId}`와 `/service/v1/clips/{clipId}/detail`, Neon player playback MPD/HLS 정보를 조합한다.
- DASH MPD 안의 thumbnail sprite 정보가 있으면 구간바 미니썸네일에 사용한다.
- 일부 영상은 sprite 메타데이터가 없거나 형식이 달라서 미니썸네일이 안 나올 수 있다. 이 경우 HLS preview fallback을 사용한다.

미니썸네일 관련 주요 함수:

- `Xt(sprite, thumbnailUrl)`: sprite preview 모드.
- `Zt(time)`: sprite index와 background position 계산.
- `Qt(time)`: sprite 실패 시 video preview fallback.
- `Pr(format, thumbnailUrl)`, `Fr(time)`: HLS 기반 hover preview.

## 구간 선택 로직

구간 선택은 전역 현재값 `w`, `T`와 항목별 저장값을 함께 사용한다.

주요 함수:

- `Rt(duration)`: 구간을 전체 범위로 초기화한다.
- `zt(start, end)`: 저장된 구간을 UI에 적용한다.
- `Bt(time)`, `Vt(time)`: start/end handle 이동.
- `Ht(time)`: drag 동작 처리.
- `rn()`: 구간바 UI만 다시 그린다. 저장은 하지 않는다.
- `on()`: 현재 선택 항목에 `w`, `T`를 저장한다.
- `rememberEditorItemRange(item, start, end)`: `editorRangeStore`에 id key와 URL key로 저장한다.
- `savedEditorItemRange(item)`: dataset, store, item field 순서로 구간을 읽는다.
- `dt(item)`: 다운로드 직전 선택 카드 dataset에서 구간을 읽는다.
- `dn(jobOrItem)`: 다운로드 파일명과 job payload에 들어갈 range를 계산한다.

주의:

- `rn()`은 1초 주기 `Pi()`에서도 호출되므로 저장 side effect를 넣으면 안 된다.
- 저장은 사용자 조작 이벤트(`Ht`, reset, 원본 플레이어 현재 시간으로 시작/종료 설정) 이후 `on()`에서만 한다.
- 선택되지 않은 카드의 다운로드 버튼은 항상 전체 다운로드 UI를 보여야 한다. 실제 동작도 전체 다운로드여야 한다.
- 선택된 카드만 현재 구간 상태를 보고 구간 다운로드 아이콘/라벨을 보여야 한다.

## 다운로드 로직

다운로드는 offscreen document에서 수행한다. MV3 service worker가 장시간 작업에 적합하지 않기 때문이다.

`src/offscreen.ts` 주요 흐름:

1. `OFFSCREEN_QUEUE_JOB` 수신.
2. playlist URL fetch.
3. HLS manifest parsing.
4. 선택 구간이 있으면 segment timeline 기준으로 겹치는 segment만 선택한다.
5. AES-128 key가 있으면 key를 로드해 segment 복호화.
6. mux.js transmuxer로 TS/fMP4 segment를 MP4 fragment로 변환.
7. Origin Private File System에 임시 파일 작성.
8. Blob URL을 만들어 background에 저장 요청.
9. background가 downloads API로 저장.

관련 함수:

- `T(url)`: playlist load + parse.
- `ee(text, baseUrl)`: HLS manifest parser.
- `oe(playlist, start, end)`: 선택 구간 segment 필터링.
- `ne(...)`: mux.js transmux flow.
- `O(...)`: segment 병렬 다운로드와 순서 보장.
- `decryptSegment(...)`: AES-128 복호화.
- `F()`, `I()`, `R()`: 임시 파일 생성, 저장, 정리.

구간 다운로드 주의:

- HLS segment 단위로 자르기 때문에 frame-perfect trimming은 아니다.
- 과거에 특정 클립 구간 다운로드 결과가 플레이어에서 길이/재생 시간이 이상하게 표시되는 문제가 있었다. segment timestamp와 muxer의 timestamp 처리 영향이 의심된다.
- 현재 offscreen transmuxer는 `keepOriginalTimestamps: false`를 사용한다. 구간 앞부분 정지 프레임/표기 시간 이상이 다시 보이면 segment 시작 PTS/DTS 재기준화와 init segment 작성 순서를 의심해야 한다.

## 옵션 로직

옵션 메뉴는 다시보기(video)와 클립(clip)을 분리해 저장한다.

옵션 키:

- `autoDownload`: 항목 추가 시 자동 다운로드.
- `closeOnAdd`: 항목 추가 시 원본 치지직 탭 닫기.
- `removeOnComplete`: 다운로드 완료 시 편집기 목록에서 제거.
- `closeOnComplete`: 다운로드 완료 시 원본 치지직 탭 닫기.

구현:

- `src/itemOptions.ts`가 `localStorage`와 `chrome.storage.local`에 `chzzkSaverItemOptions`를 저장한다.
- downloader는 `_t()`, `vt()`, `yt()`로 현재 항목 종류에 맞는 옵션을 읽는다.
- 옵션 변경 이벤트 `chzzk-saver:item-options-changed`가 발생하면 기존 항목에도 자동 다운로드 여부를 다시 검사한다.

디버그 모드:

- 옵션 메뉴의 `디버그 모드` 토글로 켜고 끈다.
- 상태는 `localStorage.chzzkSaverDebugMode`에 저장한다.
- 로그 패널은 `debugPanel`, 로그 출력은 `debugLog`에 표시된다.
- 로그는 `G(source, event, data)`를 통해 수집한다.
- URL의 key/token/hdnts/signature 등 민감 query는 `Gr()`/`Kr()`에서 redaction한다.

## 원본 플레이어 제어

원본 탭 제어는 `CHZZK_PLAYER_COMMAND`로 시작한다.

명령 예:

- `state`
- `toggle`
- `seek`
- `qualityAuto`

background는 우선 MAIN world injection을 시도하고, 실패 시 content script bridge를 사용한다.

클립 관련 주의:

- 클립 페이지는 일반 다시보기보다 player DOM이 다르고, 재생 버튼/품질 메뉴가 일반 PZP 구조와 다르게 노출될 수 있다.
- 그래서 `setPlaybackStateViaMedia`, `setPlaybackStateViaUi`, `clickPlaybackControl`, `clickVideoSurface`, keyboard toggle 등의 fallback이 있다.
- 과거 클립에서 재생/일시정지, 구간선택, seek가 모두 실패한 적이 있었다. 이때 main world에서 video를 찾지 못하거나 player command state가 반환되지 않는 로그가 나왔다.

## 자동 감지 로직

다운로더가 열려 있으면 열린 치지직 탭을 감지해 편집기 항목으로 추가한다.

주요 함수:

- `xi()`: 현재 extension tab id를 잡고, 초기 열린 탭 수집과 주기적 재수집 시작.
- `Si()`: background에 `EDITOR_COLLECT_CHZZK_TABS`를 보내 열린 치지직 탭 목록을 받는다.
- `Ci(tab, { addToEditor })`: URL/tabId/windowId 매핑 갱신, 필요하면 `Ti()`로 편집기에 추가.
- `Ti(tab)`: 자동 감지 항목을 실제 editor item으로 추가.
- `Ei(tab)`: 이미 있는 DOM 카드에 source tab 정보를 동기화.
- `wi(tabId)`: 탭 닫힘 처리.

중요한 초기화 순서:

- `editorInitReady = waitForItemOptionsReady().then(() => Je()).catch(Z)`
- 자동 감지 초기화는 `(editorInitReady || waitForItemOptionsReady()).then(() => xi()).catch(Bi)`

이 순서를 바꾸면 안 된다. 자세한 이유는 아래 버그 히스토리의 "초기 열린 탭 구간 저장 실패"를 참고한다.

## UI 구조와 주의점

편집기 목록:

- `editorItemList` 안에 `.editor-item` 카드가 쌓인다.
- 선택된 카드 안의 `.editor-item-actions`로 `selectedEditorControls`가 이동한다.
- 다운로드 중인 카드는 펼쳐진 편집 UI를 접는다.
- 항목이 많을 때 전체 확장 페이지가 아니라 편집기 영역 내부에서 스크롤되어야 한다.

최근 UI 요구:

- 일반 사용자에게 디버그 모드를 숨겼다가, 문제 추적을 위해 옵션에서 다시 켤 수 있게 복구했다.
- 편집기 카드 높이는 썸네일 기준으로 유지하고, 버튼 높이는 키우지 않는다.
- 카드가 선택되더라도 다른 카드와 높이/정렬이 깨지면 안 된다.
- 옵션 패널이 열릴 때 전체 확장 페이지에 가로 스크롤이 생기면 안 된다.

## 버그 히스토리와 수정 내역

### 일부 영상 구간바 미니썸네일 미표시

증상:

- 특정 치지직 다시보기에서 편집기 구간바 hover 미니썸네일이 보이지 않았다.

원인:

- 영상별 thumbnail sprite 메타데이터 형식이 다르거나 누락될 수 있다.
- DASH MPD/HLS에서 thumbnail template, interval, row/column 정보를 얻지 못하면 sprite preview가 실패한다.

대응:

- sprite 정보가 있으면 sprite 기반 preview를 사용한다.
- 실패하면 HLS video preview fallback을 사용한다.
- 관련 함수는 `parseMpdSeekingThumbnail`, `Xt`, `Zt`, `Qt`, `Pr`, `Fr` 계열이다.

### 옵션 패널 열 때 전체 페이지 가로 스크롤 발생

증상:

- 옵션 메뉴를 열면 확장 페이지 전체에 가로 스크롤바가 생겼고, 이동해도 빈 공간만 보였다.

원인:

- 옵션 팝오버 폭/위치가 viewport를 넘어갔다.

대응:

- `.options-menu-panel` 폭을 `min(430px, calc(100dvw - 40px), calc(100vw - 40px))`로 제한했다.
- 모바일 폭에서는 더 작은 폭을 사용한다.
- 팝오버가 오른쪽 기준으로 정렬되어도 viewport 밖으로 밀리지 않게 했다.

### 자동 다운로드 옵션이 켜져도 클립 추가 시 아무 동작 없음

증상:

- 클립 자동 다운로드 옵션을 켰는데 항목 추가 후 다운로드가 시작되지 않았다.

원인:

- 항목 옵션 로드/저장과 편집기 항목 생성 시점이 어긋나거나, 옵션 변경 이벤트가 기존 항목에 제대로 반영되지 않았다.

대응:

- `src/itemOptions.ts`에서 옵션 준비 Promise를 `globalThis.chzzkSaverItemOptionsReady`로 노출한다.
- downloader는 옵션 준비 이후 초기화하고, 옵션 변경 이벤트를 받으면 기존 항목에 `bt(item)`를 재검사한다.

### 다운로드 중인 항목이 펼쳐져 UI가 깨짐

증상:

- 다운로드가 시작된 항목이 선택된 상태로 펼쳐져 진행률/버튼/구간바가 겹쳤다.

대응:

- `gt()`에서 running/finalizing/queued/loading 상태로 들어간 항목이 선택되어 있으면 `collapseEditorItem(item)`을 호출한다.
- `isEditorItemBusy()`로 다운로드 중 카드의 선택/펼침 동작을 막는다.

### 원본 탭을 닫았다가 재생 버튼으로 다시 열면 구간바 seek만 안 됨

증상:

- 처음 열린 탭에서 추가된 항목은 컨트롤이 됐지만, 탭을 닫고 항목 재생 버튼으로 다시 열린 탭에서는 구간바 seek가 탭 플레이어 위치에 반영되지 않았다.

원인:

- 새로 열린 source tab id가 editor item과 DOM dataset에 완전히 동기화되지 않았다.

대응:

- `Ci`, `ji`, `Ei`, `Li` 계열에서 sourceTabId/sourceWindowId를 item 객체와 DOM dataset 양쪽에 동기화한다.
- `Ut(time)`은 현재 선택 item의 `sourceTabId`로 `CHZZK_PLAYER_COMMAND seek`를 보낸다.

### 클립 플레이어 제어 실패

증상:

- 클립에서 재생/일시정지, 구간선택, 구간바 seek가 모두 작동하지 않았다.
- 로그에는 `Player command did not return a state`, `치지직 플레이어를 찾지 못했습니다`가 나왔다.

원인:

- 클립 플레이어 DOM과 media element 노출 방식이 다시보기와 달랐다.
- main world injection과 isolated content script가 접근 가능한 DOM 상태가 달랐다.

대응:

- background main world command와 content bridge fallback을 유지한다.
- 클립 판별 후 media element 직접 제어, UI 버튼 클릭, 영상 표면 클릭, keyboard toggle 등 여러 fallback을 사용한다.
- 품질 자동 설정은 PZP 설정 메뉴 구조와 track list 양쪽을 탐색한다.

### 클립 구간 다운로드 결과의 길이/재생 이상

증상:

- 23초 클립에서 12~23초만 저장했는데 플레이어에는 15초로 보이고, 초반 프레임이 멈췄다가 나중에 재생되며, 표시 길이 이후에도 계속 재생됐다.

가능 원인:

- HLS segment 경계 기반 trimming과 segment 내부 timestamp가 어긋났다.
- transmux된 MP4의 duration/timestamp가 플레이어별로 다르게 해석될 수 있다.

현재 대응:

- segment 선택은 `oe(playlist, start, end)`가 담당한다.
- mux.js transmuxer는 `keepOriginalTimestamps: false`로 생성한다.

추가 조사 포인트:

- 구간 시작 segment의 PTS/DTS 재기준화가 충분한지 확인한다.
- init segment 작성 순서와 첫 media segment timestamp를 확인한다.
- 가능하면 smoke test에서 짧은 클립 구간 다운로드 파일의 duration metadata를 검사한다.

### 디버그 모드 숨김/복구

증상/요구:

- 일반 사용자에게 디버그 모드 옵션을 숨겼다가, 구간 저장 문제 추적을 위해 옵션에서 다시 켤 수 있게 해 달라는 요청이 있었다.

대응:

- `downloader.html` 옵션 grid 안에 `debugModeToggle`을 다시 노출했다.
- `Rr()`/`zr()`가 무조건 false로 고정하던 로직을 되돌려 `localStorage.chzzkSaverDebugMode` 기반으로 켜고 끄게 했다.

### 구간 버튼 상태가 다른 카드로 새는 문제

증상:

- 구간 설정이 없는 항목을 클릭했다가 구간 설정이 있는 항목을 클릭하면, 선택되지 않은 카드의 다운로드 버튼이 구간 다운로드 버튼처럼 보였다.
- 실제 다운로드 동작은 전체 다운로드였지만 UI 상태가 틀렸다.

원인:

- 다운로드 버튼 표시가 현재 전역 구간 상태 또는 이전 선택 항목 상태에 영향을 받았다.

대응:

- 선택되지 않은 항목은 항상 기본 다운로드 버튼을 보여야 한다.
- `ot(item)`은 `D === item.id && ct(item)`일 때만 구간 다운로드 상태를 표시한다.
- 선택된 항목만 현재 구간 상태를 반영한다.

### 클립 구간 선택이 다른 항목을 펼쳤다가 돌아오면 풀림

증상:

- 클립에서 구간을 설정한 뒤 다른 항목을 펼쳤다가 다시 돌아오면 구간이 풀렸다.
- 다시보기는 상대적으로 문제가 덜했다.

원인:

- 구간 상태가 DOM dataset, item field, 전역 `w/T` 사이에서 일관되게 저장되지 않았다.
- item id가 바뀌거나 중복 URL 항목이 정리될 때 저장된 구간을 찾지 못할 수 있었다.

대응:

- `editorRangeStore`를 추가해 item id와 URL key 양쪽으로 저장한다.
- `rememberEditorItemRange()`는 두 key에 모두 기록한다.
- `savedEditorItemRange()`는 dataset -> store -> item field 순서로 읽는다.
- `forgetEditorItemRange()`는 id와 URL key를 모두 삭제한다.

### 탭이 이미 열려 있는 상태에서 확장앱을 열면 구간 저장 실패

증상:

- 확장앱이 이미 열린 뒤 새로 추가한 탭은 구간 저장이 잘 됐다.
- 하지만 치지직 탭을 미리 열어둔 상태에서 확장앱을 열면, 자동 감지된 항목은 구간 선택 후 다른 항목으로 갔다 오면 저장이 안 됐다.
- 다운로드를 한 번 한 항목은 이후 구간 저장이 되는 경우가 있었다.

디버그 로그:

- 실패 케이스에서 `range.saveSkipped`가 반복됐다.
- `selectedId`와 `activeId`는 같은 id로 찍혔지만 실제 `N.get(id)`가 실패했다.
- 즉 DOM 카드에는 `data-editor-item-id`가 남아 있는데 내부 `N` Map에는 해당 item이 사라져 있었다.

원인:

- 시작 시 `Je()`와 `xi()/Si()`가 병렬로 움직였다.
- `Je()`는 `DOWNLOAD_CLEAR_JOBS` 응답을 기다린 뒤 `Ye()`에서 `N.clear()`를 수행한다.
- 그 사이 `xi()/Si()`가 먼저 열린 탭을 수집해 DOM 카드와 `N` item을 만들 수 있었다.
- 이후 늦게 실행된 `Ye()`가 `N.clear()`만 수행하고 DOM 카드는 지우지 않아, stale DOM 카드만 남았다.
- 이후 사용자가 구간을 조작하면 선택 DOM은 있으나 `N`에서 item을 못 찾아 `activeEditorItem()`이 실패했다.

수정:

- `editorInitReady` Promise를 추가했다.
- 자동 감지 초기화는 `editorInitReady`가 끝난 뒤 `xi()`를 실행한다.
- `Ye()`는 `N.clear()`뿐 아니라 기존 `.editor-item` DOM도 제거하고 `D`도 null로 초기화한다.

관련 최신 커밋:

- `92499cc Serialize editor startup initialization`
- 이전 로컬 커밋이 rebase되며 해시가 바뀌었으므로, 현재 `origin/main` 기준 최신 해시를 확인한다.

## 디버그 로그 해석 팁

구간 문제를 볼 때 중요한 이벤트:

- `range.itemRegistered`: 항목이 생성/재사용된 시점. `id`, `urlKey`, `sourceTabId`, 초기 trim 값을 본다.
- `range.metadataReady`: 메타데이터 로드 완료. `duration`, `formatId`, loaded 상태를 본다.
- `range.load`: 항목 선택 시 구간을 어디서 읽었는지 본다. `loadSource`가 `dataset`, `store`, `item` 중 무엇인지 중요하다.
- `range.selectApply`: 선택된 항목에 구간 UI를 적용한 직후.
- `range.save`: drag/구간 설정 이벤트에서 저장소에 기록한 값.
- `range.persistActive`: item field와 DOM dataset에 반영된 값.
- `range.saveSkipped`: 비정상. 선택 id가 있는데 item을 못 찾는 경우 초기화/DOM/Map 불일치를 의심한다.
- `range.download`: 다운로드 job 생성 직전 실제 적용된 구간.

로그에서 `datasetStart`, `storeIdStart`, `storeUrlStart`, `itemStart`, `currentStart`가 서로 다르면 어느 계층에서 값이 유실됐는지 볼 수 있다.

## 개발/검증 절차

일반 수정:

```powershell
npm run verify:extension
```

zip 갱신:

```powershell
$dist = Resolve-Path 'dist-extension'
Compress-Archive -Path (Join-Path $dist.Path '*') -DestinationPath 'chzzk-saver-extension.zip' -Force
```

상태 확인:

```powershell
git status --short --branch
git log --oneline -5 --decorate
```

주의:

- `dist-extension/`은 빌드 산출물이라 Git 추적하지 않는다.
- `chzzk-saver-extension.zip`도 현재 Git 추적 대상이 아니다. 사용자에게 최신 zip이 필요하면 빌드 후 직접 갱신만 한다.
- 사용자가 push를 명시하지 않으면 push하지 않는다.
- Windows PowerShell에서는 `&&`가 환경에 따라 동작하지 않을 수 있으므로 명령을 나눠 실행하는 편이 안전하다.
- 한글이 있는 파일은 `Get-Content -Encoding UTF8` 또는 `[System.IO.File]::ReadAllText(..., [System.Text.Encoding]::UTF8)`를 사용한다.

## 유지보수 시 특히 조심할 점

- `src/downloader.ts`는 한 줄에 가까운 압축된 스타일이므로 작은 변경도 diff가 크게 보일 수 있다.
- `rn()`에 저장 side effect를 넣지 않는다. 주기적 redraw 때문에 구간이 의도치 않게 덮일 수 있다.
- `N` Map과 `.editor-item` DOM은 항상 같이 유지되어야 한다.
- 자동 감지 초기화 순서를 바꾸지 않는다.
- 선택되지 않은 항목의 다운로드 UI는 구간 상태를 표시하지 않는다.
- 클립과 다시보기는 player 제어 방식이 다르므로, 하나에서 되는 방법이 다른 하나에도 된다고 가정하지 않는다.
- offscreen 다운로드는 장시간 작업이므로 service worker에 직접 넣지 않는다.
- API/CDN URL 로그에는 토큰이 포함될 수 있으므로 redaction을 유지한다.
