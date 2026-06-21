import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(root, "dist-extension");
const port = 9300 + Math.floor(Math.random() * 500);
const userDataDir = await mkdtemp(join(tmpdir(), "chzzk-whale-smoke-"));
const downloadDir = join(userDataDir, "Downloads");
const metadataUrls = readRepeatedArgValues("--metadata-url");
const shouldCheckPlayback = hasArg("--playback-check");
const shouldCheckDownload = hasArg("--download-check");
const shouldCheckPerformance = hasArg("--performance-check");
const downloadDurationSeconds = readNumberArgValue("--download-duration", shouldCheckPerformance ? 20 : 6);
const downloadQualityHeight = readNumberArgValue("--download-quality-height", shouldCheckPerformance ? 1080 : 144);

let whale;
let browser;

try {
  const whalePath = await findWhaleExecutable();
  await prepareDownloadProfile(downloadDir);
  const extensionPath = toBrowserPath(distDir);
  whale = spawn(whalePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--download-default-directory=${toBrowserPath(downloadDir)}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], {
    detached: false,
    stdio: "ignore",
    windowsHide: true,
  });

  const targets = await waitForExtensionTargets(port);
  const workerTarget = targets.find((target) =>
    target.type === "service_worker"
    && target.url.startsWith("chrome-extension://")
    && target.url.endsWith("/service-worker-loader.js")
  );
  if (!workerTarget) {
    throw new Error(`치직 세이버 service worker를 찾지 못했습니다. targets=${JSON.stringify(targets)}`);
  }

  const extensionId = new URL(workerTarget.url).host;
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];

  const popup = await checkExtensionPage(context, extensionId, "popup.html", "#addToEditor");
  const editorPagePath = metadataUrls.length || shouldCheckPlayback || shouldCheckDownload || shouldCheckPerformance
    ? "downloader.html?__smoke=1"
    : "downloader.html";
  const editor = await checkExtensionPage(context, extensionId, editorPagePath, "#vodUrl");
  const editorPage = context.pages().find((page) => page.url().includes("/downloader.html"));
  const vendor = editorPage
    ? await editorPage.evaluate(() => ({
      hls: typeof window.Hls !== "undefined",
      muxjs: typeof window.muxjs !== "undefined",
      inputTag: document.querySelector("#vodUrl")?.tagName.toLowerCase(),
    }))
    : null;

  if (!vendor?.hls || !vendor?.muxjs || vendor.inputTag !== "textarea") {
    throw new Error(`편집기 vendor/UI 확인 실패: ${JSON.stringify(vendor)}`);
  }

  const popupAdd = metadataUrls.length
    ? await checkPopupAddToEditor(context, extensionId, editorPage, metadataUrls[0])
    : null;
  const metadata = metadataUrls.length
    ? await checkMetadataLoad(editorPage, metadataUrls)
    : null;
  const playback = shouldCheckPlayback && editorPage
    ? await checkPreviewPlaybackLazyLoad(editorPage)
    : null;
  const download = shouldCheckDownload && editorPage
    ? await checkShortDownload(editorPage)
    : null;
  const performance = shouldCheckPerformance && editorPage
    ? await checkConcurrentDownloadPerformance(editorPage)
    : null;

  console.log(JSON.stringify({
    ok: true,
    whalePath,
    extensionId,
    popup,
    editor,
    vendor,
    popupAdd,
    metadata,
    playback,
    download,
    performance,
  }, null, 2));
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
  if (whale && !whale.killed) {
    whale.kill();
  }
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}

async function prepareDownloadProfile(targetDownloadDir) {
  await mkdir(join(userDataDir, "Default"), { recursive: true });
  await mkdir(targetDownloadDir, { recursive: true });
  await writeFile(join(userDataDir, "Default", "Preferences"), JSON.stringify({
    download: {
      default_directory: targetDownloadDir,
      directory_upgrade: true,
      prompt_for_download: false,
    },
    safebrowsing: {
      enabled: false,
    },
  }));
}

async function checkExtensionPage(context, extensionId, pagePath, selector) {
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const requestFailures = [];
  const responseFailures = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) => {
    requestFailures.push({
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText || "",
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      responseFailures.push({
        url: response.url(),
        status: response.status(),
      });
    }
  });

  const response = await page.goto(`chrome-extension://${extensionId}/${pagePath}`, {
    waitUntil: "load",
    timeout: 10_000,
  });
  await page.waitForSelector(selector, {
    timeout: 10_000,
    state: selector === "#vodUrl" ? "attached" : "visible",
  });
  await page.waitForTimeout(500);

  return {
    pagePath,
    status: response?.status() ?? null,
    title: await page.title(),
    url: page.url(),
    pageErrors,
    consoleErrors,
    requestFailures,
    responseFailures,
  };
}

