
const URLS = [
  "https://chzzk.naver.com/video/13659163",
  "https://chzzk.naver.com/video/13741031",
  "https://chzzk.naver.com/video/13734087",
  "https://chzzk.naver.com/video/13688683",
];
const SEGMENT_CONCURRENCY = 16;
const MAX_RUNNING_JOBS = 3;
const SAMPLE_WINDOW_MS = 5000;
const VIDEO_URL_RE = /^https:\/\/chzzk\.naver\.com\/video\/(?<id>\d+)(?:[/?#].*)?$/;

const el = {
  input: document.querySelector("#urlInput"),
  load: document.querySelector("#loadBtn"),
  start: document.querySelector("#startBtn"),
  run: document.querySelector("#runScenario"),
  stop: document.querySelector("#stopAll"),
  play: document.querySelector("#playBtn"),
  quality: document.querySelector("#qualitySelect"),
  status: document.querySelector("#status"),
  totalSpeed: document.querySelector("#totalSpeed"),
  peakSpeed: document.querySelector("#peakSpeed"),
  playerState: document.querySelector("#playerState"),
  thumbState: document.querySelector("#thumbState"),
  jobState: document.querySelector("#jobState"),
  player: document.querySelector("#player"),
  range: document.querySelector("#range"),
  hoverThumb: document.querySelector("#hoverThumb"),
  hoverSprite: document.querySelector("#hoverSprite"),
  hoverTime: document.querySelector("#hoverTime"),
  items: document.querySelector("#items"),
  jobs: document.querySelector("#jobs"),
  report: document.querySelector("#report"),
};

let items = [];
let jobs = [];
let hls = null;
let selectedItem = null;
let peakSpeed = 0;
let thumbLoads = 0;
let thumbChanges = 0;
let segmentPool = { active: 0, waiters: [], byJob: new Map() };

el.input.value = URLS.join("\n");
el.load.onclick = () => loadUrls(readUrls(), { clear: true });
el.start.onclick = () => startDownloads(items.slice(0, 3));
el.run.onclick = () => runIntegratedTest();
el.stop.onclick = () => stopAll();
el.play.onclick = () => playSelected();
el.range.addEventListener("pointermove", (event) => hoverAt(event));
el.range.addEventListener("pointerleave", () => el.hoverThumb.classList.remove("visible"));
window.setInterval(render, 500);

window.perfLab = {
  loadUrls: () => loadUrls(readUrls(), { clear: true }),
  runIntegratedTest,
  snapshot,
  stopAll,
};

function readUrls() {
  return el.input.value.split(/[\s,]+/).map((url) => url.trim()).filter(Boolean);
}

async function loadUrls(urls, { clear = false } = {}) {
  if (clear) {
    stopAll();
    items = [];
    jobs = [];
    selectedItem = null;
    peakSpeed = 0;
  }
  el.status.textContent = "영상 정보를 불러오는 중";
  for (const url of urls) {
    if (items.some((item) => item.url === url)) continue;
    const match = url.match(VIDEO_URL_RE);
    const item = { id: crypto.randomUUID(), url, videoNo: match?.groups?.id, title: url, state: "loading" };
    items.push(item);
    render();
    try {
      if (!item.videoNo) throw new Error("올바르지 않은 URL");
      const meta = await fetchJson("/api/chzzk?videoNo=" + encodeURIComponent(item.videoNo));
      const masterText = await fetchText(meta.playbackUrl, 20000);
      const formats = parseMaster(masterText, meta.playbackUrl);
      if (!formats.length) {
        formats.push({ label: "원본", url: meta.playbackUrl, height: null, fps: null, bandwidth: null });
      }
      Object.assign(item, meta, { formats, downloadFormat: selectFormat(formats, Number(el.quality.value)), playerFormat: selectFormat(formats, 720), state: "ready" });
      selectedItem ||= item;
    } catch (error) {
      item.state = "error";
      item.error = formatError(error);
    }
    render();
  }
  if (selectedItem) setupPlayer(selectedItem);
  el.status.textContent = "준비 완료";
}

function startDownloads(targetItems) {
  for (const item of targetItems) {
    if (item?.state === "ready") addJob(item);
  }
  processQueue();
}

function addJob(item) {
  if (jobs.some((job) => job.itemId === item.id && !["done", "error", "paused"].includes(job.state))) return;
  jobs.unshift({
    id: crypto.randomUUID(),
    itemId: item.id,
    videoNo: item.videoNo,
    title: item.title,
    thumbnailUrl: item.thumbnailUrl,
    format: selectFormat(item.formats, Number(el.quality.value)),
    state: "queued",
    label: "대기",
    progress: 0,
    bytes: 0,
    written: 0,
    recentSpeed: 0,
    samples: [],
    controller: null,
  });
}

function processQueue() {
  let running = jobs.filter((job) => job.state === "running" || job.state === "loading").length;
  for (const job of jobs) {
    if (running >= MAX_RUNNING_JOBS) break;
    if (job.state === "queued") {
      running += 1;
      runJob(job);
    }
  }
}

async function runJob(job) {
  const controller = new AbortController();
  Object.assign(job, { controller, state: "loading", label: "저장 정보 확인" });
  try {
    const playlistText = await fetchText(job.format.url, 20000, controller.signal);
    const playlist = parseMedia(playlistText, job.format.url);
    const segments = playlist.segments.slice(0, 240);
    job.totalSegments = segments.length + (playlist.mapUrl ? 1 : 0);
    const file = await createWritable(job.videoNo + "_" + safeName(job.title) + "_" + job.format.label + ".mp4");
    job.state = "running";
    job.label = "다운로드 중";
    if (playlist.mapUrl) {
      const init = await fetchBytes(playlist.mapUrl, controller.signal);
      await file.writable.write(init.bytes);
      job.bytes += init.bytes.byteLength;
      job.written += init.bytes.byteLength;
      updateJobSpeed(job, true);
    }
    await downloadSegments(job, segments, file.writable, controller.signal);
    job.state = "finalizing";
    job.label = "마무리 중";
    await file.writable.close();
    job.progress = 100;
    job.state = "done";
    job.label = "완료";
    job.recentSpeed = 0;
  } catch (error) {
    await job.writable?.abort?.().catch(() => {});
    if (controller.signal.aborted || String(error?.message || error).includes("aborted")) {
      job.state = "paused";
      job.label = "정지됨";
    } else {
      job.state = "error";
      job.label = "오류";
      job.error = formatError(error);
    }
    job.recentSpeed = 0;
  } finally {
    job.controller = null;
    releaseAllWaiters();
    processQueue();
    render();
  }
}

async function downloadSegments(job, segments, writable, signal) {
  let nextFetch = 0;
  let nextWrite = 0;
  let firstError = null;
  const results = new Map();
  let wakeWriter = null;
  const wake = () => { if (wakeWriter) { wakeWriter(); wakeWriter = null; } };
  const worker = async () => {
    while (true) {
      signal.throwIfAborted();
      const index = nextFetch++;
      if (index >= segments.length) return;
      await acquireSlot(job.id, signal);
      try {
        const fetched = await fetchBytes(segments[index].url, signal);
        job.bytes += fetched.bytes.byteLength;
        job.direct = (job.direct || 0) + (fetched.mode === "direct" ? 1 : 0);
        job.proxy = (job.proxy || 0) + (fetched.mode === "proxy" ? 1 : 0);
        updateJobSpeed(job);
        results.set(index, fetched.bytes);
        wake();
      } catch (error) {
        firstError ||= error;
        controllerAbort(signal);
        wake();
        throw error;
      } finally {
        releaseSlot(job.id);
      }
    }
  };
  const workers = Array.from({ length: Math.min(SEGMENT_CONCURRENCY, segments.length) }, () => worker().catch((error) => {
    firstError ||= error;
    wake();
  }));
  while (nextWrite < segments.length) {
    signal.throwIfAborted();
    if (firstError) throw firstError;
    const bytes = results.get(nextWrite);
    if (!bytes) {
      await new Promise((resolve) => { wakeWriter = resolve; });
      continue;
    }
    results.delete(nextWrite);
    await writable.write(bytes);
    job.written += bytes.byteLength;
    nextWrite += 1;
    job.progress = Math.round((nextWrite / segments.length) * 100);
  }
  await Promise.all(workers);
}

function updateJobSpeed(job, force = false) {
  const now = performance.now();
  job.samples.push({ at: now, bytes: job.bytes });
  while (job.samples.length > 2 && now - job.samples[0].at > SAMPLE_WINDOW_MS) job.samples.shift();
  const first = job.samples[0];
  const last = job.samples[job.samples.length - 1];
  job.recentSpeed = first && last && last.at > first.at ? Math.max(0, (last.bytes - first.bytes) / ((last.at - first.at) / 1000)) : 0;
  if (force) render();
}

async function acquireSlot(jobId, signal) {
  while (!canAcquire(jobId)) {
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const abort = () => reject(signal.reason || new DOMException("Aborted", "AbortError"));
      waiter.abort = abort;
      segmentPool.waiters.push(waiter);
      signal.addEventListener("abort", abort, { once: true });
    });
    signal.throwIfAborted();
  }
  segmentPool.active += 1;
  segmentPool.byJob.set(jobId, (segmentPool.byJob.get(jobId) || 0) + 1);
}

