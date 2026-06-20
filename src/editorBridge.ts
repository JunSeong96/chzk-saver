// @ts-nocheck
export {};

const CHZZK_URL_PATTERN = /^https:\/\/chzzk\.naver\.com\/(?:video\/\d+|clips\/[A-Za-z0-9_-]+)/;

const remotePanel = query("#remotePanel");
const remoteStatus = query("#remoteStatus");
const remoteFocusButton = query("#remoteFocusButton");
const remotePlayButton = query("#remotePlayButton");
const remotePauseButton = query("#remotePauseButton");
const remoteSyncButton = query("#remoteSyncButton");
const remoteMarkStartButton = query("#remoteMarkStartButton");
const remoteMarkEndButton = query("#remoteMarkEndButton");
const remoteTimeText = query("#remoteTimeText");

let editorTabId = null;
const sourceTabsByUrl = new Map();
const sourceTabsById = new Map();

init().catch((error) => {
  remoteStatus.textContent = error instanceof Error ? error.message : String(error);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "CHZZK_TAB_DISCOVERED") {
    registerSourceTab(message.payload, { addToEditor: true });
    return false;
  }
  if (message?.type === "CHZZK_TAB_REMOVED") {
    removeSourceTab(message.payload?.tabId);
    return false;
  }
  return false;
});

document.addEventListener("click", (event) => {
  if (event.target?.closest?.(".editor-item-main")) {
    window.setTimeout(refreshRemotePanel, 0);
  }
});

remoteFocusButton.addEventListener("click", () => focusSelectedSourceTab().catch(showRemoteError));
remotePlayButton.addEventListener("click", () => sendPlayerCommand("play").catch(showRemoteError));
remotePauseButton.addEventListener("click", () => sendPlayerCommand("pause").catch(showRemoteError));
remoteSyncButton.addEventListener("click", () => syncCurrentTime().catch(showRemoteError));
remoteMarkStartButton.addEventListener("click", () => markCurrentTime("start").catch(showRemoteError));
remoteMarkEndButton.addEventListener("click", () => markCurrentTime("end").catch(showRemoteError));

async function init() {
  const tab = await chrome.tabs.getCurrent();
  editorTabId = tab?.id ?? null;
  await collectOpenChzzkTabs();
  window.setInterval(() => collectOpenChzzkTabs().catch(() => {}), 5000);
  window.setInterval(() => refreshRemotePanel(), 1000);
}

async function collectOpenChzzkTabs() {
  const response = await chrome.runtime.sendMessage({ type: "EDITOR_COLLECT_CHZZK_TABS" });
  if (response?.ok === false) {
    throw Error(response.message || "열린 치지직 탭을 읽지 못했습니다.");
  }
  for (const tab of response?.tabs || []) {
    registerSourceTab(tab, { addToEditor: true });
  }
  refreshRemotePanel();
}

function registerSourceTab(tab, { addToEditor = false } = {}) {
  if (!tab?.url || !CHZZK_URL_PATTERN.test(tab.url) || !tab.tabId) {
    return;
  }
  const normalizedUrl = normalizeUrl(tab.url);
  const source = { ...tab, url: normalizedUrl };
  sourceTabsByUrl.set(normalizedUrl, source);
  sourceTabsById.set(String(tab.tabId), source);
  bindSourceToExistingCard(source);
  if (addToEditor) {
    addSourceToEditor(source).catch(() => {});
  }
  refreshRemotePanel();
}

function removeSourceTab(tabId) {
  const key = String(tabId);
  const source = sourceTabsById.get(key);
  sourceTabsById.delete(key);
  if (source) {
    sourceTabsByUrl.delete(source.url);
  }
  for (const card of document.querySelectorAll(`.editor-item[data-source-tab-id="${key}"]`)) {
    card.dataset.sourceTabId = "";
  }
  refreshRemotePanel();
}

async function addSourceToEditor(source) {
  if (!editorTabId) {
    return;
  }
  await chrome.runtime.sendMessage({
    type: "EDITOR_ADD_VIDEO",
    payload: {
      url: source.url,
      tabId: source.tabId,
      windowId: source.windowId,
      title: source.title,
      targetTabId: editorTabId,
      select: false,
      clearInput: true,
    },
  });
}

