(() => {
  const loader = document.getElementById("coverLoader");
  const stage = document.getElementById("coverStage");
  const mapImg = document.querySelector("img.cover-map");
  const startLink = document.querySelector(".cover__start");

  const TERRITORY_URL = "territorio.html";
  const MANUAL_ENTRY_KEY = "territory_manual_photo_entry";
  const MANUAL_TRANSITION_MS = 980;

  let loaderTimer = null;
  let assemblyTimer = null;
  let completeTimer = null;
  let prewarmFrame = null;
  let prewarmResolve = null;
  let prewarmPromise = null;
  let navigating = false;

  function clearTimers() {
    window.clearTimeout(loaderTimer);
    window.clearTimeout(assemblyTimer);
    window.clearTimeout(completeTimer);
  }

  function removeOneShotTransitionBlocker() {
    document.getElementById("cover-disable-native-transition")?.remove();
  }

  function resetTransientState() {
    navigating = false;
    document.body.classList.remove(
      "is-leaving",
      "is-cover-exiting",
      "is-navigation-armed",
      "is-photo-morphing"
    );

    stage?.classList.remove("is-exiting");
    removeOneShotTransitionBlocker();

    document
      .querySelectorAll(".cover-transition-overlay")
      .forEach(node => node.remove());
  }

  function showFinalState() {
    clearTimers();
    resetTransientState();
    loader?.classList.add("is-hidden");
    stage?.classList.add("is-assembling", "is-complete");
  }

  function runInitialAssembly() {
    clearTimers();
    resetTransientState();

    loaderTimer = window.setTimeout(() => {
      loader?.classList.add("is-hidden");

      assemblyTimer = window.setTimeout(() => {
        stage?.classList.add("is-assembling");
      }, 180);

      completeTimer = window.setTimeout(() => {
        stage?.classList.add("is-complete");
      }, 2550);
    }, 1350);
  }

  /*
    Precarga real del documento destino a tamaño de viewport.
    Además de calentar HTML/CSS/imagen, permite leer la geometría EXACTA
    de la fotografía y del frame de Territorio antes de navegar.
  */
  function prewarmTerritory() {
    if (prewarmPromise) return prewarmPromise;

    prewarmPromise = new Promise(resolve => {
      prewarmResolve = resolve;

      prewarmFrame = document.createElement("iframe");
      prewarmFrame.src = `${TERRITORY_URL}#prewarm`;
      prewarmFrame.tabIndex = -1;
      prewarmFrame.setAttribute("aria-hidden", "true");
      prewarmFrame.setAttribute("title", "");
      prewarmFrame.className = "cover-prewarm-frame";

      prewarmFrame.addEventListener("load", () => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            document.documentElement.dataset.territoryPrewarmed = "1";
            prewarmResolve?.(prewarmFrame);
          });
        });
      }, { once: true });

      document.body.appendChild(prewarmFrame);
    });

    return prewarmPromise;
  }

  function wait(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  function estimateTargetGeometry() {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const shellWidth = Math.min(viewportWidth - 18, 1600);
    const shellLeft = (viewportWidth - shellWidth) / 2;
    const shellTop = viewportWidth <= 760 ? 0 : 12;
    const frameHeight = Math.max(viewportHeight - 34, 245);

    let copyRatio = 1 / 2.15;

    if (viewportWidth <= 760) {
      copyRatio = 1;
    } else if (viewportWidth <= 1080) {
      copyRatio = 1 / 1.85;
    }

    const photoLeft = viewportWidth <= 760
      ? shellLeft
      : shellLeft + shellWidth * copyRatio;

    const photoWidth = viewportWidth <= 760
      ? shellWidth
      : shellWidth * (1 - copyRatio);

    return {
      frameRect: {
        left: shellLeft,
        top: shellTop,
        width: shellWidth,
        height: frameHeight
      },
      photoRect: {
        left: photoLeft,
        top: shellTop,
        width: photoWidth,
        height: 245
      }
    };
  }

  async function getTargetGeometry() {
    const frame = await Promise.race([
      prewarmTerritory(),
      wait(1500).then(() => prewarmFrame)
    ]);

    try {
      const doc = frame?.contentDocument;
      const targetPhoto = doc?.querySelector(".territory-hero__visual");
      const targetFrame = doc?.querySelector(".territory-frame");

      if (targetPhoto && targetFrame) {
        const photoRect = targetPhoto.getBoundingClientRect();
        const frameRect = targetFrame.getBoundingClientRect();

        if (photoRect.width && photoRect.height) {
          return { photoRect, frameRect };
        }
      }
    } catch (error) {
      console.warn("[Portada] No se pudo leer la geometría precargada; se usa el cálculo local.", error);
    }

    // Nunca dejamos el primer ingreso sin morph: si el iframe aún no responde,
    // usamos una geometría equivalente a la maquetación actual de Territorio.
    return estimateTargetGeometry();
  }

  function disableNativeTransitionOnce() {
    removeOneShotTransitionBlocker();

    const style = document.createElement("style");
    style.id = "cover-disable-native-transition";
    style.textContent = "@view-transition { navigation: none; }";
    document.head.appendChild(style);
  }

  function createTransitionLayers(sourceRect, target) {
    const backdrop = document.createElement("div");
    backdrop.className = "cover-transition-overlay cover-transition-backdrop";

    const frame = document.createElement("div");
    frame.className = "cover-transition-overlay cover-transition-target-frame";
    Object.assign(frame.style, {
      left: `${target.frameRect.left}px`,
      top: `${target.frameRect.top}px`,
      width: `${target.frameRect.width}px`,
      height: `${target.frameRect.height}px`
    });

    const photo = document.createElement("div");
    photo.className = "cover-transition-overlay cover-transition-photo";
    Object.assign(photo.style, {
      left: `${sourceRect.left}px`,
      top: `${sourceRect.top}px`,
      width: `${sourceRect.width}px`,
      height: `${sourceRect.height}px`
    });

    document.body.append(backdrop, frame, photo);

    return { backdrop, frame, photo };
  }

  async function runPhotoMorph(href) {
    if (navigating) return;
    navigating = true;

    const sourceRect = stage?.getBoundingClientRect();
    const target = await getTargetGeometry();

    if (!sourceRect) {
      sessionStorage.setItem(MANUAL_ENTRY_KEY, "1");
      window.location.href = href;
      return;
    }

    disableNativeTransitionOnce();
    sessionStorage.setItem(MANUAL_ENTRY_KEY, "1");

    const { backdrop, frame, photo } = createTransitionLayers(sourceRect, target);

    document.body.classList.add("is-photo-morphing");

    // Forzamos un frame con el estado inicial antes de aplicar el destino.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    backdrop.classList.add("is-active");
    frame.classList.add("is-active");

    Object.assign(photo.style, {
      left: `${target.photoRect.left}px`,
      top: `${target.photoRect.top}px`,
      width: `${target.photoRect.width}px`,
      height: `${target.photoRect.height}px`,
      borderRadius: "0 23px 0 0",
      backgroundPosition: "center 52%",
      boxShadow: "0 10px 26px rgba(24,34,48,.10)"
    });

    photo.classList.add("is-active");

    window.setTimeout(() => {
      window.location.href = href;
    }, MANUAL_TRANSITION_MS);
  }

  async function inlinePeruMap() {
    if (!mapImg || mapImg.dataset.inlineRequested === "1") return;
    mapImg.dataset.inlineRequested = "1";

    try {
      const src = mapImg.getAttribute("src");
      const response = await fetch(src, { cache: "force-cache" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const svgText = await response.text();
      const parser = new DOMParser();
      const documentSvg = parser.parseFromString(svgText, "image/svg+xml");
      const svg = documentSvg.documentElement;

      if (!svg || svg.nodeName.toLowerCase() !== "svg") {
        throw new Error("SVG inválido");
      }

      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.classList.add("cover-map", "cover-piece", "cover-map--inline");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", mapImg.alt || "Mapa del Perú");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

      const palette = [
        "rgba(255,255,255,.98)",
        "rgba(255,247,250,.94)",
        "rgba(248,235,240,.90)",
        "rgba(255,255,255,.80)"
      ];

      const departments = [...svg.querySelectorAll('path[id^="PE-"]')];

      departments.forEach((path, index) => {
        path.removeAttribute("style");
        path.removeAttribute("filter");
        path.style.setProperty("fill", palette[index % palette.length], "important");
        path.style.setProperty("fill-opacity", "1", "important");
        path.style.setProperty("stroke", "rgba(255,255,255,.98)", "important");
        path.style.setProperty("stroke-width", "1.35", "important");
        path.style.setProperty("stroke-linejoin", "round", "important");
        path.style.setProperty("vector-effect", "non-scaling-stroke", "important");
      });

      const limaCallao = svg.querySelector("#PE-LKT");
      if (limaCallao) {
        limaCallao.style.setProperty("fill", "rgba(255,255,255,.36)", "important");
        limaCallao.style.setProperty("stroke", "rgba(255,255,255,.88)", "important");
      }

      mapImg.replaceWith(document.importNode(svg, true));
    } catch (error) {
      console.warn("[Portada] Se mantiene el fallback del mapa del Perú.", error);
    }
  }

  window.addEventListener("load", () => {
    const navigationEntry = performance.getEntriesByType("navigation")[0];

    if (navigationEntry?.type === "back_forward") {
      showFinalState();
      return;
    }

    runInitialAssembly();
    prewarmTerritory();
  });

  window.addEventListener("pageshow", event => {
    if (event.persisted) {
      showFinalState();
      prewarmTerritory();
    }
  });

  startLink?.addEventListener("click", event => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    ) {
      return;
    }

    event.preventDefault();

    if (!stage?.classList.contains("is-complete") || navigating) return;

    const href = startLink.getAttribute("href") || TERRITORY_URL;
    runPhotoMorph(href);
  });

  startLink?.addEventListener("pointerenter", () => {
    prewarmTerritory();
  }, { once: true });

  inlinePeruMap();
})();