async function checkShortDownload(page) {
  await waitForSmokeApi(page);
  const started = await clickSelectedDownloadThroughUi(page, {
    durationSeconds: downloadDurationSeconds,
    qualityHeight: downloadQualityHeight,
  });
  await waitForTerminalJobs(page);
  const visibleUi = await assertVisibleDownloadUi(page, { expectedDone: 1 });

  const jobs = await page.evaluate(() => window.__CHZZK_SAVER_SMOKE__.getJobs());
  const terminalJob = jobs.find((job) => job.state === "done" || job.state === "error");
  if (!terminalJob || terminalJob.state !== "done") {
    throw new Error(`short download failed: ${JSON.stringify({ started, jobs })}`);
  }
  return {
    started,
    visibleUi,
    jobs,
    downloadDir,
  };
}

async function checkConcurrentDownloadPerformance(page) {
  await waitForSmokeApi(page);
  const started = await clickAllEditorDownloadsThroughUi(page, {
    durationSeconds: downloadDurationSeconds,
    qualityHeight: downloadQualityHeight,
  });
  if (!started.started) {
    throw new Error(`performance downloads did not start: ${JSON.stringify(started)}`);
  }

  const samples = [];
  const startTime = Date.now();
  let lastBytes = 0;
  let lastAt = startTime;
  let peakBytesPerSecond = 0;
  let activeSampleCount = 0;
  let activeBytesPerSecondSum = 0;
  let lastProgressAt = startTime;

  while (Date.now() - startTime < 240_000) {
    await page.waitForTimeout(1000);
    const jobs = await page.evaluate(() => window.__CHZZK_SAVER_SMOKE__.getJobs());
    const totalBytes = jobs.reduce((sum, job) => sum + parseSizeBytes(job.size), 0);
    const now = Date.now();
    const elapsedSeconds = Math.max((now - lastAt) / 1000, 0.001);
    const bytesPerSecond = Math.max(0, (totalBytes - lastBytes) / elapsedSeconds);
    if (bytesPerSecond > 0) {
      lastProgressAt = now;
      peakBytesPerSecond = Math.max(peakBytesPerSecond, bytesPerSecond);
      activeBytesPerSecondSum += bytesPerSecond;
      activeSampleCount += 1;
    }
    samples.push({
      atMs: now - startTime,
      totalBytes,
      bytesPerSecond,
      states: countJobStates(jobs),
    });
    lastBytes = totalBytes;
    lastAt = now;

    if (jobs.length >= started.started && jobs.every((job) => job.state === "done" || job.state === "error")) {
      const failedJobs = jobs.filter((job) => job.state !== "done");
      if (failedJobs.length) {
        throw new Error(`performance download had failed jobs: ${JSON.stringify(failedJobs)}`);
      }
      const visibleUi = await assertVisibleDownloadUi(page, { expectedDone: started.started });
      return {
        started,
        visibleUi,
        durationSeconds: downloadDurationSeconds,
        qualityHeight: downloadQualityHeight,
        jobs,
        totalBytes,
        elapsedMs: now - startTime,
        peakMbps: bytesPerSecondToMbps(peakBytesPerSecond),
        activeAverageMbps: bytesPerSecondToMbps(activeSampleCount ? activeBytesPerSecondSum / activeSampleCount : 0),
        samples,
        downloadDir,
      };
    }

    if (now - lastProgressAt > 30_000) {
      throw new Error(`download progress stalled for 30 seconds: ${JSON.stringify({ started, jobs, samples: samples.slice(-10) })}`);
    }
  }

  const jobs = await page.evaluate(() => window.__CHZZK_SAVER_SMOKE__.getJobs());
  throw new Error(`performance download timed out: ${JSON.stringify({ started, jobs, samples: samples.slice(-10) })}`);
}

async function waitForSmokeApi(page) {
  await page.waitForFunction(() => Boolean(window.__CHZZK_SAVER_SMOKE__), null, { timeout: 10_000 });
}

async function clickSelectedDownloadThroughUi(page, { durationSeconds, qualityHeight }) {
  const beforeCount = await getSmokeJobCount(page);
  const selection = await configureSelectedDownloadUi(page, { durationSeconds, qualityHeight });
  await page.locator(".editor-item.selected .editor-item-download").scrollIntoViewIfNeeded();
  await page.locator(".editor-item.selected .editor-item-download").click({ timeout: 30_000 });
  await page.waitForFunction((count) =>
    (window.__CHZZK_SAVER_SMOKE__?.getJobs?.().length || 0) > count,
  beforeCount, { timeout: 30_000 });
  return {
    jobCount: await getSmokeJobCount(page),
    selection,
  };
}

