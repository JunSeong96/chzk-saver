// @ts-nocheck
export {};

const AUTO_QUALITY_TEXT = "\uC790\uB3D9";
const QUALITY_LABEL_TEXT = "\uD654\uC9C8";
const RESOLUTION_LABEL_TEXT = "\uD574\uC0C1\uB3C4";
const SETTINGS_LABEL_TEXT = "\uC124\uC815";
const MENU_LABEL_TEXT = "\uBA54\uB274";
const QUALITY_AUTO_ALGO_VERSION = "quality-auto-pzp-direct-2026-06-22-1";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CHZZK_CONTEXT_FETCH") {
    handleContextFetch(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return true;
  }

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
watchPlayableMetadata();

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
    await setPlaybackState(video, "play");
  } else if (command === "pause") {
    await setPlaybackState(video, "pause");
  } else if (command === "seek") {
    const time = clampTime(message.time, video.duration);
    video.currentTime = time;
  } else if (command === "toggle") {
    await setPlaybackState(video, video.paused ? "play" : "pause");
  } else if (command === "qualityAuto") {
    return { ...getPlayerState(video), ...(await setQualityAuto(video)) };
  } else if (command !== "state") {
    throw Error("지원하지 않는 플레이어 명령입니다.");
  }

  return getPlayerState(video);
}

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
  return videos
    .map((video) => ({ video, score: getVideoScore(video) }))
    .sort((a, b) => b.score - a.score)[0]?.video || null;
}

async function setQualityAuto(video) {
  const root = findPlayerRoot(video) || document;
  showPlayerControls(video, root);

  const select = findQualitySelect(root) || findQualitySelect(document);
  if (select) {
    const option = [...select.options].find((option) => isAutoText(option.textContent) || isAutoText(option.value));
    if (option) {
      if (select.value === option.value) {
        return { qualityAuto: true, qualityMethod: "select-current" };
      }
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      await delay(120);
      return { qualityAuto: true, qualityMethod: "select" };
    }
  }

  const settingsButton = findSettingsButton(root) || findSettingsButton(document) || findSettingsButtonByPosition(root, video);
  let button = settingsButton || findQualityButton(root) || findQualityButton(document);
  let method = settingsButton ? "settings-menu" : "menu";
  if (!button) {
    return { qualityAuto: false, qualityMethod: "not-found", qualityAlgoVersion: QUALITY_AUTO_ALGO_VERSION };
  }

  const qualityButtonText = cleanDebugText(getElementText(button));
  let directResult = await selectQualityAutoFromOpenSettings(`${method}-direct-current`);
  if (directResult) {
    return { ...directResult, qualityButtonText };
  }

  const settingsMenuAlreadyOpen = Boolean(settingsButton && findMenuPanel(settingsButton));
  if (settingsMenuAlreadyOpen) {
    method = `${method}-current`;
  } else {
    dispatchPointerClick(button);
    await delay(320);
  }
  directResult = await selectQualityAutoFromOpenSettings(`${method}-direct`);
  if (directResult) {
    return { ...directResult, qualityButtonText };
  }

  let option = findAutoQualityOption(root) || findAutoQualityOption(document);
  let qualityMenuText = "";
  let qualityPanelText = "";
  if (!option) {
    const qualityMenuItem = findQualityMenuItem(document) || findQualityMenuItem(root);
    if (qualityMenuItem && qualityMenuItem !== button) {
      qualityMenuText = cleanDebugText(getElementText(qualityMenuItem));
      dispatchPointerClick(getClickableElement(qualityMenuItem));
      await delay(320);
      option = findAutoQualityOption(document) || findAutoQualityOption(root);
      method = `${method}-submenu`;
    } else if (settingsButton) {
      const menuPanel = findMenuPanel(settingsButton);
      qualityPanelText = cleanDebugText(getElementText(menuPanel || document.body));
      if (clickMenuRowNearAnchor(settingsButton, 0, "menu")) {
        await delay(320);
        option = findAutoQualityOption(document) || findAutoQualityOption(root);
        method = `${method}-geometry-submenu`;
      }
    }
  }
  if (!option) {
    if (settingsButton && clickMenuRowNearAnchor(settingsButton, 0, "option")) {
      await delay(180);
      return { qualityAuto: true, qualityMethod: `${method}-geometry-auto`, qualityButtonText, qualityMenuText, qualityPanelText, qualityAlgoVersion: QUALITY_AUTO_ALGO_VERSION };
    }
    sendEscape(root);
    return { qualityAuto: false, qualityMethod: "auto-option-not-found", qualityButtonText, qualityMenuText, qualityPanelText, qualityAlgoVersion: QUALITY_AUTO_ALGO_VERSION };
  }
  const qualityOptionText = cleanDebugText(getElementText(option));
  dispatchPointerClick(getClickableElement(option));
  await delay(180);
  return { qualityAuto: true, qualityMethod: method, qualityButtonText, qualityMenuText, qualityPanelText, qualityOptionText, qualityAlgoVersion: QUALITY_AUTO_ALGO_VERSION };
}

