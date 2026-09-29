const TOPOLOGY_SOURCE_URL =
  "https://raw.githubusercontent.com/Rodasluis/Peru-maps/main/salida/distrito_simplificado.geojson";

const TERRITORY_CONFIG = {
  VRAEM: {
    label: "VRAEM",
    filterField: "es_vraem",
    filterValue: "SI",
    color: "#991735",
    legendSide: "right"
  },
  NORVRAEM: {
    label: "NORVRAEM",
    filterField: "es_norvraem",
    filterValue: "SI",
    color: "#153f5b",
    legendSide: "right"
  },
  AMUVRAEM: {
    label: "AMUVRAE",
    filterField: "es_amuvraem",
    filterValue: "SI",
    color: "#0c8a60",
    legendSide: "right"
  }
};

/*
  Total único validado en la tabla maestra del proyecto.
  Los ámbitos no son excluyentes; por ello sus conteos pueden superponerse.
*/
const TOTAL_DISTRITOS_UNICOS = 34;
const TERRITORY_VERSION = "v1.1-topology";
const SVG_NS = "http://www.w3.org/2000/svg";
const IS_PREWARM = window.location.hash === "#prewarm";

function normalizeCode(value, digits) {
  if (value === null || value === undefined || value === "") return "";
  return String(value).trim().padStart(digits, "0");
}

function normalizeText(value) {
  return String(value ?? "").trim().toUpperCase();
}

function featureDistrictCode(feature) {
  const p = feature?.properties ?? {};

  return normalizeCode(
    p.ubigeo_distrito ??
    p.UBIGEO_DISTRITO ??
    p.ubigeo ??
    p.UBIGEO,
    6
  );
}

function featureDistrictName(feature) {
  const p = feature?.properties ?? {};

  return (
    p.distrito ??
    p.NOMBDIST ??
    p.nombre ??
    p.NOMBRE ??
    "Distrito"
  );
}

function uniqueCount(rows, field) {
  return new Set(
    rows
      .map(row => row[field])
      .filter(value => value !== null && value !== undefined && value !== "")
      .map(value => String(value))
  ).size;
}

function summarize(rows) {
  return {
    inversiones: uniqueCount(rows, "cui"),
    puentes: rows.reduce((sum, row) => sum + Number(row.n_puentes || 0), 0),
    distritos: uniqueCount(rows, "ubigeo_distrito"),
    provincias: uniqueCount(rows, "ubigeo_provincia"),
    departamentos: uniqueCount(rows, "ubigeo_departamento")
  };
}

function rowsForTerritory(data, territory) {
  const config = TERRITORY_CONFIG[territory];

  return data.filter(row =>
    normalizeText(row[config.filterField]) === config.filterValue
  );
}

function geometryCoordinates(geometry) {
  if (!geometry) return [];

  const output = [];

  function walk(node) {
    if (!Array.isArray(node)) return;

    if (
      node.length >= 2 &&
      typeof node[0] === "number" &&
      typeof node[1] === "number"
    ) {
      output.push(node);
      return;
    }

    node.forEach(walk);
  }

  walk(geometry.coordinates);
  return output;
}

function geometryToSvgPath(geometry, project) {
  if (!geometry) return "";

  function ringPath(ring) {
    if (!ring?.length) return "";

    return ring
      .map((coord, index) => {
        const [x, y] = project(coord);
        return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ") + " Z";
  }

  if (geometry.type === "Polygon") {
    return geometry.coordinates.map(ringPath).join(" ");
  }

  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates
      .flatMap(polygon => polygon.map(ringPath))
      .join(" ");
  }

  return "";
}

function boundsFrom(features) {
  const coords = [];

  features.forEach(feature => {
    coords.push(...geometryCoordinates(feature.geometry));
  });

  if (!coords.length) return null;

  const xs = coords.map(c => c[0]);
  const ys = coords.map(c => c[1]);

  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys)
  };
}

