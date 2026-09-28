const TERRITORY_CONFIG = {
  VRAEM: {
    label: "VRAEM",
    longLabel: "VRAEM y zonas de influencia",
    filterField: "es_vraem",
    filterValue: "SI",
    accent: "#8f2641",
    rgb: "143, 38, 65",
    chartLine: "#991735",
    chartLineRgb: "153, 23, 53"
  },
  NORVRAEM: {
    label: "NORVRAEM",
    longLabel: "Ámbito territorial del norte",
    filterField: "es_norvraem",
    filterValue: "SI",
    accent: "#315f78",
    rgb: "49, 95, 120",
    chartLine: "#153f5b",
    chartLineRgb: "21, 63, 91"
  },
  AMUVRAEM: {
    label: "AMUVRAE",
    longLabel: "Mancomunidad del VRAE",
    filterField: "es_amuvraem",
    filterValue: "SI",
    accent: "#4f8b78",
    rgb: "79, 139, 120",
    chartLine: "#0c8a60",
    chartLineRgb: "12, 138, 96"
  }
};

const TOPOLOGY_SOURCE_URL =
  "https://raw.githubusercontent.com/Rodasluis/Peru-maps/main/salida/distrito_simplificado.geojson";

const FILTER_STORAGE_KEY = "dashboard_filter_state";
const SVG_NS = "http://www.w3.org/2000/svg";
const DONUT_RADIUS = 57;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

let DISTRICT_GEO = null;
let TOPOLOGY_FEATURES = [];

function normalizeText(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeCode(value, digits) {
  if (value === null || value === undefined || value === "") return "";
  return String(value).trim().padStart(digits, "0");
}

function featureDistrictCode(feature) {
  const properties = feature?.properties || {};
  return normalizeCode(
    properties.ubigeo_distrito ??
    properties.UBIGEO_DISTRITO ??
    properties.ubigeo ??
    properties.UBIGEO,
    6
  );
}

function uniqueCount(rows, field) {
  return new Set(
    rows
      .map(row => row[field])
      .filter(value => value !== null && value !== undefined && value !== "")
      .map(String)
  ).size;
}

function sumBridges(rows) {
  return rows.reduce((sum, row) => sum + Number(row.n_puentes || 0), 0);
}

function sumDeficit(rows) {
  return rows.reduce((sum, row) => sum + Number(row.deficit || 0), 0);
}

function sumCost(rows) {
  return rows.reduce((sum, row) => sum + Number(row.costo_actualizado || 0), 0);
}

function sumField(rows, field) {
  return rows.reduce((sum, row) => sum + Number(row[field] || 0), 0);
}

function smartTitle(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("es-PE")
    .replace(/(^|[\s-])([a-záéíóúñü])/g, (_, sep, chr) => `${sep}${chr.toLocaleUpperCase("es-PE")}`)
    .replace(/\b(De|Del|La|Las|Los|Y)\b/g, word => word.toLocaleLowerCase("es-PE"));
}

function shortPliego(value) {
  const raw = String(value || "").trim();
  if (!raw) return "-";

  let text = raw.replace(/\s+-\s+.*$/, "").trim();
  let prefix = "";

  if (/^MUNICIPALIDAD\s+DISTRITAL\s+DE\s+/i.test(text)) {
    prefix = "MD";
    text = text.replace(/^MUNICIPALIDAD\s+DISTRITAL\s+DE\s+/i, "");
  } else if (/^MUNICIPALIDAD\s+PROVINCIAL\s+DE\s+/i.test(text)) {
    prefix = "MP";
    text = text.replace(/^MUNICIPALIDAD\s+PROVINCIAL\s+DE\s+/i, "");
  } else if (/^MUNICIPALIDAD\s+DISTRITAL\s+/i.test(text)) {
    prefix = "MD";
    text = text.replace(/^MUNICIPALIDAD\s+DISTRITAL\s+/i, "");
  } else if (/^MUNICIPALIDAD\s+PROVINCIAL\s+/i.test(text)) {
    prefix = "MP";
    text = text.replace(/^MUNICIPALIDAD\s+PROVINCIAL\s+/i, "");
  }

  const titled = smartTitle(text);
  return prefix ? `${prefix} ${titled}` : titled;
}

function needsResources(row) {
  return Number(row.deficit || 0) > 0 || row.requiere_recursos === true;
}

function signedAgreement(row) {
  return normalizeText(row.estado_convenio) === "CONVENIO SUSCRITO";
}

function selectedTerritory() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = normalizeText(params.get("territorio"));
  if (TERRITORY_CONFIG[fromUrl]) return fromUrl;

  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) || "{}");
    const savedTerritory = normalizeText(saved.territorio);
    if (TERRITORY_CONFIG[savedTerritory]) return savedTerritory;
  } catch (_) {}

  const fromStorage = normalizeText(localStorage.getItem("territorio_dashboard"));
  return TERRITORY_CONFIG[fromStorage] ? fromStorage : "VRAEM";
}

function currentState() {
  const params = new URLSearchParams(window.location.search);
  const territorio = selectedTerritory();

  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) || "{}");
  } catch (_) {}

  const sameTerritory = normalizeText(saved.territorio) === territorio;

  return {
    territorio,
    departamento: params.get("departamento") ?? (sameTerritory ? saved.departamento || "" : ""),
    provincia: params.get("provincia") ?? (sameTerritory ? saved.provincia || "" : ""),
    distrito: params.get("distrito") ?? (sameTerritory ? saved.distrito || "" : "")
  };
}

function persistState(state) {
  localStorage.setItem("territorio_dashboard", state.territorio);
  localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(state));
}

function queryFromState(state, extra = {}) {
  const params = new URLSearchParams();
  params.set("territorio", state.territorio);

  if (state.departamento) params.set("departamento", state.departamento);
  if (state.provincia) params.set("provincia", state.provincia);
  if (state.distrito) params.set("distrito", state.distrito);

  Object.entries(extra).forEach(([key, value]) => {
    if (value !== null && value !== undefined && String(value) !== "") {
      params.set(key, String(value));
    }
  });

  return params.toString();
}

function updateUrl(state) {
  window.history.replaceState({}, "", `${window.location.pathname}?${queryFromState(state)}`);
}

function territoryRows(data, territory) {
  const config = TERRITORY_CONFIG[territory];
  return data.filter(
    row => normalizeText(row[config.filterField]) === config.filterValue
  );
}

function filteredRows(rows, state) {
  return rows.filter(row => {
    if (state.departamento && String(row.region || "") !== state.departamento) return false;
    if (state.provincia && String(row.provincia || "") !== state.provincia) return false;
    if (state.distrito && String(row.distrito || "") !== state.distrito) return false;
    return true;
  });
}