function releaseSlot(jobId) {
  segmentPool.active = Math.max(0, segmentPool.active - 1);
  const next = Math.max(0, (segmentPool.byJob.get(jobId) || 0) - 1);
  if (next) segmentPool.byJob.set(jobId, next);
  else segmentPool.byJob.delete(jobId);
  releaseAllWaiters();
}

function releaseAllWaiters() {
  const waiters = segmentPool.waiters;
  segmentPool.waiters = [];
  for (const waiter of waiters) waiter.resolve();
}

function canAcquire(jobId) {
  const running = Math.max(1, jobs.filter((job) => job.state === "running").length);
  const perJob = Math.max(1, Math.ceil(SEGMENT_CONCURRENCY / running));
  return segmentPool.active < SEGMENT_CONCURRENCY && (segmentPool.byJob.get(jobId) || 0) < perJob;
}

function setupPlayer(item) {
  selectedItem = item;
  if (hls) hls.destroy();
  el.player.poster = item.thumbnailUrl || "";
  const format = item.playerFormat || selectFormat(item.formats, 720) || item.formats[0];
  if (!format) return;
  if (window.Hls?.isSupported?.()) {
    hls = new Hls({
      autoStartLoad: true,
      enableWorker: true,
      maxBufferLength: 90,
      maxMaxBufferLength: 180,
      fetchSetup: (context, init) => new Request(context.url, { ...init, cache: "no-store", credentials: "include", priority: "low" }),
      xhrSetup: (xhr) => { xhr.withCredentials = true; },
    });
    hls.attachMedia(el.player);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(format.url));
  } else {
    el.player.src = format.url;
  }
}