function expandBounds(bounds, ratioX = 0.12, ratioY = 0.14) {
  if (!bounds) return null;

  const spanX = Math.max(bounds.maxX - bounds.minX, 0.001);
  const spanY = Math.max(bounds.maxY - bounds.minY, 0.001);

  return {
    minX: bounds.minX - spanX * ratioX,
    maxX: bounds.maxX + spanX * ratioX,
    minY: bounds.minY - spanY * ratioY,
    maxY: bounds.maxY + spanY * ratioY
  };
}

function featureIntersectsBounds(feature, bounds) {
  const featureBounds = boundsFrom([feature]);
  if (!featureBounds || !bounds) return false;

  return !(
    featureBounds.maxX < bounds.minX ||
    featureBounds.minX > bounds.maxX ||
    featureBounds.maxY < bounds.minY ||
    featureBounds.minY > bounds.maxY
  );
}

function makeProjector(bounds, width = 320, height = 230, padding = 9) {
  const spanX = Math.max(bounds.maxX - bounds.minX, 0.001);
  const spanY = Math.max(bounds.maxY - bounds.minY, 0.001);

  const scale = Math.min(
    (width - padding * 2) / spanX,
    (height - padding * 2) / spanY
  );

  const renderedWidth = spanX * scale;
  const renderedHeight = spanY * scale;

  const offsetX = (width - renderedWidth) / 2;
  const offsetY = (height - renderedHeight) / 2;

  return ([lon, lat]) => [
    offsetX + (lon - bounds.minX) * scale,
    offsetY + (bounds.maxY - lat) * scale
  ];
}

function districtSummary(rows) {
  const grouped = new Map();

  rows.forEach(row => {
    const code = normalizeCode(row.ubigeo_distrito, 6);
    if (!code) return;

    if (!grouped.has(code)) {
      grouped.set(code, {
        code,
        name: row.distrito || "Distrito",
        province: row.provincia || "",
        department: row.region || row.departamento || "",
        bridges: 0,
        cuis: new Set()
      });
    }

    const item = grouped.get(code);
    item.bridges += Number(row.n_puentes || 0);

    if (row.cui !== null && row.cui !== undefined && row.cui !== "") {
      item.cuis.add(String(row.cui));
    }
  });

  grouped.forEach(item => {
    item.investments = item.cuis.size;
  });

  return grouped;
}

function svgElement(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);

  Object.entries(attrs).forEach(([key, value]) => {
    el.setAttribute(key, String(value));
  });

  return el;
}

function addTitle(parent, text) {
  const title = svgElement("title");
  title.textContent = text;
  parent.appendChild(title);
}

function setMapDelay(element, index, base = 160, step = 20) {
  element.style.setProperty("--map-delay", `${base + index * step}ms`);
}

function ensureTooltip(svg) {
  const wrap = svg.closest(".territory-card__map-wrap");
  if (!wrap) return null;

  let tooltip = wrap.querySelector(".territory-map-tooltip");
  if (tooltip) return tooltip;

  tooltip = document.createElement("div");
  tooltip.className = "territory-map-tooltip";
  tooltip.setAttribute("aria-hidden", "true");
  tooltip.innerHTML = `
    <div class="territory-map-tooltip__name"></div>
    <div class="territory-map-tooltip__place"></div>
    <div class="territory-map-tooltip__metrics">
      <div><strong data-tooltip="ioarr">0</strong><span>IOARR</span></div>
      <i></i>
      <div><strong data-tooltip="bridges">0</strong><span>Puentes</span></div>
    </div>
  `;

  wrap.appendChild(tooltip);
  return tooltip;
}