async function clickAllEditorDownloadsThroughUi(page, { durationSeconds, qualityHeight }) {
  const itemCount = await page.locator(".editor-item").count();
  let started = 0;
  for (let index = 0; index < itemCount; index += 1) {
    const beforeCount = await getSmokeJobCount(page);
    await page.locator(".editor-item").nth(index).locator(".editor-item-main").click({ timeout: 30_000 });
    await configureSelectedDownloadUi(page, { durationSeconds, qualityHeight });
    await page.locator(".editor-item.selected .editor-item-download").scrollIntoViewIfNeeded();
    await page.locator(".editor-item.selected .editor-item-download").click({ timeout: 30_000 });
    await page.waitForFunction((count) =>
      (window.__CHZZK_SAVER_SMOKE__?.getJobs?.().length || 0) > count,
    beforeCount, { timeout: 30_000 });
    started += 1;
  }
  return {
    jobCount: await getSmokeJobCount(page),
    started,
  };
}

async function configureSelectedDownloadUi(page, { durationSeconds, qualityHeight }) {
  return page.evaluate(({ durationSeconds, qualityHeight }) => {
    const selected = document.querySelector(".editor-item.selected");
    if (!selected) {
      throw new Error("smoke download requires a selected editor item");
    }
    const qualitySelect = document.querySelector("#qualitySelect");
    const downloadButton = selected.querySelector(".editor-item-download");
    if (!qualitySelect || !downloadButton) {
      throw new Error("smoke download controls are missing");
    }
    const options = [...qualitySelect.options];
    const qualityPattern = new RegExp(`${qualityHeight}p`);
    const selectedOption = options.find((option) => qualityPattern.test(option.textContent || "")) || options[options.length - 1];
    if (!selectedOption) {
      throw new Error("smoke download quality option is missing");
    }
    qualitySelect.value = selectedOption.value;
    qualitySelect.dispatchEvent(new Event("change", { bubbles: true }));
    window.dispatchEvent(new CustomEvent("chzzk-saver:set-range-start", { detail: { time: 0 } }));
    window.dispatchEvent(new CustomEvent("chzzk-saver:set-range-end", {
      detail: { time: Math.max(1, Number(durationSeconds) || 6) },
    }));
    const rect = downloadButton.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || downloadButton.disabled) {
      throw new Error(`smoke download button is not clickable: ${JSON.stringify({
        width: rect.width,
        height: rect.height,
        disabled: downloadButton.disabled,
      })}`);
    }
    return {
      url: selected.dataset.url || "",
      quality: selectedOption.textContent?.trim() || "",
      range: document.querySelector("#rangeDurationText")?.textContent?.trim() || "",
      cardTrimStart: selected.dataset.trimStart || "",
      cardTrimEnd: selected.dataset.trimEnd || "",
      downloadIcon: downloadButton.querySelector(".editor-item-icon")?.className || "",
      downloadRange: downloadButton.dataset.range || "",
    };
  }, { durationSeconds, qualityHeight });
}

async function waitForTerminalJobs(page) {
  await page.waitForFunction(() => {
    const jobs = window.__CHZZK_SAVER_SMOKE__?.getJobs?.() || [];
    return jobs.some((job) => job.state === "done" || job.state === "error");
  }, null, { timeout: 180_000 });
}

async function getSmokeJobCount(page) {
  return page.evaluate(() => window.__CHZZK_SAVER_SMOKE__?.getJobs?.().length || 0);
}