async function playSelected() {
  if (!selectedItem && items[0]) setupPlayer(items[0]);
  await el.player.play().catch(() => {});
}

function hoverAt(event) {
  if (!selectedItem?.seekingThumbnailSprite) return;
  const rect = el.range.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
  const seconds = ratio * (selectedItem.durationSeconds || 1);
  showSprite(seconds, event.clientX - rect.left);
}

function showSprite(seconds, x) {
  const sprite = selectedItem.seekingThumbnailSprite;
  const interval = Math.max(1, sprite.intervalMs || 10000);
  const index = Math.max(0, Math.floor(((sprite.startDateMs || 0) + seconds * 1000 + interval) / interval));
  const perSheet = sprite.rowCount * sprite.columnCount;
  const sheet = Math.floor(index / perSheet);
  const cell = index % perSheet;
  const col = cell % sprite.columnCount;
  const row = Math.floor(cell / sprite.columnCount);
  const url = sprite.urlTemplate.replaceAll("{spriteIndex}", String(sheet)).replaceAll("{index}", String(sheet));
  const old = el.hoverSprite.dataset.url;
  el.hoverSprite.dataset.url = url + "#" + cell;
  el.hoverSprite.style.backgroundImage = `url("${url}")`;
  el.hoverSprite.style.backgroundSize = `${sprite.columnCount * 100}% ${sprite.rowCount * 100}%`;
  el.hoverSprite.style.backgroundPosition = `${sprite.columnCount <= 1 ? 0 : col / (sprite.columnCount - 1) * 100}% ${sprite.rowCount <= 1 ? 0 : row / (sprite.rowCount - 1) * 100}%`;
  el.hoverThumb.style.left = Math.max(80, Math.min(el.range.clientWidth - 80, x)) + "px";
  el.hoverTime.textContent = formatDuration(seconds);
  el.hoverThumb.classList.add("visible");
  thumbLoads += 1;
  if (old && old !== el.hoverSprite.dataset.url) thumbChanges += 1;
}

