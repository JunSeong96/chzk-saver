// @ts-nocheck
export {};

const urlInput = query("#vodUrl");
const addButton = query("#addToEditor");
const goButton = query("#goToEditor");
const statusText = query("#status");
const addView = query("#addView");
const doneView = query("#doneView");
const CHZZK_URL_PATTERN = /^https:\/\/chzzk\.naver\.com\/(?:video\/\d+|clips\/[A-Za-z0-9_-]+)/;

let editorTabId = null;

init().catch((error) => {
  statusText.textContent = error instanceof Error ? error.message : String(error);
});

addButton.addEventListener("click", () => {
  addCurrentInput().catch((error) => {
    statusText.textContent = error instanceof Error ? error.message : String(error);
  });
});

urlInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }
  event.preventDefault();
  addCurrentInput().catch((error) => {
    statusText.textContent = error instanceof Error ? error.message : String(error);
  });
});

goButton.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "EDITOR_OPEN_WINDOW", payload: {} });
  if (response?.ok !== false) {
    window.close();
  }
});

async function init() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.url && CHZZK_URL_PATTERN.test(activeTab.url)) {
    urlInput.value = activeTab.url;
    statusText.textContent = "현재 탭의 주소를 불러왔습니다.";
    return;
  }

  const saved = await chrome.storage.local.get("lastVodUrl");
  if (saved.lastVodUrl) {
    urlInput.value = saved.lastVodUrl;
  }
}

async function addCurrentInput() {
  const url = urlInput.value.trim();
  if (!url || !CHZZK_URL_PATTERN.test(url)) {
    statusText.textContent = "치지직 영상 또는 클립 주소를 입력해 주세요.";
    return;
  }

  addButton.disabled = true;
  statusText.textContent = "편집기에 추가하는 중입니다.";
  try {
    await chrome.storage.local.set({ lastVodUrl: url });
    const response = await chrome.runtime.sendMessage({
      type: "EDITOR_OPEN_WINDOW",
      payload: { addUrl: url },
    });
    if (response?.ok === false) {
      throw Error(response.message || "편집기를 열지 못했습니다.");
    }
    editorTabId = response?.tabId ?? null;
    showDoneView();
  } finally {
    addButton.disabled = false;
  }
}

function showDoneView() {
  addView.hidden = true;
  doneView.hidden = false;
}

function query(selector) {
  const element = document.querySelector(selector);
  if (!element) {
    throw Error(`필수 UI 요소를 찾을 수 없습니다: ${selector}`);
  }
  return element;
}