async function setPlaybackState(video, action) {
  const targetPaused = action === "pause";
  if (video.paused === targetPaused && !(action === "play" && video.ended)) {
    return;
  }

  if (action === "play") {
    await playMediaElement(video);
  } else {
    pauseMediaElement(video);
  }

  if (!(await waitForPausedState(video, targetPaused))) {
    throw Error("Player playback state did not change.");
  }
}
async function playMediaElement(video) {
  await HTMLMediaElement.prototype.play.call(video);
}

function pauseMediaElement(video) {
  HTMLMediaElement.prototype.pause.call(video);
}

function clickPlaybackControl(video, action) {
  const button = findPlaybackButton(video, action);
  if (!button) {
    return false;
  }
  dispatchPointerClick(button);
  return true;
}

function clickVideoSurface(video) {
  dispatchPointerClick(video);
  return true;
}

function sendKeyboardToggle(video) {
  const target = findPlayerRoot(video) || video;
  target.focus?.({ preventScroll: true });
  for (const eventName of ["keydown", "keyup"]) {
    target.dispatchEvent(new KeyboardEvent(eventName, {
      key: " ",
      code: "Space",
      bubbles: true,
      cancelable: true,
      composed: true,
    }));
  }
  return true;
}

function dispatchPointerClick(element) {
  const rect = element.getBoundingClientRect?.();
  const x = rect ? Math.round(rect.left + rect.width / 2) : Math.round(innerWidth / 2);
  const y = rect ? Math.round(rect.top + rect.height / 2) : Math.round(innerHeight / 2);
  dispatchPointerClickAt(element, x, y);
}

function dispatchPointClick(x, y) {
  const target = document.elementFromPoint(x, y) || document.body;
  dispatchPointerClickAt(target, x, y);
}

function dispatchPointerClickAt(element, x, y) {
  element.dispatchEvent(new PointerEvent("pointerdown", pointerEventInit(x, y)));
  element.dispatchEvent(new MouseEvent("mousedown", mouseEventInit(x, y)));
  element.dispatchEvent(new PointerEvent("pointerup", pointerEventInit(x, y)));
  element.dispatchEvent(new MouseEvent("mouseup", mouseEventInit(x, y)));
  element.dispatchEvent(new MouseEvent("click", mouseEventInit(x, y)));
  element.click?.();
}

function showPlayerControls(video, root) {
  const rect = video.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2) || Math.round(innerWidth / 2);
  const y = Math.round(rect.top + rect.height / 2) || Math.round(innerHeight / 2);
  for (const target of [video, root].filter(Boolean)) {
    target.dispatchEvent(new PointerEvent("pointermove", { ...pointerEventInit(), clientX: x, clientY: y, buttons: 0 }));
    target.dispatchEvent(new MouseEvent("mousemove", { ...mouseEventInit(), clientX: x, clientY: y, buttons: 0 }));
  }
}

function pointerEventInit(x = Math.round(innerWidth / 2), y = Math.round(innerHeight / 2)) {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
  };
}

function mouseEventInit(x = Math.round(innerWidth / 2), y = Math.round(innerHeight / 2)) {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
  };
}

