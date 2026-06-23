export {};

const STORAGE_KEY = "chzzkSaverItemOptions";
const optionKeys = [
  "autoDownload",
  "closeOnAdd",
  "removeOnComplete",
  "closeOnComplete",
] as const;
const contentKinds = ["video", "clip"] as const;

type OptionKey = typeof optionKeys[number];
type ContentKind = typeof contentKinds[number];
type KindOptions = Record<OptionKey, boolean>;
type ItemOptions = Record<ContentKind, KindOptions>;
type PartialKindOptions = Partial<Record<OptionKey, unknown>>;
type PartialItemOptions = Partial<Record<ContentKind, PartialKindOptions>> | null | undefined;

const controls = Object.fromEntries(
  contentKinds.flatMap((kind) => optionKeys.map((key) => [
    `${kind}.${key}`,
    document.querySelector<HTMLInputElement>(`#${kind}${capitalize(key)}`),
  ])),
) as Record<`${ContentKind}.${OptionKey}`, HTMLInputElement | null>;

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

function readControls(): ItemOptions {
  const next = normalizeOptions();
  for (const kind of contentKinds) {
    for (const key of optionKeys) {
      next[kind][key] = controls[`${kind}.${key}`]?.checked === true;
    }
  }
  return next;
}

function applyOptions(options: ItemOptions) {
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

function writeLocalOptions(options: PartialItemOptions) {
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

function writeStoredOptions(options: PartialItemOptions) {
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

function notifyOptionsChanged(options: PartialItemOptions) {
  globalThis.chzzkSaverItemOptions = normalizeOptions(options);
  window.dispatchEvent(new CustomEvent("chzzk-saver:item-options-changed", {
    detail: globalThis.chzzkSaverItemOptions,
  }));
}

function normalizeOptions(options: PartialItemOptions = {}): ItemOptions {
  const source = options ?? {};
  return {
    video: normalizeKind(source.video),
    clip: normalizeKind(source.clip),
  };
}

function normalizeKind(options: PartialKindOptions = {}): KindOptions {
  const source = options ?? {};
  return {
    autoDownload: Boolean(source.autoDownload),
    closeOnAdd: Boolean(source.closeOnAdd),
    removeOnComplete: Boolean(source.removeOnComplete),
    closeOnComplete: Boolean(source.closeOnComplete),
  };
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
