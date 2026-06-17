// @ts-nocheck
export {};

const OFFSCREEN_URL = "offscreen.html";
let offscreenCreation = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ installedAt: Date.now() });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "EDITOR_ADD_VIDEO") {
    return false;
  }

  handleMessage(message)
    .then((response) => sendResponse(response || { ok: true }))
    .catch((error) => {
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

async function handleMessage(message) {
  if (!message?.type || message.target === "offscreen") {
    return { ok: true };
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
    await broadcastToDownloadPages({
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
        filename: payload.filename,
        saveAs: false,
        conflictAction: "uniquify",
      }),
    );
    return { ok: true };
  }

  return { ok: true };
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

async function broadcastToDownloadPages(message) {
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("downloader.html*") });
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