function bindSourceToExistingCard(source) {
  for (const card of document.querySelectorAll(".editor-item")) {
    if (normalizeUrl(card.dataset.url || "") === source.url) {
      card.dataset.sourceTabId = String(source.tabId);
      card.dataset.sourceWindowId = String(source.windowId || "");
    }
  }
}

async function focusSelectedSourceTab() {
  const source = getSelectedSource();
  if (!source?.tabId) {
    throw Error("연결된 치지직 탭이 없습니다.");
  }
  await chrome.runtime.sendMessage({
    type: "EDITOR_FOCUS_TAB",
    payload: { tabId: source.tabId },
  });
}

async function sendPlayerCommand(command, payload = {}) {
  const source = getSelectedSource();
  if (!source?.tabId) {
    throw Error("연결된 치지직 탭이 없습니다.");
  }
  const response = await chrome.runtime.sendMessage({
    type: "CHZZK_PLAYER_COMMAND",
    payload: { tabId: source.tabId, command, ...payload },
  });
  if (response?.ok === false) {
    throw Error(response.message || "원본 플레이어를 제어하지 못했습니다.");
  }
  updateRemoteState(response?.state);
  return response?.state;
}

async function syncCurrentTime() {
  const state = await sendPlayerCommand("state");
  if (typeof state?.currentTime === "number") {
    window.dispatchEvent(new CustomEvent("chzzk-saver:seek-editor-range", {
      detail: { time: state.currentTime },
    }));
  }
}

async function markCurrentTime(target) {
  const state = await sendPlayerCommand("state");
  if (typeof state?.currentTime !== "number") {
    return;
  }
  window.dispatchEvent(new CustomEvent(
    target === "start" ? "chzzk-saver:set-range-start" : "chzzk-saver:set-range-end",
    { detail: { time: state.currentTime } },
  ));
}

function refreshRemotePanel() {
  const selected = getSelectedCard();
  remotePanel.hidden = !selected;
  if (!selected) {
    return;
  }
  const source = getSelectedSource();
  if (!source?.tabId) {
    remoteStatus.textContent = "원본 탭 연결 없음";
    setRemoteDisabled(true);
    return;
  }
  remoteStatus.textContent = "원본 탭 연결됨";
  setRemoteDisabled(false);
}

function updateRemoteState(state) {
  if (!state) {
    return;
  }
  remoteStatus.textContent = state.paused ? "일시정지됨" : "재생 중";
  remoteTimeText.textContent = `${formatTime(state.currentTime)}${state.duration ? ` / ${formatTime(state.duration)}` : ""}`;
}

function getSelectedSource() {
  const selected = getSelectedCard();
  if (!selected) {
    return null;
  }
  const tabId = selected.dataset.sourceTabId;
  if (tabId && sourceTabsById.has(tabId)) {
    return sourceTabsById.get(tabId);
  }
  const url = normalizeUrl(selected.dataset.url || "");
  return sourceTabsByUrl.get(url) || null;
}

function getSelectedCard() {
  return document.querySelector(".editor-item.selected");
}

function setRemoteDisabled(disabled) {
  for (const button of [
    remoteFocusButton,
    remotePlayButton,
    remotePauseButton,
    remoteSyncButton,
    remoteMarkStartButton,
    remoteMarkEndButton,
  ]) {
    button.disabled = disabled;
  }
}

function showRemoteError(error) {
  remoteStatus.textContent = error instanceof Error ? error.message : String(error);
}

function normalizeUrl(url) {
  const match = String(url || "").match(/https:\/\/chzzk\.naver\.com\/(?:video\/\d+|clips\/[A-Za-z0-9_-]+)/);
  return match?.[0] || "";
}

function formatTime(value) {
  const total = Math.max(0, Number.parseInt(value, 10) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function query(selector) {
  const element = document.querySelector(selector);
  if (!element) {
    throw Error(`필수 UI 요소를 찾을 수 없습니다: ${selector}`);
  }
  return element;
}
