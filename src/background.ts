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
    const command = message.payload?.command;
    await emitDebugLog("background", "playerCommand.request", {
      tabId,
      command,
      time: message.payload?.time ?? null,
    });
    try {
      const state = command === "qualityAuto"
        ? await executeQualityAutoCommandInMainWorld(tabId)
        : await executePlayerCommandInMainWorld(tabId, {
          command,
          time: message.payload?.time,
        });
      await emitDebugLog("background", "playerCommand.mainWorld.done", {
        tabId,
        command,
        paused: state?.paused,
        currentTime: state?.currentTime,
        readyState: state?.readyState,
        qualityAuto: state?.qualityAuto,
        qualityMethod: state?.qualityMethod,
        qualityButtonText: state?.qualityButtonText,
        qualityMenuText: state?.qualityMenuText,
        qualityPanelText: state?.qualityPanelText,
        qualityOptionText: state?.qualityOptionText,
        qualityAlgoVersion: state?.qualityAlgoVersion,
        qualitySelected: state?.qualitySelected,
        qualityPrevious: state?.qualityPrevious,
        qualityTargetType: state?.qualityTargetType,
        qualityTrackCount: state?.qualityTrackCount,
        qualityTracks: state?.qualityTracks,
      });
      return { ok: true, state };
    } catch (error) {
      await emitDebugLog("background", "playerCommand.mainWorld.error", {
        tabId,
        command,
        message: error instanceof Error ? error.message : String(error),
      });
      await ensurePlayerBridge(tabId);
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "CHZZK_PLAYER_COMMAND",
        command,
        time: message.payload?.time,
      });
      await emitDebugLog("background", "playerCommand.content.done", {
        tabId,
        command,
        ok: response?.ok !== false,
        paused: response?.state?.paused,
        currentTime: response?.state?.currentTime,
        readyState: response?.state?.readyState,
        qualityAuto: response?.state?.qualityAuto,
        qualityMethod: response?.state?.qualityMethod,
        qualityButtonText: response?.state?.qualityButtonText,
        qualityMenuText: response?.state?.qualityMenuText,
        qualityPanelText: response?.state?.qualityPanelText,
        qualityOptionText: response?.state?.qualityOptionText,
        qualityAlgoVersion: response?.state?.qualityAlgoVersion,
        qualitySelected: response?.state?.qualitySelected,
        qualityPrevious: response?.state?.qualityPrevious,
        qualityTargetType: response?.state?.qualityTargetType,
        qualityTrackCount: response?.state?.qualityTrackCount,
        qualityTracks: response?.state?.qualityTracks,
        message: response?.message || "",
      });
      return response;
    }
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
    const startedAt = new Date(Date.now() - 2000).toISOString();
    await emitDebugLog("background", "saveFile.start", {
      filename: payload.filename,
      objectUrl: Boolean(payload.objectUrl),
    });
    const downloadId = await chrome.downloads.download({
      url: payload.objectUrl,
      filename: ensureMp4Filename(payload.filename),
      saveAs: false,
      conflictAction: "uniquify",
    });
    const download = await waitForDownloadItem(downloadId);
    await cleanupTmpDownloadsNear(download, startedAt);
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

async function executePlayerCommandInMainWorld(tabId, payload) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: runPlayerCommandInPage,
    args: [payload],
  });
  if (!result?.result) {
    throw Error("Player command did not return a state.");
  }
  return result.result;
}

async function executeQualityAutoCommandInMainWorld(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: runQualityAutoCommandInPage,
  });
  if (!result?.result) {
    throw Error("Quality command did not return a state.");
  }
  return result.result;
}