function findPlaybackButton(video, action) {
  const root = findPlayerRoot(video) || document;
  const wanted = action === "play"
    ? [/재생/, /play/i]
    : [/일시/, /정지/, /pause/i];
  const fallback = [/playback/i, /play/i, /pause/i, /pzp.*play/i];
  const controls = [...root.querySelectorAll("button, [role='button'], [aria-label], [class]")]
    .filter((element) => element !== video && isVisibleElement(element));
  return controls
    .map((element) => ({ element, score: getPlaybackControlScore(element, wanted, fallback) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.element || null;
}

function getPlaybackControlScore(element, wanted, fallback) {
  const text = [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.className,
    element.textContent,
  ].filter(Boolean).join(" ");
  let score = wanted.some((pattern) => pattern.test(text)) ? 100 : 0;
  if (fallback.some((pattern) => pattern.test(text))) {
    score += 20;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 64 && rect.height <= 64) {
    score += 8;
  }
  return score;
}

function findQualitySelect(root) {
  return [...root.querySelectorAll("select")]
    .find((select) => [...select.options].some((option) => isAutoText(option.textContent) || isQualityText(option.textContent))) || null;
}

function findQualityButton(root) {
  const controls = [...root.querySelectorAll("button, [role='button'], [role='menuitem'], [role='option'], [aria-label], [title], [data-testid], [class*='quality'], [class*='resolution']")]
    .filter((element) => isVisibleElement(element) && isCompactControl(element));
  return controls
    .map((element) => ({ element, score: getQualityControlScore(element) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.element || null;
}

function getQualityControlScore(element) {
  if (!isCompactControl(element)) {
    return 0;
  }
  const text = getElementText(element);
  let score = 0;
  if (new RegExp(`quality|resolution|pzp.*quality|${QUALITY_LABEL_TEXT}|${RESOLUTION_LABEL_TEXT}`, "i").test(text)) {
    score += 100;
  }
  if (isQualityText(text)) {
    score += 45;
  }
  if (score <= 0) {
    return 0;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 120 && rect.height <= 80) {
    score += 8;
  }
  return score;
}

function findSettingsButton(root) {
  const controls = [...root.querySelectorAll("button, [role='button'], [aria-label], [title], [data-testid], [class*='setting']")]
    .filter((element) => isVisibleElement(element) && isCompactControl(element));
  return controls
    .map((element) => ({ element, score: getSettingsControlScore(element) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.element || null;
}

function getSettingsControlScore(element) {
  if (!isCompactControl(element)) {
    return 0;
  }
  const text = getElementText(element);
  if (/clip|custom__clip|pip|fullscreen|viewmode|volume|playback|prev|next|클립|전체\s*화면|넓은\s*화면/i.test(text) && !/pzp-setting-button|pzp-pc-setting-button/i.test(text)) {
    return 0;
  }
  let score = 0;
  if (/pzp-setting-button|pzp-pc-setting-button/i.test(text)) {
    score += 180;
  }
  if (new RegExp(`(^|\\s)${SETTINGS_LABEL_TEXT}(\\s|$)|menu open|open settings`, "i").test(text)) {
    score += 90;
  }
  if (new RegExp(`setting|settings|option|options|pzp.*setting|${SETTINGS_LABEL_TEXT}|${MENU_LABEL_TEXT}`, "i").test(text)) {
    score += 100;
  }
  if (score <= 0) {
    return 0;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 80 && rect.height <= 80) {
    score += 12;
  }
  return score;
}

function findSettingsButtonByPosition(root, video) {
  const playerRect = (findPlayerRoot(video) || video).getBoundingClientRect();
  const controls = [...root.querySelectorAll("button, [role='button'], [aria-label], [title], [data-testid], [class]")]
    .filter((element) => isVisibleElement(element) && isCompactControl(element))
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => {
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      return (
        centerX >= playerRect.left + playerRect.width * 0.52 &&
        centerX <= playerRect.right + 8 &&
        centerY >= playerRect.bottom - Math.max(140, playerRect.height * 0.2) &&
        centerY <= playerRect.bottom + 12
      );
    })
    .sort((a, b) => {
      const aCenterX = a.rect.left + a.rect.width / 2;
      const bCenterX = b.rect.left + b.rect.width / 2;
      return bCenterX - aCenterX;
    });

  return controls[2]?.element || controls[1]?.element || controls[0]?.element || null;
}

function findAutoQualityOption(root) {
  const options = [...root.querySelectorAll("button, [role='button'], [role='menuitem'], [role='option'], li, div, span, [aria-label], [title], [data-testid], [class*='quality']")]
    .filter((element) => isVisibleElement(element) && isMenuOptionCandidate(element) && isAutoText(getElementText(element)));
  return options
    .map((element) => ({ element, score: getAutoOptionScore(element) }))
    .sort((a, b) => b.score - a.score)[0]?.element || null;
}

function findQualityMenuItem(root) {
  const options = [...root.querySelectorAll("button, [role='button'], [role='menuitem'], [role='option'], li, div, span, [aria-label], [title], [data-testid], [class*='quality'], [class*='resolution']")]
    .filter((element) => isVisibleElement(element) && isMenuOptionCandidate(element));
  return options
    .map((element) => ({ element, score: getQualityMenuItemScore(element) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.element || null;
}

function getQualityMenuItemScore(element) {
  const text = getElementText(element);
  let score = 0;
  if (new RegExp(`${QUALITY_LABEL_TEXT}|${RESOLUTION_LABEL_TEXT}|quality|resolution`, "i").test(text)) {
    score += 100;
  }
  if (isQualityText(text)) {
    score += 50;
  }
  if (element.getAttribute("role") === "menuitem" || element.getAttribute("role") === "option") {
    score += 12;
  }
  return score;
}

function getAutoOptionScore(element) {
  const text = getElementText(element).trim();
  let score = new RegExp(`^${AUTO_QUALITY_TEXT}(?:\\s*\\([^)]+\\))?$|^auto(?:\\s*\\([^)]+\\))?$`, "i").test(text) ? 100 : 20;
  if (element.getAttribute("role") === "option" || element.getAttribute("role") === "menuitem") {
    score += 10;
  }
  return score;
}

function getClickableElement(element) {
  return element.closest("button, [role='button'], [role='menuitem'], [role='option'], li") || element;
}

async function selectQualityAutoFromOpenSettings(method) {
  let panel = findPzpSettingsPanel();
  if (!panel) {
    return null;
  }

  let option = findAutoQualityItem(panel);
  if (!option) {
    const qualityItem = findPzpQualityHomeItem(panel);
    if (!qualityItem) {
      return null;
    }
    const qualityMenuText = cleanDebugText(getElementText(qualityItem));
    dispatchPointerClick(getClickableElement(qualityItem));
    await delay(220);
    panel = findPzpSettingsPanel();
    option = panel ? findAutoQualityItem(panel) : null;
    if (!option) {
      return {
        qualityAuto: false,
        qualityMethod: `${method}-auto-option-not-found`,
        qualityMenuText,
        qualityPanelText: cleanDebugText(getElementText(panel || document.body)),
        qualityAlgoVersion: QUALITY_AUTO_ALGO_VERSION,
      };
    }
    const qualityOptionText = cleanDebugText(getElementText(option));
    dispatchPointerClick(getClickableElement(option));
    await delay(180);
    return {
      qualityAuto: true,
      qualityMethod: `${method}-submenu`,
      qualityMenuText,
      qualityPanelText: cleanDebugText(getElementText(panel)),
      qualityOptionText,
      qualityAlgoVersion: QUALITY_AUTO_ALGO_VERSION,
    };
  }

  const qualityOptionText = cleanDebugText(getElementText(option));
  dispatchPointerClick(getClickableElement(option));
  await delay(180);
  return {
    qualityAuto: true,
    qualityMethod: method,
    qualityPanelText: cleanDebugText(getElementText(panel)),
    qualityOptionText,
    qualityAlgoVersion: QUALITY_AUTO_ALGO_VERSION,
  };
}

function findPzpSettingsPanel() {
  const panels = [...document.querySelectorAll(".pzp-setting-quality-pane__flexbox, .pzp-setting-quality-pane__list-container, .pzp-settings, .pzp-pc-settings")]
    .filter(isVisibleElement)
    .map((element) => ({ element, text: cleanDebugText(getHumanText(element)), rect: element.getBoundingClientRect(), classText: String(element.className || "") }))
    .filter(({ text, rect }) => (
      rect.width >= 160 &&
      rect.width <= 460 &&
      rect.height >= 60 &&
      rect.height <= 460 &&
      new RegExp(`${RESOLUTION_LABEL_TEXT}|${AUTO_QUALITY_TEXT}|144p|720p|1080p|quality|resolution|auto`, "i").test(text)
    ))
    .sort((a, b) => {
      const aScore = (/quality-pane/i.test(a.classText) ? 20000 : 0) + (/pzp-settings|pzp-pc-settings/i.test(a.classText) ? 10000 : 0);
      const bScore = (/quality-pane/i.test(b.classText) ? 20000 : 0) + (/pzp-settings|pzp-pc-settings/i.test(b.classText) ? 10000 : 0);
      return bScore - aScore || (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height);
    });
  return panels[0]?.element || null;
}

function findPzpQualityHomeItem(panel) {
  const items = [...panel.querySelectorAll(".pzp-setting-intro-quality, .pzp-pc-setting-intro-quality, .pzp-ui-setting-home-item, li, [role='button'], button, div")]
    .filter((element) => isVisibleElement(element) && isMenuOptionCandidate(element));
  return items
    .map((element) => ({ element, score: getQualityMenuItemScore(element) + (/pzp-setting-intro-quality|pzp-pc-setting-intro-quality/i.test(String(element.className || "")) ? 200 : 0) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.element || null;
}

function findAutoQualityItem(panel) {
  const items = [...panel.querySelectorAll(".pzp-ui-setting-quality-item, .pzp-ui-setting-pane-item, li, [role='option'], [role='menuitem'], button, div, span")]
    .filter((element) => isVisibleElement(element) && isMenuOptionCandidate(element));
  return items
    .map((element) => ({ element, score: getAutoOptionScore(element) + (/pzp-ui-setting-quality-item|pzp-ui-setting-pane-item/i.test(String(element.className || "")) ? 200 : 0) }))
    .filter((item) => item.score > 0 && isAutoText(getElementText(item.element)))
    .sort((a, b) => b.score - a.score)[0]?.element || null;
}

function findMenuPanel(anchor) {
  const anchorRect = anchor.getBoundingClientRect();
  const anchorCenterX = anchorRect.left + anchorRect.width / 2;
  const menuPattern = new RegExp(`${QUALITY_LABEL_TEXT}|${RESOLUTION_LABEL_TEXT}|${AUTO_QUALITY_TEXT}|144p|720p|1080p|resolution|quality|auto`, "i");
  const preferred = [...document.querySelectorAll(".pzp-settings, .pzp-pc-settings, .pzp-setting-quality-pane__flexbox, .pzp-setting-quality-pane__list-container")]
    .filter((element) => isVisibleElement(element) && element !== anchor && !anchor.contains(element))
    .map((element) => ({
      element,
      rect: element.getBoundingClientRect(),
      text: cleanDebugText(getHumanText(element)),
      classText: String(element.className || ""),
    }))
    .filter(({ rect, text }) => (
      menuPattern.test(text) &&
      rect.width >= 160 &&
      rect.width <= 460 &&
      rect.height >= 60 &&
      rect.height <= 460 &&
      rect.left <= anchorRect.right + 260 &&
      rect.right >= anchorRect.left - 460 &&
      rect.bottom <= anchorRect.top + Math.max(120, anchorRect.height * 3)
    ))
    .sort((a, b) => {
      const aScore = (/pzp-settings|pzp-pc-settings|quality-pane/i.test(a.classText) ? 20000 : 0);
      const bScore = (/pzp-settings|pzp-pc-settings|quality-pane/i.test(b.classText) ? 20000 : 0);
      const aDistance = Math.abs((a.rect.left + a.rect.width / 2) - anchorCenterX) + Math.abs(a.rect.bottom - anchorRect.top);
      const bDistance = Math.abs((b.rect.left + b.rect.width / 2) - anchorCenterX) + Math.abs(b.rect.bottom - anchorRect.top);
      return (bScore - aScore) || (aDistance - bDistance);
    });
  if (preferred[0]) {
    return preferred[0].element;
  }
  const candidates = [...document.querySelectorAll("div, ul, ol, [role='menu'], [role='listbox'], [class]")]
    .filter((element) => isVisibleElement(element) && element !== anchor && !anchor.contains(element))
    .map((element) => ({
      element,
      rect: element.getBoundingClientRect(),
      text: cleanDebugText(getHumanText(element)),
      rawTextLength: String(getHumanText(element) || "").replace(/\s+/g, " ").trim().length,
      classText: String(element.className || ""),
    }))
    .filter(({ rect, rawTextLength, text, classText }) => (
      rect.width >= 180 &&
      rect.width <= 420 &&
      rect.height >= 64 &&
      rect.height <= 420 &&
      rawTextLength <= 700 &&
      (menuPattern.test(text) || /pzp-settings|pzp-pc-settings|quality-pane|setting.*panel/i.test(classText)) &&
      rect.left >= 0 &&
      rect.right <= innerWidth + 8 &&
      rect.top >= 0 &&
      rect.bottom <= anchorRect.top + Math.max(96, anchorRect.height * 2) &&
      rect.left <= anchorRect.right + 240 &&
      rect.right >= anchorRect.left - 440
    ))
    .sort((a, b) => {
      const aScore = (/pzp-settings|setting.*panel/i.test(a.classText) ? 20000 : 0) + (menuPattern.test(a.text) ? 10000 : 0);
      const bScore = (/pzp-settings|setting.*panel/i.test(b.classText) ? 20000 : 0) + (menuPattern.test(b.text) ? 10000 : 0);
      const aDistance = Math.abs((a.rect.left + a.rect.width / 2) - anchorCenterX) + Math.abs(a.rect.bottom - anchorRect.top);
      const bDistance = Math.abs((b.rect.left + b.rect.width / 2) - anchorCenterX) + Math.abs(b.rect.bottom - anchorRect.top);
      return (bScore - aScore) || (aDistance - bDistance);
    });
  return candidates[0]?.element || null;
}

function clickMenuRowNearAnchor(anchor, rowIndex, mode) {
  const panel = findMenuPanel(anchor);
  if (!panel) {
    return false;
  }
  const rect = panel.getBoundingClientRect();
  const hasHeader = mode === "option" && new RegExp(`${RESOLUTION_LABEL_TEXT}|quality|resolution`, "i").test(getHumanText(panel));
  const headerOffset = hasHeader ? Math.min(96, Math.max(48, rect.height * 0.22)) : 0;
  const usableHeight = Math.max(40, rect.height - headerOffset);
  const rowCount = mode === "menu" ? 4 : Math.max(1, Math.round(usableHeight / 64));
  const rowHeight = Math.min(76, Math.max(44, usableHeight / rowCount));
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + headerOffset + rowHeight * (rowIndex + 0.5));
  dispatchPointClick(x, y);
  return true;
}

function getElementText(element) {
  return [
    element.getAttribute?.("aria-label"),
    element.getAttribute?.("title"),
    element.getAttribute?.("data-testid"),
    element.className,
    element.textContent,
  ].filter(Boolean).join(" ");
}

function getHumanText(element) {
  return [
    element.getAttribute?.("aria-label"),
    element.getAttribute?.("title"),
    element.getAttribute?.("data-testid"),
    element.textContent,
  ].filter(Boolean).join(" ");
}

function isCompactControl(element) {
  const rect = element.getBoundingClientRect();
  const text = cleanDebugText(getHumanText(element));
  return rect.width > 1 && rect.height > 1 && rect.width <= 180 && rect.height <= 120 && text.length <= 220;
}

function isMenuOptionCandidate(element) {
  const rect = element.getBoundingClientRect();
  const text = cleanDebugText(getHumanText(element));
  const rawText = String(getHumanText(element) || "").replace(/\s+/g, " ").trim();
  return rect.width > 1 && rect.height > 1 && rect.width <= 480 && rect.height <= 110 && text.length > 0 && rawText.length <= 180;
}

function cleanDebugText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function isAutoText(text) {
  return new RegExp(`(^|[\\s/|])${AUTO_QUALITY_TEXT}($|[\\s/|])|(^|[\\s/|])auto($|[\\s/|])`, "i").test(String(text || ""));
}

function isQualityText(text) {
  return new RegExp(`(?:^|[\\s/|])(?:[1-9]\\d{2,3}p|auto|${AUTO_QUALITY_TEXT})(?:$|[\\s/|])`, "i").test(String(text || ""));
}

function sendEscape(root) {
  (root || document).dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    bubbles: true,
    cancelable: true,
    composed: true,
  }));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findPlayerRoot(video) {
  const videoRect = video.getBoundingClientRect();
  let best = null;
  let node = video.parentElement;
  while (node && node !== document.documentElement) {
    const text = `${node.id || ""} ${node.className || ""}`;
    const rect = node.getBoundingClientRect();
    const overlapsVideo = rect.left <= videoRect.left + 2 && rect.right >= videoRect.right - 2 && rect.top <= videoRect.top + 2 && rect.bottom >= videoRect.bottom - 2;
    if (overlapsVideo) {
      const buttonCount = [...node.querySelectorAll("button, [role='button'], [aria-label], [title], [data-testid]")].filter(isVisibleElement).length;
      let score = 0;
      if (/pzp(?:\s|$)|pzp-pc|chzzk_player|player_layout/i.test(text)) {
        score += 300;
      } else if (/player|webplayer|video/i.test(text)) {
        score += 80;
      }
      score += Math.min(buttonCount, 20) * 20;
      if (buttonCount > 0 && score > (best?.score || 0)) {
        best = { node, score };
      }
    }
    node = node.parentElement;
  }
  return best?.node || video.parentElement || document;
}

function getVideoScore(video) {
  const rect = video.getBoundingClientRect();
  const style = getComputedStyle(video);
  const visible = rect.width > 2 && rect.height > 2 && style.display !== "none" && style.visibility !== "hidden";
  return (
    (visible ? rect.width * rect.height : 0) +
    (video.readyState >= HTMLMediaElement.HAVE_METADATA ? 100000 : 0) +
    (video.currentSrc || video.src ? 10000 : 0) +
    (!video.paused ? 5000 : 0)
  );
}

function isVisibleElement(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 1 && rect.height > 1 && style.display !== "none" && style.visibility !== "hidden";
}

function waitForPausedState(video, paused) {
  return new Promise((resolve) => {
    if (video.paused === paused) {
      resolve(true);
      return;
    }
    const startedAt = performance.now();
    const tick = () => {
      if (video.paused === paused) {
        resolve(true);
      } else if (performance.now() - startedAt > 700) {
        resolve(false);
      } else {
        requestAnimationFrame(tick);
      }
    };
    tick();
  });
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
  safeRuntimeSendMessage({
    type: "CHZZK_PAGE_READY",
    payload: getPageSnapshot(),
  });
}

function safeRuntimeSendMessage(message) {
  try {
    chrome.runtime?.sendMessage?.(message)?.catch?.(() => {});
  } catch {
    // The old content script can outlive the extension context after reload/build.
  }
}

function getPageSnapshot() {
  const video = findVideo();
  return {
    url: location.href,
    title: getMetaContent("og:title") || document.title || "",
    thumbnailUrl: getMetaContent("og:image") || video?.poster || "",
    durationSeconds: Number.isFinite(video?.duration) ? video.duration : null,
  };
}

function getMetaContent(name) {
  return document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content || "";
}

function watchPlayableMetadata() {
  let lastSignature = "";
  let currentVideo = null;

  const notifyIfChanged = () => {
    const snapshot = getPageSnapshot();
    const signature = [
      snapshot.url,
      snapshot.title,
      snapshot.thumbnailUrl,
      Math.round(Number(snapshot.durationSeconds) || 0),
    ].join("|");
    if (signature !== lastSignature) {
      lastSignature = signature;
      notifyReady();
    }
  };

  const bindVideo = () => {
    const video = findVideo();
    if (!video || video === currentVideo) {
      return;
    }
    currentVideo = video;
    for (const eventName of ["loadedmetadata", "durationchange", "loadeddata"]) {
      video.addEventListener(eventName, notifyIfChanged, { passive: true });
    }
    notifyIfChanged();
  };

  bindVideo();
  const observer = new MutationObserver(() => {
    bindVideo();
    notifyIfChanged();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["content", "poster"],
  });

  let ticks = 0;
  const timer = window.setInterval(() => {
    bindVideo();
    notifyIfChanged();
    ticks += 1;
    if (ticks >= 20) {
      window.clearInterval(timer);
    }
  }, 500);
}
