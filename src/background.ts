// @ts-nocheck
export {};

const OFFSCREEN_URL = "offscreen.html";
const EDITOR_URL = "downloader.html";
const CHZZK_URL_PATTERN = /^https:\/\/chzzk\.naver\.com\/(?:video\/\d+|clips\/[A-Za-z0-9_-]+)/;
const CHZZK_QUERY_URLS = [
  "https://chzzk.naver.com/video/*",
  "https://chzzk.naver.com/clips/*",
];

let offscreenCreation = null;
let editorWindowId = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ installedAt: Date.now() });
});

chrome.action.onClicked.addListener(async () => {
  await openOrFocusEditorWindow();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response || { ok: true }))
    .catch((error) => {
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab?.url;
  if (!isChzzkPlayableUrl(url)) {
    return;
  }
  if (changeInfo.status && changeInfo.status !== "complete") {
    return;
  }
  notifyEditorAboutChzzkTab({ ...tab, id: tabId, url }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  broadcastToEditorPages({
    type: "CHZZK_TAB_REMOVED",
    payload: { tabId },
  }).catch(() => {});
});

async function handleMessage(message, sender) {
  if (!message?.type || message.target === "offscreen") {
    return { ok: true };
  }

  if (message.type === "EDITOR_OPEN_WINDOW") {
    const tab = await openOrFocusEditorWindow(message.payload || {});
    return { ok: true, tabId: tab?.id, windowId: tab?.windowId };
  }

  if (message.type === "EDITOR_COLLECT_CHZZK_TABS") {
    return { ok: true, tabs: await collectChzzkTabs() };
  }

  if (message.type === "EDITOR_FOCUS_TAB") {
    await focusTab(message.payload?.tabId);
    return { ok: true };
  }

  if (message.type === "EDITOR_OPEN_SOURCE_TAB") {
    const tab = await openSourceTab(message.payload?.url);
    return { ok: true, tab: serializeTab(tab) };
  }

  if (message.type === "EDITOR_ADD_VIDEO") {
    const targetTabId = message.payload?.targetTabId;
    if (targetTabId && sender?.tab?.id === targetTabId) {
      return { ok: true };
    }
    if (targetTabId) {
      await chrome.tabs.sendMessage(targetTabId, message);
      return { ok: true };
    }
    const tab = await openOrFocusEditorWindow({ addUrl: message.payload?.url });
    return { ok: true, tabId: tab?.id, windowId: tab?.windowId };
  }

  if (message.type === "CHZZK_PAGE_READY") {
    const tab = sender?.tab;
    if (tab?.id && isChzzkPlayableUrl(tab.url)) {
      await notifyEditorAboutChzzkTab({
        ...tab,
        url: message.payload?.url || tab.url,
        title: message.payload?.title || tab.title,
        thumbnailUrl: message.payload?.thumbnailUrl || "",
        durationSeconds: message.payload?.durationSeconds ?? null,
      });
    }
    return { ok: true };
  }

  if (message.type === "CHZZK_PLAYER_COMMAND") {
    const tabId = Number(message.payload?.tabId);
    if (!Number.isFinite(tabId)) {
      throw Error("연결된 치지직 탭을 찾지 못했습니다.");
    }
    await ensurePlayerBridge(tabId);
    return await chrome.tabs.sendMessage(tabId, {
      type: "CHZZK_PLAYER_COMMAND",
      command: message.payload?.command,
      time: message.payload?.time,
    });
  }

  if (message.type === "DOWNLOAD_QUEUE_JOB") {
    await sendToOffscreen("OFFSCREEN_QUEUE_JOB", message.payload);
    return { ok: true };
  }
  if (message.type === "DOWNLOAD_CANCEL_JOB") {
    await sendToOffscreen("OFFSCREEN_CANCEL_JOB", message.payload);
    return { ok: true };
  }
  if (message.type === "DOWNLOAD_PAUSE_JOB") {
    await sendToOffscreen("OFFSCREEN_PAUSE_JOB", message.payload);
    return { ok: true };
  }
  if (message.type === "DOWNLOAD_RESUME_JOB") {
    await sendToOffscreen("OFFSCREEN_RESUME_JOB", message.payload);
    return { ok: true };
  }
  if (message.type === "DOWNLOAD_DELETE_JOB") {
    await sendToOffscreen("OFFSCREEN_DELETE_JOB", message.payload);
    return { ok: true };
  }
  if (message.type === "DOWNLOAD_INTERACTIVE_STATE") {
    await sendToOffscreen("OFFSCREEN_INTERACTIVE_STATE", message.payload);
    return { ok: true };
  }
  if (message.type === "DOWNLOAD_CLEAR_JOBS") {
    await emitDebugLog("background", "clearJobs.forward", {
      reason: message.payload?.reason || "",
    });
    await sendToOffscreen("OFFSCREEN_CLEAR_JOBS", message.payload);
    return { ok: true };
  }

  if (message.target === "background" && message.type === "OFFSCREEN_JOB_UPDATE") {
    await broadcastToEditorPages({
      type: "DOWNLOAD_JOB_UPDATE",
      payload: message.payload,
    });
    return { ok: true };
  }

  if (message.target === "background" && message.type === "OFFSCREEN_DEBUG_LOG") {
    await emitDebugLog("offscreen", message.payload?.event || "log", message.payload?.data || {});
    return { ok: true };
  }

  if (message.target === "background" && message.type === "OFFSCREEN_SAVE_FILE") {
    const payload = message.payload;
    await emitDebugLog("background", "saveFile.start", {
      filename: payload.filename,
      objectUrl: Boolean(payload.objectUrl),
    });
    await waitForDownload(
      await chrome.downloads.download({
        url: payload.objectUrl,
        filename: ensureMp4Filename(payload.filename),
        saveAs: false,
        conflictAction: "uniquify",
      }),
    );
    await emitDebugLog("background", "saveFile.done", {
      filename: payload.filename,
    });
    return { ok: true };
  }

  if (message.target === "background" && message.type === "OFFSCREEN_FETCH_BINARY") {
    await emitDebugLog("background", "contextFetch.request", {
      url: sanitizeDebugUrl(message.payload?.url),
      sourceTabId: message.payload?.sourceTabId || null,
      sourceUrl: sanitizeDebugUrl(message.payload?.sourceUrl),
    });
    return {
      ok: true,
      bytes: await fetchBinaryFromChzzkContext(message.payload || {}),
    };
  }

  return { ok: true };
}

async function ensurePlayerBridge(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "CHZZK_PLAYER_COMMAND", command: "state" });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: installInjectedPlayerBridge,
    });
  }
}