async function assertVisibleDownloadUi(page, { expectedDone }) {
  const state = await page.evaluate(() => {
    const editorProgress = [...document.querySelectorAll(".editor-item-progress")]
      .filter((element) => !element.hidden)
      .map((element) => ({
        state: element.querySelector(".state-pill")?.textContent?.trim() || "",
        percent: element.querySelector(".editor-progress-percent")?.textContent?.trim() || "",
        size: element.querySelector(".editor-progress-size")?.textContent?.trim() || "",
        speed: element.querySelector(".editor-progress-speed")?.textContent?.trim() || "",
        eta: element.querySelector(".editor-progress-eta")?.textContent?.trim() || "",
      }));
    const jobCards = [...document.querySelectorAll(".download-job")]
      .map((element) => ({
        state: element.querySelector(".state-pill")?.textContent?.trim() || "",
        percent: element.querySelector(".job-percent")?.textContent?.trim() || "",
        size: element.querySelector(".job-size")?.textContent?.trim() || "",
        speed: element.querySelector(".job-speed")?.textContent?.trim() || "",
        eta: element.querySelector(".job-eta")?.textContent?.trim() || "",
      }));
    return {
      queueStatus: document.querySelector("#queueStatus")?.textContent?.trim() || "",
      editorProgress,
      jobCards,
      downloadButtons: [...document.querySelectorAll(".editor-item-download")]
        .map((button) => ({
          icon: button.querySelector(".editor-item-icon")?.className || "",
          range: button.dataset.range || "",
          disabled: Boolean(button.disabled),
        })),
    };
  });

  const doneEditorProgress = state.editorProgress.filter((item) =>
    item.state === "완료" && item.percent === "100%" && item.eta === "완료");
  const doneJobCards = state.jobCards.filter((item) =>
    item.state === "완료" && item.percent === "100%" && item.eta === "완료");
  if (doneEditorProgress.length < expectedDone || doneJobCards.length < expectedDone) {
    throw new Error(`visible download UI did not reflect completion: ${JSON.stringify({ expectedDone, state })}`);
  }
  return state;
}

async function checkPopupAddToEditor(context, extensionId, editorPage, url) {
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const requestFailures = [];
  const responseFailures = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) => {
    requestFailures.push({
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText || "",
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      responseFailures.push({
        url: response.url(),
        status: response.status(),
      });
    }
  });

  await page.goto(`chrome-extension://${extensionId}/popup.html`, {
    waitUntil: "load",
    timeout: 10_000,
  });
  await page.fill("#vodUrl", url);
  await page.click("#addToEditor");
  await page.waitForSelector("#doneView:not([hidden])", { timeout: 60_000 });
  await editorPage.waitForFunction(() =>
    document.querySelectorAll(".editor-item").length >= 1
    && document.querySelectorAll(".editor-item.selected").length === 1
    && !document.querySelector("#videoSection")?.hidden,
  null, { timeout: 60_000 });

  const state = await page.evaluate(() => ({
    doneVisible: !document.querySelector("#doneView")?.hidden,
    addVisible: !document.querySelector("#addView")?.hidden,
    status: document.querySelector("#status")?.textContent?.trim() || "",
  }));
  return {
    ...state,
    pageErrors,
    consoleErrors,
    requestFailures,
    responseFailures,
  };
}

async function checkPreviewPlaybackLazyLoad(page) {
  await page.waitForFunction(() => {
    const player = document.querySelector("#previewPlayer");
    return Boolean(player?.getAttribute("src") || player?.currentSrc)
      && player.readyState >= HTMLMediaElement.HAVE_METADATA;
  }, null, { timeout: 20_000 });

  return page.evaluate(() => {
    const player = document.querySelector("#previewPlayer");
    return {
      src: player?.getAttribute("src") || "",
      currentSrc: player?.currentSrc || "",
      preload: player?.preload || "",
      readyState: player?.readyState ?? null,
      controls: Boolean(player?.controls),
      paused: Boolean(player?.paused),
    };
  });
}