function moveTooltip(tooltip, wrap, event) {
  if (!tooltip || !wrap) return;

  const rect = wrap.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();

  const margin = 10;
  let x = event.clientX - rect.left + 14;
  let y = event.clientY - rect.top + 14;

  x = Math.min(x, rect.width - tooltipRect.width - margin);
  y = Math.min(y, rect.height - tooltipRect.height - margin);
  x = Math.max(margin, x);
  y = Math.max(margin, y);

  tooltip.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

function wireDistrictHover(path, stat, svg) {
  if (!stat) return;

  path.classList.add("territory-map__district--interactive");
  path.dataset.ubigeo = stat.code;

  const tooltip = ensureTooltip(svg);
  const wrap = svg.closest(".territory-card__map-wrap");

  path.addEventListener("pointerenter", event => {
    svg.classList.add("has-district-hover");
    path.classList.add("is-hovered");

    svg
      .querySelectorAll(".territory-map__district--selected")
      .forEach(other => {
        if (other !== path) other.classList.add("is-dimmed");
      });

    if (tooltip) {
      tooltip.querySelector(".territory-map-tooltip__name").textContent = stat.name;
      tooltip.querySelector(".territory-map-tooltip__place").textContent =
        [stat.province, stat.department].filter(Boolean).join(" · ");
      tooltip.querySelector('[data-tooltip="ioarr"]').textContent =
        stat.investments.toLocaleString("es-PE");
      tooltip.querySelector('[data-tooltip="bridges"]').textContent =
        stat.bridges.toLocaleString("es-PE");
      tooltip.classList.add("is-visible");
      tooltip.setAttribute("aria-hidden", "false");
      moveTooltip(tooltip, wrap, event);
    }
  });

  path.addEventListener("pointermove", event => {
    moveTooltip(tooltip, wrap, event);
  });

  path.addEventListener("pointerleave", () => {
    svg.classList.remove("has-district-hover");
    path.classList.remove("is-hovered");

    svg
      .querySelectorAll(".territory-map__district--selected.is-dimmed")
      .forEach(other => other.classList.remove("is-dimmed"));

    tooltip?.classList.remove("is-visible");
    tooltip?.setAttribute("aria-hidden", "true");
  });
}

function buildFallbackFeatureIndex(fallbackDistrictGeo) {
  const map = new Map();

  (fallbackDistrictGeo?.features || []).forEach(feature => {
    const code = normalizeCode(feature.properties?.ubigeo_distrito, 6);
    if (code) map.set(code, feature);
  });

  return map;
}


function toDisplayName(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("es-PE")
    .replace(/(^|[\s-])([a-záéíóúñ])/g, (_, sep, letter) => sep + letter.toLocaleUpperCase("es-PE"));
}

function renderDepartmentLegend(svg, territory, rows) {
  const wrap = svg.closest(".territory-card__map-wrap");
  if (!wrap) return;

  wrap.querySelector(".territory-department-legend")?.remove();

  const departments = [...new Set(
    rows
      .map(row => row.region || row.departamento)
      .filter(Boolean)
      .map(value => String(value).trim())
  )].sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));

  if (!departments.length) return;

  const legend = document.createElement("div");
  const side = TERRITORY_CONFIG[territory]?.legendSide || "right";
  legend.className = `territory-department-legend territory-department-legend--${side}`;
  legend.setAttribute("aria-hidden", "true");

  legend.innerHTML = `
    <span class="territory-department-legend__title">Departamentos</span>
    <div class="territory-department-legend__items">
      ${departments.map(name => `
        <span class="territory-department-legend__item">
          <i></i>${toDisplayName(name)}
        </span>
      `).join("")}
    </div>
  `;

  wrap.appendChild(legend);
}

