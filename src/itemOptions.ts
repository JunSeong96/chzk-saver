// @ts-nocheck
export {};

const STORAGE_KEY = "chzzkSaverItemOptions";
const optionKeys = [
  "autoDownload",
  "closeOnAdd",
  "removeOnComplete",
  "closeOnComplete",
];
const contentKinds = ["video", "clip"];

const controls = Object.fromEntries(
  contentKinds.flatMap((kind) => optionKeys.map((key) => [
    `${kind}.${key}`,
    document.querySelector(`#${kind}${capitalize(key)}`),
  ])),
);

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
  const next = normalizeOptions();
  for (const kind of contentKinds) {
    for (const key of optionKeys) {
      next[kind][key] = controls[`${kind}.${key}`]?.checked === true;
    }
  }
  return next;
}

function applyOptions(options) {
  for (const kind of contentKinds) {
    for (const key of optionKeys) {
      const input = controls[`${kind}.${key}`];
      if (input) {
        input.checked = options[kind][key];
      }
    }
  }
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

function normalizeOptions(options = {}) {
  return {
    video: normalizeKind(options.video),
    clip: normalizeKind(options.clip),
  };
}

function normalizeKind(options = {}) {
  return {
    autoDownload: Boolean(options.autoDownload),
    closeOnAdd: Boolean(options.closeOnAdd),
    removeOnComplete: Boolean(options.removeOnComplete),
    closeOnComplete: Boolean(options.closeOnComplete),
  };
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
