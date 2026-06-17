import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 3010);
const API_BASE = "https://api.chzzk.naver.com/service/v3";

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (url.pathname === "/") {
      send(response, 200, "text/html; charset=utf-8", html);
      return;
    }
    if (url.pathname === "/perf-lab.js") {
      send(response, 200, "text/javascript; charset=utf-8", clientJs);
      return;
    }
    if (url.pathname === "/api/chzzk") {
      await handleChzzk(url, response);
      return;
    }
    if (url.pathname === "/api/proxy") {
      await handleProxy(url, response);
      return;
    }
    if (url.pathname.startsWith("/vendor/")) {
      servePublic(url.pathname, response);
      return;
    }
    sendJson(response, 404, { message: "not found" });
  } catch (error) {
    sendJson(response, 500, { message: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`perf lab: http://127.0.0.1:${port}/`);
});

async function handleChzzk(url, response) {
  const videoNo = url.searchParams.get("videoNo");
  if (!/^\d+$/.test(videoNo || "")) {
    sendJson(response, 400, { message: "videoNo가 올바르지 않습니다." });
    return;
  }
  const apiResponse = await fetch(`${API_BASE}/videos/${videoNo}`, {
    cache: "no-store",
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0",
    },
  });
  if (!apiResponse.ok) {
    sendJson(response, apiResponse.status, { message: `CHZZK API HTTP ${apiResponse.status}` });
    return;
  }
  const body = await apiResponse.json();
  if (body.code !== 200 || !body.content) {
    sendJson(response, 502, { message: body.message || "영상 정보를 불러오지 못했습니다." });
    return;
  }
  const payload = body.content;
  const playback = parsePlayback(payload.liveRewindPlaybackJson);
  const hlsMedia = playback?.media?.find((item) => item.protocol === "HLS" && item.path);
  if (!hlsMedia) {
    sendJson(response, 502, { message: "HLS 재생 정보를 찾지 못했습니다." });
    return;
  }
  sendJson(response, 200, {
    videoNo: String(payload.videoNo),
    title: payload.videoTitle || `chzzk_${payload.videoNo}`,
    channelName: payload.channel?.channelName || "",
    durationSeconds: payload.duration || null,
    thumbnailUrl: payload.thumbnailImageUrl || "",
    playbackUrl: hlsMedia.path,
    seekingThumbnailSprite: normalizeSprite(playback?.thumbnail?.spriteSeekingThumbnail, payload.liveOpenDate),
  });
}

async function handleProxy(url, response) {
  const target = url.searchParams.get("url");
  if (!target || !/^https:\/\/.+/i.test(target)) {
    sendJson(response, 400, { message: "proxy url이 올바르지 않습니다." });
    return;
  }
  const upstream = await fetch(target, {
    cache: "no-store",
    headers: {
      accept: "*/*",
      "user-agent": "Mozilla/5.0",
    },
  });
  response.writeHead(upstream.status, {
    "access-control-allow-origin": "*",
    "content-type": upstream.headers.get("content-type") || "application/octet-stream",
    "cache-control": "no-store",
  });
  if (!upstream.body) {
    response.end(Buffer.from(await upstream.arrayBuffer()));
    return;
  }
  for await (const chunk of upstream.body) {
    response.write(chunk);
  }
  response.end();
}

function servePublic(pathname, response) {
  const filePath = join(publicDir, pathname.replace(/^\//, ""));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    sendJson(response, 404, { message: "asset not found" });
    return;
  }
  response.writeHead(200, { "content-type": mime(filePath), "cache-control": "no-store" });
  createReadStream(filePath).pipe(response);
}

function sendJson(response, status, value) {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(value));
}

function send(response, status, type, body) {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  response.end(body);
}

