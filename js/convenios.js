const TERRITORY_CONFIG = {
  VRAEM: {
    label: "VRAEM",
    longLabel: "VRAEM y zonas de influencia",
    filterField: "es_vraem",
    filterValue: "SI",
    accent: "#8f2641",
    rgb: "143, 38, 65"
  },
  NORVRAEM: {
    label: "NORVRAEM",
    longLabel: "Ámbito territorial del norte",
    filterField: "es_norvraem",
    filterValue: "SI",
    accent: "#315f78",
    rgb: "49, 95, 120"
  },
  AMUVRAEM: {
    label: "AMUVRAE",
    longLabel: "Mancomunidad del VRAE",
    filterField: "es_amuvraem",
    filterValue: "SI",
    accent: "#4f8b78",
    rgb: "79, 139, 120"
  }
};

const DOCUMENT_CONFIG = {
  apiUrl: "https://script.google.com/macros/s/AKfycbwG5AGahup-QcZQjtBamqxqPkVLy-f0HhBcX9yvA6xORETGMYtxTmFs4-KYKx1cFQqxDA/exec",
  timeoutMs: 9000
};

const FILTER_STORAGE_KEY = "dashboard_filter_state";
const DONUT_RADIUS = 66;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;
const PAGE_SIZE = 10;

let APP_DATA = [];
let CURRENT_STATE = null;
let CURRENT_STATUS = "TODOS";
let CURRENT_SEARCH = "";
let CURRENT_PAGE = 1;
let CURRENT_ROWS = [];

function agreementSerial(row) {
  const text = cleanText(row?.numero_convenio);
  if (!text) return "";

  const match =
    text.match(/(?:N[°º]?\s*)?(\d+)\s*[-–]?\s*2026/i) ||
    text.match(/(\d+)/);

  return match ? String(Number(match[1])) : "";
}

function expectedPdfName(row) {
  const serial = agreementSerial(row);
  return serial ? `CV-2026-${serial.padStart(5, "0")}-000.pdf` : "";
}

