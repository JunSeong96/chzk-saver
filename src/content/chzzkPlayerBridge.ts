// @ts-nocheck
export {};

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

let lastUrl = location.href;
window.setInterval(() => {
  if (lastUrl === location.href) {
    return;
  }
  lastUrl = location.href;
  notifyReady();
}, 1000);

async function handlePlayerCommand(message) {
  const video = await waitForVideo();
  const command = message.command;

  if (command === "play") {
    await video.play();
  } else if (command === "pause") {
    video.pause();
  } else if (command === "seek") {
    const time = clampTime(message.time, video.duration);
    video.currentTime = time;
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
