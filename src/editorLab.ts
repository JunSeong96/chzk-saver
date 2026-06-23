export {};

type MediaKind = "video" | "clip";
type ItemState = "preview" | "loading" | "ready" | "error";

type EditorItem = {
  id: string;
  url: string;
  title: string;
  thumbnailUrl: string;
  durationSeconds: number | null;
  contentKind: string;
  state: ItemState;
  loadMs: number | null;
  error?: string;
  metadataPromise?: Promise<void> | null;
};

const VIDEO_URL_RE = /^https:\/\/chzzk\.naver\.com\/video\/(?<id>\d+)(?:[/?#].*)?$/;
const CLIP_URL_RE = /^https:\/\/chzzk\.naver\.com\/clips\/(?<id>[A-Za-z0-9_-]+)(?:[/?#].*)?$/;

const el = {
  input: query<HTMLTextAreaElement>("#urlInput"),
  detectOnce: query<HTMLButtonElement>("#detectOnce"),
  detectDuplicate: query<HTMLButtonElement>("#detectDuplicate"),
  clear: query<HTMLButtonElement>("#clear"),
  items: query<HTMLDivElement>("#items"),
  log: query<HTMLPreElement>("#log"),
  eventCount: query<HTMLElement>("#eventCount"),
  itemCount: query<HTMLElement>("#itemCount"),
  loadedCount: query<HTMLElement>("#loadedCount"),
  dedupeCount: query<HTMLElement>("#dedupeCount"),
};

const items = new Map<string, EditorItem>();
let inputEvents = 0;
let dedupeCount = 0;
let logLines: string[] = [];

el.detectOnce.addEventListener("click", () => {
  detectOpenTabs(readUrls());
});

el.detectDuplicate.addEventListener("click", async () => {
  for (let i = 0; i < 3; i += 1) {
    detectOpenTabs(readUrls());
    await delay(250);
  }
});

el.clear.addEventListener("click", () => {
  items.clear();
  inputEvents = 0;
  dedupeCount = 0;
  logLines = [];
  render();
});

detectOpenTabs(readUrls());

function detectOpenTabs(urls: string[]) {
  for (const rawUrl of urls) {
    inputEvents += 1;
    const url = normalizeChzzkUrl(rawUrl);
    const parsed = parseChzzkUrl(url);
    if (!parsed) {
      pushLog(`무시: ${rawUrl}`);
      continue;
    }
    const tabSnapshot = createTabSnapshot(url, parsed);
    upsertEditorItem(tabSnapshot);
  }
  render();
}

function upsertEditorItem(snapshot: { url: string; title: string; contentKind: string }) {
  const existing = items.get(snapshot.url);
  if (existing) {
    dedupeCount += 1;
    existing.title = prefer(snapshot.title, existing.title);
    existing.contentKind = prefer(snapshot.contentKind, existing.contentKind);
    pushLog(`중복 감지 -> 기존 카드 갱신: ${snapshot.url}`);
    if (existing.state === "error") {
      loadMetadata(existing);
    }
    render();
    return existing;
  }

  const item: EditorItem = {
    id: crypto.randomUUID(),
    url: snapshot.url,
    title: snapshot.title,
    thumbnailUrl: "",
    durationSeconds: null,
    contentKind: snapshot.contentKind,
    state: "preview",
    loadMs: null,
    metadataPromise: null,
  };
  items.set(item.url, item);
  pushLog(`카드 생성: ${item.url}`);
  loadMetadata(item);
  render();
  return item;
}

function loadMetadata(item: EditorItem) {
  if (item.metadataPromise) {
    return item.metadataPromise;
  }
  item.state = item.thumbnailUrl || item.durationSeconds ? "preview" : "loading";
  item.error = "";
  item.metadataPromise = (async () => {
    const startedAt = performance.now();
    const response = await fetch(`/api/media?url=${encodeURIComponent(item.url)}`, {
      cache: "no-store",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw Error(body?.message || `HTTP ${response.status}`);
    }
    item.title = prefer(body.title, item.title);
    item.thumbnailUrl = prefer(body.thumbnailUrl, item.thumbnailUrl);
    item.durationSeconds = Number.isFinite(Number(body.durationSeconds)) ? Number(body.durationSeconds) : item.durationSeconds;
    item.contentKind = prefer(body.contentKind, item.contentKind);
    item.loadMs = Math.round(body.loadMs ?? performance.now() - startedAt);
    item.state = "ready";
    pushLog(`로드 완료 ${item.loadMs}ms: ${item.url}`);
  })().catch((error) => {
    item.state = "error";
    item.error = error instanceof Error ? error.message : String(error);
    pushLog(`로드 실패: ${item.url} / ${item.error}`);
  }).finally(() => {
    item.metadataPromise = null;
    render();
  });
  render();
  return item.metadataPromise;
}

function createTabSnapshot(url: string, parsed: { type: MediaKind; id: string }) {
  return {
    url,
    title: parsed.type === "video" ? `탭 제목 ${parsed.id}` : `클립 탭 ${parsed.id}`,
    contentKind: parsed.type === "video" ? "영상" : "클립",
  };
}

function readUrls() {
  return el.input.value
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeChzzkUrl(value: string) {
  const parsed = parseChzzkUrl(value);
  if (!parsed) return value.trim();
  return parsed.type === "video"
    ? `https://chzzk.naver.com/video/${parsed.id}`
    : `https://chzzk.naver.com/clips/${parsed.id}`;
}

function parseChzzkUrl(value: string): { type: MediaKind; id: string } | null {
  const text = String(value || "").trim();
  const video = text.match(VIDEO_URL_RE);
  if (video?.groups?.id) return { type: "video", id: video.groups.id };
  const clip = text.match(CLIP_URL_RE);
  if (clip?.groups?.id) return { type: "clip", id: clip.groups.id };
  return null;
}

function render() {
  const values = [...items.values()];
  el.eventCount.textContent = String(inputEvents);
  el.itemCount.textContent = String(values.length);
  el.loadedCount.textContent = String(values.filter((item) => item.state === "ready").length);
  el.dedupeCount.textContent = String(dedupeCount);
  el.items.innerHTML = values.map(renderItem).join("") || `<p>감지된 항목이 없습니다.</p>`;
  el.log.textContent = logLines.slice(-80).join("\n");
}

function renderItem(item: EditorItem) {
  const duration = item.durationSeconds ? formatDuration(item.durationSeconds) : "길이 확인 중";
  const thumbnail = item.thumbnailUrl || "/assets/logo.png";
  const stateLabel = item.state === "ready"
    ? `로드 완료${item.loadMs ? ` · ${item.loadMs}ms` : ""}`
    : item.state === "error"
      ? "오류"
      : item.state === "loading"
        ? "불러오는 중"
        : "탭 정보";
  return `
    <article class="card" data-url="${escapeHtml(item.url)}" data-loaded="${item.state === "ready"}">
      <div class="card-main">
        <img src="${escapeHtml(thumbnail)}" alt="">
        <div>
          <div class="title">${escapeHtml(item.title || "영상 정보를 불러오는 중")}</div>
          <div class="meta">
            <span class="kind">${escapeHtml(item.contentKind || "영상")}</span>
            <span>${escapeHtml(duration)}</span>
            ${item.error ? `<span class="error">${escapeHtml(item.error)}</span>` : ""}
          </div>
        </div>
        <span class="state">${escapeHtml(stateLabel)}</span>
      </div>
      <pre>${escapeHtml(item.url)}</pre>
    </article>
  `;
}

function pushLog(message: string) {
  logLines.push(`${new Date().toLocaleTimeString()} ${message}`);
}

function prefer<T>(next: T, current: T): T {
  return next || current;
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector(selector);
  if (!element) throw Error(`필수 UI 요소를 찾을 수 없습니다: ${selector}`);
  return element as T;
}

function formatDuration(value: number) {
  const total = Math.max(0, Number.parseInt(String(value), 10) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] || char));
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