async function runQualityAutoCommandInPage() {
  const video = await waitForVideo();
  const qualityResult = await setQualityAuto(video);
  return { ...getPlayerState(video), ...qualityResult, mainWorld: true };

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
          reject(Error("CHZZK player video not found."));
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
    const qualityAlgoVersion = "quality-auto-neder2-videoTracks-2026-06-22-1";
    const preferredHeight = 1080;
    const player = findPlayerRoot(video) || video;
    const trackTarget = findVideoTrackListTarget(player) || findVideoTrackListTarget(video) || findVideoTrackListTarget(document);
    const trackList = trackTarget?.trackList || null;
    const tracks = toTrackArray(trackList);
    const selectedTrack = getSelectedTrack(tracks, trackList);

    if (!tracks.length) {
      const fallback = await selectPreferredQualityFromPzpMenu(video, preferredHeight, qualityAlgoVersion, "tracks-missing");
      if (fallback.qualityAuto) {
        return fallback;
      }
      return {
        qualityAuto: false,
        qualityMethod: "neder2-videoTracks-tracks-missing",
        qualityAlgoVersion,
        qualityTargetType: describeQualityTarget(trackTarget?.target || player),
        qualityTrackCount: 0,
        qualityTrackerLength: Array.isArray(readLooseProp(window, "__chzzkSaverQualityTargets"))
          ? readLooseProp(window, "__chzzkSaverQualityTargets").length
          : null,
        qualityFallbackMethod: fallback.qualityMethod,
        qualityFallbackText: fallback.qualityFallbackText,
      };
    }

    const targetTrack = pickTargetTrack(tracks, selectedTrack, preferredHeight);
    if (!targetTrack) {
      const fallback = await selectPreferredQualityFromPzpMenu(video, preferredHeight, qualityAlgoVersion, "unavailable");
      if (fallback.qualityAuto) {
        return fallback;
      }
      return {
        qualityAuto: false,
        qualityMethod: "neder2-videoTracks-unavailable",
        qualityAlgoVersion,
        qualitySelected: describeTrack(selectedTrack),
        qualityTargetType: describeQualityTarget(trackTarget?.target),
        qualityTrackCount: tracks.length,
        qualityTracks: describeTracks(tracks),
        qualityFallbackMethod: fallback.qualityMethod,
        qualityFallbackText: fallback.qualityFallbackText,
      };
    }

    const targetHeight = getTrackHeight(targetTrack);
    if (selectedTrack && trackMatchesHeight(selectedTrack, targetHeight)) {
      return {
        qualityAuto: true,
        qualityMethod: "neder2-videoTracks-already",
        qualityAlgoVersion,
        qualitySelected: describeTrack(selectedTrack),
        qualityTargetType: describeQualityTarget(trackTarget?.target),
        qualityTrackCount: tracks.length,
        qualityTracks: describeTracks(tracks),
      };
    }

    const currentTime = Number(video?.currentTime);
    const shouldResume = video?.paused === false;
    const selected = selectTrack(trackList, tracks, targetTrack);
    if (selected) {
      restorePlaybackAfterQualityChange(video, currentTime, shouldResume);
    }

    return {
      qualityAuto: selected,
      qualityMethod: selected ? "neder2-videoTracks-selected" : "neder2-videoTracks-pending",
      qualityAlgoVersion,
      qualitySelected: describeTrack(targetTrack),
      qualityPrevious: describeTrack(selectedTrack),
      qualityTargetType: describeQualityTarget(trackTarget?.target),
      qualityTrackCount: tracks.length,
      qualityTracks: describeTracks(tracks),
    };
  }

  async function selectPreferredQualityFromPzpMenu(video, preferredHeight, qualityAlgoVersion, reason) {
    const root = findPlayerRoot(video) || document;
    const settingsButton = root.querySelector?.(".pzp-setting-button, .pzp-pc-setting-button, .pzp-pc__setting-button")
      || document.querySelector(".pzp-setting-button, .pzp-pc-setting-button, .pzp-pc__setting-button");
    if (!settingsButton || !isVisibleElement(settingsButton)) {
      return {
        qualityAuto: false,
        qualityMethod: `neder2-videoTracks-${reason}-pzp-settings-missing`,
        qualityAlgoVersion,
      };
    }

    showPlayerControls(video, root);
    dispatchPointerClick(settingsButton);
    await delay(180);

    const settingsPanel = findVisiblePzpPanel(".pzp-settings, .pzp-pc-settings, .pzp-pc__settings");
    const qualityMenuItem = findBestVisibleElement(
      settingsPanel || document,
      ".pzp-ui-setting-pane-item, .pzp-setting-pane-item, li, button, [role='menuitem'], [role='button']",
      (element) => {
        const text = getHumanText(element);
        return /\uD574\uC0C1\uB3C4|resolution|quality/i.test(text) && /(?:\d{3,4}p|auto|\uC790\uB3D9)/i.test(text);
      }
    );

    if (!qualityMenuItem) {
      sendEscape(root);
      return {
        qualityAuto: false,
        qualityMethod: `neder2-videoTracks-${reason}-pzp-quality-menu-missing`,
        qualityAlgoVersion,
        qualityFallbackText: cleanDebugText(getHumanText(settingsPanel || document.body)),
      };
    }

    dispatchPointerClick(getClickableElement(qualityMenuItem));
    await delay(180);

    const qualityPanel = findVisiblePzpPanel(".pzp-setting-quality-pane__flexbox, .pzp-setting-quality-pane__list-container, .pzp-settings, .pzp-pc-settings");
    const optionElements = [
      ...((qualityPanel || document).querySelectorAll?.(".pzp-ui-setting-quality-item, .pzp-ui-setting-pane-item, li, button, [role='option'], [role='menuitem'], [role='button']") || []),
    ].filter((element) => isVisibleElement(element) && cleanDebugText(getHumanText(element)));

    const preferredText = `${preferredHeight}p`;
    let targetOption = optionElements.find((element) => new RegExp(`(^|[^\\d])${preferredHeight}\\s*p([^\\d]|$)`, "i").test(getHumanText(element)));
    let fallbackText = preferredText;

    if (!targetOption) {
      const lowerOptions = optionElements
        .map((element) => {
          const match = getHumanText(element).match(/(?:^|[^\d])(\d{3,4})\s*p(?:[^\d]|$)/i);
          return match ? { element, height: Number(match[1]) } : null;
        })
        .filter((item) => item && item.height < preferredHeight)
        .sort((a, b) => b.height - a.height);
      targetOption = lowerOptions[0]?.element || null;
      fallbackText = lowerOptions[0] ? `${lowerOptions[0].height}p` : "";
    }

    if (!targetOption) {
      sendEscape(root);
      return {
        qualityAuto: false,
        qualityMethod: `neder2-videoTracks-${reason}-pzp-quality-option-missing`,
        qualityAlgoVersion,
        qualityFallbackText: cleanDebugText(getHumanText(qualityPanel || document.body)),
      };
    }

    const optionText = cleanDebugText(getHumanText(targetOption));
    dispatchPointerClick(getClickableElement(targetOption));
    await delay(180);

    return {
      qualityAuto: true,
      qualityMethod: `neder2-videoTracks-${reason}-pzp-selected`,
      qualityAlgoVersion,
      qualityOptionText: optionText,
      qualityFallbackText: fallbackText,
      qualityTargetType: describeQualityTarget(settingsButton),
      qualityTrackCount: 0,
      qualityTrackerLength: Array.isArray(readLooseProp(window, "__chzzkSaverQualityTargets"))
        ? readLooseProp(window, "__chzzkSaverQualityTargets").length
        : null,
    };
  }

  function findVisiblePzpPanel(selector) {
    return [...document.querySelectorAll(selector)]
      .filter(isVisibleElement)
      .sort((a, b) => visibleArea(b) - visibleArea(a))[0] || null;
  }

  function visibleArea(element) {
    if (!isVisibleElement(element)) {
      return 0;
    }
    const rect = element.getBoundingClientRect();
    return rect.width * rect.height;
  }

  function findBestVisibleElement(root, selector, predicate) {
    return [...root.querySelectorAll(selector)]
      .filter((element) => isVisibleElement(element) && predicate(element))
      .sort((a, b) => {
        const aText = getHumanText(a);
        const bText = getHumanText(b);
        const aScore = (/pzp-ui-setting-pane-item|pzp-setting-pane-item/.test(String(a.className || "")) ? 100 : 0) - aText.length;
        const bScore = (/pzp-ui-setting-pane-item|pzp-setting-pane-item/.test(String(b.className || "")) ? 100 : 0) - bText.length;
        return bScore - aScore;
      })[0] || null;
  }

  function findVideoTrackListTarget(root) {
    for (const target of collectQualityTargets(root)) {
      if (target instanceof HTMLElement && !target.isConnected) {
        continue;
      }
      const trackList = getTrackListFromTarget(target);
      if (trackList) {
        return { target, trackList };
      }
    }
    return null;
  }

  function collectQualityTargets(root) {
    const targets = [];
    const seen = new WeakSet();
    const keys = [
      "_corePlayer",
      "corePlayer",
      "_player",
      "player",
      "_controller",
      "controller",
      "_mediaController",
      "mediaController",
    ];

    const add = (target, depth) => {
      if (!target || (typeof target !== "object" && typeof target !== "function")) {
        return;
      }
      if (seen.has(target)) {
        return;
      }
      seen.add(target);
      targets.push(target);
      if (depth <= 0) {
        return;
      }
      for (const key of keys) {
        add(readLooseProp(target, key), depth - 1);
      }
    };

    add(root, 3);
    const trackedTargets = readLooseProp(window, "__chzzkSaverQualityTargets");
    if (Array.isArray(trackedTargets)) {
      for (const target of trackedTargets) {
        add(target, 3);
      }
    }
    if (root instanceof Element) {
      for (const selector of ["video", "pzp-pc", "pzp-player", "pzp-core-player", "pzp-pc-player", "[class^='pzp']", "[class*=' pzp']"]) {
        for (const element of root.querySelectorAll(selector)) {
          add(element, 3);
        }
      }
    }
    for (const selector of ["#player_layout", ".chzzk_player", "video", "pzp-pc", "pzp-player", "pzp-core-player", "pzp-pc-player", "[class^='pzp']", "[class*=' pzp']"]) {
      for (const element of document.querySelectorAll(selector)) {
        add(element, 3);
      }
    }
    return targets;
  }

  function readLooseProp(target, prop) {
    try {
      return target?.[prop];
    } catch {
      return null;
    }
  }

  function getTrackListFromTarget(target) {
    const tracks = readLooseProp(target, "videoTracks");
    return tracks && Number.isFinite(Number(tracks.length)) && Number(tracks.length) > 0
      ? tracks
      : null;
  }

  function toTrackArray(trackList) {
    const tracks = [];
    const length = Number(trackList?.length) || 0;
    for (let index = 0; index < length; index += 1) {
      const track = trackList[index] || trackList.item?.(index);
      if (track) {
        tracks.push(track);
      }
    }
    return tracks;
  }

  function pushTrackTextPart(parts, value) {
    if (value == null || value === "") {
      return;
    }
    if (typeof value === "object") {
      const width = Number(readLooseProp(value, "width") || readLooseProp(value, "videoWidth"));
      const height = Number(readLooseProp(value, "height") || readLooseProp(value, "videoHeight"));
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        parts.push(`${Math.round(width)}x${Math.round(height)}`);
      }
      return;
    }
    parts.push(String(value));
  }

  function pushTrackTextProp(parts, target, prop) {
    pushTrackTextPart(parts, readLooseProp(target, prop));
  }

  function trackText(track) {
    const parts = [];
    [
      "id",
      "label",
      "kind",
      "videoQuality",
      "qualityLabel",
      "quality",
      "resolution",
      "displayResolution",
      "height",
      "width",
      "videoHeight",
      "videoWidth",
      "videoBitrate",
      "encodingOptionID",
      "encodingOptionId",
      "src",
      "baseUrl",
      "url",
    ].forEach((prop) => pushTrackTextProp(parts, track, prop));

    const dataset = readLooseProp(track, "dataset");
    [
      "encodingTrackId",
      "encodingOptionID",
      "encodingOptionId",
      "quality",
      "qualityLabel",
      "label",
      "resolution",
      "height",
      "videoHeight",
      "width",
      "videoWidth",
    ].forEach((prop) => pushTrackTextProp(parts, dataset, prop));

    const attributes = readLooseProp(track, "attributes");
    ["RESOLUTION", "resolution", "height", "videoHeight", "BANDWIDTH", "bandwidth"]
      .forEach((prop) => pushTrackTextProp(parts, attributes, prop));

    return parts.join(" ").toLowerCase();
  }

  function isAutomaticTrack(track) {
    const text = trackText(track);
    return text.includes("abr") || text.includes("auto") || text.includes("\uC790\uB3D9");
  }

  function readNumericHeight(target, props) {
    for (const prop of props) {
      const value = Number(readLooseProp(target, prop));
      if (Number.isFinite(value) && value > 0) {
        return Math.round(value);
      }
    }
    return NaN;
  }

  function getTrackHeight(track) {
    const directHeight = readNumericHeight(track, ["height", "videoHeight"]);
    if (Number.isFinite(directHeight)) {
      return directHeight;
    }
    const datasetHeight = readNumericHeight(readLooseProp(track, "dataset"), ["height", "videoHeight"]);
    if (Number.isFinite(datasetHeight)) {
      return datasetHeight;
    }
    const attributesHeight = readNumericHeight(readLooseProp(track, "attributes"), ["height", "videoHeight"]);
    if (Number.isFinite(attributesHeight)) {
      return attributesHeight;
    }

    const text = trackText(track);
    const resolutionMatch = text.match(/\b\d{3,5}\s*x\s*(\d{3,4})\b/);
    if (resolutionMatch) {
      return Number(resolutionMatch[1]);
    }
    const labelMatch = text.match(/(?:^|[^\d])(\d{3,4})\s*p(?:\b|[^\d])/);
    return labelMatch ? Number(labelMatch[1]) : NaN;
  }

  function getSelectedTrack(tracks, trackList) {
    const selectedTrack = tracks.find((track) => track?.selected);
    if (selectedTrack) {
      return selectedTrack;
    }
    const selectedIndex = Number(trackList?.selectedIndex);
    if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && tracks[selectedIndex]) {
      return tracks[selectedIndex];
    }
    return null;
  }

  function getSelectableTrackCandidates(tracks) {
    const candidates = [];
    for (const track of tracks) {
      if (isAutomaticTrack(track)) {
        continue;
      }
      const height = getTrackHeight(track);
      if (Number.isFinite(height)) {
        candidates.push({ track, height });
      }
    }
    return candidates;
  }

  function scoreTrack(track, selectedTrack) {
    let score = 0;
    const text = trackText(track);
    if (track?.kind && selectedTrack?.kind && track.kind === selectedTrack.kind) {
      score += 20;
    }
    if (!text.includes("p2p")) {
      score += 8;
    }
    if (text.includes("low-latency")) {
      score += 4;
    }
    if (Number.isFinite(Number(track?.videoBitrate))) {
      score += Math.min(Number(track.videoBitrate) / 1000000, 10);
    }
    return score;
  }

  function pickTargetTrack(tracks, selectedTrack, preferredHeight) {
    const candidates = getSelectableTrackCandidates(tracks);
    if (!candidates.length) {
      return null;
    }

    const exactCandidates = candidates.filter((candidate) => candidate.height === preferredHeight);
    if (exactCandidates.length) {
      exactCandidates.sort((a, b) => scoreTrack(b.track, selectedTrack) - scoreTrack(a.track, selectedTrack));
      return exactCandidates[0].track;
    }

    const lowerCandidates = candidates.filter((candidate) => candidate.height < preferredHeight);
    if (!lowerCandidates.length) {
      return null;
    }

    const fallbackHeight = Math.max(...lowerCandidates.map((candidate) => candidate.height));
    const fallbackCandidates = lowerCandidates.filter((candidate) => candidate.height === fallbackHeight);
    fallbackCandidates.sort((a, b) => scoreTrack(b.track, selectedTrack) - scoreTrack(a.track, selectedTrack));
    return fallbackCandidates[0].track;
  }

  function trackMatchesHeight(track, height) {
    return !isAutomaticTrack(track) && getTrackHeight(track) === height;
  }

  function selectTrack(trackList, tracks, targetTrack) {
    const targetIndex = tracks.indexOf(targetTrack);
    for (const track of tracks) {
      if (track === targetTrack) {
        continue;
      }
      try {
        if (track?.selected) {
          track.selected = false;
        }
      } catch {
        // Some player adapters expose selected as readonly.
      }
    }

    try {
      targetTrack.selected = true;
    } catch {
      // Fall back to selectedIndex when the track object rejects writes.
    }

    try {
      if (targetIndex >= 0 && Number(trackList?.selectedIndex) !== targetIndex) {
        trackList.selectedIndex = targetIndex;
      }
    } catch {
      // selectedIndex is not writable on every PZP adapter.
    }

    const selectedIndex = Number(trackList?.selectedIndex);
    const selectedTrack = Number.isInteger(selectedIndex) && selectedIndex >= 0
      ? tracks[selectedIndex]
      : getSelectedTrack(tracks, trackList);

    return selectedTrack === targetTrack || targetTrack.selected === true;
  }

  function restorePlaybackAfterQualityChange(video, currentTime, shouldResume) {
    setTimeout(() => {
      const nextVideo = findVideo() || video;
      if (!(nextVideo instanceof HTMLVideoElement)) {
        return;
      }
      if (Number.isFinite(currentTime) && currentTime > 1 && Number(nextVideo.currentTime) < 1) {
        try {
          nextVideo.currentTime = currentTime;
        } catch {
          // Some streams reject seeks until metadata is ready.
        }
      }
      if (shouldResume && nextVideo.paused) {
        nextVideo.play?.()?.catch?.(() => {});
      }
    }, 250);
  }

  function describeTrack(track) {
    if (!track) {
      return null;
    }
    const height = getTrackHeight(track);
    return {
      id: String(track.id || ""),
      label: String(track.label || ""),
      kind: String(track.kind || ""),
      qualityLabel: String(track.qualityLabel || ""),
      height: Number.isFinite(height) ? height : null,
      automatic: isAutomaticTrack(track),
      selected: Boolean(track.selected),
    };
  }

  function describeTracks(tracks) {
    return tracks.map(describeTrack).slice(0, 12);
  }

  function describeQualityTarget(target) {
    if (!target) {
      return "";
    }
    if (target instanceof Element) {
      return [
        target.localName,
        target.id ? `#${target.id}` : "",
        target.className ? `.${String(target.className).trim().replace(/\s+/g, ".")}` : "",
      ].join("");
    }
    return String(target.constructor?.name || typeof target);
  }

  function getClickableElement(element) {
    return element.closest("button, [role='button'], [role='menuitem'], [role='option'], li") || element;
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

  function dispatchPointerClick(element) {
    const rect = element.getBoundingClientRect?.();
    const x = rect ? Math.round(rect.left + rect.width / 2) : Math.round(innerWidth / 2);
    const y = rect ? Math.round(rect.top + rect.height / 2) : Math.round(innerHeight / 2);
    dispatchPointerClickAt(element, x, y);
  }

  function dispatchPointerClickAt(element, x, y) {
    element.dispatchEvent(new PointerEvent("pointerdown", pointerEventInit(x, y)));
    element.dispatchEvent(new MouseEvent("mousedown", mouseEventInit(x, y)));
    element.dispatchEvent(new PointerEvent("pointerup", pointerEventInit(x, y)));
    element.dispatchEvent(new MouseEvent("mouseup", mouseEventInit(x, y)));
    element.dispatchEvent(new MouseEvent("click", mouseEventInit(x, y)));
    element.click?.();
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
        } else if (/player|webplayer|video|live|vod/i.test(text)) {
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

  function getHumanText(element) {
    return [
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      element.getAttribute?.("data-testid"),
      element.textContent,
    ].filter(Boolean).join(" ");
  }

  function cleanDebugText(text) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, 120);
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
}

