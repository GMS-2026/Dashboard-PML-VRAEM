const TOPOLOGY_SOURCE_URL =
  "https://raw.githubusercontent.com/Rodasluis/Peru-maps/main/salida/distrito_simplificado.geojson";

const TERRITORY_CONFIG = {
  VRAEM: {
    filterField: "es_vraem",
    filterValue: "SI"
  },
  NORVRAEM: {
    filterField: "es_norvraem",
    filterValue: "SI"
  },
  AMUVRAEM: {
    filterField: "es_amuvraem",
    filterValue: "SI"
  }
};

const SVG_NS = "http://www.w3.org/2000/svg";

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
    puentes: rows.reduce(
      (sum, row) => sum + Number(row.n_puentes || 0),
      0
    ),
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
    return geometry.coordinates
      .map(ringPath)
      .join(" ");
  }

  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates
      .flatMap(polygon => polygon.map(ringPath))
      .join(" ");
  }

  return "";
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

function boundsFrom(features, points = []) {
  const coords = [];

  features.forEach(feature => {
    coords.push(...geometryCoordinates(feature.geometry));
  });

  points.forEach(point => {
    if (Number.isFinite(point.lon) && Number.isFinite(point.lat)) {
      coords.push([point.lon, point.lat]);
    }
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

function districtSummary(rows) {
  const grouped = new Map();

  rows.forEach(row => {
    const code = normalizeCode(row.ubigeo_distrito, 6);
    if (!code) return;

    if (!grouped.has(code)) {
      grouped.set(code, {
        code,
        name: row.distrito || "Distrito",
        bridges: 0,
        lonTotal: 0,
        latTotal: 0,
        coordCount: 0
      });
    }

    const item = grouped.get(code);

    item.bridges += Number(row.n_puentes || 0);

    const lon = Number(
      row["LONGITUD.1"] ??
      row.longitud ??
      row.LONGITUD
    );

    const lat = Number(
      row.latitud ??
      row.LATITUD
    );

    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      item.lonTotal += lon;
      item.latTotal += lat;
      item.coordCount += 1;
    }
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

function renderMiniMap(
  svg,
  territory,
  rows,
  topologyFeatures,
  fallbackDistrictGeo
) {
  svg.replaceChildren();

  const districtStats = districtSummary(rows);
  const selectedCodes = new Set(districtStats.keys());

  const provinceCodes = new Set(
    rows
      .map(row => normalizeCode(row.ubigeo_provincia, 4))
      .filter(Boolean)
  );

  /*
    Contexto y ámbito salen de LA MISMA geometría topológica.
    Esa es la prueba que queremos evaluar visualmente.
  */
  const contextDistrictFeatures = topologyFeatures.filter(feature => {
    const districtCode = featureDistrictCode(feature);
    if (!districtCode) return false;

    return provinceCodes.has(districtCode.slice(0, 4));
  });

  const selectedDistrictFeatures = contextDistrictFeatures.filter(feature =>
    selectedCodes.has(featureDistrictCode(feature))
  );

  const selectedAvailableCodes = new Set(
    selectedDistrictFeatures.map(featureDistrictCode)
  );

  const contextOnlyFeatures = contextDistrictFeatures.filter(feature =>
    !selectedCodes.has(featureDistrictCode(feature))
  );

  /*
    Fallback solo si la fuente pública no trae algún UBIGEO del proyecto.
    Se usa tu GeoJSON actual exclusivamente para ese distrito puntual.
  */
  const fallbackFeatures = fallbackDistrictGeo.features.filter(feature => {
    const code = normalizeCode(
      feature.properties?.ubigeo_distrito,
      6
    );

    return (
      selectedCodes.has(code) &&
      !selectedAvailableCodes.has(code)
    );
  });

  const fallbackCodes = new Set(
    fallbackFeatures.map(feature =>
      normalizeCode(feature.properties?.ubigeo_distrito, 6)
    )
  );

  const missingPoints = [...districtStats.values()]
    .filter(item =>
      !selectedAvailableCodes.has(item.code) &&
      !fallbackCodes.has(item.code) &&
      item.coordCount > 0
    )
    .map(item => ({
      ...item,
      lon: item.lonTotal / item.coordCount,
      lat: item.latTotal / item.coordCount
    }));

  const allSelectedFeatures = [
    ...selectedDistrictFeatures,
    ...fallbackFeatures
  ];

  /*
    El encuadre usa las provincias relacionadas completas,
    igual que tu vista actual.
  */
  const primaryFeatures = contextDistrictFeatures.length
    ? contextDistrictFeatures
    : allSelectedFeatures;

  const bounds = boundsFrom(primaryFeatures, missingPoints);
  if (!bounds) return;

  const project = makeProjector(bounds);

  // Contexto territorial: discreto.
  contextOnlyFeatures.forEach(feature => {
    const path = svgElement("path", {
      d: geometryToSvgPath(feature.geometry, project),
      class: "territory-map__district--context"
    });

    addTitle(
      path,
      `${featureDistrictName(feature)} — referencia territorial`
    );

    svg.appendChild(path);
  });

  // Ámbito con geometría topológica.
  selectedDistrictFeatures.forEach(feature => {
    const code = featureDistrictCode(feature);
    const stat = districtStats.get(code);
    const bridges = stat?.bridges || 0;

    const opacity =
      Math.min(0.68 + bridges * 0.025, 0.90);

    const path = svgElement("path", {
      d: geometryToSvgPath(feature.geometry, project),
      class: "territory-map__district--selected",
      "fill-opacity": opacity.toFixed(2)
    });

    addTitle(
      path,
      `${featureDistrictName(feature)}: ${bridges} puente${bridges === 1 ? "" : "s"}`
    );

    svg.appendChild(path);
  });

  // Fallback: solo si algún UBIGEO no está en la fuente pública.
  fallbackFeatures.forEach(feature => {
    const code = normalizeCode(
      feature.properties?.ubigeo_distrito,
      6
    );

    const stat = districtStats.get(code);
    const bridges = stat?.bridges || 0;

    const path = svgElement("path", {
      d: geometryToSvgPath(feature.geometry, project),
      class: "territory-map__district--selected",
      "fill-opacity": "0.78"
    });

    addTitle(
      path,
      `${feature.properties?.distrito || "Distrito"} — geometría local de respaldo`
    );

    svg.appendChild(path);
  });

  // Punto de respaldo si no hay polígono en ninguna de las dos fuentes.
  missingPoints.forEach(point => {
    const [x, y] = project([point.lon, point.lat]);

    const ring = svgElement("circle", {
      cx: x.toFixed(2),
      cy: y.toFixed(2),
      r: point.bridges > 1 ? 5.3 : 4.7,
      class: "territory-map__missing-ring"
    });

    addTitle(
      ring,
      `${point.name}: sin polígono disponible`
    );

    svg.appendChild(ring);

    svg.appendChild(
      svgElement("circle", {
        cx: x.toFixed(2),
        cy: y.toFixed(2),
        r: point.bridges > 1 ? 2.8 : 2.4,
        class: "territory-map__point"
      })
    );
  });
}

function writeCardStats(card, summary) {
  Object.entries(summary).forEach(([key, value]) => {
    const target =
      card?.querySelector(`[data-stat="${key}"]`);

    if (target) {
      target.textContent =
        value.toLocaleString("es-PE");
    }
  });
}

function animateNumber(element, finalValue, duration = 650) {
  if (!element) return;

  const start = performance.now();

  function tick(now) {
    const progress =
      Math.min((now - start) / duration, 1);

    const eased =
      1 - Math.pow(1 - progress, 3);

    element.textContent =
      Math.round(finalValue * eased)
        .toLocaleString("es-PE");

    if (progress < 1) {
      requestAnimationFrame(tick);
    }
  }

  requestAnimationFrame(tick);
}

async function initTopologyTest() {
  const status =
    document.getElementById("sourceStatus");

  try {
    const [
      dataResponse,
      fallbackDistrictResponse,
      topologyResponse
    ] = await Promise.all([
      fetch("data/puentes.json", { cache: "no-store" }),

      fetch(
        "data/territorio-distritos.geojson",
        { cache: "no-store" }
      ),

      fetch(
        TOPOLOGY_SOURCE_URL,
        { cache: "no-store" }
      )
    ]);

    if (!dataResponse.ok) {
      throw new Error(
        "No se pudo cargar data/puentes.json"
      );
    }

    if (!fallbackDistrictResponse.ok) {
      throw new Error(
        "No se pudo cargar data/territorio-distritos.geojson"
      );
    }

    if (!topologyResponse.ok) {
      throw new Error(
        `No se pudo cargar la fuente topológica pública (${topologyResponse.status}).`
      );
    }

    const [
      data,
      fallbackDistrictGeo,
      topologyGeo
    ] = await Promise.all([
      dataResponse.json(),
      fallbackDistrictResponse.json(),
      topologyResponse.json()
    ]);

    if (!Array.isArray(data) || !data.length) {
      throw new Error(
        "data/puentes.json está vacío."
      );
    }

    if (!Array.isArray(topologyGeo.features)) {
      throw new Error(
        "La fuente topológica no tiene una colección GeoJSON válida."
      );
    }

    /*
      Total único REAL de tu proyecto actual.
      No se hardcodea 34 ni otro número.
    */
    const totalSummary = summarize(data);

    animateNumber(
      document.getElementById("totalInversiones"),
      totalSummary.inversiones
    );

    animateNumber(
      document.getElementById("totalPuentes"),
      totalSummary.puentes
    );

    animateNumber(
      document.getElementById("totalDistritos"),
      totalSummary.distritos
    );

    animateNumber(
      document.getElementById("totalProvincias"),
      totalSummary.provincias
    );

    Object.keys(TERRITORY_CONFIG)
      .forEach(territory => {

        const rows =
          rowsForTerritory(data, territory);

        const summary =
          summarize(rows);

        const card =
          document.querySelector(
            `[data-territory="${territory}"]`
          );

        const svg =
          document.querySelector(
            `[data-map="${territory}"]`
          );

        writeCardStats(card, summary);

        renderMiniMap(
          svg,
          territory,
          rows,
          topologyGeo.features,
          fallbackDistrictGeo
        );
      });

    status.textContent =
      `Fuente topológica cargada · ${topologyGeo.features.length.toLocaleString("es-PE")} distritos disponibles`;

    status.classList.add("is-ok");

    console.info(
      "[Prueba topológica]",
      `Fuente cargada con ${topologyGeo.features.length} features.`
    );

  } catch (error) {
    console.error("[Prueba topológica]", error);

    status.textContent =
      `Error: ${error.message}`;

    status.classList.add("is-error");

    document
      .querySelectorAll(".territory-card__map-wrap")
      .forEach(container => {
        container.classList.add("is-map-error");
      });
  }
}

window.addEventListener(
  "DOMContentLoaded",
  initTopologyTest
);