async function ensureContextFetchBridge(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "CHZZK_CONTEXT_FETCH",
      payload: { probe: true },
    });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: installInjectedContextFetchBridge,
    });
  }
}

function installInjectedContextFetchBridge() {
  if (window.__CHZZK_SAVER_CONTEXT_FETCH_BRIDGE__) {
    return;
  }
  window.__CHZZK_SAVER_CONTEXT_FETCH_BRIDGE__ = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "CHZZK_CONTEXT_FETCH") {
      return false;
    }

    handleContextFetch(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return true;
  });

  async function handleContextFetch(message) {
    if (message.payload?.probe) {
      return { ready: true };
    }

    const url = String(message.payload?.url || "");
    if (!/^https:\/\/api\.chzzk\.naver\.com\//.test(url)) {
      throw Error("허용되지 않은 치지직 요청입니다.");
    }

    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) {
      throw Error(`HTTP ${response.status}`);
    }

    return {
      bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
    };
  }
}

function installInjectedPlayerBridge() {
  if (window.__CHZZK_SAVER_PLAYER_BRIDGE__) {
    return;
  }
  window.__CHZZK_SAVER_PLAYER_BRIDGE__ = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "CHZZK_PLAYER_COMMAND") {
      return false;
    }

    handlePlayerCommand(message)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return true;
  });

  notifyReady();
  window.addEventListener("pageshow", notifyReady);

  async function handlePlayerCommand(message) {
    const video = await waitForVideo();
    const command = message.command;

    if (command === "play") {
      await video.play();
    } else if (command === "pause") {
      video.pause();
    } else if (command === "seek") {
      video.currentTime = clampTime(message.time, video.duration);
    } else if (command === "toggle") {
      if (video.paused) {
        await video.play();
      } else {
        video.pause();
      }
    } else if (command !== "state") {
      throw Error("지원하지 않는 플레이어 명령입니다.");
    }

    return getPlayerState(video);
  }

  async function waitForVideo() {
    const existing = findVideo();
    if (existing) {
      return existing;
    }

    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const observer = new MutationObserver(() => {
        const video = findVideo();
        if (video) {
          observer.disconnect();
          resolve(video);
        } else if (Date.now() - startedAt > 10000) {
          observer.disconnect();
          reject(Error("치지직 플레이어를 찾지 못했습니다."));
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  function findVideo() {
    const videos = [...document.querySelectorAll("video")];
    return videos.find((video) => video.readyState >= HTMLMediaElement.HAVE_METADATA) || videos[0] || null;
  }

  function getPlayerState(video) {
    return {
      url: location.href,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      paused: video.paused,
      ended: video.ended,
      readyState: video.readyState,
    };
  }

  function clampTime(time, duration) {
    const numeric = Number(time);
    if (!Number.isFinite(numeric)) {
      return 0;
    }
    const max = Number.isFinite(duration) ? duration : Number.MAX_SAFE_INTEGER;
    return Math.min(Math.max(0, numeric), max);
  }

  function notifyReady() {
    chrome.runtime.sendMessage({
      type: "CHZZK_PAGE_READY",
      payload: { url: location.href },
    }).catch(() => {});
  }
}

async function openOrFocusEditorWindow({ addUrl = "" } = {}) {
  const existing = await findEditorTab();
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId) {
      editorWindowId = existing.windowId;
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    if (addUrl) {
      await chrome.tabs.sendMessage(existing.id, {
        type: "EDITOR_ADD_VIDEO",
        payload: {
          url: addUrl,
          targetTabId: existing.id,
          select: true,
          clearInput: true,
        },
      }).catch(() => {});
    }
    return existing;
  }

  const url = addUrl
    ? chrome.runtime.getURL(`${EDITOR_URL}?addUrl=${encodeURIComponent(addUrl)}`)
    : chrome.runtime.getURL(EDITOR_URL);
  const win = await chrome.windows.create({
    url,
    type: "popup",
    width: 520,
    height: 574,
    focused: true,
  });
  editorWindowId = win.id ?? null;
  return win.tabs?.[0] || null;
}

async function findEditorTab() {
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL(`${EDITOR_URL}*`) });
  if (!tabs.length) {
    editorWindowId = null;
    return null;
  }
  const preferred = editorWindowId
    ? tabs.find((tab) => tab.windowId === editorWindowId)
    : null;
  return preferred || tabs[0];
}