function sortSpanish(values) {
  return [...values].sort((a, b) =>
    String(a).localeCompare(String(b), "es", { sensitivity: "base" })
  );
}

function optionsFor(rows, field) {
  return sortSpanish(new Set(rows.map(row => row[field]).filter(Boolean)));
}

function populateSelect(select, options, selected, allLabel) {
  const current = selected || "";
  select.replaceChildren();

  const all = document.createElement("option");
  all.value = "";
  all.textContent = allLabel;
  select.appendChild(all);

  options.forEach(value => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });

  select.value = [...select.options].some(option => option.value === current)
    ? current
    : "";
}

function refreshFilterOptions(baseRows, state) {
  const departamentoSelect = document.getElementById("departamentoSelect");
  const provinciaSelect = document.getElementById("provinciaSelect");
  const distritoSelect = document.getElementById("distritoSelect");

  populateSelect(
    departamentoSelect,
    optionsFor(baseRows, "region"),
    state.departamento,
    "Todos"
  );

  const departmentRows = baseRows.filter(
    row => !state.departamento || String(row.region || "") === state.departamento
  );

  populateSelect(
    provinciaSelect,
    optionsFor(departmentRows, "provincia"),
    state.provincia,
    "Todas"
  );

  const provinceRows = departmentRows.filter(
    row => !state.provincia || String(row.provincia || "") === state.provincia
  );

  populateSelect(
    distritoSelect,
    optionsFor(provinceRows, "distrito"),
    state.distrito,
    "Todos"
  );
}

function compactMoney(value) {
  const number = Number(value || 0);

  if (Math.abs(number) >= 1_000_000) {
    return `S/ ${(number / 1_000_000).toLocaleString("es-PE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })} M`;
  }

  if (Math.abs(number) >= 1_000) {
    return `S/ ${(number / 1_000).toLocaleString("es-PE", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    })} mil`;
  }

  return `S/ ${number.toLocaleString("es-PE", { maximumFractionDigits: 0 })}`;
}

function tableMoney(value) {
  const number = Number(value || 0);

  if (Math.abs(number) >= 1_000_000) {
    return `${(number / 1_000_000).toLocaleString("es-PE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })} M`;
  }

  if (Math.abs(number) >= 1_000) {
    return `${(number / 1_000).toLocaleString("es-PE", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    })} mil`;
  }

  return number.toLocaleString("es-PE", { maximumFractionDigits: 0 });
}

function integer(value) {
  return Number(value || 0).toLocaleString("es-PE");
}

function percent(value, total) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function animateNumber(element, finalValue, options = {}) {
  if (!element) return;

  const {
    duration = 650,
    formatter = value => integer(Math.round(value))
  } = options;

  const start = performance.now();

  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    element.textContent = formatter(finalValue * eased);

    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      element.textContent = formatter(finalValue);
    }
  }

  requestAnimationFrame(tick);
}

function updateNavigation(state) {
  const query = queryFromState(state);

  document.querySelectorAll("[data-nav-page]").forEach(link => {
    link.href = `${link.dataset.navPage}?${query}`;
  });

  const config = {
    mapa: ["mapa.html", {}],
    convenios: ["convenios.html", { requiere_recursos: "si" }],
    demanda: ["demanda.html", { requiere_recursos: "si" }]
  };

  document.querySelectorAll("[data-drill]").forEach(link => {
    const item = config[link.dataset.drill];
    if (!item) return;
    link.href = `${item[0]}?${queryFromState(state, item[1])}`;
  });
}

function computeModel(rows) {
  const requires = rows.filter(needsResources);
  const sufficient = rows.filter(row => !needsResources(row));

  const withAgreement = requires.filter(signedAgreement);
  const withoutAgreement = requires.filter(row => !signedAgreement(row));

  const enTramite = requires.filter(
    row => normalizeText(row.estado_convenio) === "EN TRÁMITE"
  );

  const noPresento = requires.filter(
    row => normalizeText(row.estado_convenio) === "NO PRESENTÓ"
  );

  const allSeleccion = rows.filter(
    row => normalizeText(row.estado_situacional) === "PROCESO DE SELECCIÓN"
  );

  const allEett = rows.filter(
    row => normalizeText(row.estado_situacional).includes(
      "ELABORACIÓN DE EXPEDIENTE TÉCNICO"
    )
  );

  const known = new Set([...allSeleccion, ...allEett]);
  const allOther = rows.filter(row => !known.has(row));

  const package1 = withAgreement.filter(
    row => normalizeText(row.paquete) === "GRUPO 01"
  );

  const pendingRequest = withAgreement.filter(
    row => normalizeText(row.paquete) !== "GRUPO 01"
  );

  const conditioned = withoutAgreement;

  const totalCost = sumCost(rows);
  const deficit = sumDeficit(requires);
  const fundedAmount = Math.max(0, totalCost - deficit);

  const provinceMap = new Map();

  requires.forEach(row => {
    const province = String(row.provincia || "Sin provincia").trim() || "Sin provincia";

    if (!provinceMap.has(province)) {
      provinceMap.set(province, {
        province,
        deficit: 0,
        cuis: new Set()
      });
    }

    const item = provinceMap.get(province);
    item.deficit += Number(row.deficit || 0);
    item.cuis.add(String(row.cui || ""));
  });

  const rawProvinceDeficit = [...provinceMap.values()]
    .map(item => ({
      province: item.province,
      deficit: item.deficit,
      investments: item.cuis.size
    }))
    .sort((a, b) => b.deficit - a.deficit || b.investments - a.investments);

  let provinceDeficit = rawProvinceDeficit.slice(0, 6);

  if (rawProvinceDeficit.length > 6) {
    const others = rawProvinceDeficit.slice(6).reduce(
      (acc, item) => {
        acc.deficit += item.deficit;
        acc.investments += item.investments;
        return acc;
      },
      { province: "OTROS", deficit: 0, investments: 0 }
    );

    provinceDeficit.push(others);
  }

  const provinceDistributionMap = new Map();

  rows.forEach(row => {
    const province = String(row.provincia || "Sin provincia").trim() || "Sin provincia";

    if (!provinceDistributionMap.has(province)) {
      provinceDistributionMap.set(province, new Set());
    }

    provinceDistributionMap.get(province).add(String(row.cui || ""));
  });

  const provinceDistribution = [...provinceDistributionMap.entries()]
    .map(([province, cuis]) => ({
      province,
      investments: cuis.size
    }))
    .sort((a, b) => b.investments - a.investments)
    .slice(0, 6);

  const financialGapRows = requires
    .map(row => ({
      cui: String(row.cui || "-"),
      pliego: shortPliego(row.pliego),
      pliegoFull: String(row.pliego || "-"),
      cost: Number(row.costo_actualizado || 0),
      accrued: Number(row.devengado_acumulado || 0),
      pim: Number(row.pim || 0),
      deficit: Number(row.deficit || 0),
      district: String(row.distrito || "Sin distrito")
    }))
    .sort((a, b) => b.deficit - a.deficit || b.cost - a.cost);

  const financialCost = sumField(requires, "costo_actualizado");
  const financialAccrued = sumField(requires, "devengado_acumulado");
  const financialPim = sumField(requires, "pim");
  const financialDeficit = Math.max(
    financialCost - financialAccrued - financialPim,
    0
  );

  const directCount = uniqueCount(
    rows.filter(row => normalizeText(row.ambito_vraem) === "INTERVENCIÓN DIRECTA"),
    "cui"
  );
  const influenceCount = uniqueCount(
    rows.filter(row => normalizeText(row.ambito_vraem) === "ZONA DE INFLUENCIA"),
    "cui"
  );
  const geocodedCount = uniqueCount(
    rows.filter(row => row.tiene_coordenadas === true || normalizeText(row.tiene_coordenadas) === "SI"),
    "cui"
  );

  return {
    rows,
    investments: uniqueCount(rows, "cui"),
    bridges: sumBridges(rows),
    departments: uniqueCount(rows, "ubigeo_departamento"),
    provinces: uniqueCount(rows, "ubigeo_provincia"),
    districts: uniqueCount(rows, "ubigeo_distrito"),

    sufficient,
    requires,
    withAgreement,
    withoutAgreement,
    enTramite,
    noPresento,

    allSeleccion,
    allEett,
    allOther,

    package1,
    pendingRequest,
    conditioned,

    provinceDeficit,
    provinceDistribution,
    financialGapRows,
    financialCost,
    financialAccrued,
    financialPim,
    financialDeficit,
    directCount,
    influenceCount,
    geocodedCount,

    totalCost,
    deficit,
    fundedAmount
  };
}