function parsePlayback(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeSprite(sprite, liveOpenDate) {
  const format = sprite?.spriteFormat;
  if (!sprite?.urlTemplate || !format) return null;
  const interval = Number(format.interval) || 0;
  const intervalSeconds = format.intervalType === "millisecond" ? interval / 1000 : interval;
  const rowCount = Number(format.rowCount) || 0;
  const columnCount = Number(format.columnCount) || 0;
  if (!intervalSeconds || !rowCount || !columnCount) return null;
  return {
    urlTemplate: sprite.urlTemplate,
    rowCount,
    columnCount,
    intervalMs: intervalSeconds * 1000,
    thumbnailWidth: Number(format.thumbnailWidth) || 160,
    thumbnailHeight: Number(format.thumbnailHeight) || 90,
    startDateMs: parseLiveOpenDate(liveOpenDate),
  };
}

function parseLiveOpenDate(value) {
  if (!value) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const normalized = String(value).trim().replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/, "$1T$2+09:00");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mime(filePath) {
  return {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  }[extname(filePath)] || "application/octet-stream";
}

const html = String.raw`<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>치직 세이버 성능 랩</title>
    <style>
      :root { color-scheme: dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #07100f; color: #f4fffb; }
      body { margin: 0; }
      main { max-width: 1500px; margin: 0 auto; padding: 24px; display: grid; gap: 16px; }
      .panel { border: 1px solid #1f3937; background: #0c1515; border-radius: 8px; padding: 16px; }
      .top { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
      textarea { width: 100%; min-height: 92px; resize: vertical; border: 1px solid #2c4644; border-radius: 8px; background: #172121; color: #fff; padding: 12px; font-size: 15px; box-sizing: border-box; }
      button, select { border: 1px solid #2b4946; border-radius: 8px; background: #182424; color: #fff; padding: 10px 14px; font-weight: 700; }
      button.primary { background: #00f59c; color: #00110c; border-color: #00f59c; }
      button.danger { color: #ff6d7a; }
      .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .metrics { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 8px; }
      .metric { background: #111d1d; border: 1px solid #213a38; border-radius: 8px; padding: 10px; }
      .metric strong { display: block; font-size: 22px; color: #2dffd1; }
      .layout { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(420px, .8fr); gap: 16px; align-items: start; }
      video { width: 100%; aspect-ratio: 16 / 9; background: #020605; border-radius: 8px; display: block; }
      .range { position: relative; height: 56px; margin-top: 14px; border: 1px solid #1b3331; border-radius: 8px; background: #081010; }
      .rangeTrack { position: absolute; left: 18px; right: 18px; top: 25px; height: 8px; background: #1b2b2b; border-radius: 999px; }
      .rangeTrack::before { content: ""; display: block; width: 65%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #00ff9d, #62d7ff); }
      .hoverThumb { position: absolute; bottom: 44px; width: 160px; height: 90px; transform: translateX(-50%); border: 1px solid #44ffe0; border-radius: 6px; overflow: hidden; background: #020605; display: none; }
      .hoverThumb.visible { display: block; }
      .hoverSprite { width: 100%; height: 100%; background-repeat: no-repeat; }
      .hoverTime { position: absolute; bottom: 3px; left: 0; right: 0; text-align: center; font-weight: 800; text-shadow: 0 1px 2px #000; }
      .list { display: grid; gap: 10px; max-height: 640px; overflow: auto; }
      article { border: 1px solid #203b39; background: #081111; border-radius: 8px; padding: 12px; display: grid; gap: 8px; }
      .item, .jobHead { display: grid; grid-template-columns: 96px minmax(0, 1fr) auto; gap: 10px; align-items: center; }
      img { width: 96px; height: 54px; object-fit: cover; border-radius: 6px; background: #d8eef6; }
      .title { overflow-wrap: anywhere; font-weight: 800; }
      .pill { display: inline-block; color: #21ffc1; border: 1px solid #087e64; border-radius: 999px; padding: 4px 9px; font-size: 12px; }
      .bar { height: 8px; background: #162524; border-radius: 999px; overflow: hidden; }
      .bar i { display: block; height: 100%; background: linear-gradient(90deg, #00ff9d, #62d7ff); }
      pre { margin: 0; white-space: pre-wrap; color: #b7cbc7; }
    </style>
  </head>
  <body>
    <main>
      <section class="panel top">
        <div>
          <h1>치직 세이버 성능 랩</h1>
          <p>실제 브라우저 fetch/HLS/OPFS로 총속도, 플레이어, 미니썸네일을 계측합니다.</p>
        </div>
        <div class="row">
          <select id="qualitySelect"><option value="1080">다운로드 1080p</option><option value="720">다운로드 720p</option></select>
          <button id="runScenario" class="primary">4개 링크 통합 테스트</button>
          <button id="stopAll" class="danger">전체 정지</button>
        </div>
      </section>
      <section class="panel">
        <textarea id="urlInput"></textarea>
        <div class="row" style="margin-top:10px">
          <button id="loadBtn">영상 불러오기</button>
          <button id="startBtn">앞 3개 다운로드</button>
          <button id="playBtn">플레이어 재생</button>
          <span id="status"></span>
        </div>
      </section>
      <section class="metrics">
        <div class="metric">총속도<strong id="totalSpeed">0 MB/s</strong></div>
        <div class="metric">피크<strong id="peakSpeed">0 MB/s</strong></div>
        <div class="metric">플레이어<strong id="playerState">대기</strong></div>
        <div class="metric">썸네일<strong id="thumbState">대기</strong></div>
        <div class="metric">작업<strong id="jobState">0개</strong></div>
      </section>
      <section class="layout">
        <div class="panel">
          <video id="player" controls playsinline muted></video>
          <div class="range" id="range">
            <div class="hoverThumb" id="hoverThumb"><div id="hoverSprite" class="hoverSprite"></div><span id="hoverTime" class="hoverTime">0:00</span></div>
            <div class="rangeTrack"></div>
          </div>
          <pre id="report"></pre>
        </div>
        <div class="panel">
          <h2>영상</h2>
          <div id="items" class="list"></div>
          <h2>다운로드 작업</h2>
          <div id="jobs" class="list"></div>
        </div>
      </section>
    </main>
    <script src="/vendor/hls.min.js"></script>
    <script type="module" src="/perf-lab.js"></script>
  </body>
</html>`;

const clientJs = readFileSync(new URL("./perf-lab-client.js", import.meta.url), "utf8");