async function collectChzzkTabs() {
  const groups = await Promise.all(CHZZK_QUERY_URLS.map((url) => chrome.tabs.query({ url })));
  return groups.flat().filter((tab) => isChzzkPlayableUrl(tab.url)).map(serializeTab);
}

async function notifyEditorAboutChzzkTab(tab) {
  await broadcastToEditorPages({
    type: "CHZZK_TAB_DISCOVERED",
    payload: serializeTab(tab),
  });
}

function serializeTab(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title || "",
    thumbnailUrl: tab.thumbnailUrl || "",
    durationSeconds: tab.durationSeconds ?? null,
  };
}

async function focusTab(tabId) {
  const numericTabId = Number(tabId);
  if (!Number.isFinite(numericTabId)) {
    throw Error("연결된 치지직 탭을 찾지 못했습니다.");
  }
  const tab = await chrome.tabs.update(numericTabId, { active: true });
  if (tab?.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

async function openSourceTab(url) {
  if (!isChzzkPlayableUrl(url)) {
    throw Error("열 수 있는 치지직 주소가 없습니다.");
  }
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const targetWindow = windows.find((win) => win.focused) || windows[0] || null;
  const tab = await chrome.tabs.create({
    url,
    active: true,
    ...(targetWindow?.id ? { windowId: targetWindow.id } : {}),
  });
  if (tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return tab;
}

async function fetchBinaryFromChzzkContext(payload) {
  const url = String(payload.url || "");
  const sourceUrl = String(payload.sourceUrl || "");
  if (!/^https:\/\/api\.chzzk\.naver\.com\//.test(url)) {
    throw Error("허용되지 않은 치지직 요청입니다.");
  }

  let tab = await resolveChzzkContextTab(payload.sourceTabId, sourceUrl);
  let createdTabId = null;
  if (!tab?.id) {
    if (!isChzzkPlayableUrl(sourceUrl)) {
      throw Error("AES 키를 받을 치지직 원본 탭을 찾지 못했습니다.");
    }
    tab = await chrome.tabs.create({ url: sourceUrl, active: false });
    createdTabId = tab.id ?? null;
  }

  if (!tab?.id) {
    throw Error("AES 키를 받을 치지직 원본 탭을 열지 못했습니다.");
  }

  try {
    await waitForTabComplete(tab.id);
    await ensureContextFetchBridge(tab.id);
    await emitDebugLog("background", "contextFetch.tabReady", {
      tabId: tab.id,
      createdTabId,
      tabUrl: sanitizeDebugUrl(tab.url),
    });
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "CHZZK_CONTEXT_FETCH",
      payload: { url },
    });
    if (response?.ok === false) {
      throw Error(response.message || "치지직 페이지에서 AES 키를 받지 못했습니다.");
    }
    if (!Array.isArray(response?.bytes)) {
      throw Error("치지직 페이지의 AES 키 응답이 올바르지 않습니다.");
    }
    await emitDebugLog("background", "contextFetch.done", {
      byteLength: response.bytes.length,
    });
    return response.bytes;
  } finally {
    if (createdTabId) {
      chrome.tabs.remove(createdTabId).catch(() => {});
    }
  }
}

async function resolveChzzkContextTab(sourceTabId, sourceUrl) {
  const tabId = Number(sourceTabId);
  if (Number.isFinite(tabId)) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.id && isChzzkPlayableUrl(tab.url)) {
      return tab;
    }
  }

  const tabs = await collectChzzkTabs();
  if (sourceUrl) {
    const normalized = normalizeChzzkTabUrl(sourceUrl);
    const matched = tabs.find((tab) => normalizeChzzkTabUrl(tab.url) === normalized);
    if (matched?.tabId) {
      return chrome.tabs.get(matched.tabId).catch(() => null);
    }
  }
  if (tabs[0]?.tabId) {
    return chrome.tabs.get(tabs[0].tabId).catch(() => null);
  }
  return null;
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(Error("치지직 원본 탭 로딩 시간이 초과되었습니다."));
    }, 20000);
    const cleanup = () => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        cleanup();
        resolve();
      }
    }).catch((error) => {
      cleanup();
      reject(error);
    });
  });
}

