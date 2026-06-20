// @ts-nocheck
export {};

const STORAGE_KEY = "chzzkSaverItemOptions";
const defaults = {
  video: { autoDownload: false, removeOnComplete: false },
  clip: { autoDownload: false, removeOnComplete: false },
};

const controls = {
  videoAutoDownload: document.querySelector("#videoAutoDownload"),
  videoRemoveOnComplete: document.querySelector("#videoRemoveOnComplete"),
  clipAutoDownload: document.querySelector("#clipAutoDownload"),
  clipRemoveOnComplete: document.querySelector("#clipRemoveOnComplete"),
};

init().catch(() => {});

async function init() {
  const storage = globalThis.chrome?.storage?.local;
  const stored = storage ? await storage.get(STORAGE_KEY).catch(() => ({})) : {};
  const options = normalizeOptions(stored?.[STORAGE_KEY] || readLocalOptions());
  writeLocalOptions(options);
  applyOptions(options);

  for (const input of Object.values(controls)) {
    input?.addEventListener("change", () => {
      const next = readControls();
      writeLocalOptions(next);
      storage?.set({ [STORAGE_KEY]: next }).catch(() => {});
      window.dispatchEvent(new CustomEvent("chzzk-saver:item-options-changed", { detail: next }));
    });
  }
}

function readControls() {
  return normalizeOptions({
    video: {
      autoDownload: controls.videoAutoDownload?.checked,
      removeOnComplete: controls.videoRemoveOnComplete?.checked,
    },
    clip: {
      autoDownload: controls.clipAutoDownload?.checked,
      removeOnComplete: controls.clipRemoveOnComplete?.checked,
    },
  });
}

function applyOptions(options) {
  if (controls.videoAutoDownload) controls.videoAutoDownload.checked = options.video.autoDownload;
  if (controls.videoRemoveOnComplete) controls.videoRemoveOnComplete.checked = options.video.removeOnComplete;
  if (controls.clipAutoDownload) controls.clipAutoDownload.checked = options.clip.autoDownload;
  if (controls.clipRemoveOnComplete) controls.clipRemoveOnComplete.checked = options.clip.removeOnComplete;
}

function readLocalOptions() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function writeLocalOptions(options) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeOptions(options)));
}

function normalizeOptions(options) {
  return {
    video: {
      autoDownload: Boolean(options?.video?.autoDownload),
      removeOnComplete: Boolean(options?.video?.removeOnComplete),
    },
    clip: {
      autoDownload: Boolean(options?.clip?.autoDownload),
      removeOnComplete: Boolean(options?.clip?.removeOnComplete),
    },
  };
}