function renderMiniMap(svg, territory, rows, topologyFeatures, fallbackDistrictGeo) {
  svg.replaceChildren();

  const districtStats = districtSummary(rows);
  const selectedCodes = new Set(districtStats.keys());

  renderDepartmentLegend(svg, territory, rows);
  const fallbackIndex = buildFallbackFeatureIndex(fallbackDistrictGeo);

  const selectedTopologyFeatures = topologyFeatures.filter(feature =>
    selectedCodes.has(featureDistrictCode(feature))
  );

  const availableCodes = new Set(selectedTopologyFeatures.map(featureDistrictCode));

  const fallbackSelectedFeatures = [...selectedCodes]
    .filter(code => !availableCodes.has(code) && fallbackIndex.has(code))
    .map(code => fallbackIndex.get(code));

  const allSelectedFeatures = [
    ...selectedTopologyFeatures,
    ...fallbackSelectedFeatures
  ];

  if (!allSelectedFeatures.length) {
    svg.closest(".territory-card__map-wrap")?.classList.add("is-map-error");
    return;
  }

  /*
    ZOOM A ÁREA DE INTERÉS:
    el encuadre se calcula SOLO con los distritos del ámbito. Después se
    expande ligeramente para mostrar contexto inmediato, no provincias enteras.
  */
  const selectedBounds = boundsFrom(allSelectedFeatures);
  const viewportBounds = expandBounds(
    selectedBounds,
    territory === "AMUVRAEM" ? 0.16 : 0.11,
    territory === "AMUVRAEM" ? 0.18 : 0.13
  );

  const contextCandidates = topologyFeatures.filter(feature => {
    const code = featureDistrictCode(feature);
    return code && !selectedCodes.has(code) && featureIntersectsBounds(feature, viewportBounds);
  });

  const project = makeProjector(viewportBounds, 320, 230, 10);

  /* Contexto inmediato, muy tenue. */
  contextCandidates.forEach((feature, index) => {
    const path = svgElement("path", {
      d: geometryToSvgPath(feature.geometry, project),
      class: "territory-map__district--context"
    });

    setMapDelay(path, index, 90, 9);
    svg.appendChild(path);
  });

  /* Ámbito: una sola fuente geométrica, sin volver a dibujar provincia encima. */
  allSelectedFeatures.forEach((feature, index) => {
    const code = featureDistrictCode(feature) ||
      normalizeCode(feature.properties?.ubigeo_distrito, 6);
    const stat = districtStats.get(code);
    const bridges = stat?.bridges || 0;
    const opacity = Math.min(0.70 + bridges * 0.02, 0.90);

    const path = svgElement("path", {
      d: geometryToSvgPath(feature.geometry, project),
      class: "territory-map__district--selected",
      "fill-opacity": opacity.toFixed(2)
    });

    setMapDelay(path, index, 160, 18);

    if (stat) {
      wireDistrictHover(path, stat, svg);
    }

    svg.appendChild(path);
  });

  requestAnimationFrame(() => {
    svg.classList.add("is-map-ready");
  });

  const missingCodes = [...selectedCodes].filter(
    code => !availableCodes.has(code) && !fallbackIndex.has(code)
  );

  if (missingCodes.length) {
    console.warn(`[Territorio ${territory}] UBIGEO sin polígono:`, missingCodes);
  }
}

function animateNumber(element, finalValue, duration = 700, delay = 0) {
  if (!element) return;

  window.setTimeout(() => {
    const start = performance.now();

    function tick(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);

      element.textContent = Math.round(finalValue * eased).toLocaleString("es-PE");

      if (progress < 1) {
        requestAnimationFrame(tick);
      } else {
        element.textContent = Number(finalValue).toLocaleString("es-PE");
      }
    }

    requestAnimationFrame(tick);
  }, delay);
}

function writeCardStats(card, summary, cardIndex = 0) {
  const order = ["inversiones", "puentes", "distritos", "provincias", "departamentos"];

  order.forEach((key, index) => {
    const target = card?.querySelector(`[data-stat="${key}"]`);
    if (!target) return;

    animateNumber(
      target,
      summary[key] || 0,
      620,
      cardIndex * 90 + index * 55
    );
  });
}

function chooseTerritory(territory) {
  if (!TERRITORY_CONFIG[territory]) return;

  localStorage.setItem("territorio_dashboard", territory);
  document
    .querySelector(`[data-territory="${territory}"]`)
    ?.classList.add("is-selected");

  window.location.href = `inicio.html?territorio=${encodeURIComponent(territory)}`;
}

function wireCards() {
  document.querySelectorAll(".territory-card").forEach(card => {
    const territory = card.dataset.territory;

    card.addEventListener("click", event => {
      // Toda la tarjeta es el selector del ámbito; el mapa conserva hover,
      // pero un clic en cualquier punto de la tarjeta abre Inicio filtrado.
      if (event.defaultPrevented) return;
      chooseTerritory(territory);
    });

    card.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        chooseTerritory(territory);
      }
    });
  });
}