async function checkMetadataLoad(page, urls) {
  if (!page) {
    throw new Error("편집기 페이지를 찾지 못했습니다.");
  }

  const uniqueUrls = [...new Set(urls)];
  const expectedItemCount = uniqueUrls.length;
  await page.evaluate((items) => {
    for (const url of items) {
      window.dispatchEvent(new CustomEvent("chzzk-saver:add-editor-video", {
        detail: { url, select: false, clearInput: true },
      }));
    }
  }, uniqueUrls);

  await page.waitForFunction((expectedCount) => {
    const items = [...document.querySelectorAll(".editor-item")];
    const message = document.querySelector("#message")?.textContent?.trim() || "";
    const loadedItems = items.filter((item) => item.dataset.loaded === "true");
    return items.length === expectedCount
      && loadedItems.length === expectedCount
      && !message.includes("실패")
      && !message.includes("오류");
  }, expectedItemCount, { timeout: 60_000 });

  await page.locator(".editor-item").first().locator(".editor-item-main").click({ timeout: 30_000 });
  await page.waitForFunction(() =>
    document.querySelectorAll(".editor-item.selected").length === 1
    && !document.querySelector("#videoSection")?.hidden
    && document.querySelectorAll("#qualitySelect option").length > 0,
  null, { timeout: 30_000 });

  const state = await page.evaluate(() => ({
    title: document.querySelector(".editor-item-title")?.textContent?.trim() || "",
    kind: document.querySelector(".editor-item-kind")?.textContent?.trim() || "",
    duration: document.querySelector(".editor-item-duration")?.textContent?.trim() || "",
    message: document.querySelector("#message")?.textContent?.trim() || "",
    videoVisible: !document.querySelector("#videoSection")?.hidden,
    inputValue: document.querySelector("#vodUrl")?.value || "",
    editorItemCount: document.querySelectorAll(".editor-item").length,
    selectedEditorItemCount: document.querySelectorAll(".editor-item.selected").length,
    focusedEditorItem: document.activeElement?.classList?.contains("editor-item-main") || false,
    playerSelectedQuality: document.querySelector("#playerQualitySelect")?.value || "",
    playerSelectedQualityLabel: document.querySelector("#playerQualitySelect option:checked")?.textContent?.trim() || "",
    playerQualityOptions: [...document.querySelectorAll("#playerQualitySelect option")]
      .map((option) => option.textContent?.trim())
      .filter(Boolean),
    qualityOptions: [...document.querySelectorAll("#qualitySelect option")]
      .map((option) => option.textContent?.trim())
      .filter(Boolean),
  }));

  if (/(실패|오류|입력|찾지 못|권한|중단)/.test(state.message)) {
    throw new Error(`메타데이터 로드 실패: ${state.message}`);
  }
  if (!state.title || state.title === "영상 정보를 불러오는 중" || !state.videoVisible || !state.qualityOptions.length) {
    throw new Error(`메타데이터 UI 확인 실패: ${JSON.stringify(state)}`);
  }
  if (state.inputValue) {
    throw new Error(`링크 로드 후 검색창이 비워지지 않았습니다: ${JSON.stringify(state)}`);
  }
  if (state.editorItemCount !== expectedItemCount || state.selectedEditorItemCount !== 1 || !state.focusedEditorItem) {
    throw new Error(`편집기 항목/포커스 확인 실패: ${JSON.stringify(state)}`);
  }
  return state;
}

async function waitForExtensionTargets(debugPort) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        if (targets.some((target) => target.url?.endsWith?.("/service-worker-loader.js"))) {
          return targets;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await delay(400);
  }
  throw new Error(`Whale 디버깅 타깃을 찾지 못했습니다: ${lastError?.message || "timeout"}`);
}

async function findWhaleExecutable() {
  const candidates = [
    "C:/Program Files/Naver/Naver Whale/Application",
    "C:/Program Files/NAVER/Naver Whale/Application",
    "C:/Program Files (x86)/Naver/Naver Whale/Application",
    "C:/Program Files (x86)/NAVER/Naver Whale/Application",
  ];

  for (const appDir of candidates) {
    const versionExe = await findVersionedWhaleExecutable(appDir);
    if (versionExe) {
      return versionExe;
    }
    const wrapperExe = join(appDir, "whale.exe");
    if (existsSync(wrapperExe)) {
      return wrapperExe;
    }
  }
  throw new Error("Naver Whale 실행 파일을 찾지 못했습니다.");
}

async function findVersionedWhaleExecutable(appDir) {
  if (!existsSync(appDir)) {
    return null;
  }
  const entries = await readdir(appDir, { withFileTypes: true });
  const versions = entries
    .filter((entry) => entry.isDirectory() && /^\d+\./.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareVersionDesc);

  for (const version of versions) {
    const exe = join(appDir, version, "whale.exe");
    if (existsSync(exe)) {
      return exe;
    }
  }
  return null;
}

function compareVersionDesc(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (right[index] || 0) - (left[index] || 0);
    if (diff) {
      return diff;
    }
  }
  return 0;
}

function toBrowserPath(value) {
  return value.replaceAll("\\", "/");
}

function readArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} 값을 입력해 주세요.`);
  }
  return value;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function readNumberArgValue(name, fallback) {
  const value = readArgValue(name);
  if (value === null) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} 값은 0보다 큰 숫자여야 합니다.`);
  }
  return number;
}

function readRepeatedArgValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) {
      continue;
    }
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} 값을 입력해 주세요.`);
    }
    values.push(value);
  }
  return values;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function countJobStates(jobs) {
  return jobs.reduce((counts, job) => {
    counts[job.state] = (counts[job.state] || 0) + 1;
    return counts;
  }, {});
}

function parseSizeBytes(sizeText) {
  const firstPart = String(sizeText || "").split("/", 1)[0].trim();
  const match = firstPart.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!match) {
    return 0;
  }
  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  const scale = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  }[unit] || 1;
  return Math.round(value * scale);
}

function bytesPerSecondToMbps(bytesPerSecond) {
  return Math.round((bytesPerSecond / 1024 / 1024) * 100) / 100;
}