async function runPlayerCommandInPage(payload) {
  const video = await waitForVideo();
  const command = payload?.command;

  if (command === "play") {
    await setPlaybackState(video, "play");
  } else if (command === "pause") {
    await setPlaybackState(video, "pause");
  } else if (command === "seek") {
    video.currentTime = clampTime(payload?.time, video.duration);
  } else if (command === "toggle") {
    await setPlaybackState(video, video.paused ? "play" : "pause");
  } else if (command !== "state") {
    throw Error("Unsupported player command.");
  }

  return getPlayerState(video);

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
          reject(Error("CHZZK player video not found."));
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

  async function setPlaybackState(video, action) {
  const targetPaused = action === "pause";
  if (video.paused === targetPaused && !(action === "play" && video.ended)) {
    return;
  }

  if (!isClipPage()) {
    await setPlaybackStateViaMedia(video, action);
    if (await waitForSettledPausedState(video, targetPaused)) {
      return;
    }
    throw Error("Player playback state did not change.");
  }

  if (await setPlaybackStateViaUi(video, action, targetPaused)) {
    return;
  }
  await setPlaybackStateViaMedia(video, action, { allowMutedKickstart: true });
  if (await waitForSettledPausedState(video, targetPaused)) {
    return;
  }
  throw Error("Player playback state did not change.");
}
function isClipPage() {
    return /^\/clips\//.test(location.pathname);
  }

  async function setPlaybackStateViaMedia(video, action, { allowMutedKickstart = false } = {}) {
    if (action === "play") {
      await playMediaElement(video, { allowMutedKickstart });
      return;
    }
    pauseMediaElement(video);
  }

  async function setPlaybackStateViaUi(video, action, targetPaused) {
    showPlayerControls(video, findPlayerRoot(video) || document);
    const attempts = [
      () => clickPlaybackControl(video, action),
      () => clickVideoSurface(video),
      () => sendKeyboardToggle(video),
    ];
    for (const attempt of attempts) {
      if (!attempt()) {
        continue;
      }
      if (await waitForSettledPausedState(video, targetPaused, 900)) {
        return true;
      }
    }
    return false;
  }
async function playMediaElement(video, { allowMutedKickstart = false } = {}) {
    try {
      await HTMLMediaElement.prototype.play.call(video);
    } catch (error) {
      if (!allowMutedKickstart) {
        throw error;
      }
      const wasMuted = video.muted;
      video.muted = true;
      await HTMLMediaElement.prototype.play.call(video);
      window.setTimeout(() => {
        video.muted = wasMuted;
      }, 120);
    }
  }

  function pauseMediaElement(video) {
    HTMLMediaElement.prototype.pause.call(video);
  }

  function clickPlaybackControl(video, action) {
    const button = findPlaybackButton(video, action);
    if (!button) {
      return false;
    }
    dispatchPointerClick(button, { invokeClick: false });
    return true;
  }

  function clickVideoSurface(video) {
    dispatchPointerClick(video, { invokeClick: false });
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

  function dispatchPointerClick(element, options = {}) {
    const rect = element.getBoundingClientRect?.();
    const x = rect ? Math.round(rect.left + rect.width / 2) : Math.round(innerWidth / 2);
    const y = rect ? Math.round(rect.top + rect.height / 2) : Math.round(innerHeight / 2);
    element.dispatchEvent(new PointerEvent("pointerdown", pointerEventInit(x, y)));
    element.dispatchEvent(new MouseEvent("mousedown", mouseEventInit(x, y)));
    element.dispatchEvent(new PointerEvent("pointerup", pointerEventInit(x, y)));
    element.dispatchEvent(new MouseEvent("mouseup", mouseEventInit(x, y)));
    element.dispatchEvent(new MouseEvent("click", mouseEventInit(x, y)));
    if (options.invokeClick !== false) {
      element.click?.();
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
    if (rect.width <= 72 && rect.height <= 72) {
      score += 8;
    }
    return score;
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
        } else if (/player|webplayer|video|live|vod/i.test(text)) {
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

  function waitForPausedState(video, paused, timeoutMs = 700) {
    return new Promise((resolve) => {
      if (video.paused === paused) {
        resolve(true);
        return;
      }
      const startedAt = performance.now();
      const tick = () => {
        if (video.paused === paused) {
          resolve(true);
        } else if (performance.now() - startedAt > timeoutMs) {
          resolve(false);
        } else {
          requestAnimationFrame(tick);
        }
      };
      tick();
    });
  }

  async function waitForSettledPausedState(video, paused, timeoutMs = 700) {
    if (!await waitForPausedState(video, paused, timeoutMs)) {
      return false;
    }
    await delay(160);
    return video.paused === paused;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getPlayerState(video) {
    return {
      url: location.href,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      paused: video.paused,
      ended: video.ended,
      readyState: video.readyState,
      mainWorld: true,
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
      await setPlaybackState(video, "play");
    } else if (command === "pause") {
      await setPlaybackState(video, "pause");
    } else if (command === "seek") {
      video.currentTime = clampTime(message.time, video.duration);
    } else if (command === "toggle") {
      await setPlaybackState(video, video.paused ? "play" : "pause");
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
    return videos
      .map((video) => ({ video, score: getVideoScore(video) }))
      .sort((a, b) => b.score - a.score)[0]?.video || null;
  }

  async function setPlaybackState(video, action) {
  const targetPaused = action === "pause";
  if (video.paused === targetPaused && !(action === "play" && video.ended)) {
    return;
  }

  if (!isClipPage()) {
    await setPlaybackStateViaMedia(video, action);
    if (await waitForSettledPausedState(video, targetPaused)) {
      return;
    }
    throw Error("Player playback state did not change.");
  }

  if (await setPlaybackStateViaUi(video, action, targetPaused)) {
    return;
  }
  await setPlaybackStateViaMedia(video, action, { allowMutedKickstart: true });
  if (await waitForSettledPausedState(video, targetPaused)) {
    return;
  }
  throw Error("Player playback state did not change.");
}
function isClipPage() {
    return /^\/clips\//.test(location.pathname);
  }

  async function setPlaybackStateViaMedia(video, action, { allowMutedKickstart = false } = {}) {
    if (action === "play") {
      await playMediaElement(video, { allowMutedKickstart });
      return;
    }
    pauseMediaElement(video);
  }

  async function setPlaybackStateViaUi(video, action, targetPaused) {
    showPlayerControls(video, findPlayerRoot(video) || document);
    const attempts = [
      () => clickPlaybackControl(video, action),
      () => clickVideoSurface(video),
      () => sendKeyboardToggle(video),
    ];
    for (const attempt of attempts) {
      if (!attempt()) {
        continue;
      }
      if (await waitForSettledPausedState(video, targetPaused, 900)) {
        return true;
      }
    }
    return false;
  }
async function playMediaElement(video, { allowMutedKickstart = false } = {}) {
    try {
      await HTMLMediaElement.prototype.play.call(video);
    } catch (error) {
      if (!allowMutedKickstart) {
        throw error;
      }
      const wasMuted = video.muted;
      video.muted = true;
      await HTMLMediaElement.prototype.play.call(video);
      window.setTimeout(() => {
        video.muted = wasMuted;
      }, 120);
    }
  }

  function pauseMediaElement(video) {
    HTMLMediaElement.prototype.pause.call(video);
  }

  function clickPlaybackControl(video, action) {
    const button = findPlaybackButton(video, action);
    if (!button) {
      return false;
    }
    dispatchPointerClick(button, { invokeClick: false });
    return true;
  }

  function clickVideoSurface(video) {
    dispatchPointerClick(video, { invokeClick: false });
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

  function dispatchPointerClick(element, options = {}) {
    const rect = element.getBoundingClientRect?.();
    const x = rect ? Math.round(rect.left + rect.width / 2) : Math.round(innerWidth / 2);
    const y = rect ? Math.round(rect.top + rect.height / 2) : Math.round(innerHeight / 2);
    element.dispatchEvent(new PointerEvent("pointerdown", pointerEventInit(x, y)));
    element.dispatchEvent(new MouseEvent("mousedown", mouseEventInit(x, y)));
    element.dispatchEvent(new PointerEvent("pointerup", pointerEventInit(x, y)));
    element.dispatchEvent(new MouseEvent("mouseup", mouseEventInit(x, y)));
    element.dispatchEvent(new MouseEvent("click", mouseEventInit(x, y)));
    if (options.invokeClick !== false) {
      element.click?.();
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

  function waitForPausedState(video, paused, timeoutMs = 700) {
    return new Promise((resolve) => {
      if (video.paused === paused) {
        resolve(true);
        return;
      }
      const startedAt = performance.now();
      const tick = () => {
        if (video.paused === paused) {
          resolve(true);
      } else if (performance.now() - startedAt > timeoutMs) {
          resolve(false);
        } else {
          requestAnimationFrame(tick);
        }
      };
      tick();
    });
  }

  async function waitForSettledPausedState(video, paused, timeoutMs = 700) {
    if (!await waitForPausedState(video, paused, timeoutMs)) {
      return false;
    }
    await delay(160);
    return video.paused === paused;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      payload: { url: location.href },
    });
  }

  function safeRuntimeSendMessage(message) {
    try {
      chrome.runtime?.sendMessage?.(message)?.catch?.(() => {});
    } catch {
      // The injected bridge can outlive the extension context after reload.
    }
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
    width: 800,
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

function waitForDownloadItem(downloadId) {
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
    const resolveDownload = () => {
      chrome.downloads.search({ id: downloadId })
        .then(([download]) => finish(resolve, download || { id: downloadId }))
        .catch(() => finish(resolve, { id: downloadId }));
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
        resolveDownload();
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
          finish(resolve, download);
        } else if (download?.state === "interrupted") {
          finish(reject, Error("브라우저 저장이 중단되었습니다."));
        }
      })
      .catch((error) => finish(reject, error));
  });
}

async function cleanupTmpDownloadsNear(download, startedAfter) {
  const finalPath = String(download?.filename || "");
  const finalDirectory = finalPath ? normalizeDirectoryName(finalPath) : "";
  const startedAfterMs = Date.parse(startedAfter) || Date.now() - 60000;
  const endedBeforeMs = Date.now() + 15000;
  const candidates = await chrome.downloads.search({
    filenameRegex: "[\\\\/][0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\.tmp$",
    startedAfter,
  }).catch(() => []);
  let removed = 0;

  for (const item of candidates) {
    if (!isTmpDownloadCleanupCandidate(item, finalDirectory, startedAfterMs, endedBeforeMs)) {
      continue;
    }
    try {
      await chrome.downloads.removeFile(item.id);
      await chrome.downloads.erase({ id: item.id }).catch(() => {});
      removed += 1;
    } catch (error) {
      await emitDebugLog("background", "saveFile.tmpCleanup.error", {
        id: item.id,
        filename: item.filename,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (removed || candidates.length) {
    await emitDebugLog("background", "saveFile.tmpCleanup.done", {
      removed,
      candidates: candidates.length,
      directory: finalDirectory ? "[download-dir]" : "",
    });
  }
}

function isTmpDownloadCleanupCandidate(item, finalDirectory, startedAfterMs, endedBeforeMs) {
  const filename = String(item?.filename || "");
  const basename = filename.split(/[\\/]/).pop() || "";
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.tmp$/.test(basename)) {
    return false;
  }
  if (finalDirectory && normalizeDirectoryName(filename) !== finalDirectory) {
    return false;
  }
  const startedAt = Date.parse(item.startTime || "");
  if (Number.isFinite(startedAt) && (startedAt < startedAfterMs || startedAt > endedBeforeMs)) {
    return false;
  }
  const endedAt = Date.parse(item.endTime || "");
  if (Number.isFinite(endedAt) && endedAt > endedBeforeMs) {
    return false;
  }
  return true;
}

function normalizeDirectoryName(filename) {
  return String(filename || "").replace(/[\\/][^\\/]*$/, "").toLowerCase();
}
