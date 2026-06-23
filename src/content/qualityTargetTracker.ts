// @ts-nocheck
export {};

(() => {
  const INSTALL_FLAG = "__chzzkSaverQualityTrackerInstalled";
  const TARGETS_KEY = "__chzzkSaverQualityTargets";
  const MEDIA_ELEMENTS_KEY = "__chzzkSaverMediaElements";
  const MAX_TARGETS = 40;

  if (window[INSTALL_FLAG]) {
    return;
  }

  try {
    Object.defineProperty(window, INSTALL_FLAG, { value: true });
  } catch {
    window[INSTALL_FLAG] = true;
  }

  const trackedTargets = [];
  const trackedMediaElements = [];
  try {
    Object.defineProperty(window, TARGETS_KEY, {
      configurable: false,
      value: trackedTargets,
    });
  } catch {
    window[TARGETS_KEY] = trackedTargets;
  }
  try {
    Object.defineProperty(window, MEDIA_ELEMENTS_KEY, {
      configurable: false,
      value: trackedMediaElements,
    });
  } catch {
    window[MEDIA_ELEMENTS_KEY] = trackedMediaElements;
  }

  const nativeDefineProperty = Object.defineProperty;
  const nativeDefineProperties = Object.defineProperties;
  const nativeReflectDefineProperty = Reflect?.defineProperty;
  const nativeCreateElement = Document.prototype.createElement;
  const nativeCreateElementNS = Document.prototype.createElementNS;

  function rememberQualityTarget(target) {
    if (!target || (typeof target !== "object" && typeof target !== "function")) {
      return;
    }
    if (trackedTargets.includes(target)) {
      return;
    }
    trackedTargets.push(target);
    if (trackedTargets.length > MAX_TARGETS) {
      trackedTargets.shift();
    }
  }

  function rememberMediaElement(element) {
    if (!isMediaElement(element) || trackedMediaElements.includes(element)) {
      return;
    }
    trackedMediaElements.push(element);
    if (trackedMediaElements.length > MAX_TARGETS) {
      trackedMediaElements.shift();
    }
  }

  function isMediaElement(value) {
    const tagName = value?.tagName?.toLowerCase?.();
    return tagName === "video" || tagName === "audio";
  }

  function hasTrackList(value) {
    return value && Number.isFinite(Number(value.length)) && Number(value.length) > 0;
  }

  function markWrapped(fn) {
    try {
      nativeDefineProperty(fn, "__chzzkSaverVideoTracksWrapped", { value: true });
    } catch {
      fn.__chzzkSaverVideoTracksWrapped = true;
    }
  }

  function wrapVideoTracksDescriptor(prop, descriptor) {
    if (prop !== "videoTracks" || !descriptor) {
      return descriptor;
    }
    if (descriptor.get?.__chzzkSaverVideoTracksWrapped || descriptor.set?.__chzzkSaverVideoTracksWrapped) {
      return descriptor;
    }

    const nextDescriptor = { ...descriptor };

    if (typeof descriptor.get === "function") {
      const originalGet = descriptor.get;
      nextDescriptor.get = function() {
        const tracks = originalGet.call(this);
        if (hasTrackList(tracks)) {
          rememberQualityTarget(this);
        }
        return tracks;
      };
      markWrapped(nextDescriptor.get);
    }

    if (typeof descriptor.set === "function") {
      const originalSet = descriptor.set;
      nextDescriptor.set = function(value) {
        rememberQualityTarget(this);
        return originalSet.call(this, value);
      };
      markWrapped(nextDescriptor.set);
    }

    return nextDescriptor;
  }

  function safeWrapDescriptor(prop, descriptor) {
    try {
      return wrapVideoTracksDescriptor(prop, descriptor);
    } catch {
      return descriptor;
    }
  }

  try {
    Object.defineProperty = function(target, prop, descriptor) {
      return nativeDefineProperty.call(Object, target, prop, safeWrapDescriptor(prop, descriptor));
    };
  } catch {
    // The command path can still use direct videoTracks discovery.
  }

  if (nativeDefineProperties) {
    try {
      Object.defineProperties = function(target, descriptors) {
        if (descriptors == null) {
          return nativeDefineProperties.call(Object, target, descriptors);
        }

        let nextDescriptors = descriptors;
        try {
          nextDescriptors = {};
          for (const key of Reflect.ownKeys(descriptors)) {
            nextDescriptors[key] = wrapVideoTracksDescriptor(key, descriptors[key]);
          }
        } catch {
          nextDescriptors = descriptors;
        }

        return nativeDefineProperties.call(Object, target, nextDescriptors);
      };
    } catch {
      // Object.defineProperty interception is enough for the known player path.
    }
  }

  if (nativeReflectDefineProperty) {
    try {
      Reflect.defineProperty = function(target, prop, descriptor) {
        return nativeReflectDefineProperty.call(Reflect, target, prop, safeWrapDescriptor(prop, descriptor));
      };
    } catch {
      // Opportunistic.
    }
  }

  try {
    Document.prototype.createElement = function(tagName, options) {
      const element = nativeCreateElement.call(this, tagName, options);
      rememberMediaElement(element);
      return element;
    };
  } catch {
    // Direct DOM scans can still find open player trees.
  }

  try {
    Document.prototype.createElementNS = function(namespaceURI, qualifiedName, options) {
      const element = nativeCreateElementNS.call(this, namespaceURI, qualifiedName, options);
      rememberMediaElement(element);
      return element;
    };
  } catch {
    // Opportunistic.
  }

  try {
    for (const element of document.querySelectorAll("video,audio")) {
      rememberMediaElement(element);
    }
  } catch {
    // Ignore early document access issues.
  }
})();
