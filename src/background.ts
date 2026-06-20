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

  if (message.type === "EDITOR_ADD_VIDEO") {
    const targetTabId = message.payload?.targetTabId;
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
      await notifyEditorAboutChzzkTab(tab);
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

  if (message.target === "background" && message.type === "OFFSCREEN_SAVE_FILE") {
    const payload = message.payload;
    await waitForDownload(
      await chrome.downloads.download({
        url: payload.objectUrl,
        filename: ensureMp4Filename(payload.filename),
        saveAs: false,
        conflictAction: "uniquify",
      }),
    );
    return { ok: true };
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
    width: 1320,
    height: 860,
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

function isChzzkPlayableUrl(url) {
  return typeof url === "string" && CHZZK_URL_PATTERN.test(url);
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