function extractDriveId(value) {
  const text = String(value || "");
  if (!text) return "";

  const direct = text.match(/\/file\/d\/([^/?#]+)/i);
  if (direct) return direct[1];

  const query = text.match(/[?&]id=([^&#]+)/i);
  if (query) return decodeURIComponent(query[1]);

  // Los IDs de Drive normalmente tienen 20+ caracteres alfanuméricos/guiones.
  if (/^[\w-]{20,}$/.test(text)) return text;
  return "";
}

function isPdfLike(name, mime) {
  return /\.pdf$/i.test(String(name || "").trim()) ||
    /application\/pdf/i.test(String(mime || ""));
}

class DriveConventionResolver {
  constructor(config) {
    this.config = config;
    this.cache = new Map();
  }

  jsonp(params) {
    return new Promise(resolve => {
      const callbackName = `__convPdf_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement("script");
      let settled = false;

      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { delete window[callbackName]; } catch (_) {}
        script.remove();
        resolve(value || null);
      };

      const timeout = setTimeout(() => finish(null), this.config.timeoutMs);
      window[callbackName] = payload => finish(payload);
      script.onerror = () => finish(null);

      try {
        const url = new URL(this.config.apiUrl);
        Object.entries(params || {}).forEach(([key, value]) => {
          if (value !== null && value !== undefined && String(value) !== "") {
            url.searchParams.set(key, String(value));
          }
        });
        url.searchParams.set("callback", callbackName);
        url.searchParams.set("_ts", String(Date.now()));
        script.src = url.toString();
        document.head.appendChild(script);
      } catch (_) {
        finish(null);
      }
    });
  }

  entryForCui(payload, cui) {
    if (!payload) return null;
    const key = String(cui || "");

    return (
      payload?.items?.[key] ??
      payload?.data?.items?.[key] ??
      payload?.data?.[key] ??
      payload?.[key] ??
      payload?.item ??
      payload
    );
  }

  collectFiles(payload, cui) {
    const root = this.entryForCui(payload, cui);
    if (!root) return [];

    const files = [];
    const visited = new Set();

    const visit = (node, key = "") => {
      if (node === null || node === undefined) return;

      if (typeof node === "string") {
        const text = cleanText(node);
        if (/\.pdf(?:$|[?#])/i.test(text) || /\.pdf$/i.test(key)) {
          files.push({ name: key || "", mime: "application/pdf", id: "", url: text });
        }
        return;
      }

      if (typeof node !== "object" || visited.has(node)) return;
      visited.add(node);

      if (Array.isArray(node)) {
        node.forEach(item => visit(item, key));
        return;
      }

      const name = cleanText(node.name ?? node.title ?? node.fileName ?? node.filename ?? "");
      const mime = cleanText(node.mimeType ?? node.mime_type ?? node.type ?? "");
      const id = cleanText(node.id ?? node.fileId ?? node.file_id ?? "");
      const url = cleanText(
        node.webViewLink ?? node.webContentLink ?? node.downloadUrl ??
        node.download_url ?? node.url ?? node.link ?? ""
      );

      if (isPdfLike(name, mime) || /\.pdf(?:$|[?#])/i.test(url)) {
        files.push({ name, mime, id, url });
      }

      Object.entries(node).forEach(([childKey, value]) => visit(value, childKey));
    };

    visit(root);
    return files;
  }

  chooseExactPdf(files, row) {
    if (!Array.isArray(files) || !files.length) return null;

    const expected = expectedPdfName(row).toLowerCase();
    const serial = agreementSerial(row);
    const padded = serial ? serial.padStart(5, "0") : "";

    const exact = files.find(file => cleanText(file.name).toLowerCase() === expected);
    if (exact) return exact;

    if (padded) {
      return files.find(file => {
        const name = cleanText(file.name).toUpperCase();
        return name.includes("CV-2026-") && name.includes(padded) && /\.PDF$/i.test(name);
      }) || null;
    }

    return null;
  }

  normalize(file, row) {
    if (!file) return null;

    const id = cleanText(file.id) || extractDriveId(file.url);
    const name = cleanText(file.name) || expectedPdfName(row) || "Convenio.pdf";

    if (id) {
      const encoded = encodeURIComponent(id);
      return {
        id,
        name,
        viewUrl: `https://drive.google.com/file/d/${encoded}/view`,
        previewUrl: `https://drive.google.com/file/d/${encoded}/preview`,
        downloadUrl: `https://drive.google.com/uc?export=download&id=${encoded}`
      };
    }

    const url = cleanText(file.url);
    if (!url || !/\.pdf(?:$|[?#])/i.test(url)) return null;

    return { id: "", name, viewUrl: url, previewUrl: url, downloadUrl: url };
  }

  async resolve(row) {
    const cui = cleanText(row?.cui);
    const expected = expectedPdfName(row);
    if (!cui || !expected || statusKey(row) !== "SUSCRITO") return null;

    const cacheKey = `${cui}|${expected}`;
    if (this.cache.has(cacheKey)) return await this.cache.get(cacheKey);

    // El backend resuelve el PDF por el número exacto del convenio.
    // No se consulta la API de fotografías: esa respuesta solo contiene imágenes.
    const serial = agreementSerial(row);
    const task = this.jsonp({ action: "convenio", numero: serial, cui }).then(payload => {
      if (!payload?.ok || !payload?.found) return null;

      const direct = payload?.file || payload?.data?.file || null;
      if (direct) {
        return this.normalize({
          id: direct.id || direct.fileId || "",
          name: direct.name || direct.fileName || expected,
          mime: direct.mimeType || direct.mime || "application/pdf",
          url: direct.viewUrl || direct.url || direct.link || ""
        }, row);
      }

      const selected = this.chooseExactPdf(this.collectFiles(payload, cui), row);
      return this.normalize(selected, row);
    }).catch(() => null);

    this.cache.set(cacheKey, task);
    const resolved = await task;
    this.cache.set(cacheKey, resolved);
    return resolved;
  }
}

const conventionResolver = new DriveConventionResolver(DOCUMENT_CONFIG);

function normalizeText(value) {
  return String(value ?? "").trim().toUpperCase();
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function uniqueCount(rows, field) {
  return new Set(
    rows.map(row => row[field])
      .filter(value => value !== null && value !== undefined && value !== "")
      .map(String)
  ).size;
}

function percent(value, total) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function statusKey(row) {
  const raw = normalizeText(row.estado_convenio);

  if (raw === "CONVENIO SUSCRITO") return "SUSCRITO";
  if (raw === "EN TRÁMITE") return "EN TRÁMITE";
  return "NO PRESENTADO";
}

function statusLabel(row) {
  const status = statusKey(row);

  if (status === "SUSCRITO") return "Convenio suscrito";
  if (status === "EN TRÁMITE") return "En trámite";
  return "No presentado";
}

function statusFilterLabel(status) {
  if (status === "SUSCRITO") return "convenio suscrito";
  if (status === "EN TRÁMITE") return "en trámite";
  if (status === "NO PRESENTADO") return "no presentado";
  return "todos los estados";
}

function statusIcon(status) {
  if (status === "SUSCRITO") return "ri-checkbox-circle-fill";
  if (status === "EN TRÁMITE") return "ri-time-line";
  return "ri-file-warning-line";
}

function statusClass(status) {
  if (status === "SUSCRITO") return "subscribed";
  if (status === "EN TRÁMITE") return "pending";
  return "none";
}

function flowStageForRow(row) {
  const state = statusKey(row);
  const raw = cleanText(row?.etapa_convenio);
  const normalized = normalizeText(raw);

  if (state === "SUSCRITO") {
    return {
      step: 7,
      label: "Convenio suscrito",
      detail: raw || "Convenio suscrito",
      tone: "success"
    };
  }

  if (state === "NO PRESENTADO") {
    return {
      step: 1,
      label: "Solicitud del pliego",
      detail: "No presentó trámite para convenio",
      tone: "muted"
    };
  }

  if (normalized.includes("DEVUELTO A MUNICIPALIDAD")) {
    return {
      step: 2,
      label: "Evaluación PVD",
      detail: "Devuelto a la municipalidad para subsanación",
      tone: "warning",
      returned: true
    };
  }

  if (normalized.includes("EVALUACION INICIAL") || normalized.includes("EVALUACIÓN INICIAL")) {
    return { step: 2, label: "Evaluación PVD", detail: raw, tone: "active" };
  }

  if (normalized.includes("OPP") && (normalized.includes("EVALUACION") || normalized.includes("EVALUACIÓN"))) {
    return { step: 3, label: "Opinión OPP", detail: raw, tone: "active" };
  }

  if (
    normalized.includes("RETORNO DE OPP") ||
    (normalized.includes("ELABORACION") && normalized.includes("CONVENIO")) ||
    (normalized.includes("ELABORACIÓN") && normalized.includes("CONVENIO")) ||
    normalized.includes("PROYECTO DE CONVENIO")
  ) {
    return { step: 4, label: "Elaboración de convenio", detail: raw, tone: "active" };
  }

  if (normalized.includes("OPINION OAJ") || normalized.includes("OPINIÓN OAJ")) {
    return { step: 5, label: "Opinión OAJ", detail: raw, tone: "active" };
  }

  if (normalized.includes("SUSCRIP")) {
    return { step: 6, label: "Suscripción MTC · Pliego", detail: raw, tone: "active" };
  }

  if (normalized.includes("ENUMER") || normalized.includes("NOTIFIC")) {
    return { step: 7, label: "Enumeración y notificación", detail: raw, tone: "active" };
  }

  const number = Number((raw.match(/^(\d+)/) || [])[1]);
  const fallback = {
    1: { step: 2, label: "Evaluación PVD" },
    2: { step: 3, label: "Opinión OPP" },
    3: { step: 4, label: "Elaboración de convenio" },
    4: { step: 4, label: "Elaboración de convenio" },
    5: { step: 5, label: "Opinión OAJ" },
    6: { step: 4, label: "Elaboración de convenio" },
    7: { step: 6, label: "Suscripción MTC · Pliego" },
    8: { step: 7, label: "Enumeración y notificación" }
  }[number];

  if (fallback) {
    return { ...fallback, detail: raw || fallback.label, tone: "active" };
  }

  return {
    step: 4,
    label: raw || "En trámite",
    detail: raw || "Etapa en trámite",
    tone: "active"
  };
}

function stageInfo(row) {
  const state = statusKey(row);
  const flow = flowStageForRow(row);

  if (state === "SUSCRITO") {
    return { label: "Convenio suscrito", progress: 100, flowStep: 7 };
  }

  if (state === "NO PRESENTADO") {
    return { label: "No presentó trámite", progress: 0, flowStep: 1 };
  }

  return {
    label: flow.returned ? "Devuelto para subsanación" : flow.label,
    progress: Math.round((flow.step / 7) * 100),
    flowStep: flow.step,
    detail: flow.detail,
    tone: flow.tone
  };
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
    departamento:
      params.get("departamento") ??
      (sameTerritory ? saved.departamento || "" : ""),
    provincia:
      params.get("provincia") ??
      (sameTerritory ? saved.provincia || "" : ""),
    distrito:
      params.get("distrito") ??
      (sameTerritory ? saved.distrito || "" : "")
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
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}?${queryFromState(state)}`
  );
}

function territoryRows(data, territory) {
  const config = TERRITORY_CONFIG[territory];

  return data.filter(
    row => normalizeText(row[config.filterField]) === config.filterValue
  );
}

function geographicRows(rows, state) {
  return rows.filter(row => {
    if (
      state.departamento &&
      String(row.region || "") !== state.departamento
    ) {
      return false;
    }

    if (
      state.provincia &&
      String(row.provincia || "") !== state.provincia
    ) {
      return false;
    }

    if (
      state.distrito &&
      String(row.distrito || "") !== state.distrito
    ) {
      return false;
    }

    return true;
  });
}

function sortSpanish(values) {
  return [...values].sort((a, b) =>
    String(a).localeCompare(String(b), "es", { sensitivity: "base" })
  );
}

function optionsFor(rows, field) {
  return sortSpanish(
    new Set(rows.map(row => row[field]).filter(Boolean))
  );
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
    row =>
      !state.departamento ||
      String(row.region || "") === state.departamento
  );

  populateSelect(
    provinciaSelect,
    optionsFor(departmentRows, "provincia"),
    state.provincia,
    "Todas"
  );

  const provinceRows = departmentRows.filter(
    row =>
      !state.provincia ||
      String(row.provincia || "") === state.provincia
  );

  populateSelect(
    distritoSelect,
    optionsFor(provinceRows, "distrito"),
    state.distrito,
    "Todos"
  );
}

function updateNavigation(state) {
  const query = queryFromState(state);

  document.querySelectorAll("[data-nav-page]").forEach(link => {
    link.href = `${link.dataset.navPage}?${query}`;
  });

  document.getElementById("backInicio").href =
    `inicio.html?${query}`;
}

function animateNumber(element, finalValue, duration = 600) {
  if (!element) return;

  const start = performance.now();

  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);

    element.textContent = Math.round(finalValue * eased)
      .toLocaleString("es-PE");

    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      element.textContent = Number(finalValue)
        .toLocaleString("es-PE");
    }
  }

  requestAnimationFrame(tick);
}

function setDonut(items, total) {
  let consumed = 0;

  items.forEach(({ element, value }) => {
    if (!element) return;

    element.style.strokeDasharray =
      `0 ${DONUT_CIRCUMFERENCE}`;

    element.style.strokeDashoffset =
      `${-consumed}`;

    consumed +=
      total > 0
        ? DONUT_CIRCUMFERENCE * value / total
        : 0;
  });

  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      let offset = 0;

      items.forEach(({ element, value }) => {
        if (!element) return;

        const length =
          total > 0
            ? DONUT_CIRCUMFERENCE * value / total
            : 0;

        element.style.strokeDasharray =
          `${length} ${Math.max(0, DONUT_CIRCUMFERENCE - length)}`;

        element.style.strokeDashoffset =
          `${-offset}`;

        offset += length;
      });
    })
  );
}

function setWidth(element, value, total) {
  if (!element) return;

  const pct =
    total > 0
      ? Math.max(0, value / total * 100)
      : 0;

  element.style.width = "0%";

  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      element.style.width = `${pct}%`;
    })
  );
}

function modelFor(rows) {
  const subscribed = rows.filter(row => statusKey(row) === "SUSCRITO");
  const pending = rows.filter(row => statusKey(row) === "EN TRÁMITE");
  const none = rows.filter(row => statusKey(row) === "NO PRESENTADO");

  return {
    rows,
    total: rows.length,
    subscribed,
    pending,
    none
  };
}

function renderHeader(state) {
  const config = TERRITORY_CONFIG[state.territorio];

  document.documentElement.style.setProperty(
    "--scope-color",
    config.accent
  );

  document.documentElement.style.setProperty(
    "--scope-rgb",
    config.rgb
  );

  document.getElementById("pageTitle").textContent =
    `Gestión de convenios - ${config.label}`;

  document.getElementById("territoryChip").textContent =
    config.label;
}

function renderDistribution(model) {
  animateNumber(
    document.getElementById("totalConvenios"),
    model.total
  );

  animateNumber(
    document.getElementById("donutTotal"),
    model.total
  );

  animateNumber(
    document.getElementById("legendTotal"),
    model.total
  );

  animateNumber(
    document.getElementById("legendSubscribed"),
    model.subscribed.length
  );

  animateNumber(
    document.getElementById("legendPending"),
    model.pending.length
  );

  animateNumber(
    document.getElementById("legendNone"),
    model.none.length
  );

  document.getElementById("legendSubscribedPct").textContent =
    `${percent(model.subscribed.length, model.total)}%`;

  document.getElementById("legendPendingPct").textContent =
    `${percent(model.pending.length, model.total)}%`;

  document.getElementById("legendNonePct").textContent =
    `${percent(model.none.length, model.total)}%`;

  setDonut(
    [
      {
        element: document.getElementById("donutSubscribed"),
        value: model.subscribed.length
      },
      {
        element: document.getElementById("donutPending"),
        value: model.pending.length
      },
      {
        element: document.getElementById("donutNone"),
        value: model.none.length
      }
    ],
    model.total
  );

  setWidth(
    document.getElementById("stackSubscribed"),
    model.subscribed.length,
    model.total
  );

  setWidth(
    document.getElementById("stackPending"),
    model.pending.length,
    model.total
  );

  setWidth(
    document.getElementById("stackNone"),
    model.none.length,
    model.total
  );
}

function renderStageSummary(model) {
  const container = document.getElementById("stageSummary");
  container.replaceChildren();

  if (!model.pending.length) {
    const empty = document.createElement("div");
    empty.className = "stage-summary-empty";
    empty.innerHTML =
      `<span><i class="ri-checkbox-circle-line"></i><br>No hay convenios en trámite en el filtro actual.</span>`;

    container.appendChild(empty);
    return;
  }

  const groups = new Map();

  model.pending.forEach(row => {
    const stage = stageInfo(row);
    const key = stage.label;

    if (!groups.has(key)) {
      groups.set(key, {
        label: key,
        count: 0,
        progress: stage.progress
      });
    }

    groups.get(key).count += 1;
  });

  const rows = [...groups.values()]
    .sort((a, b) =>
      b.progress - a.progress ||
      b.count - a.count
    );

  const maxCount = Math.max(
    ...rows.map(item => item.count),
    1
  );

  rows.slice(0, 5).forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "stage-summary-row";

    const labelNorm = normalizeText(item.label);
    let rowIcon = "ri-route-line";
    let rowTone = "";

    if (labelNorm.includes("DEVUELTO") || labelNorm.includes("SUBSAN")) {
      rowIcon = "ri-loop-right-line";
      rowTone = " is-warning";
    } else if (labelNorm.includes("OPINION") || labelNorm.includes("OPP") || labelNorm.includes("OAJ")) {
      rowIcon = "ri-file-text-line";
      rowTone = " is-opinion";
    } else if (labelNorm.includes("EVALUACION") || labelNorm.includes("PVD")) {
      rowIcon = "ri-team-line";
      rowTone = " is-evaluation";
    } else if (labelNorm.includes("ELABORACION") || labelNorm.includes("CONVENIO")) {
      rowIcon = "ri-settings-3-line";
    }

    row.className += rowTone;
    row.innerHTML = `
      <span class="stage-summary-row__icon" aria-hidden="true"><i class="${rowIcon}"></i></span>

      <div class="stage-summary-row__main">
        <div class="stage-summary-row__label">
          <span title="${escapeHtml(item.label)}">
            ${escapeHtml(item.label)}
          </span>
          <em>${item.progress}%</em>
        </div>

        <div class="stage-summary-row__bar">
          <i></i>
        </div>
      </div>

      <strong>${item.count}</strong>
    `;

    container.appendChild(row);

    const bar = row.querySelector(".stage-summary-row__bar i");

    setTimeout(() => {
      bar.style.width =
        `${Math.max(12, item.count / maxCount * 100)}%`;
    }, 100 + index * 70);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function filteredTableRows(rows) {
  const query = normalizeText(CURRENT_SEARCH);

  return rows.filter(row => {
    if (
      CURRENT_STATUS !== "TODOS" &&
      statusKey(row) !== CURRENT_STATUS
    ) {
      return false;
    }

    if (!query) return true;

    const haystack = [
      row.cui,
      row.pliego,
      row.region,
      row.provincia,
      row.distrito,
      row.numero_convenio,
      row.etapa_convenio
    ]
      .map(normalizeText)
      .join(" ");

    return haystack.includes(query);
  });
}

function renderTable(rows) {
  const tbody = document.getElementById("agreementTableBody");
  tbody.replaceChildren();

  const filtered = filteredTableRows(rows);
  const totalPages = Math.max(
    1,
    Math.ceil(filtered.length / PAGE_SIZE)
  );

  CURRENT_PAGE = Math.min(CURRENT_PAGE, totalPages);

  const start = (CURRENT_PAGE - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(start, start + PAGE_SIZE);

  if (!pageRows.length) {
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td colspan="8" class="table-empty">
        <div class="table-empty__content">
          <i class="ri-inbox-2-line"></i>
          <strong>Sin resultados</strong>
          <span>No se encontraron convenios con los filtros aplicados.</span>
        </div>
      </td>
    `;

    tbody.appendChild(tr);
  } else {
    pageRows.forEach((row, pageIndex) => {
      tbody.appendChild(
        buildTableRow(
          row,
          start + pageIndex + 1
        )
      );
    });
  }

  const visibleStart =
    filtered.length
      ? start + 1
      : 0;

  const visibleEnd =
    Math.min(start + PAGE_SIZE, filtered.length);

  document.getElementById("tableCounter").textContent =
    `Mostrando ${visibleStart}-${visibleEnd} de ${filtered.length} inversiones`;

  document.getElementById("pageIndicator").textContent =
    `${CURRENT_PAGE} / ${totalPages}`;

  document.getElementById("prevPage").disabled =
    CURRENT_PAGE <= 1;

  document.getElementById("nextPage").disabled =
    CURRENT_PAGE >= totalPages;

  document.getElementById("tableSummary").textContent =
    `${filtered.length} inversiones visibles · ${statusFilterLabel(CURRENT_STATUS)}`;

  hydrateDocuments(pageRows);
}

function buildTableRow(row, index) {
  const tr = document.createElement("tr");

  const status = statusKey(row);
  const cls = statusClass(status);
  const stage = stageInfo(row);

  const convenioNumber =
    cleanText(row.numero_convenio) || "—";

  const inconsistent =
    status === "NO PRESENTADO" &&
    convenioNumber !== "—";

  tr.dataset.cui = String(row.cui || "");

  tr.innerHTML = `
    <td>
      <span class="row-index">${index}</span>
    </td>

    <td>
      <span class="cui-code">
        <i class="ri-hashtag"></i>
        ${escapeHtml(row.cui)}
      </span>
    </td>

    <td>
      <div class="entity-cell">
        <strong title="${escapeHtml(row.pliego)}">
          ${escapeHtml(row.pliego || "—")}
        </strong>
        <span title="${escapeHtml(row.denominacion_inversion)}">
          ${escapeHtml(shortInvestmentName(row.denominacion_inversion))}
        </span>
      </div>
    </td>

    <td>
      <div class="location-cell">
        <strong>${escapeHtml(row.distrito || "—")}</strong>
        <span>${escapeHtml(row.provincia || "—")} · ${escapeHtml(row.region || "—")}</span>
      </div>
    </td>

    <td>
      ${
        status === "EN TRÁMITE"
          ? `<button type="button" class="status-chip status-chip--${cls} status-chip--clickable" data-open-flow title="Ver detalle del flujo de esta inversión">
              <i class="${statusIcon(status)}"></i>
              ${escapeHtml(statusLabel(row))}
              <i class="ri-arrow-right-s-line status-chip__arrow"></i>
            </button>`
          : `<span class="status-chip status-chip--${cls}">
              <i class="${statusIcon(status)}"></i>
              ${escapeHtml(statusLabel(row))}
            </span>`
      }
    </td>

    <td>
      ${
        status === "EN TRÁMITE"
          ? `<button type="button" class="progress-cell progress-cell--${cls} progress-cell--clickable" data-open-flow title="${escapeHtml(stage.detail || stage.label)} · Ver detalle del flujo">
              <div class="progress-cell__top">
                <span>${escapeHtml(stage.label)}</span>
                <strong>${stage.progress}%</strong>
              </div>
              <div class="progress-cell__track"><i data-progress="${stage.progress}"></i></div>
            </button>`
          : `<div class="progress-cell progress-cell--${cls}">
              <div class="progress-cell__top">
                <span title="${escapeHtml(stage.label)}">${escapeHtml(stage.label)}</span>
                <strong>${stage.progress}%</strong>
              </div>
              <div class="progress-cell__track"><i data-progress="${stage.progress}"></i></div>
            </div>`
      }
    </td>

    <td>
      <span class="agreement-number">
        <i class="ri-file-text-line"></i>
        <span title="${escapeHtml(convenioNumber)}">
          ${escapeHtml(shortAgreementNumber(convenioNumber))}
        </span>
        ${
          inconsistent
            ? `<i class="ri-alert-line data-warning" title="El registro figura como NO PRESENTADO pero contiene número de convenio. Validar fuente."></i>`
            : ""
        }
      </span>
    </td>

    <td>
      <div class="doc-cell" data-doc-cui="${escapeHtml(row.cui)}"></div>
    </td>
  `;

  requestAnimationFrame(() => {
    tr.querySelectorAll("[data-progress]").forEach(bar => {
      bar.style.width = `${bar.dataset.progress}%`;
    });
  });

  tr.querySelectorAll("[data-open-flow]").forEach(control => {
    control.addEventListener("click", () => openFlowModal(row));
  });

  return tr;
}

function shortInvestmentName(value) {
  const text = cleanText(value);

  if (!text) return "Inversión IOARR";

  return text.length > 75
    ? `${text.slice(0, 72)}…`
    : text;
}

function shortAgreementNumber(value) {
  if (!value || value === "—") return "—";

  const match =
    String(value).match(/(?:N[°º]?\s*)?(\d+)\s*[-–]?\s*2026/i);

  return match
    ? `N° ${match[1]}-2026`
    : String(value);
}

function setDocumentButtonBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle("is-loading", busy);

  const icon = button.querySelector("i");
  if (!icon) return;

  if (busy) {
    button.dataset.originalIcon = icon.className;
    icon.className = "ri-loader-4-line";
  } else if (button.dataset.originalIcon) {
    icon.className = button.dataset.originalIcon;
    delete button.dataset.originalIcon;
  }
}

function showDocumentNotice(message) {
  let toast = document.getElementById("convDocumentToast");

  if (!toast) {
    toast = document.createElement("div");
    toast.id = "convDocumentToast";
    toast.className = "conv-document-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.classList.add("is-visible");

  clearTimeout(showDocumentNotice.timer);
  showDocumentNotice.timer = setTimeout(() => {
    toast.classList.remove("is-visible");
  }, 4200);
}

function expectedDocumentHint(row) {
  return expectedPdfName(row) || "PDF del convenio";
}

async function resolveDocumentForAction(row, button) {
  setDocumentButtonBusy(button, true);
  button?.setAttribute("aria-busy", "true");

  try {
    const pdf = await conventionResolver.resolve(row);

    if (!pdf) {
      showDocumentNotice(
        `No se encontró ${expectedDocumentHint(row)} en Google Drive para el CUI ${cleanText(row?.cui)}. Verifica que el Apps Script V13 esté implementado y que el PDF exista en la carpeta de convenios con ese nombre.`
      );
    }

    return pdf;
  } finally {
    setDocumentButtonBusy(button, false);
    button?.removeAttribute("aria-busy");
  }
}

function triggerPdfDownload(pdf, row) {
  if (!pdf?.downloadUrl) return;

  const link = document.createElement("a");
  link.href = pdf.downloadUrl;
  link.download = pdf.name || `Convenio_${row.cui}.pdf`;
  link.rel = "noopener";

  if (isAbsoluteUrl(pdf.downloadUrl)) {
    link.target = "_blank";
  }

  document.body.appendChild(link);
  link.click();
  link.remove();
}

function hydrateDocuments(rows) {
  rows.forEach(row => {
    const cell = document.querySelector(
      `[data-doc-cui="${CSS.escape(String(row.cui))}"]`
    );

    if (!cell) return;
    cell.replaceChildren();

    const status = statusKey(row);
    const hasDocumentKey = Boolean(agreementSerial(row));

    if (status !== "SUSCRITO" || !hasDocumentKey) {
      const button = document.createElement("button");
      button.className = "doc-btn";
      button.type = "button";
      button.disabled = true;
      button.title = status === "SUSCRITO"
        ? "No se pudo determinar el número del convenio PDF"
        : "Documento disponible únicamente para convenios suscritos";
      button.innerHTML = `<i class="ri-file-pdf-2-line"></i>`;
      cell.appendChild(button);
      return;
    }

    const view = document.createElement("button");
    view.className = "doc-btn";
    view.type = "button";
    view.title = "Ver convenio PDF";
    view.setAttribute("aria-label", `Ver convenio PDF del CUI ${row.cui}`);
    view.innerHTML = `<i class="ri-eye-line"></i>`;
    view.addEventListener("click", async () => {
      const pdf = await resolveDocumentForAction(row, view);
      if (pdf) openPdfModal(pdf, row);
    });

    const download = document.createElement("button");
    download.className = "doc-btn doc-btn--download";
    download.type = "button";
    download.title = "Descargar convenio PDF";
    download.setAttribute("aria-label", `Descargar convenio PDF del CUI ${row.cui}`);
    download.innerHTML = `<i class="ri-download-2-line"></i>`;
    download.addEventListener("click", async () => {
      const pdf = await resolveDocumentForAction(row, download);
      if (pdf) triggerPdfDownload(pdf, row);
    });

    cell.append(view, download);
  });
}

function openFlowModal(row = null) {
  const modal = document.getElementById("flowModal");
  const context = document.getElementById("flowModalContext");
  const subtitle = document.getElementById("flowModalSubtitle");
  const note = document.getElementById("flowModalNote");
  if (!modal) return;

  const steps = [...modal.querySelectorAll("[data-flow-step]")];
  steps.forEach(step => {
    step.classList.remove("is-complete", "is-current", "is-pending", "is-warning", "is-neutral");
    const marker = step.querySelector(".flow-step__current");
    if (marker) marker.innerHTML = '<i class="ri-map-pin-fill"></i> Etapa actual';
  });

  if (row) {
    const flow = flowStageForRow(row);
    const currentStep = Math.min(7, Math.max(1, Number(flow.step) || 1));

    context.hidden = false;
    document.getElementById("flowContextCui").textContent = `CUI ${cleanText(row.cui) || "—"}`;
    document.getElementById("flowContextEntity").textContent = cleanText(row.pliego) || "—";
    document.getElementById("flowContextLocation").textContent = [row.distrito, row.provincia, row.region].filter(Boolean).join(" · ") || "—";
    document.getElementById("flowContextStage").textContent = flow.detail || flow.label;
    document.getElementById("flowContextHint").textContent = flow.returned
      ? "El expediente se encuentra devuelto para subsanación antes de continuar con el flujo."
      : `Corresponde al hito ${currentStep} de 7: ${flow.label}.`;

    subtitle.textContent = `Seguimiento del CUI ${cleanText(row.cui)} dentro del proceso de suscripción.`;
    note.textContent = flow.returned
      ? "La marca de subsanación identifica una devolución a la municipalidad. El flujo continuará desde la etapa correspondiente cuando se levanten las observaciones."
      : "Las etapas anteriores se muestran como recorridas y la etapa registrada queda resaltada. La posición corresponde a la información disponible en la fuente.";

    steps.forEach(step => {
      const number = Number(step.dataset.flowStep);
      if (number < currentStep) step.classList.add("is-complete");
      else if (number === currentStep) {
        step.classList.add("is-current");
        if (flow.returned) {
          step.classList.add("is-warning");
          const marker = step.querySelector(".flow-step__current");
          if (marker) marker.innerHTML = '<i class="ri-arrow-go-back-line"></i> En subsanación';
        }
      } else step.classList.add("is-pending");
    });
  } else {
    context.hidden = true;
    subtitle.textContent = "Desde la solicitud del pliego hasta la enumeración y notificación.";
    note.textContent = "Vista general del proceso. Para ubicar una inversión específica, selecciona su estado o etapa en la tabla de convenios en trámite.";
    steps.forEach(step => step.classList.add("is-neutral"));
  }

  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("flow-modal-open");
  setTimeout(() => document.getElementById("closeFlowModal")?.focus(), 40);
}

function closeFlowModal() {
  const modal = document.getElementById("flowModal");
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("flow-modal-open");
}

function bindFlowModal() {
  const modal = document.getElementById("flowModal");
  if (!modal) return;

  document.getElementById("openFlowDetail")?.addEventListener("click", () => openFlowModal());
  modal.querySelectorAll("[data-close-flow-modal]").forEach(node => {
    node.addEventListener("click", closeFlowModal);
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && modal.classList.contains("is-open")) {
      closeFlowModal();
    }
  });
}

function openPdfModal(pdf, row) {
  const modal = document.getElementById("pdfModal");
  const frame = document.getElementById("pdfModalFrame");
  const title = document.getElementById("pdfModalTitle");
  const meta = document.getElementById("pdfModalMeta");
  const download = document.getElementById("pdfModalDownload");
  const external = document.getElementById("pdfModalExternal");

  if (!modal || !frame || !title || !download || !external) return;

  title.textContent = "Convenio suscrito";
  if (meta) {
    meta.textContent = `CUI ${row.cui} · ${pdf.name || "Convenio.pdf"}`;
  }

  frame.src = pdf.previewUrl || pdf.viewUrl;

  download.href = pdf.downloadUrl;
  download.download = pdf.name || `Convenio_${row.cui}.pdf`;
  download.target = "_blank";
  download.rel = "noopener";

  external.href = pdf.viewUrl;

  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("pdf-modal-open");

  requestAnimationFrame(() => {
    document.getElementById("closePdfModal")?.focus();
  });
}

function closePdfModal() {
  const modal = document.getElementById("pdfModal");
  const frame = document.getElementById("pdfModalFrame");

  if (!modal) return;

  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("pdf-modal-open");

  if (frame) frame.src = "about:blank";
}

function bindPdfModal() {
  const modal = document.getElementById("pdfModal");
  if (!modal) return;

  modal.querySelectorAll("[data-close-pdf-modal]").forEach(node => {
    node.addEventListener("click", closePdfModal);
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && modal.classList.contains("is-open")) {
      closePdfModal();
    }
  });
}

function renderStatusButtons() {
  document
    .querySelectorAll("[data-status-filter]")
    .forEach(button => {
      button.classList.toggle(
        "is-active",
        button.dataset.statusFilter === CURRENT_STATUS
      );
    });
}

function exportCsv() {
  const rows = filteredTableRows(CURRENT_ROWS);

  const columns = [
    ["CUI", row => row.cui],
    ["Pliego", row => row.pliego],
    ["Departamento", row => row.region],
    ["Provincia", row => row.provincia],
    ["Distrito", row => row.distrito],
    ["Estado", row => statusLabel(row)],
    ["Etapa", row => stageInfo(row).label],
    ["Avance referencial", row => `${stageInfo(row).progress}%`],
    ["Numero convenio", row => row.numero_convenio || ""]
  ];

  const csvRows = [
    columns.map(([label]) => label)
  ];

  rows.forEach(row => {
    csvRows.push(
      columns.map(([, getter]) => getter(row))
    );
  });

  const csv = csvRows
    .map(values =>
      values
        .map(value =>
          `"${String(value ?? "").replaceAll('"', '""')}"`
        )
        .join(";")
    )
    .join("\n");

  const blob = new Blob(
    ["\ufeff", csv],
    { type: "text/csv;charset=utf-8;" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download =
    `convenios_${CURRENT_STATE.territorio}_${new Date().toISOString().slice(0, 10)}.csv`;

  document.body.appendChild(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
}

function renderAll(state, baseRows) {
  CURRENT_STATE = state;

  const geoRows = geographicRows(baseRows, state);
  CURRENT_ROWS = geoRows;

  const model = modelFor(geoRows);

  renderHeader(state);
  renderDistribution(model);
  renderStageSummary(model);
  renderStatusButtons();
  renderTable(geoRows);
  updateNavigation(state);

  document.body.classList.remove("is-loading");
}

function bindFilters(data, initialState) {
  const territorioSelect =
    document.getElementById("territorioSelect");

  const departamentoSelect =
    document.getElementById("departamentoSelect");

  const provinciaSelect =
    document.getElementById("provinciaSelect");

  const distritoSelect =
    document.getElementById("distritoSelect");

  const resetButton =
    document.getElementById("resetFilters");

  let state = { ...initialState };
  let baseRows =
    territoryRows(data, state.territorio);

  function apply(nextState) {
    state = { ...nextState };
    baseRows =
      territoryRows(data, state.territorio);

    CURRENT_PAGE = 1;

    persistState(state);
    updateUrl(state);

    territorioSelect.value =
      state.territorio;

    refreshFilterOptions(
      baseRows,
      state
    );

    renderAll(
      state,
      baseRows
    );
  }

  territorioSelect.addEventListener(
    "change",
    () => apply({
      territorio: territorioSelect.value,
      departamento: "",
      provincia: "",
      distrito: ""
    })
  );

  departamentoSelect.addEventListener(
    "change",
    () => apply({
      ...state,
      departamento: departamentoSelect.value,
      provincia: "",
      distrito: ""
    })
  );

  provinciaSelect.addEventListener(
    "change",
    () => apply({
      ...state,
      provincia: provinciaSelect.value,
      distrito: ""
    })
  );

  distritoSelect.addEventListener(
    "change",
    () => apply({
      ...state,
      distrito: distritoSelect.value
    })
  );

  resetButton.addEventListener(
    "click",
    () => apply({
      territorio: state.territorio,
      departamento: "",
      provincia: "",
      distrito: ""
    })
  );

  document
    .querySelectorAll("[data-status-filter]")
    .forEach(button => {
      button.addEventListener("click", () => {
        CURRENT_STATUS =
          button.dataset.statusFilter;

        CURRENT_PAGE = 1;

        renderStatusButtons();
        renderTable(CURRENT_ROWS);
      });
    });

  document
    .getElementById("searchInput")
    .addEventListener("input", event => {
      CURRENT_SEARCH =
        event.target.value.trim();

      CURRENT_PAGE = 1;
      renderTable(CURRENT_ROWS);
    });

  document
    .getElementById("prevPage")
    .addEventListener("click", () => {
      if (CURRENT_PAGE <= 1) return;

      CURRENT_PAGE -= 1;
      renderTable(CURRENT_ROWS);
    });

  document
    .getElementById("nextPage")
    .addEventListener("click", () => {
      CURRENT_PAGE += 1;
      renderTable(CURRENT_ROWS);
    });

  document
    .getElementById("exportCsv")
    .addEventListener("click", exportCsv);

  apply(state);
}

async function initConvenios() {
  const response = await fetch(
    "data/puentes.json",
    { cache: "no-store" }
  );

  if (!response.ok) {
    throw new Error(
      "No se pudo cargar data/puentes.json"
    );
  }

  APP_DATA = await response.json();

  if (!Array.isArray(APP_DATA)) {
    throw new Error(
      "data/puentes.json no contiene una matriz válida."
    );
  }

  bindFilters(
    APP_DATA,
    currentState()
  );
}

window.addEventListener(
  "DOMContentLoaded",
  () => {
    bindPdfModal();
    bindFlowModal();

    initConvenios().catch(error => {
      console.error("[Convenios]", error);
      document.body.classList.remove("is-loading");
    });
  }
);