async function runIntegratedTest() {
  stopAll();
  items = [];
  jobs = [];
  peakSpeed = 0;
  thumbLoads = 0;
  thumbChanges = 0;
  el.report.textContent = "4개 링크 로드 중";
  await loadUrls(URLS, { clear: true });
  setupPlayer(items[0]);
  playSelected().catch(() => {});
  el.report.textContent = "플레이어 재생을 병렬로 시도하고 다운로드를 시작합니다.";
  startDownloads(items.slice(0, 3));
  const startedAt = performance.now();
  const playerStart = el.player.currentTime || 0;
  for (let i = 0; i < 16; i += 1) {
    const rect = el.range.getBoundingClientRect();
    showSprite((i / 15) * (selectedItem.durationSeconds || 1), 80 + i * Math.max(1, (rect.width - 160) / 15));
    await delay(650);
    if (i === 5) startDownloads(items.slice(3, 4));
  }
  const playerAdvanced = (el.player.currentTime || 0) - playerStart;
  const result = snapshot();
  result.elapsedMs = Math.round(performance.now() - startedAt);
  result.playerAdvanced = playerAdvanced;
  result.playerReadyState = el.player.readyState;
  result.playerPaused = el.player.paused;
  result.thumbLoads = thumbLoads;
  result.thumbChanges = thumbChanges;
  el.report.textContent = JSON.stringify(result, null, 2);
  return result;
}

function snapshot() {
  const running = jobs.filter((job) => ["running", "loading", "finalizing"].includes(job.state));
  const totalSpeed = running.reduce((sum, job) => sum + (job.recentSpeed || 0), 0);
  peakSpeed = Math.max(peakSpeed, totalSpeed);
  return {
    totalSpeed,
    totalSpeedText: formatSpeed(totalSpeed),
    peakSpeed,
    peakSpeedText: formatSpeed(peakSpeed),
    player: {
      readyState: el.player.readyState,
      currentTime: el.player.currentTime,
      paused: el.player.paused,
      error: el.player.error?.message || null,
    },
    thumbnails: { loads: thumbLoads, changes: thumbChanges, visible: el.hoverThumb.classList.contains("visible") },
    jobs: jobs.map((job) => ({ videoNo: job.videoNo, state: job.state, label: job.label, progress: job.progress, speed: job.recentSpeed, speedText: formatSpeed(job.recentSpeed || 0), bytes: job.bytes, direct: job.direct || 0, proxy: job.proxy || 0 })),
  };
}

function stopAll() {
  for (const job of jobs) {
    job.controller?.abort();
    if (["queued", "loading", "running"].includes(job.state)) {
      job.state = "paused";
      job.label = "정지됨";
      job.recentSpeed = 0;
    }
  }
  releaseAllWaiters();
}

function render() {
  const snap = snapshot();
  el.totalSpeed.textContent = snap.totalSpeedText;
  el.peakSpeed.textContent = snap.peakSpeedText;
  el.playerState.textContent = `rs ${el.player.readyState} · ${el.player.paused ? "pause" : "play"} · ${formatDuration(el.player.currentTime || 0)}`;
  el.thumbState.textContent = `${thumbChanges}/${thumbLoads}`;
  el.jobState.textContent = `${jobs.length}개 · 실행 ${jobs.filter((job) => ["running", "loading", "finalizing"].includes(job.state)).length}`;
  el.items.innerHTML = items.map((item) => `<article class="item"><img src="${item.thumbnailUrl || ""}" alt=""><div><div class="title">${escapeHtml(item.title)}</div><p>${item.state}${item.error ? " · " + escapeHtml(item.error) : ""}</p></div><button data-item="${item.id}">선택</button></article>`).join("");
  el.jobs.innerHTML = jobs.map((job) => `<article><div class="jobHead"><img src="${job.thumbnailUrl || ""}" alt=""><div><span class="pill">${job.label}</span><div class="title">${escapeHtml(job.title)}</div></div><b>${job.progress}%</b></div><div class="bar"><i style="width:${job.progress}%"></i></div><div class="row"><span>${formatBytes(job.bytes)} / ${formatBytes(job.written)}</span><span>${formatSpeed(job.recentSpeed || 0)}</span><span>direct ${job.direct || 0} / proxy ${job.proxy || 0}</span></div>${job.error ? `<pre>${escapeHtml(job.error)}</pre>` : ""}</article>`).join("");
  el.items.querySelectorAll("[data-item]").forEach((button) => {
    button.onclick = () => setupPlayer(items.find((item) => item.id === button.dataset.item));
  });
}

