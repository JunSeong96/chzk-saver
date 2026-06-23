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

const ready = init();
globalThis.chzzkSaverItemOptionsReady = ready;
ready.catch(() => {});

async function init() {
  const localOptions = readLocalOptions();
  const storedOptions = await readStoredOptions();
  const options = normalizeOptions(storedOptions || localOptions);
  writeLocalOptions(options);
  applyOptions(options);
  notifyOptionsChanged(options);

  for (const input of Object.values(controls)) {
    input?.addEventListener("change", () => {
      const next = readControls();
      writeLocalOptions(next);
      writeStoredOptions(next);
      notifyOptionsChanged(next);
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

async function readStoredOptions() {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage?.get) {
    return null;
  }
  try {
    const result = storage.get(STORAGE_KEY);
    if (result?.then) {
      return (await result.catch(() => null))?.[STORAGE_KEY] || null;
    }
  } catch {}
  return new Promise((resolve) => {
    try {
      storage.get(STORAGE_KEY, (result) => resolve(result?.[STORAGE_KEY] || null));
    } catch {
      resolve(null);
    }
  });
}

function writeStoredOptions(options) {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage?.set) {
    return;
  }
  try {
    storage.set({ [STORAGE_KEY]: normalizeOptions(options) })?.catch?.(() => {});
  } catch {
    try {
      storage.set({ [STORAGE_KEY]: normalizeOptions(options) }, () => {});
    } catch {}
  }
}

function notifyOptionsChanged(options) {
  window.dispatchEvent(new CustomEvent("chzzk-saver:item-options-changed", {
    detail: normalizeOptions(options),
  }));
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