async function loadTopologyFeatures(fallbackDistrictGeo) {
  try {
    const response = await fetch(TOPOLOGY_SOURCE_URL, { cache: "force-cache" });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const topologyGeo = await response.json();

    if (!Array.isArray(topologyGeo.features) || !topologyGeo.features.length) {
      throw new Error("La fuente simplificada no contiene features válidas.");
    }

    console.info(
      `[Territorio ${TERRITORY_VERSION}] Geometría simplificada cargada: ${topologyGeo.features.length} distritos.`
    );

    return topologyGeo.features;
  } catch (error) {
    console.warn(
      `[Territorio ${TERRITORY_VERSION}] No se pudo cargar la geometría simplificada; se usa el GeoJSON local como respaldo.`,
      error
    );

    return fallbackDistrictGeo.features || [];
  }
}

async function initTerritoryPage() {
  if (IS_PREWARM) {
    document.documentElement.dataset.prewarmed = "1";
    return;
  }

  if (sessionStorage.getItem("territory_manual_photo_entry") === "1") {
    sessionStorage.removeItem("territory_manual_photo_entry");
    document.body.classList.add("is-photo-arrival");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => document.body.classList.remove("is-photo-arrival"));
    });
  }

  wireCards();

  console.info(
    `[Territorio ${TERRITORY_VERSION}] Total único validado: ${TOTAL_DISTRITOS_UNICOS} distritos por UBIGEO.`
  );

  try {
    const [dataResponse, fallbackDistrictResponse] = await Promise.all([
      fetch("data/puentes.json", { cache: "no-store" }),
      fetch("data/territorio-distritos.geojson", { cache: "force-cache" })
    ]);

    if (!dataResponse.ok) {
      throw new Error("No se pudo cargar data/puentes.json");
    }

    if (!fallbackDistrictResponse.ok) {
      throw new Error("No se pudo cargar data/territorio-distritos.geojson");
    }

    const [data, fallbackDistrictGeo] = await Promise.all([
      dataResponse.json(),
      fallbackDistrictResponse.json()
    ]);

    if (!Array.isArray(data) || !data.length) {
      throw new Error("data/puentes.json está vacío.");
    }

    const totalSummary = summarize(data);

    animateNumber(document.getElementById("totalInversiones"), totalSummary.inversiones, 720, 120);
    animateNumber(document.getElementById("totalPuentes"), totalSummary.puentes, 720, 220);
    animateNumber(document.getElementById("totalDistritos"), TOTAL_DISTRITOS_UNICOS, 720, 320);
    animateNumber(document.getElementById("totalProvincias"), totalSummary.provincias, 720, 420);

    const territoryRows = {};

    Object.keys(TERRITORY_CONFIG).forEach((territory, cardIndex) => {
      const rows = rowsForTerritory(data, territory);
      territoryRows[territory] = rows;

      const summary = summarize(rows);
      const card = document.querySelector(`[data-territory="${territory}"]`);

      writeCardStats(card, summary, cardIndex);

      requestAnimationFrame(() => {
        card?.classList.add("is-data-ready");
      });
    });

    const topologyFeatures = await loadTopologyFeatures(fallbackDistrictGeo);

    Object.keys(TERRITORY_CONFIG).forEach(territory => {
      const svg = document.querySelector(`[data-map="${territory}"]`);
      renderMiniMap(
        svg,
        territory,
        territoryRows[territory],
        topologyFeatures,
        fallbackDistrictGeo
      );
    });
  } catch (error) {
    console.error("[Territorio]", error);

    document
      .querySelectorAll(".territory-card__map-wrap")
      .forEach(container => container.classList.add("is-map-error"));
  }
}

function resetTerritoryTransientState() {
  document.body.classList.remove("is-leaving");

  document
    .querySelectorAll(".territory-card.is-selected")
    .forEach(card => card.classList.remove("is-selected"));
}

window.addEventListener("pageshow", event => {
  if (event.persisted) resetTerritoryTransientState();
});

window.addEventListener("DOMContentLoaded", initTerritoryPage);