function isChzzkPlayableUrl(url) {
  return typeof url === "string" && CHZZK_URL_PATTERN.test(url);
}

function normalizeChzzkTabUrl(url) {
  const match = String(url || "").match(CHZZK_URL_PATTERN);
  return match ? match[0] : String(url || "");
}

async function emitDebugLog(source, event, data = {}) {
  await broadcastToEditorPages({
    type: "DOWNLOAD_DEBUG_LOG",
    payload: {
      source,
      event,
      data,
      at: Date.now(),
    },
  }).catch(() => {});
}

function sanitizeDebugUrl(url) {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(String(url));
    for (const key of parsed.searchParams.keys()) {
      if (/key|token|hmac|hdnts|auth|signature/i.test(key)) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }
    return parsed.href;
  } catch {
    return String(url).slice(0, 300);
  }
}

function ensureMp4Filename(filename) {
  const safeName = String(filename || "video.mp4").trim() || "video.mp4";
  return /\.mp4$/i.test(safeName) ? safeName : `${safeName.replace(/\.[^.\\/]+$/, "")}.mp4`;
}

async function sendToOffscreen(type, payload) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ target: "offscreen", type, payload });
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  offscreenCreation ||= chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["BLOBS"],
    justification: "다운로드한 영상 데이터를 MP4 파일로 조립하고 임시 Blob URL을 생성합니다.",
  }).finally(() => {
    offscreenCreation = null;
  });

  await offscreenCreation;
}

async function hasOffscreenDocument() {
  if (chrome.offscreen.hasDocument) {
    return chrome.offscreen.hasDocument();
  }
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  return (await globalThis.clients.matchAll()).some((client) => client.url === offscreenUrl);
}

async function broadcastToEditorPages(message) {
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL(`${EDITOR_URL}*`) });
  await Promise.allSettled(
    tabs.map((tab) => tab.id ? chrome.tabs.sendMessage(tab.id, message) : Promise.resolve()),
  );
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback(value);
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId) {
        return;
      }
      if (delta.error?.current) {
        finish(reject, Error(`브라우저 저장 실패: ${delta.error.current}`));
        return;
      }
      if (delta.state?.current === "complete") {
        finish(resolve);
        return;
      }
      if (delta.state?.current === "interrupted") {
        finish(reject, Error("브라우저 저장이 중단되었습니다."));
      }
    };
    const cleanup = () => chrome.downloads.onChanged.removeListener(onChanged);

    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId })
      .then(([download]) => {
        if (download?.state === "complete") {
          finish(resolve);
        } else if (download?.state === "interrupted") {
          finish(reject, Error("브라우저 저장이 중단되었습니다."));
        }
      })
      .catch((error) => finish(reject, error));
  });
}