function setDonut(items, total) {
  let consumed = 0;

  items.forEach(({ element, value }) => {
    if (!element) return;
    element.style.strokeDasharray = `0 ${DONUT_CIRCUMFERENCE}`;
    element.style.strokeDashoffset = `${-consumed}`;
    consumed += total > 0 ? DONUT_CIRCUMFERENCE * value / total : 0;
  });

  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      let offset = 0;

      items.forEach(({ element, value }) => {
        if (!element) return;

        const length =
          total > 0 ? DONUT_CIRCUMFERENCE * value / total : 0;

        element.style.strokeDasharray =
          `${length} ${Math.max(0, DONUT_CIRCUMFERENCE - length)}`;

        element.style.strokeDashoffset = `${-offset}`;

        offset += length;
      });
    })
  );
}

function positionDonutLabels(items, total) {
  let consumed = 0;

  items.forEach(({ element, value }) => {
    if (!element) return;

    if (!total || value <= 0) {
      element.style.opacity = "0";
      return;
    }

    const startAngle = -90 + (consumed / total) * 360;
    const midAngle = startAngle + (value / total) * 180;
    const radians = midAngle * Math.PI / 180;
    const radius = 38;

    element.style.left = `${50 + Math.cos(radians) * radius}%`;
    element.style.top = `${50 + Math.sin(radians) * radius}%`;
    element.style.opacity = value / total >= .055 ? "1" : "0";
    consumed += value;
  });
}

function setWidth(element, value, total) {
  if (!element) return;

  const pct = total > 0 ? Math.max(0, (value / total) * 100) : 0;

  element.style.width = "0%";

  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      element.style.width = `${pct}%`;
    })
  );
}

function setBarHeight(element, value, maxValue) {
  if (!element) return;

  const pct = maxValue > 0 ? Math.max(0, (value / maxValue) * 100) : 0;

  element.style.height = "0%";

  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      element.style.height = value > 0 ? `${Math.max(8, pct)}%` : "2px";
    })
  );
}

function renderScope(state, model) {
  const config = TERRITORY_CONFIG[state.territorio];

  document.documentElement.style.setProperty("--scope-color", config.accent);
  document.documentElement.style.setProperty("--scope-rgb", config.rgb);
  document.documentElement.style.setProperty("--territory-line-color", config.chartLine);
  document.documentElement.style.setProperty("--territory-line-rgb", config.chartLineRgb);
  document.body.dataset.territory = config.label;

  document.getElementById("inicioTitulo").textContent = `Inicio - ${config.label}`;
  document.getElementById("inicioSubtitulo").textContent =
    `${config.longLabel}. Situación financiera y ruta de gestión.`;

  document.getElementById("territoryChip").textContent = config.label;
  document.getElementById("agreementSubtitle").textContent =
    `Estado de los convenios en el ámbito ${config.label}`;

  animateNumber(document.getElementById("geoDepartamentos"), model.departments);
  animateNumber(document.getElementById("geoProvincias"), model.provinces);
  animateNumber(document.getElementById("geoDistritos"), model.districts);

  animateNumber(document.getElementById("mapDirectCount"), model.directCount);
  animateNumber(document.getElementById("mapInfluenceCount"), model.influenceCount);
  animateNumber(document.getElementById("mapGeocodedCount"), model.geocodedCount);
}

function renderKpis(model) {
  animateNumber(document.getElementById("kpiInversiones"), model.investments);
  animateNumber(document.getElementById("kpiPuentes"), model.bridges);
  animateNumber(document.getElementById("kpiSinDeficit"), model.sufficient.length);
  animateNumber(document.getElementById("kpiConDeficit"), model.requires.length);

  animateNumber(
    document.getElementById("kpiDeficit"),
    model.deficit,
    { duration: 820, formatter: compactMoney }
  );
}
function renderPortfolio(model) {
  setDonut(
    [
      {
        element: document.getElementById("resourceDonutOk"),
        value: model.sufficient.length
      },
      {
        element: document.getElementById("resourceDonutRisk"),
        value: model.requires.length
      }
    ],
    model.investments
  );

  animateNumber(
    document.getElementById("resourceDonutTotal"),
    model.investments
  );

  animateNumber(
    document.getElementById("resourceOkCount"),
    model.sufficient.length
  );

  animateNumber(
    document.getElementById("resourceRiskCount"),
    model.requires.length
  );

  const resourceOkPct = percent(model.sufficient.length, model.investments);
  const resourceRiskPct = percent(model.requires.length, model.investments);

  ["resourceOkPct", "resourceOkPctLabel"].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.textContent = `${resourceOkPct}%`;
  });

  ["resourceRiskPct", "resourceRiskPctLabel"].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.textContent = `${resourceRiskPct}%`;
  });

  positionDonutLabels(
    [
      { element: document.getElementById("resourceOkPctLabel"), value: model.sufficient.length },
      { element: document.getElementById("resourceRiskPctLabel"), value: model.requires.length }
    ],
    model.investments
  );

  animateNumber(
    document.getElementById("investmentTotal"),
    model.totalCost,
    { formatter: compactMoney }
  );

  animateNumber(
    document.getElementById("investmentFunded"),
    model.fundedAmount,
    { formatter: compactMoney }
  );

  animateNumber(
    document.getElementById("investmentDeficit"),
    model.deficit,
    { formatter: compactMoney }
  );

  const fundedPct = percent(model.fundedAmount, model.totalCost);
  const deficitPct = Math.max(0, 100 - fundedPct);

  document.getElementById("investmentFundedPct").textContent =
    `(${fundedPct}%)`;

  document.getElementById("investmentDeficitPct").textContent =
    `(${deficitPct}%)`;

  setWidth(
    document.getElementById("investmentFundedBar"),
    model.fundedAmount,
    model.totalCost
  );

  setWidth(
    document.getElementById("investmentDeficitBar"),
    model.deficit,
    model.totalCost
  );
}

function renderStage(model) {
  animateNumber(
    document.getElementById("stageTotalBridges"),
    model.investments
  );

  animateNumber(
    document.getElementById("stageSelectionCount"),
    model.allSeleccion.length
  );

  animateNumber(
    document.getElementById("stageEettCount"),
    model.allEett.length
  );

  animateNumber(
    document.getElementById("stageOtherCount"),
    model.allOther.length
  );

  document.getElementById("stageSelectionPct").textContent =
    `${percent(model.allSeleccion.length, model.investments)}%`;

  document.getElementById("stageEettPct").textContent =
    `${percent(model.allEett.length, model.investments)}%`;

  document.getElementById("stageOtherPct").textContent =
    `${percent(model.allOther.length, model.investments)}%`;

  setWidth(
    document.getElementById("stageSelectionSegment"),
    model.allSeleccion.length,
    model.investments
  );

  setWidth(
    document.getElementById("stageEettSegment"),
    model.allEett.length,
    model.investments
  );

  setWidth(
    document.getElementById("stageOtherSegment"),
    model.allOther.length,
    model.investments
  );
}

function renderAgreements(model) {
  setDonut(
    [
      {
        element: document.getElementById("agreementDonutSigned"),
        value: model.withAgreement.length
      },
      {
        element: document.getElementById("agreementDonutPending"),
        value: model.enTramite.length
      },
      {
        element: document.getElementById("agreementDonutNone"),
        value: model.noPresento.length
      }
    ],
    model.requires.length
  );

  animateNumber(
    document.getElementById("agreementDonutTotal"),
    model.requires.length
  );

  animateNumber(
    document.getElementById("agreementSignedCount"),
    model.withAgreement.length
  );

  animateNumber(
    document.getElementById("agreementPendingCount"),
    model.enTramite.length
  );

  animateNumber(
    document.getElementById("agreementNoneCount"),
    model.noPresento.length
  );

  document.getElementById("agreementSignedPct").textContent =
    `${percent(model.withAgreement.length, model.requires.length)}%`;

  document.getElementById("agreementPendingPct").textContent =
    `${percent(model.enTramite.length, model.requires.length)}%`;

  document.getElementById("agreementNonePct").textContent =
    `${percent(model.noPresento.length, model.requires.length)}%`;

  const agreementLabelItems = [
    { id: "agreementSignedPctDonut", value: model.withAgreement.length },
    { id: "agreementPendingPctDonut", value: model.enTramite.length },
    { id: "agreementNonePctDonut", value: model.noPresento.length }
  ];

  agreementLabelItems.forEach(item => {
    const element = document.getElementById(item.id);
    if (element) element.textContent = `${percent(item.value, model.requires.length)}%`;
  });

  positionDonutLabels(
    agreementLabelItems.map(item => ({
      element: document.getElementById(item.id),
      value: item.value
    })),
    model.requires.length
  );

}

function renderResourceManagement(model) {
  animateNumber(
    document.getElementById("routeChartPackage1Count"),
    model.package1.length
  );

  animateNumber(
    document.getElementById("routeChartPendingCount"),
    model.pendingRequest.length
  );

  animateNumber(
    document.getElementById("routeChartConditionedCount"),
    model.conditioned.length
  );

  const total = Math.max(model.requires.length, 1);
  const max = Math.max(
    model.package1.length,
    model.pendingRequest.length,
    model.conditioned.length,
    1
  );

  setBarHeight(
    document.getElementById("routeChartPackage1Bar"),
    model.package1.length,
    max
  );

  setBarHeight(
    document.getElementById("routeChartPendingBar"),
    model.pendingRequest.length,
    max
  );

  setBarHeight(
    document.getElementById("routeChartConditionedBar"),
    model.conditioned.length,
    max
  );

  document.getElementById("routeChartPackage1Pct").textContent =
    `${percent(model.package1.length, total)}%`;

  document.getElementById("routeChartPendingPct").textContent =
    `${percent(model.pendingRequest.length, total)}%`;

  document.getElementById("routeChartConditionedPct").textContent =
    `${percent(model.conditioned.length, total)}%`;
}

function renderFinancialGap(model) {
  const financialTotals = [
    { ids: ["financialTotalCost", "financialModalTotalCost"], value: model.financialCost },
    { ids: ["financialTotalAccrued", "financialModalTotalAccrued"], value: model.financialAccrued },
    { ids: ["financialTotalPim", "financialModalTotalPim"], value: model.financialPim },
    { ids: ["financialTotalDeficit", "financialModalTotalDeficit"], value: model.financialDeficit }
  ];

  financialTotals.forEach(item => {
    item.ids.forEach(id => {
      animateNumber(
        document.getElementById(id),
        item.value,
        { formatter: compactMoney }
      );
    });
  });

  const targets = [
    document.getElementById("financialGapRows"),
    document.getElementById("financialGapRowsModal")
  ].filter(Boolean);

  targets.forEach(container => {
    container.replaceChildren();

    if (!model.financialGapRows.length) {
      const empty = document.createElement("div");
      empty.className = "financial-empty";
      empty.textContent = "Sin inversiones con déficit financiero en el filtro activo.";
      container.appendChild(empty);
      return;
    }

    model.financialGapRows.forEach(item => {
      const row = document.createElement("div");
      row.className = "financial-row";
      row.setAttribute("role", "row");

      const values = [
        item.cui,
        item.pliego,
        tableMoney(item.cost),
        tableMoney(item.accrued),
        tableMoney(item.pim),
        tableMoney(item.deficit)
      ];

      values.forEach((value, index) => {
        const cell = document.createElement("span");
        cell.setAttribute("role", "cell");
        cell.textContent = value;

        if (index === 0) cell.title = `CUI ${value}`;
        if (index === 1) cell.title = item.pliegoFull;

        row.appendChild(cell);
      });

      container.appendChild(row);
    });
  });
}

function groupedGap(rows, field) {
  const grouped = new Map();

  rows.filter(needsResources).forEach(row => {
    const label = String(row[field] || `Sin ${field}`).trim() || `Sin ${field}`;
    const current = grouped.get(label) || {
      label,
      deficit: 0,
      investments: new Set()
    };

    current.deficit += Number(row.deficit || 0);
    current.investments.add(String(row.cui || ""));
    grouped.set(label, current);
  });

  const sorted = [...grouped.values()]
    .map(item => ({
      label: item.label,
      deficit: item.deficit,
      investments: item.investments.size
    }))
    .sort((a, b) => b.deficit - a.deficit || b.investments - a.investments);

  // Se muestran todas las provincias/distritos. La altura visual del card
  // se mantiene fija y, cuando hay más filas de las visibles, el contenedor
  // usa scroll interno en lugar de agrupar registros como "OTROS".
  return sorted;
}

function renderProvinceBars(model, state) {
  const container = document.getElementById("provinceBars");
  const title = document.getElementById("territorialGapTitle");
  const leadHead = document.getElementById("territorialGapLeadHead");

  if (!container) return;
  container.replaceChildren();

  const byDistrict = Boolean(state?.provincia);
  const distribution = groupedGap(
    model.rows,
    byDistrict ? "distrito" : "provincia"
  );

  if (title) {
    title.textContent = byDistrict ? "Brecha por distrito" : "Brecha por provincia";
  }
  if (leadHead) {
    leadHead.textContent = byDistrict ? "Distrito" : "Provincia";
  }

  if (!distribution.length || model.deficit <= 0) {
    const empty = document.createElement("div");
    empty.className = "province-empty";
    empty.textContent = "Sin déficit financiero en el filtro activo.";
    container.appendChild(empty);
    return;
  }

  const max = Math.max(...distribution.map(item => item.deficit), 1);

  distribution.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "province-row";

    const name = document.createElement("span");
    name.className = "province-row__name";
    name.title = item.label;
    name.textContent = item.label;

    const track = document.createElement("i");
    track.className = "province-row__track";

    const fill = document.createElement("b");
    fill.className = "province-row__fill";
    track.appendChild(fill);

    const value = document.createElement("strong");
    value.className = "province-row__value";

    const amount = document.createElement("span");
    amount.textContent = compactMoney(item.deficit);

    const pct = document.createElement("span");
    pct.className = "province-row__pct";
    pct.textContent = `${percent(item.deficit, model.deficit)}%`;

    value.append(amount, pct);
    row.append(name, track, value);
    container.appendChild(row);

    window.setTimeout(() => {
      fill.style.width = `${Math.max(4, (item.deficit / max) * 100)}%`;
    }, 80 + index * 55);
  });
}

function geometryCoordinates(geometry) {
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

  if (geometry) walk(geometry.coordinates);
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
    return geometry.coordinates.flatMap(polygon => polygon.map(ringPath)).join(" ");
  }
  return "";
}

function boundsFrom(features) {
  const coords = [];
  features.forEach(feature => coords.push(...geometryCoordinates(feature.geometry)));
  if (!coords.length) return null;

  const xs = coords.map(coord => coord[0]);
  const ys = coords.map(coord => coord[1]);
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

function makeProjector(bounds, width = 320, height = 230, padding = 10) {
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

function buildFallbackFeatureIndex(fallbackDistrictGeo) {
  const map = new Map();
  (fallbackDistrictGeo?.features || []).forEach(feature => {
    const code = featureDistrictCode(feature);
    if (code) map.set(code, feature);
  });
  return map;
}

async function loadTopologyFeatures(fallbackDistrictGeo) {
  try {
    const response = await fetch(TOPOLOGY_SOURCE_URL, { cache: "force-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const topologyGeo = await response.json();
    if (!Array.isArray(topologyGeo.features) || !topologyGeo.features.length) {
      throw new Error("La fuente simplificada no contiene features válidas.");
    }

    return topologyGeo.features;
  } catch (error) {
    console.warn(
      "[Inicio] No se pudo cargar la geometría simplificada de Territorio; se usa el GeoJSON local como respaldo.",
      error
    );
    return fallbackDistrictGeo?.features || [];
  }
}

function svgPath(feature, className, project) {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", geometryToSvgPath(feature.geometry, project));
  path.setAttribute("class", className);
  return path;
}

function renderScopeMap(baseRows, model, state) {
  const svg = document.getElementById("scopeMiniMap");
  const legend = document.getElementById("scopeMapLegend");

  if (!svg || !legend || !TOPOLOGY_FEATURES.length) return;

  svg.replaceChildren();
  legend.replaceChildren();
  svg.classList.remove("is-map-ready");

  const selectedCodes = new Set(
    model.rows
      .map(row => normalizeCode(row.ubigeo_distrito, 6))
      .filter(Boolean)
  );

  if (!selectedCodes.size) {
    const empty = document.createElementNS(SVG_NS, "text");
    empty.setAttribute("x", "160");
    empty.setAttribute("y", "118");
    empty.setAttribute("text-anchor", "middle");
    empty.setAttribute("class", "scope-map__empty");
    empty.textContent = "Sin geometría para el filtro";
    svg.appendChild(empty);
    return;
  }

  const fallbackIndex = buildFallbackFeatureIndex(DISTRICT_GEO);
  const selectedTopologyFeatures = TOPOLOGY_FEATURES.filter(feature =>
    selectedCodes.has(featureDistrictCode(feature))
  );
  const availableCodes = new Set(selectedTopologyFeatures.map(featureDistrictCode));
  const fallbackSelectedFeatures = [...selectedCodes]
    .filter(code => !availableCodes.has(code) && fallbackIndex.has(code))
    .map(code => fallbackIndex.get(code));

  const selectedFeatures = [
    ...selectedTopologyFeatures,
    ...fallbackSelectedFeatures
  ];

  if (!selectedFeatures.length) return;

  const selectedBounds = boundsFrom(selectedFeatures);
  const territory = state?.territorio || "VRAEM";
  const viewportBounds = expandBounds(
    selectedBounds,
    territory === "AMUVRAEM" ? 0.16 : 0.11,
    territory === "AMUVRAEM" ? 0.18 : 0.13
  );

  const contextFeatures = TOPOLOGY_FEATURES.filter(feature => {
    const code = featureDistrictCode(feature);
    return code && !selectedCodes.has(code) && featureIntersectsBounds(feature, viewportBounds);
  });

  const project = makeProjector(viewportBounds, 320, 230, 10);

  contextFeatures.forEach((feature, index) => {
    const path = svgPath(
      feature,
      "scope-map__context territory-map__district--context",
      project
    );
    path.style.setProperty("--map-delay", `${90 + index * 9}ms`);
    svg.appendChild(path);
  });

  selectedFeatures.forEach((feature, index) => {
    const path = svgPath(
      feature,
      "scope-map__active territory-map__district--selected",
      project
    );
    path.style.setProperty("--map-delay", `${160 + index * 18}ms`);
    path.style.animation = `mapPiece .44s ease ${index * 16}ms both`;

    const name = feature?.properties?.distrito ||
      feature?.properties?.NOMBDIST ||
      feature?.properties?.nombre ||
      feature?.properties?.NOMBRE ||
      "Distrito";
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = String(name);
    path.appendChild(title);
    svg.appendChild(path);
  });

  requestAnimationFrame(() => svg.classList.add("is-map-ready"));

  model.provinceDistribution.slice(0, 5).forEach((item, index) => {
    const row = document.createElement("div");
    row.innerHTML = `
      <i style="opacity:${Math.max(.48, 1 - index * .10)}"></i>
      <span title="${item.province}">${item.province}</span>
      <strong>${item.investments}</strong>
    `;
    legend.appendChild(row);
  });
}

function renderAll(state, baseRows) {
  const model = computeModel(filteredRows(baseRows, state));

  renderScope(state, model);
  renderKpis(model);
  renderPortfolio(model);
  renderFinancialGap(model);
  renderAgreements(model);
  renderResourceManagement(model);
  renderStage(model);
  renderProvinceBars(model, state);
  renderScopeMap(baseRows, model, state);
  updateNavigation(state);

  document.body.classList.remove("is-loading");
}

function bindFilters(data, initialState) {
  const territorioSelect = document.getElementById("territorioSelect");
  const departamentoSelect = document.getElementById("departamentoSelect");
  const provinciaSelect = document.getElementById("provinciaSelect");
  const distritoSelect = document.getElementById("distritoSelect");
  const resetButton = document.getElementById("resetFilters");

  let state = { ...initialState };
  let baseRows = territoryRows(data, state.territorio);

  function apply(nextState) {
    state = { ...nextState };
    baseRows = territoryRows(data, state.territorio);

    persistState(state);
    updateUrl(state);

    territorioSelect.value = state.territorio;

    refreshFilterOptions(baseRows, state);
    renderAll(state, baseRows);
  }

  territorioSelect.addEventListener("change", () =>
    apply({
      territorio: territorioSelect.value,
      departamento: "",
      provincia: "",
      distrito: ""
    })
  );

  departamentoSelect.addEventListener("change", () =>
    apply({
      ...state,
      departamento: departamentoSelect.value,
      provincia: "",
      distrito: ""
    })
  );

  provinciaSelect.addEventListener("change", () =>
    apply({
      ...state,
      provincia: provinciaSelect.value,
      distrito: ""
    })
  );

  distritoSelect.addEventListener("change", () =>
    apply({
      ...state,
      distrito: distritoSelect.value
    })
  );

  resetButton.addEventListener("click", () =>
    apply({
      territorio: state.territorio,
      departamento: "",
      provincia: "",
      distrito: ""
    })
  );

  apply(state);
}

function bindFinancialModal() {
  const modal = document.getElementById("financialModal");
  const openButton = document.getElementById("expandFinancialTable");
  const closeButton = document.getElementById("closeFinancialModal");

  if (!modal || !openButton || !closeButton) return;

  const open = () => {
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    closeButton.focus();
  };

  const close = () => {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    openButton.focus();
  };

  openButton.addEventListener("click", open);
  closeButton.addEventListener("click", close);

  modal.querySelectorAll("[data-close-financial-modal]").forEach(node => {
    node.addEventListener("click", close);
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && modal.classList.contains("is-open")) close();
  });
}

async function initInicio() {
  const [dataResponse, fallbackGeoResponse] = await Promise.all([
    fetch("data/puentes.json", { cache: "no-store" }),
    fetch("data/territorio-distritos.geojson", { cache: "force-cache" })
      .catch(() => null)
  ]);

  if (!dataResponse.ok) {
    throw new Error("No se pudo cargar data/puentes.json");
  }

  const data = await dataResponse.json();

  if (!Array.isArray(data) || !data.length) {
    throw new Error("data/puentes.json está vacío.");
  }

  if (fallbackGeoResponse?.ok) {
    DISTRICT_GEO = await fallbackGeoResponse.json();
  } else {
    DISTRICT_GEO = { features: [] };
  }

  TOPOLOGY_FEATURES = await loadTopologyFeatures(DISTRICT_GEO);
  bindFilters(data, currentState());
}

window.addEventListener("DOMContentLoaded", () => {
  bindFinancialModal();
  initInicio().catch(error => {
    console.error("[Inicio]", error);
    document.body.classList.remove("is-loading");
  });
});

/* =========================================================
   V17 - FILTROS CRUZADOS EN KPI, DONAS, BARRAS Y ESTADOS
   ========================================================= */

let INICIO_VISUAL_FILTER = null;
let INICIO_RUNTIME = null;

function visualFilterKey(filter) {
  return filter ? `${filter.type}:${filter.value}` : '';
}

function rowMatchesVisualFilter(row, filter = INICIO_VISUAL_FILTER) {
  if (!filter) return true;
  const status = normalizeText(row.estado_convenio);
  const situation = normalizeText(row.estado_situacional);
  const packageName = normalizeText(row.paquete);

  if (filter.type === 'resources') {
    return filter.value === 'sufficient' ? !needsResources(row) : needsResources(row);
  }
  if (filter.type === 'agreement') {
    if (!needsResources(row)) return false;
    if (filter.value === 'signed') return signedAgreement(row);
    if (filter.value === 'pending') return status === 'EN TRÁMITE';
    if (filter.value === 'none') return status === 'NO PRESENTÓ';
  }
  if (filter.type === 'management') {
    if (!needsResources(row)) return false;
    if (filter.value === 'package1') return signedAgreement(row) && packageName === 'GRUPO 01';
    if (filter.value === 'pending') return signedAgreement(row) && packageName !== 'GRUPO 01';
    if (filter.value === 'conditioned') return !signedAgreement(row);
  }
  if (filter.type === 'stage') {
    const isSelection = situation === 'PROCESO DE SELECCIÓN';
    const isEett = situation.includes('ELABORACIÓN DE EXPEDIENTE TÉCNICO');
    if (filter.value === 'selection') return isSelection;
    if (filter.value === 'eett') return isEett;
    if (filter.value === 'other') return !isSelection && !isEett;
  }
  return true;
}

function visualFilterRows(rows) {
  return INICIO_VISUAL_FILTER ? rows.filter(row => rowMatchesVisualFilter(row)) : rows;
}

function ensureVisualFilterChip() {
  let chip = document.getElementById('visualFilterChip');
  if (chip) return chip;
  const reset = document.getElementById('resetFilters');
  if (!reset) return null;
  chip = document.createElement('button');
  chip.type = 'button';
  chip.id = 'visualFilterChip';
  chip.className = 'visual-filter-chip';
  chip.hidden = true;
  chip.innerHTML = '<i class="bi bi-funnel-fill"></i><span></span><b aria-hidden="true">×</b>';
  chip.title = 'Quitar filtro del gráfico';
  chip.addEventListener('click', () => setInicioVisualFilter(null));
  reset.parentNode.insertBefore(chip, reset);
  return chip;
}

function updateVisualFilterChip() {
  const chip = ensureVisualFilterChip();
  if (!chip) return;
  chip.hidden = !INICIO_VISUAL_FILTER;
  const text = chip.querySelector('span');
  if (text) text.textContent = INICIO_VISUAL_FILTER?.label || '';
}

function refreshCrossFilterTargetState() {
  const activeKey = visualFilterKey(INICIO_VISUAL_FILTER);
  document.querySelectorAll('[data-crossfilter-key]').forEach(element => {
    const active = Boolean(activeKey) && element.dataset.crossfilterKey === activeKey;
    element.classList.toggle('is-crossfilter-active', active);
    element.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  updateVisualFilterChip();
}

function setInicioVisualFilter(filter) {
  if (filter?.type === 'all') filter = null;
  const nextKey = visualFilterKey(filter);
  const currentKey = visualFilterKey(INICIO_VISUAL_FILTER);
  INICIO_VISUAL_FILTER = nextKey && nextKey !== currentKey ? filter : null;
  if (INICIO_RUNTIME) renderAll(INICIO_RUNTIME.state, INICIO_RUNTIME.baseRows);
}

function makeCrossFilterTarget(element, filter) {
  if (!element || !filter) return;
  const key = visualFilterKey(filter);
  element.dataset.crossfilterKey = key;
  element.classList.add('crossfilter-target');
  element.setAttribute('role', 'button');
  element.setAttribute('tabindex', '0');
  element.setAttribute('aria-pressed', 'false');
  element.title = `Filtrar: ${filter.label}`;
  if (element.dataset.crossfilterBound === '1') return;
  element.dataset.crossfilterBound = '1';
  const activate = event => {
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    if (event.type === 'keydown') event.preventDefault();
    event.stopPropagation();
    setInicioVisualFilter(filter);
  };
  element.addEventListener('click', activate);
  element.addEventListener('keydown', activate);
}

function bindInicioCrossFilters() {
  ensureVisualFilterChip();
  const kpis = [...document.querySelectorAll('.kpi-row .kpi-card')];
  makeCrossFilterTarget(kpis[0], { type: 'all', value: 'all', label: 'Toda la cartera' });
  makeCrossFilterTarget(kpis[1], { type: 'all', value: 'all', label: 'Toda la cartera' });
  makeCrossFilterTarget(kpis[2], { type: 'resources', value: 'sufficient', label: 'Con totalidad de recursos' });
  makeCrossFilterTarget(kpis[3], { type: 'resources', value: 'requires', label: 'Requieren recursos' });
  makeCrossFilterTarget(kpis[4], { type: 'resources', value: 'requires', label: 'Con déficit financiero' });

  const resourceGood = { type: 'resources', value: 'sufficient', label: 'Con totalidad de recursos' };
  const resourceRisk = { type: 'resources', value: 'requires', label: 'Requieren recursos' };
  makeCrossFilterTarget(document.getElementById('resourceDonutOk'), resourceGood);
  makeCrossFilterTarget(document.getElementById('resourceDonutRisk'), resourceRisk);
  makeCrossFilterTarget(document.querySelector('.resource-item--good'), resourceGood);
  makeCrossFilterTarget(document.querySelector('.resource-item--risk'), resourceRisk);
  makeCrossFilterTarget(document.getElementById('investmentFundedBar'), resourceGood);
  makeCrossFilterTarget(document.getElementById('investmentDeficitBar'), resourceRisk);
  document.querySelectorAll('.investment-progress__legend > div').forEach((el, index) => {
    makeCrossFilterTarget(el, index === 0 ? resourceGood : resourceRisk);
  });
  // Los KPI del cálculo financiero son informativos y no actúan como filtros.
  document.querySelectorAll('.card-financial-gap .financial-summary-kpi').forEach(el => {
    el.classList.remove('crossfilter-target', 'is-crossfilter-active');
    el.removeAttribute('data-crossfilter-key');
    el.removeAttribute('role');
    el.removeAttribute('tabindex');
    el.removeAttribute('aria-pressed');
    el.removeAttribute('title');
  });

  const agreementFilters = [
    { type: 'agreement', value: 'signed', label: 'Convenio suscrito' },
    { type: 'agreement', value: 'pending', label: 'Convenio en trámite' },
    { type: 'agreement', value: 'none', label: 'No presentó trámite' }
  ];
  ['agreementDonutSigned', 'agreementDonutPending', 'agreementDonutNone'].forEach((id, index) => {
    makeCrossFilterTarget(document.getElementById(id), agreementFilters[index]);
  });
  document.querySelectorAll('.agreement-list > div').forEach((el, index) => makeCrossFilterTarget(el, agreementFilters[index]));

  const managementFilters = [
    { type: 'management', value: 'package1', label: 'Paquete 1' },
    { type: 'management', value: 'pending', label: 'Por solicitar recursos' },
    { type: 'management', value: 'conditioned', label: 'Pendientes de convenio' }
  ];
  document.querySelectorAll('.prep-chart--management .prep-item').forEach((el, index) => makeCrossFilterTarget(el, managementFilters[index]));

  const stageFilters = [
    { type: 'stage', value: 'selection', label: 'Proceso de selección' },
    { type: 'stage', value: 'eett', label: 'Elaboración de EETT' },
    { type: 'stage', value: 'other', label: 'Otros / sin inicio' }
  ];
  ['stageSelectionSegment', 'stageEettSegment', 'stageOtherSegment'].forEach((id, index) => makeCrossFilterTarget(document.getElementById(id), stageFilters[index]));
  document.querySelectorAll('.stage-legend > div').forEach((el, index) => makeCrossFilterTarget(el, stageFilters[index]));
  document.querySelectorAll('.stage-values > span').forEach((el, index) => makeCrossFilterTarget(el, stageFilters[index]));

  refreshCrossFilterTargetState();
}

function renderAll(state, baseRows) {
  const territoryFiltered = filteredRows(baseRows, state);
  const model = computeModel(visualFilterRows(territoryFiltered));

  renderScope(state, model);
  renderKpis(model);
  renderPortfolio(model);
  renderFinancialGap(model);
  renderAgreements(model);
  renderResourceManagement(model);
  renderStage(model);
  renderProvinceBars(model, state);
  renderScopeMap(baseRows, model, state);
  updateNavigation(state);
  refreshCrossFilterTargetState();

  document.body.classList.remove('is-loading');
}

function renderProvinceBars(model, state) {
  const container = document.getElementById('provinceBars');
  const title = document.getElementById('territorialGapTitle');
  const leadHead = document.getElementById('territorialGapLeadHead');
  if (!container) return;
  container.replaceChildren();

  const byDistrict = Boolean(state?.provincia);
  const distribution = groupedGap(model.rows, byDistrict ? 'distrito' : 'provincia');
  if (title) title.textContent = byDistrict ? 'Brecha por distrito' : 'Brecha por provincia';
  if (leadHead) leadHead.textContent = byDistrict ? 'Distrito' : 'Provincia';

  if (!distribution.length || model.deficit <= 0) {
    const empty = document.createElement('div');
    empty.className = 'province-empty';
    empty.textContent = 'Sin déficit financiero en el filtro activo.';
    container.appendChild(empty);
    return;
  }

  const max = Math.max(...distribution.map(item => item.deficit), 1);
  distribution.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'province-row crossfilter-target province-row--filterable';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.title = `Filtrar por ${byDistrict ? 'distrito' : 'provincia'}: ${item.label}`;

    const name = document.createElement('span');
    name.className = 'province-row__name';
    name.title = item.label;
    name.textContent = item.label;

    const track = document.createElement('i');
    track.className = 'province-row__track';
    const fill = document.createElement('b');
    fill.className = 'province-row__fill';
    track.appendChild(fill);

    const value = document.createElement('strong');
    value.className = 'province-row__value';
    const amount = document.createElement('span');
    amount.textContent = compactMoney(item.deficit);
    const pct = document.createElement('span');
    pct.className = 'province-row__pct';
    pct.textContent = `${percent(item.deficit, model.deficit)}%`;
    value.append(amount, pct);
    row.append(name, track, value);
    container.appendChild(row);

    const applyArea = () => {
      if (!INICIO_RUNTIME?.apply) return;
      if (byDistrict) {
        INICIO_RUNTIME.apply({ ...INICIO_RUNTIME.state, distrito: item.label }, { preserveVisual: true });
      } else {
        INICIO_RUNTIME.apply({ ...INICIO_RUNTIME.state, provincia: item.label, distrito: '' }, { preserveVisual: true });
      }
    };
    row.addEventListener('click', applyArea);
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        applyArea();
      }
    });

    window.setTimeout(() => {
      fill.style.width = `${Math.max(4, (item.deficit / max) * 100)}%`;
    }, 80 + index * 45);
  });
}

function bindFilters(data, initialState) {
  const territorioSelect = document.getElementById('territorioSelect');
  const departamentoSelect = document.getElementById('departamentoSelect');
  const provinciaSelect = document.getElementById('provinciaSelect');
  const distritoSelect = document.getElementById('distritoSelect');
  const resetButton = document.getElementById('resetFilters');

  let state = { ...initialState };
  let baseRows = territoryRows(data, state.territorio);

  function apply(nextState, { preserveVisual = false } = {}) {
    state = { ...nextState };
    baseRows = territoryRows(data, state.territorio);
    if (!preserveVisual) INICIO_VISUAL_FILTER = null;

    persistState(state);
    updateUrl(state);
    territorioSelect.value = state.territorio;
    refreshFilterOptions(baseRows, state);

    INICIO_RUNTIME = { state, baseRows, apply };
    renderAll(state, baseRows);
  }

  territorioSelect.addEventListener('change', () => apply({ territorio: territorioSelect.value, departamento: '', provincia: '', distrito: '' }));
  departamentoSelect.addEventListener('change', () => apply({ ...state, departamento: departamentoSelect.value, provincia: '', distrito: '' }));
  provinciaSelect.addEventListener('change', () => apply({ ...state, provincia: provinciaSelect.value, distrito: '' }));
  distritoSelect.addEventListener('change', () => apply({ ...state, distrito: distritoSelect.value }));
  resetButton.addEventListener('click', () => apply({ territorio: state.territorio, departamento: '', provincia: '', distrito: '' }));

  apply(state, { preserveVisual: true });
  bindInicioCrossFilters();
}

/* =========================================================
   V19 - KPI DE INICIO: FILTRO SIN REPINTADO TERRITORIAL
   ========================================================= */
function refreshCrossFilterTargetState() {
  const activeKey = visualFilterKey(INICIO_VISUAL_FILTER);
  document.querySelectorAll('[data-crossfilter-key]').forEach(element => {
    const active = Boolean(activeKey) && element.dataset.crossfilterKey === activeKey;
    const isGeneralKpi = element.matches('.kpi-row .kpi-card');
    if (isGeneralKpi) {
      // Los KPI siguen actuando como filtro y sus valores se recalculan,
      // pero no cambian al color del ámbito cuando el filtro está activo.
      element.classList.remove('is-crossfilter-active');
      element.classList.toggle('is-crossfilter-kpi-selected', active);
    } else {
      element.classList.toggle('is-crossfilter-active', active);
    }
    element.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  updateVisualFilterChip();
}