async function createWritable(name) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("chzzk-saver-perf-lab", { create: true });
  const handle = await dir.getFileHandle(Date.now() + "_" + name, { create: true });
  return { handle, writable: await handle.createWritable() };
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

async function fetchText(url, timeoutMs, signal = null) {
  const response = await fetchWithFallback(url, { signal, timeoutMs });
  return response.text();
}

async function fetchBytes(url, signal) {
  const response = await fetchWithFallback(url, { signal, timeoutMs: 30000, priority: "high" });
  return { bytes: new Uint8Array(await response.arrayBuffer()), mode: response.modeName };
}

async function fetchWithFallback(url, { signal = null, timeoutMs, priority = "auto" }) {
  try {
    const response = await fetchWithTimeout(url, { signal, timeoutMs, priority });
    response.modeName = "direct";
    return response;
  } catch (error) {
    if (signal?.aborted) throw error;
    const response = await fetchWithTimeout("/api/proxy?url=" + encodeURIComponent(url), { signal, timeoutMs, priority });
    response.modeName = "proxy";
    return response;
  }
}

async function fetchWithTimeout(url, { signal = null, timeoutMs, priority = "auto" }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, { cache: "no-store", credentials: "include", signal: controller.signal, priority });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

function parseMaster(text, masterUrl) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const formats = [];
  let attrs = null;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) { attrs = parseAttrs(line.slice(18)); continue; }
    if (line.startsWith("#") || !attrs) continue;
    const [width, height] = parseResolution(attrs.RESOLUTION);
    const fps = Number.parseFloat(attrs["FRAME-RATE"]) || null;
    const bandwidth = Number.parseInt(attrs.BANDWIDTH, 10) || null;
    formats.push({ label: height ? `${height}p${fps ? " · " + Math.round(fps) + "fps" : ""}` : "화질", url: new URL(line, masterUrl).href, width, height, fps, bandwidth });
    attrs = null;
  }
  return formats.sort((a, b) => ((b.height || 0) - (a.height || 0)) || ((b.bandwidth || 0) - (a.bandwidth || 0)));
}

function parseMedia(text, playlistUrl) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const segments = [];
  let mapUrl = null;
  let duration = 0;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttrs(line.slice(11));
      if (attrs.URI) mapUrl = new URL(attrs.URI, playlistUrl).href;
    } else if (line.startsWith("#EXTINF:")) {
      duration = Number.parseFloat(line.slice(8).split(",", 1)[0]) || 0;
    } else if (!line.startsWith("#")) {
      segments.push({ url: new URL(line, playlistUrl).href, duration });
      duration = 0;
    }
  }
  return { mapUrl, segments };
}

function parseAttrs(value) {
  const attrs = {};
  let current = "";
  let quote = false;
  const parts = [];
  for (const char of value) {
    if (char === '"') { quote = !quote; current += char; continue; }
    if (char === "," && !quote) { parts.push(current); current = ""; continue; }
    current += char;
  }
  if (current) parts.push(current);
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index !== -1) attrs[part.slice(0, index).trim()] = part.slice(index + 1).trim().replace(/^"|"$/g, "");
  }
  return attrs;
}

function parseResolution(value = "") {
  const [width, height] = value.split("x").map((part) => Number.parseInt(part, 10));
  return [Number.isFinite(width) ? width : null, Number.isFinite(height) ? height : null];
}

function selectFormat(formats, maxHeight) {
  return formats.find((format) => !format.height || format.height <= maxHeight) || formats[0] || null;
}

function controllerAbort(signal) {
  signal.dispatchEvent?.(new Event("abort"));
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}
function formatSpeed(bytes) { return `${formatBytes(bytes)}/s`; }
function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function safeName(value) { return String(value || "video").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80); }
function formatError(error) { return error instanceof Error ? error.message : String(error); }
function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }

