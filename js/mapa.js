/* =========================================================
   MAPA VRAEM - IMPLEMENTACION ESTABLE V29
   ---------------------------------------------------------
   Esta versión reemplaza la acumulación de funciones y overrides
   de versiones anteriores. Leaflet es la única fuente de verdad
   para navegación, zoom, polígonos y puntos.
   ========================================================= */

const TERRITORY_CONFIG = {
  VRAEM: { label: 'VRAEM', field: 'es_vraem', color: '#991735' },
  NORVRAEM: { label: 'NORVRAEM', field: 'es_norvraem', color: '#153f5b' },
  AMUVRAEM: { label: 'AMUVRAE', field: 'es_amuvraem', color: '#0c8a60' }
};

const SHARED_FILTER_STORAGE_KEY = 'dashboard_filter_state';
const MAP_UI_STORAGE_KEY = 'vraem_map_ui_stable_v28';
const PHOTO_MANIFEST_URL = 'data/fotos-manifest.json';
const TOPOLOGY_SOURCE_URL = 'https://raw.githubusercontent.com/Rodasluis/Peru-maps/main/salida/distrito_simplificado.geojson';
const DEPARTMENT_COLORS = ['#b11d3b', '#2b8aad', '#25916d', '#f0a035', '#7351be', '#4f7f4c', '#c96c35'];

const app = {
  map: null,
  baseLayer: null,
  polygonLayer: null,
  pointLayer: null,
  territory: 'VRAEM',
  mapMode: 'detailed',
  data: [],
  territoryRows: [],
  filteredRows: [],
  localDistrictGeo: null,
  localProvinceGeo: null,
  featureByCode: new Map(),
  rowByDistrictCode: new Map(),
  districtStats: new Map(),
  markerByCui: new Map(),
  polygonLayers: [],
  selectedCui: null,
  hoverLayers: [],
  hoverClearTimer: null,
  photoManifest: { rootFolder: '', apiUrl: '', items: {} },
  photoIndex: 0,
  photoRequests: new Map(),
  weather: null,
  viewToken: 0,
  cuiHoverActive: false,
  initialized: false,
  moving: false,
  focusToken: 0,
  focusTimer: null,
  focusMoveEnd: null
};

/* =========================================================
   UTILIDADES
   ========================================================= */

function cleanText(value) {
  return String(value ?? '').trim();
}

function normalizeText(value) {
  return cleanText(value).toUpperCase();
}

function normalizeKey(value) {
  return normalizeText(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeCode(value, digits = 6) {
  const text = cleanText(value);
  return text ? text.padStart(digits, '0') : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toTitleCase(value) {
  return cleanText(value)
    .toLocaleLowerCase('es-PE')
    .replace(/(^|[\s/\-()])([a-záéíóúüñ])/g, (_, a, b) => a + b.toLocaleUpperCase('es-PE'));
}

function numberValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatNumber(value, decimals = 0) {
  const n = numberValue(value);
  if (n === null) return 'Sin dato';
  return n.toLocaleString('es-PE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function formatMoney(value) {
  const n = numberValue(value);
  if (n === null) return 'Sin dato';
  return `S/ ${n.toLocaleString('es-PE', { maximumFractionDigits: 0 })}`;
}

function formatMoneyCompact(value) {
  const n = numberValue(value);
  if (n === null) return 'Sin dato';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    return `S/ ${(n / 1_000_000).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} M`;
  }
  if (abs >= 1_000) {
    return `S/ ${(n / 1_000).toLocaleString('es-PE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} mil`;
  }
  return formatMoney(n);
}

function uniqueSorted(rows, field) {
  return [...new Set(rows.map(row => cleanText(row[field])).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
}

function sumBridges(rows) {
  return rows.reduce((sum, row) => sum + (numberValue(row.n_puentes) || 0), 0);
}

function uniqueCount(rows, field) {
  return new Set(rows.map(row => cleanText(row[field])).filter(Boolean)).size;
}

function sumDeficit(rows) {
  return rows.reduce((sum, row) => sum + (numberValue(row.deficit) || 0), 0);
}

function rowHasCoordinates(row) {
  return numberValue(row.latitud) !== null && numberValue(row['LONGITUD.1']) !== null;
}

function rowLatLng(row) {
  return L.latLng(Number(row.latitud), Number(row['LONGITUD.1']));
}

function normalizeTerritoryKey(value) {
  const key = normalizeText(value);
  if (key === 'AMUVRAE') return 'AMUVRAEM';
  return TERRITORY_CONFIG[key] ? key : '';
}

function territoryLabel(key = app.territory) {
  const normalized = normalizeTerritoryKey(key) || key;
  return TERRITORY_CONFIG[normalized]?.label || normalized;
}

function territoryRows(data, territory = app.territory) {
  const config = TERRITORY_CONFIG[territory];
  return data.filter(row => normalizeText(row[config.field]) === 'SI');
}

function needsResources(row) {
  return Boolean(row.requiere_recursos) || (numberValue(row.deficit) || 0) > 0;
}

function packageStatus(row) {
  const raw = normalizeKey(row.paquete);
  if (raw === 'GRUPO 01' || raw === 'GRUPO 1' || raw === 'PAQUETE 1' || raw === 'PAQUETE 01') {
    return 'Paquete 1';
  }
  if (needsResources(row)) return 'Pendiente de gestión';
  return 'Sin déficit';
}

function shortInvestmentName(row) {
  const source = cleanText(row.denominacion_inversion);
  if (!source) return `Inversión CUI ${row.cui}`;
  const bridgeMatch = source.match(/PUENTE\s+([^,;]+?)(?:\s+EN\s+LA|\s+EN\s+EL|\s+DEL\s+|,|;|$)/i);
  if (bridgeMatch?.[1]) return `Puente ${toTitleCase(bridgeMatch[1].trim())}`;
  const text = source
    .replace(/^RENOVACI[ÓO]N DE PUENTE;?\s*/i, '')
    .replace(/^EN EL\(LA\)\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const reduced = text.split(/\s+EN\s+LA\s+|\s+EN\s+EL\s+|,|;/i)[0] || text;
  return reduced.length > 86 ? `${toTitleCase(reduced.slice(0, 83))}...` : toTitleCase(reduced);
}

function featureDistrictCode(feature) {
  const p = feature?.properties || {};
  return normalizeCode(p.ubigeo_distrito ?? p.UBIGEO_DISTRITO ?? p.ubigeo ?? p.UBIGEO, 6);
}

function geometryCoordinates(geometry) {
  const output = [];
  if (!geometry) return output;
  const walk = node => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      output.push([node[0], node[1]]);
      return;
    }
    node.forEach(walk);
  };
  walk(geometry.coordinates);
  return output;
}

/* =========================================================
   ESTADO COMPARTIDO ENTRE VISTAS
   ========================================================= */

function readSharedState() {
  try {
    return JSON.parse(localStorage.getItem(SHARED_FILTER_STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function selectedTerritory() {
  const params = new URLSearchParams(window.location.search);
  const query = normalizeTerritoryKey(params.get('territorio'));
  if (query) return query;

  const shared = normalizeTerritoryKey(readSharedState().territorio);
  if (shared) return shared;

  const fallback = normalizeTerritoryKey(localStorage.getItem('territorio_dashboard'));
  return fallback || 'VRAEM';
}

function initialHierarchy() {
  const params = new URLSearchParams(window.location.search);
  const shared = readSharedState();
  const sameTerritory = normalizeTerritoryKey(shared.territorio) === app.territory;
  return {
    departamento: params.get('departamento') || (sameTerritory ? cleanText(shared.departamento) : ''),
    provincia: params.get('provincia') || (sameTerritory ? cleanText(shared.provincia) : ''),
    distrito: params.get('distrito') || (sameTerritory ? cleanText(shared.distrito) : '')
  };
}

function readMapUiState() {
  try {
    return JSON.parse(localStorage.getItem(MAP_UI_STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function currentFilters() {
  return {
    territorio: app.territory,
    departamento: document.getElementById('departamentoSelect')?.value || '',
    provincia: document.getElementById('provinciaSelect')?.value || '',
    distrito: document.getElementById('distritoSelect')?.value || ''
  };
}

function persistSharedState() {
  const filters = currentFilters();
  localStorage.setItem('territorio_dashboard', app.territory);
  localStorage.setItem(SHARED_FILTER_STORAGE_KEY, JSON.stringify(filters));
  localStorage.setItem(MAP_UI_STORAGE_KEY, JSON.stringify({
    mapMode: app.mapMode,
    color: document.getElementById('colorSelect')?.value || 'departamento'
  }));
}

function updateUrl() {
  const filters = currentFilters();
  const url = new URL(window.location.href);
  url.searchParams.set('territorio', app.territory);
  ['departamento', 'provincia', 'distrito'].forEach(key => {
    if (filters[key]) url.searchParams.set(key, filters[key]);
    else url.searchParams.delete(key);
  });
  const color = document.getElementById('colorSelect')?.value || 'departamento';
  if (color !== 'departamento') url.searchParams.set('color', color);
  else url.searchParams.delete('color');
  if (app.selectedCui) url.searchParams.set('cui', app.selectedCui);
  else url.searchParams.delete('cui');
  history.replaceState(null, '', `${url.pathname.split('/').pop()}${url.search}`);
}

function preserveLinks() {
  const filters = currentFilters();
  document.querySelectorAll('[data-preserve-territory]').forEach(link => {
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    const url = new URL(href, document.baseURI);
    url.searchParams.set('territorio', app.territory);
    if (filters.departamento) url.searchParams.set('departamento', filters.departamento);
    else url.searchParams.delete('departamento');
    if (filters.provincia) url.searchParams.set('provincia', filters.provincia);
    else url.searchParams.delete('provincia');
    if (filters.distrito) url.searchParams.set('distrito', filters.distrito);
    else url.searchParams.delete('distrito');
    link.setAttribute('href', `${url.pathname.split('/').pop()}?${url.searchParams.toString()}`);
  });

  const back = document.querySelector('.map-back-btn');
  if (back) {
    const url = new URL('territorio.html', document.baseURI);
    url.searchParams.set('territorio', app.territory);
    back.setAttribute('href', `${url.pathname.split('/').pop()}?${url.searchParams.toString()}`);
  }
}

/* =========================================================
   INDICES Y GEOMETRIA
   ========================================================= */

function rebuildIndexes() {
  app.rowByDistrictCode = new Map();
  app.districtStats = new Map();

  app.territoryRows.forEach(row => {
    const code = normalizeCode(row.ubigeo_distrito, 6);
    if (!code) return;
    if (!app.rowByDistrictCode.has(code)) app.rowByDistrictCode.set(code, row);
    if (!app.districtStats.has(code)) {
      app.districtStats.set(code, {
        code,
        departamento: row.region || '',
        provincia: row.provincia || '',
        distrito: row.distrito || '',
        bridges: 0,
        deficit: 0,
        cuis: new Set()
      });
    }
    const stat = app.districtStats.get(code);
    stat.bridges += numberValue(row.n_puentes) || 0;
    stat.deficit += numberValue(row.deficit) || 0;
    if (cleanText(row.cui)) stat.cuis.add(String(row.cui));
  });
  app.districtStats.forEach(stat => { stat.investments = stat.cuis.size; });
}

function rebuildFeatureIndex() {
  app.featureByCode = new Map();
  (app.localDistrictGeo?.features || []).forEach(feature => {
    const code = featureDistrictCode(feature);
    if (code) app.featureByCode.set(code, feature);
  });
}

function territoryFeatures() {
  const codes = new Set(app.territoryRows.map(row => normalizeCode(row.ubigeo_distrito, 6)).filter(Boolean));
  return [...codes].map(code => app.featureByCode.get(code)).filter(Boolean);
}

function filteredRows() {
  const filters = currentFilters();
  return app.territoryRows.filter(row => {
    if (filters.departamento && normalizeText(row.region) !== normalizeText(filters.departamento)) return false;
    if (filters.provincia && normalizeText(row.provincia) !== normalizeText(filters.provincia)) return false;
    if (filters.distrito && normalizeText(row.distrito) !== normalizeText(filters.distrito)) return false;
    return true;
  });
}

function filteredFeatureCodes() {
  return new Set(app.filteredRows.map(row => normalizeCode(row.ubigeo_distrito, 6)).filter(Boolean));
}

function rowForFeature(feature) {
  return app.rowByDistrictCode.get(featureDistrictCode(feature)) || null;
}

/* =========================================================
   FILTROS
   ========================================================= */

function populateSelect(select, items, placeholder, selected = '') {
  if (!select) return;
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` + items
    .map(item => `<option value="${escapeHtml(item)}">${escapeHtml(toTitleCase(item))}</option>`)
    .join('');
  select.value = items.includes(selected) ? selected : '';
}

function syncFilterOptions({ restore = false } = {}) {
  const dept = document.getElementById('departamentoSelect');
  const prov = document.getElementById('provinciaSelect');
  const dist = document.getElementById('distritoSelect');
  const initial = restore ? initialHierarchy() : {
    departamento: dept?.value || '',
    provincia: prov?.value || '',
    distrito: dist?.value || ''
  };

  const departments = uniqueSorted(app.territoryRows, 'region');
  populateSelect(dept, departments, 'Todos', initial.departamento);
  const deptRows = app.territoryRows.filter(row => !dept.value || normalizeText(row.region) === normalizeText(dept.value));
  populateSelect(prov, uniqueSorted(deptRows, 'provincia'), 'Todas', initial.provincia);
  const provRows = deptRows.filter(row => !prov.value || normalizeText(row.provincia) === normalizeText(prov.value));
  populateSelect(dist, uniqueSorted(provRows, 'distrito'), 'Todos', initial.distrito);
  document.getElementById('provinciaField').hidden = !dept.value;
  document.getElementById('distritoField').hidden = !(dept.value && prov.value);
}

function setHierarchyFromRow(row) {
  const dept = document.getElementById('departamentoSelect');
  const prov = document.getElementById('provinciaSelect');
  const dist = document.getElementById('distritoSelect');
  dept.value = cleanText(row.region);
  const deptRows = app.territoryRows.filter(item => normalizeText(item.region) === normalizeText(dept.value));
  populateSelect(prov, uniqueSorted(deptRows, 'provincia'), 'Todas', cleanText(row.provincia));
  const provRows = deptRows.filter(item => normalizeText(item.provincia) === normalizeText(prov.value));
  populateSelect(dist, uniqueSorted(provRows, 'distrito'), 'Todos', cleanText(row.distrito));
  document.getElementById('provinciaField').hidden = false;
  document.getElementById('distritoField').hidden = false;
}

function resetInvestmentSelection({ clearSearch = false, updateUrlNow = true } = {}) {
  app.focusToken += 1;
  clearFocusTransition();
  app.selectedCui = null;
  app.cuiHoverActive = false;
  const empty = document.getElementById('investmentEmpty');
  const content = document.getElementById('investmentContent');
  if (empty) empty.hidden = false;
  if (content) content.hidden = true;
  if (clearSearch) {
    const input = document.getElementById('cuiSearchInput');
    if (input) input.value = '';
    const suggestions = document.getElementById('cuiSuggestions');
    if (suggestions) suggestions.hidden = true;
  }
  refreshSelectedMarker();
  if (updateUrlNow) updateUrl();
}

function switchTerritory(nextTerritory, { fit = true } = {}) {
  const key = normalizeTerritoryKey(nextTerritory);
  if (!key) return;
  cancelMapTransition();
  resetInvestmentSelection({ clearSearch: true, updateUrlNow: false });
  app.territory = key;
  app.territoryRows = territoryRows(app.data, app.territory);
  rebuildIndexes();
  document.getElementById('territorioSelect').value = app.territory;
  document.getElementById('departamentoSelect').value = '';
  document.getElementById('provinciaSelect').value = '';
  document.getElementById('distritoSelect').value = '';
  syncFilterOptions();
  applyTerritoryTheme();
  app.filteredRows = filteredRows();
  renderPolygons();
  buildTerritoryMarkers();
  updateVisibleMarkers();
  updateHeaderAndStats();
  renderLegend();
  updatePeruLocator();
  app.weather?.setBounds(weatherBoundsForTerritory());
  persistSharedState();
  preserveLinks();
  updateUrl();
  if (fit) requestAnimationFrame(() => fitCurrentView({ animate: true, includeSelected: false }));
}

function applyFilters({ fit = true, animate = true, resetSelection = false } = {}) {
  if (fit) cancelMapTransition();
  if (resetSelection) resetInvestmentSelection({ clearSearch: true, updateUrlNow: false });
  app.filteredRows = filteredRows();
  if (app.selectedCui && !app.filteredRows.some(row => String(row.cui) === String(app.selectedCui))) {
    resetInvestmentSelection({ clearSearch: true, updateUrlNow: false });
  }

  updateHeaderAndStats();
  renderLegend();
  updatePolygonStyles();
  updateVisibleMarkers();
  updatePeruLocator();
  persistSharedState();
  preserveLinks();
  updateUrl();

  if (fit) requestAnimationFrame(() => fitCurrentView({ animate, includeSelected: false }));
}

/* =========================================================
   MAPA BASE
   ========================================================= */

function baseMapConfig(mode) {
  const configs = {
    detailed: {
      label: 'OpenStreetMap',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: {
        maxNativeZoom: 19,
        maxZoom: 21,
        attribution: '&copy; OpenStreetMap contributors'
      }
    },
    cartographic: {
      label: 'CARTO Voyager',
      url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      options: {
        subdomains: 'abcd',
        maxNativeZoom: 20,
        maxZoom: 21,
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
      }
    },
    satellite: {
      label: 'Esri World Imagery',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      options: {
        maxNativeZoom: 17,
        maxZoom: 21,
        attribution: 'Imagery &copy; Esri'
      }
    }
  };
  return configs[mode] || configs.detailed;
}

function setBaseMap(mode) {
  if (!app.map) return;
  app.mapMode = ['detailed', 'cartographic', 'satellite'].includes(mode) ? mode : 'detailed';
  document.querySelectorAll('[data-mode]').forEach(button => {
    button.classList.toggle('is-active', button.dataset.mode === app.mapMode);
  });

  if (app.baseLayer) {
    try { app.map.removeLayer(app.baseLayer); } catch {}
    app.baseLayer = null;
  }

  const config = baseMapConfig(app.mapMode);
  app.baseLayer = L.tileLayer(config.url, {
    ...config.options,
    updateWhenIdle: false,
    updateWhenZooming: true,
    keepBuffer: 5,
    detectRetina: false,
    crossOrigin: true,
    noWrap: false
  }).addTo(app.map);
  app.baseLayer.bringToBack();

  const credit = document.getElementById('mapBasemapCredit');
  if (credit) credit.textContent = `Mapa base: ${config.label}`;
  persistSharedState();
}

function initialCenter() {
  const rows = app.territoryRows.filter(rowHasCoordinates);
  if (!rows.length) return [-12.2, -74.2];
  return [
    rows.reduce((sum, row) => sum + Number(row.latitud), 0) / rows.length,
    rows.reduce((sum, row) => sum + Number(row['LONGITUD.1']), 0) / rows.length
  ];
}

function closeAllMapTooltips() {
  const groups = [app.polygonLayer, app.pointLayer];
  groups.forEach(group => {
    if (!group || typeof group.eachLayer !== 'function') return;
    group.eachLayer(layer => {
      if (layer && typeof layer.closeTooltip === 'function') {
        try { layer.closeTooltip(); } catch {}
      }
    });
  });
}

function cancelMapTransition() {
  stopMapMotion();
}

function initLeaflet() {
  if (app.map) return app.map;
  const center = initialCenter();
  app.map = L.map('leafletMap', {
    center,
    zoom: 8,
    zoomControl: false,
    attributionControl: true,
    preferCanvas: false,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 80,
    wheelDebounceTime: 28,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    boxZoom: true,
    keyboard: true,
    dragging: true,
    touchZoom: true,
    inertia: true,
    inertiaDeceleration: 3200,
    inertiaMaxSpeed: 1200,
    easeLinearity: 0.22,
    fadeAnimation: true,
    zoomAnimation: true,
    markerZoomAnimation: true
  });

  if (!app.map.getPane('weatherPane')) app.map.createPane('weatherPane');
  const weatherPane = app.map.getPane('weatherPane');
  weatherPane.style.zIndex = '350';
  weatherPane.style.pointerEvents = 'none';

  L.control.zoom({ position: 'bottomright' }).addTo(app.map);
  L.control.scale({ position: 'bottomleft', metric: true, imperial: false, maxWidth: 120 }).addTo(app.map);

  app.map.on('movestart', () => {
    app.moving = true;
    hideAreaHover();
    closeAllMapTooltips();
  });
  app.map.on('zoomstart', () => {
    app.moving = true;
    hideAreaHover();
    closeAllMapTooltips();
  });
  app.map.on('moveend', () => {
    app.moving = false;
  });
  app.map.on('zoomend', () => {
    app.moving = false;
    app.weather?.syncZoomOpacity();
  });
  setBaseMap(app.mapMode);
  requestAnimationFrame(() => app.map.invalidateSize(false));
  return app.map;
}

/* =========================================================
   POLIGONOS Y HOVER TERRITORIAL
   ========================================================= */

function polygonBaseStyle(feature) {
  const row = rowForFeature(feature);
  const filters = currentFilters();
  const selectedCodes = filteredFeatureCodes();
  const isSelected = selectedCodes.has(featureDistrictCode(feature));
  const hasFilter = Boolean(filters.departamento || filters.provincia || filters.distrito);
  const color = TERRITORY_CONFIG[app.territory].color;
  return {
    color: isSelected ? color : '#8b9aa7',
    weight: isSelected ? (filters.distrito ? 1.55 : 1.05) : 0.55,
    opacity: isSelected ? 0.82 : 0.30,
    fillColor: color,
    fillOpacity: hasFilter ? (isSelected ? 0.065 : 0.008) : 0.030,
    interactive: Boolean(row),
    bubblingMouseEvents: true
  };
}

function currentHoverLevel() {
  const filters = currentFilters();
  if (!filters.departamento) return 'departamento';
  if (!filters.provincia) return 'provincia';
  return 'distrito';
}

function areaKeyFromRow(row, level) {
  if (!row) return '';
  if (level === 'departamento') return normalizeKey(row.region);
  if (level === 'provincia') return `${normalizeKey(row.region)}|${normalizeKey(row.provincia)}`;
  return normalizeCode(row.ubigeo_distrito, 6);
}

function areaLabelFromRow(row, level) {
  if (level === 'departamento') return toTitleCase(row.region);
  if (level === 'provincia') return toTitleCase(row.provincia);
  return toTitleCase(row.distrito);
}

function statForArea(row, level) {
  const key = areaKeyFromRow(row, level);
  const rows = app.territoryRows.filter(item => areaKeyFromRow(item, level) === key);
  return {
    investments: new Set(rows.map(item => cleanText(item.cui)).filter(Boolean)).size,
    bridges: sumBridges(rows),
    deficit: sumDeficit(rows)
  };
}

function clearAreaHighlight() {
  if (app.hoverClearTimer) {
    clearTimeout(app.hoverClearTimer);
    app.hoverClearTimer = null;
  }
  app.hoverLayers.forEach(({ layer, feature }) => {
    if (layer && app.map?.hasLayer(layer)) layer.setStyle(polygonBaseStyle(feature));
  });
  app.hoverLayers = [];
}

function highlightArea(row) {
  if (app.cuiHoverActive || !row) return;
  clearAreaHighlight();
  const level = currentHoverLevel();
  const key = areaKeyFromRow(row, level);
  const color = TERRITORY_CONFIG[app.territory].color;
  app.polygonLayers.forEach(item => {
    const candidate = rowForFeature(item.feature);
    if (!candidate || areaKeyFromRow(candidate, level) !== key) return;
    item.layer.setStyle({
      ...polygonBaseStyle(item.feature),
      color,
      weight: 2.2,
      opacity: 1,
      fillOpacity: 0.15
    });
    app.hoverLayers.push(item);
  });
  showAreaHover(row, level);
}

function showAreaHover(row, level) {
  const root = document.getElementById('mapAreaHover');
  if (!root || !row || app.cuiHoverActive) return;
  const stat = statForArea(row, level);
  document.getElementById('mapAreaHoverLevel').textContent = level === 'departamento' ? 'Departamento' : level === 'provincia' ? 'Provincia' : 'Distrito';
  document.getElementById('mapAreaHoverName').textContent = areaLabelFromRow(row, level);
  document.getElementById('mapAreaHoverPath').textContent = `${toTitleCase(row.region)} · ${toTitleCase(row.provincia)} · ${toTitleCase(row.distrito)} · ${stat.investments} IOARR · ${stat.bridges} puentes · ${formatMoney(stat.deficit)} déficit`;
  root.hidden = false;
}

function hideAreaHover({ delayed = false } = {}) {
  const hide = () => {
    clearAreaHighlight();
    const root = document.getElementById('mapAreaHover');
    if (root) root.hidden = true;
  };
  if (!delayed) return hide();
  app.hoverClearTimer = setTimeout(hide, 55);
}

function drillFromPolygon(row) {
  if (!row || app.cuiHoverActive) return;
  cancelMapTransition();
  resetInvestmentSelection({ clearSearch: true, updateUrlNow: false });
  const level = currentHoverLevel();
  const dept = document.getElementById('departamentoSelect');
  const prov = document.getElementById('provinciaSelect');
  const dist = document.getElementById('distritoSelect');
  if (level === 'departamento') {
    dept.value = cleanText(row.region);
    syncFilterOptions();
  } else if (level === 'provincia') {
    prov.value = cleanText(row.provincia);
    const deptRows = app.territoryRows.filter(item => normalizeText(item.region) === normalizeText(dept.value));
    const provRows = deptRows.filter(item => normalizeText(item.provincia) === normalizeText(prov.value));
    populateSelect(dist, uniqueSorted(provRows, 'distrito'), 'Todos', '');
    document.getElementById('distritoField').hidden = false;
  } else {
    dist.value = cleanText(row.distrito);
  }
  applyFilters({ fit: true, animate: true, resetSelection: false });
}

function renderPolygons() {
  if (!app.map) return;
  clearAreaHighlight();
  if (app.polygonLayer) app.map.removeLayer(app.polygonLayer);
  app.polygonLayers = [];
  const collection = { type: 'FeatureCollection', features: territoryFeatures() };
  app.polygonLayer = L.geoJSON(collection, {
    style: polygonBaseStyle,
    onEachFeature(feature, layer) {
      const row = rowForFeature(feature);
      if (!row) return;
      const item = { feature, layer };
      app.polygonLayers.push(item);
      layer.on('mouseover', () => {
        if (app.cuiHoverActive) return;
        if (app.hoverClearTimer) { clearTimeout(app.hoverClearTimer); app.hoverClearTimer = null; }
        highlightArea(row);
      });
      layer.on('mouseout', () => {
        if (!app.cuiHoverActive) hideAreaHover({ delayed: true });
      });
      layer.on('click', event => {
        if (app.cuiHoverActive) return;
        drillFromPolygon(row);
      });
    }
  }).addTo(app.map);
  updatePolygonStyles();
}

function updatePolygonStyles() {
  if (!app.polygonLayer) return;
  clearAreaHighlight();
  app.polygonLayer.eachLayer(layer => {
    if (layer.feature) layer.setStyle(polygonBaseStyle(layer.feature));
  });
}

/* =========================================================
   PUNTOS CUI
   ========================================================= */

function colorMode() {
  const key = document.getElementById('colorSelect')?.value || 'departamento';
  const departments = uniqueSorted(app.territoryRows, 'region');
  const palette = new Map(departments.map((name, index) => [normalizeText(name), DEPARTMENT_COLORS[index % DEPARTMENT_COLORS.length]]));

  if (key === 'ambito') {
    return {
      label: 'Ámbito de intervención',
      key: row => normalizeText(row.ambito_vraem) || 'NO DEFINIDO',
      items: [
        { key: 'INTERVENCIÓN DIRECTA', label: 'Intervención directa', color: '#159870' },
        { key: 'ZONA DE INFLUENCIA', label: 'Zona de influencia', color: '#ef9f32' },
        { key: 'NO DEFINIDO', label: 'No definido', color: '#64748b' }
      ]
    };
  }
  if (key === 'longitud') {
    return {
      label: 'Longitud del puente',
      key: row => {
        const value = numberValue(row.longitud) || 0;
        if (value <= 10) return 'L1';
        if (value <= 20) return 'L2';
        return 'L3';
      },
      items: [
        { key: 'L1', label: 'Hasta 10 m', color: '#159870' },
        { key: 'L2', label: 'Más de 10 a 20 m', color: '#ef9f32' },
        { key: 'L3', label: 'Más de 20 m', color: '#b42343' }
      ]
    };
  }
  if (key === 'recursos') {
    return {
      label: 'Necesidad de recursos',
      key: row => needsResources(row) ? 'SI' : 'NO',
      items: [
        { key: 'SI', label: 'Requiere recursos', color: '#b42343' },
        { key: 'NO', label: 'Con totalidad de recursos', color: '#159870' }
      ]
    };
  }
  if (key === 'paquete') {
    return {
      label: 'Gestión por paquete',
      key: row => packageStatus(row),
      items: [
        { key: 'Paquete 1', label: 'Paquete 1', color: '#991735' },
        { key: 'Pendiente de gestión', label: 'Pendiente de gestión', color: '#d98b28' },
        { key: 'Sin déficit', label: 'Sin déficit', color: '#0c8a60' }
      ]
    };
  }
  return {
    label: 'Departamento',
    key: row => normalizeText(row.region),
    items: departments.map(name => ({
      key: normalizeText(name),
      label: toTitleCase(name),
      color: palette.get(normalizeText(name)) || '#64748b'
    }))
  };
}

function markerColor(row) {
  const mode = colorMode();
  return mode.items.find(item => item.key === mode.key(row))?.color || '#64748b';
}

function markerSize(row, selected = false) {
  const length = numberValue(row.longitud) || 0;
  const base = length > 20 ? 6.2 : length > 10 ? 5.7 : 5.2;
  return selected ? base + 2.6 : base;
}

function pointTooltip(row) {
  return `
    <div class="map-point-tooltip">
      <strong>CUI ${escapeHtml(row.cui)}</strong>
      <span>${escapeHtml(shortInvestmentName(row))}</span>
      <small>${escapeHtml(`${toTitleCase(row.distrito)}, ${toTitleCase(row.provincia)} · ${toTitleCase(row.region)}`)}</small>
      <div><b>${escapeHtml(formatMoney(row.deficit))}</b><em>Déficit</em></div>
    </div>`;
}

function markerStyle(row, selected = false) {
  return {
    radius: markerSize(row, selected),
    color: '#ffffff',
    weight: selected ? 2.4 : 1.7,
    opacity: 1,
    fillColor: markerColor(row),
    fillOpacity: 0.96,
    className: `map-cui-circle${selected ? ' is-selected' : ''}`,
    interactive: true,
    bubblingMouseEvents: false
  };
}

function applyMarkerVisual(marker, row, selected = false, hovered = false) {
  const style = markerStyle(row, selected);
  marker.setRadius(style.radius + (hovered ? 1.5 : 0));
  marker.setStyle({
    color: style.color,
    weight: hovered ? Math.max(style.weight, 2.2) : style.weight,
    opacity: 1,
    fillColor: style.fillColor,
    fillOpacity: 0.98
  });
  const el = marker.getElement?.();
  if (el) {
    el.classList.toggle('is-selected', selected);
    el.classList.toggle('is-hovered', hovered);
  }
  if (selected || hovered) marker.bringToFront?.();
}

function buildTerritoryMarkers() {
  if (!app.map) return;
  if (app.pointLayer) {
    try { app.map.removeLayer(app.pointLayer); } catch {}
  }
  app.pointLayer = L.layerGroup().addTo(app.map);
  app.markerByCui = new Map();

  app.territoryRows.filter(rowHasCoordinates).forEach(row => {
    const marker = L.circleMarker(rowLatLng(row), markerStyle(row, false));
    marker.bindTooltip(pointTooltip(row), {
      direction: 'top',
      className: 'map-cui-tooltip',
      opacity: 1,
      offset: [0, -8],
      sticky: false
    });

    marker.on('mouseover', () => {
      app.cuiHoverActive = true;
      hideAreaHover();
      prefetchPhotoMetadata(row.cui);
      applyMarkerVisual(marker, row, String(row.cui) === String(app.selectedCui), true);
    });
    marker.on('mouseout', () => {
      applyMarkerVisual(marker, row, String(row.cui) === String(app.selectedCui), false);
      window.setTimeout(() => { app.cuiHoverActive = false; }, 35);
    });
    marker.on('click', event => {
      if (event?.originalEvent) {
        L.DomEvent.stopPropagation(event.originalEvent);
        L.DomEvent.preventDefault(event.originalEvent);
      }
      app.cuiHoverActive = true;
      hideAreaHover();
      selectInvestment(row, { zoom: true });
      window.setTimeout(() => { app.cuiHoverActive = false; }, 100);
    });

    marker.addTo(app.pointLayer);
    app.markerByCui.set(String(row.cui), { marker, row });
  });
}

function updateVisibleMarkers() {
  if (!app.pointLayer) return;
  const visible = new Set(app.filteredRows.filter(rowHasCoordinates).map(row => String(row.cui)));
  app.markerByCui.forEach(({ marker, row }, cui) => {
    const shouldShow = visible.has(cui);
    const isShown = app.pointLayer.hasLayer(marker);
    if (shouldShow && !isShown) marker.addTo(app.pointLayer);
    if (!shouldShow && isShown) app.pointLayer.removeLayer(marker);
    if (shouldShow) applyMarkerVisual(marker, row, cui === String(app.selectedCui), false);
  });
}

function refreshSelectedMarker() {
  app.markerByCui.forEach(({ marker, row }, cui) => {
    applyMarkerVisual(marker, row, cui === String(app.selectedCui), false);
  });
}

/* =========================================================
   ZOOM Y ENCUADRE
   ========================================================= */

function rowsBounds(rows) {
  const bounds = L.latLngBounds();
  rows.filter(rowHasCoordinates).forEach(row => bounds.extend(rowLatLng(row)));
  return bounds.isValid() ? bounds : null;
}

function featureBounds(feature) {
  if (!feature?.geometry) return null;
  const bounds = L.latLngBounds();
  geometryCoordinates(feature.geometry).forEach(([lon, lat]) => bounds.extend([lat, lon]));
  return bounds.isValid() ? bounds : null;
}

function provinceFeatureForFilters(filters) {
  if (!filters.provincia) return null;
  return (app.localProvinceGeo?.features || []).find(feature => {
    const p = feature.properties || {};
    const province = normalizeText(p.provincia ?? p.PROVINCIA);
    const dept = normalizeText(p.departamento ?? p.DEPARTAMENTO);
    return province === normalizeText(filters.provincia) && (!filters.departamento || dept === normalizeText(filters.departamento));
  }) || null;
}

function districtFeatureForRows(rows) {
  const code = normalizeCode(rows[0]?.ubigeo_distrito, 6);
  return code ? app.featureByCode.get(code) || null : null;
}

function polygonBoundsForRows(rows) {
  const bounds = L.latLngBounds();
  const codes = new Set(rows.map(row => normalizeCode(row.ubigeo_distrito, 6)).filter(Boolean));
  codes.forEach(code => {
    const b = featureBounds(app.featureByCode.get(code));
    if (b) bounds.extend(b);
  });
  return bounds.isValid() ? bounds : null;
}

function mergeBounds(...items) {
  const merged = L.latLngBounds();
  items.filter(Boolean).forEach(bounds => {
    if (bounds?.isValid?.()) merged.extend(bounds);
  });
  return merged.isValid() ? merged : null;
}

function targetBoundsForCurrentView() {
  const filters = currentFilters();
  if (filters.distrito) {
    return mergeBounds(
      featureBounds(districtFeatureForRows(app.filteredRows)),
      rowsBounds(app.filteredRows)
    );
  }
  if (filters.provincia) {
    return mergeBounds(
      featureBounds(provinceFeatureForFilters(filters)),
      polygonBoundsForRows(app.filteredRows),
      rowsBounds(app.filteredRows)
    );
  }
  return mergeBounds(
    polygonBoundsForRows(app.filteredRows),
    rowsBounds(app.filteredRows)
  ) || mergeBounds(
    polygonBoundsForRows(app.territoryRows),
    rowsBounds(app.territoryRows)
  );
}

function clearFocusTransition() {
  if (!app.map) return;
  if (app.focusTimer) {
    window.clearTimeout(app.focusTimer);
    app.focusTimer = null;
  }
  if (app.focusMoveEnd) {
    try { app.map.off('moveend', app.focusMoveEnd); } catch {}
    app.focusMoveEnd = null;
  }
  app.map.getContainer()?.classList.remove('is-focus-transition');
}

function stopMapMotion() {
  if (!app.map) return;
  app.viewToken += 1;
  app.focusToken += 1;
  clearFocusTransition();
  try { app.map.stop(); } catch {}
  app.moving = false;
  closeAllMapTooltips();
  hideAreaHover();
}

function flyBounds(bounds, { animate = true, maxZoom = 15, duration = 0.72, padding = [54, 54] } = {}) {
  if (!app.map || !bounds?.isValid?.()) return;
  stopMapMotion();
  const options = {
    paddingTopLeft: padding,
    paddingBottomRight: padding,
    maxZoom
  };
  if (!animate || !app.initialized) {
    app.map.fitBounds(bounds, options);
    return;
  }
  app.map.flyToBounds(bounds, {
    ...options,
    duration,
    easeLinearity: 0.25,
    noMoveStart: false
  });
}

function fitCurrentView({ animate = true, includeSelected = false } = {}) {
  if (!app.map) return;
  if (includeSelected && app.selectedCui) {
    const row = app.filteredRows.find(item => String(item.cui) === String(app.selectedCui));
    if (row && rowHasCoordinates(row)) return zoomToInvestment(row, { animate });
  }

  const bounds = targetBoundsForCurrentView();
  if (!bounds) return;
  const filters = currentFilters();
  const maxZoom = filters.distrito ? 13.6 : filters.provincia ? 11.4 : filters.departamento ? 9.6 : 8.6;
  const duration = filters.distrito ? 0.72 : filters.provincia ? 0.68 : 0.62;
  flyBounds(bounds, { animate, maxZoom, duration, padding: [52, 52] });
}

function zoomForScaleMeters(latitude, meters = 300) {
  const lat = Number(latitude) || 0;
  const cosLat = Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const mapWidth = app.map?.getSize?.().x || 720;
  // Los 300 m deben ocupar prácticamente todo el ancho útil del mapa.
  // Antes se calculaban sobre 118 px, por eso el acercamiento quedaba a varios km.
  const referencePixels = Math.max(420, mapWidth - 72);
  const metersPerPixel = Math.max(0.08, meters / referencePixels);
  const zoom = Math.log2((156543.03392 * cosLat) / metersPerPixel);
  return Math.max(17.75, Math.min(19.35, zoom));
}

function zoomToInvestment(row, { animate = true } = {}) {
  if (!app.map || !rowHasCoordinates(row)) return;

  stopMapMotion();
  const map = app.map;
  const latlng = rowLatLng(row);
  const targetZoom = zoomForScaleMeters(latlng.lat, 300);
  const token = ++app.focusToken;

  try { map.invalidateSize(false); } catch {}

  const reachedTarget = () => {
    const center = map.getCenter();
    const distance = center?.distanceTo ? center.distanceTo(latlng) : Infinity;
    return distance <= 45 && Math.abs(map.getZoom() - targetZoom) <= 0.45;
  };

  const finish = ({ force = false } = {}) => {
    if (token !== app.focusToken || String(app.selectedCui) !== String(row.cui)) return;
    if (app.focusMoveEnd) {
      try { map.off('moveend', app.focusMoveEnd); } catch {}
      app.focusMoveEnd = null;
    }
    if (app.focusTimer) {
      window.clearTimeout(app.focusTimer);
      app.focusTimer = null;
    }
    if ((force || !reachedTarget()) && String(app.selectedCui) === String(row.cui)) {
      try { map.setView(latlng, targetZoom, { animate: false, reset: true }); } catch {}
    }
    map.getContainer()?.classList.remove('is-focus-transition');
    app.weather?.syncZoomOpacity();
  };

  if (!animate || !app.initialized) {
    try { map.setView(latlng, targetZoom, { animate: false, reset: true }); } catch {}
    finish();
    return;
  }

  map.getContainer()?.classList.add('is-focus-transition');
  app.focusMoveEnd = () => finish();
  map.once('moveend', app.focusMoveEnd);

  try {
    map.flyTo(latlng, targetZoom, {
      animate: true,
      duration: 0.92,
      easeLinearity: 0.22,
      noMoveStart: false
    });
  } catch {
    finish({ force: true });
    return;
  }

  // Guardia de estabilidad: si otra condición del navegador interrumpe flyTo,
  // al finalizar el intervalo se garantiza el encuadre del CUI.
  app.focusTimer = window.setTimeout(() => finish({ force: !reachedTarget() }), 1250);
}

function weatherBoundsForTerritory() {
  return mergeBounds(polygonBoundsForRows(app.territoryRows), rowsBounds(app.territoryRows));
}

/* =========================================================
   CABECERA, KPI, LEYENDAS Y BREADCRUMB
   ========================================================= */

function applyTerritoryTheme() {
  const color = TERRITORY_CONFIG[app.territory].color;
  document.body.style.setProperty('--map-territory-color', color);
  document.getElementById('vraem-map-module')?.style.setProperty('--map-territory-color', color);
}

function updateHeaderAndStats() {
  const filters = currentFilters();
  const trail = [{ label: territoryLabel(), level: 'territory' }];
  if (filters.departamento) trail.push({ label: toTitleCase(filters.departamento), level: 'departamento' });
  if (filters.provincia) trail.push({ label: toTitleCase(filters.provincia), level: 'provincia' });
  if (filters.distrito) trail.push({ label: toTitleCase(filters.distrito), level: 'distrito' });
  if (trail.length === 1) trail.push({ label: 'Cobertura general', level: 'all' });

  document.getElementById('drillTrail').innerHTML = trail.map((item, index) => {
    const active = index === trail.length - 1;
    const sep = index ? '<i class="bi bi-chevron-right"></i>' : '';
    if (active) return `${sep}<span class="is-active">${escapeHtml(item.label)}</span>`;
    return `${sep}<button type="button" data-trail-level="${item.level}">${escapeHtml(item.label)}</button>`;
  }).join('');

  document.getElementById('visibleInvestments').textContent = formatNumber(app.filteredRows.length);
  document.getElementById('visibleBridges').textContent = formatNumber(sumBridges(app.filteredRows));
  document.getElementById('visibleDistricts').textContent = formatNumber(uniqueCount(app.filteredRows, 'ubigeo_distrito'));

  const context = filters.distrito
    ? `Distrito de ${toTitleCase(filters.distrito)}`
    : filters.provincia
      ? `Provincia de ${toTitleCase(filters.provincia)}`
      : filters.departamento
        ? `Departamento de ${toTitleCase(filters.departamento)}`
        : `Cartera georreferenciada - ${territoryLabel()}`;

  document.getElementById('mapContextTitle').textContent = context;
  document.getElementById('mapPageTitle').textContent = `Mapa interactivo - ${territoryLabel()}`;
  document.getElementById('territoryLegendSubtitle').textContent = filters.distrito
    ? `${toTitleCase(filters.distrito)} · nivel distrital`
    : filters.provincia
      ? `${toTitleCase(filters.provincia)} · nivel provincial`
      : filters.departamento
        ? `${toTitleCase(filters.departamento)} · nivel departamental`
        : `${territoryLabel()} · cobertura general`;
}

function renderLegend() {
  const mode = colorMode();
  document.getElementById('legendModeLabel').textContent = mode.label;
  const counts = new Map();
  app.filteredRows.forEach(row => counts.set(mode.key(row), (counts.get(mode.key(row)) || 0) + 1));
  document.getElementById('legendItems').innerHTML = mode.items
    .filter(item => counts.has(item.key))
    .map(item => `<div class="map-legend__item"><span><i style="--legend-color:${item.color}"></i>${escapeHtml(item.label)}</span><b>${counts.get(item.key)}</b></div>`)
    .join('') || '<div class="map-legend__empty">Sin puntos visibles</div>';
}

function updatePeruLocator() {
  const rows = app.filteredRows.filter(rowHasCoordinates);
  const point = document.getElementById('peruLocatorPoint');
  const image = document.querySelector('.peru-locator__map img');
  const container = document.querySelector('.peru-locator__map');
  if (!rows.length || !point || !image || !container) {
    if (point) point.hidden = true;
    return;
  }

  const west = -81.390559;
  const east = -68.672457;
  const north = -0.036136;
  const south = -18.388935;
  const lon = rows.reduce((sum, row) => sum + Number(row['LONGITUD.1']), 0) / rows.length;
  const lat = rows.reduce((sum, row) => sum + Number(row.latitud), 0) / rows.length;
  const fx = (lon - west) / (east - west);
  const fy = (north - lat) / (north - south);

  const position = () => {
    const parent = container.getBoundingClientRect();
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    point.hidden = false;
    point.style.left = `${rect.left - parent.left + rect.width * Math.max(0, Math.min(1, fx))}px`;
    point.style.top = `${rect.top - parent.top + rect.height * Math.max(0, Math.min(1, fy))}px`;
  };
  if (image.complete) position();
  else image.addEventListener('load', position, { once: true });
}

function navigateTrail(level) {
  cancelMapTransition();
  const dept = document.getElementById('departamentoSelect');
  const prov = document.getElementById('provinciaSelect');
  const dist = document.getElementById('distritoSelect');
  if (level === 'territory') { dept.value = ''; prov.value = ''; dist.value = ''; }
  else if (level === 'departamento') { prov.value = ''; dist.value = ''; }
  else if (level === 'provincia') dist.value = '';
  syncFilterOptions();
  applyFilters({ fit: true, animate: true, resetSelection: true });
}

/* =========================================================
   DETALLE DE INVERSION
   ========================================================= */

function updateDetailsLink(row) {
  const params = new URLSearchParams();
  const filters = currentFilters();
  params.set('territorio', app.territory);
  params.set('cui', String(row.cui));
  if (filters.departamento) params.set('departamento', filters.departamento);
  if (filters.provincia) params.set('provincia', filters.provincia);
  if (filters.distrito) params.set('distrito', filters.distrito);
  document.getElementById('detailsButton').href = `puentes.html?${params.toString()}`;
}

function selectInvestment(row, { zoom = true } = {}) {
  if (!row) return;
  stopMapMotion();
  app.selectedCui = String(row.cui);
  if (zoom) zoomToInvestment(row, { animate: true });
  document.getElementById('investmentEmpty').hidden = true;
  document.getElementById('investmentContent').hidden = false;
  document.getElementById('selectedCui').textContent = `CUI ${row.cui}`;
  document.getElementById('selectedScope').textContent = `${territoryLabel()} · ${toTitleCase(row.ambito_vraem || 'Ámbito')}`;
  document.getElementById('selectedName').textContent = shortInvestmentName(row);
  document.getElementById('selectedPlace').querySelector('span').textContent = `${toTitleCase(row.distrito)}, ${toTitleCase(row.provincia)} · ${toTitleCase(row.region)}`;
  document.getElementById('selectedCost').textContent = formatMoneyCompact(row.costo_actualizado);
  document.getElementById('selectedPim').textContent = formatMoneyCompact(row.pim);
  document.getElementById('selectedDeficit').textContent = formatMoneyCompact(row.deficit);
  document.getElementById('selectedBridgeCount').textContent = formatNumber(row.n_puentes);
  document.getElementById('selectedLength').textContent = numberValue(row.longitud) !== null ? `${formatNumber(row.longitud)} m` : 'Sin dato';
  document.getElementById('selectedResources').textContent = needsResources(row) ? 'Requiere recursos' : 'Sin déficit financiero';
  document.getElementById('selectedPackage').textContent = packageStatus(row);
  document.getElementById('selectedAgreement').textContent = row.estado_convenio ? toTitleCase(row.estado_convenio) : 'Sin dato';
  document.getElementById('selectedSituation').textContent = row.estado_situacional ? toTitleCase(row.estado_situacional) : 'Sin dato';
  document.getElementById('selectedUtmEast').textContent = formatNumber(row.este_utm, 3);
  document.getElementById('selectedUtmNorth').textContent = formatNumber(row.norte_utm, 3);
  updateDetailsLink(row);
  renderPhotoGallery(row.cui);
  refreshSelectedMarker();
  const panel = document.getElementById('investmentPanel');
  if (panel) panel.scrollTop = 0;
  persistSharedState();
  updateUrl();
}

function clearSelection(renderMarkers = true) {
  resetInvestmentSelection({ clearSearch: false, updateUrlNow: false });
  if (renderMarkers) refreshSelectedMarker();
  updateUrl();
}

/* =========================================================
   BUSQUEDA CUI
   ========================================================= */

function territoryForRow(row) {
  if (normalizeText(row?.[TERRITORY_CONFIG[app.territory]?.field]) === 'SI') return app.territory;
  return Object.keys(TERRITORY_CONFIG).find(key => normalizeText(row?.[TERRITORY_CONFIG[key].field]) === 'SI') || app.territory;
}

function suggestionRows(query = '') {
  const q = normalizeKey(query);
  const source = q ? app.data : app.filteredRows;
  const seen = new Set();
  return source.filter(row => {
    const cui = cleanText(row.cui);
    if (!cui || seen.has(cui)) return false;
    const haystack = normalizeKey(`${cui} ${shortInvestmentName(row)} ${row.distrito || ''} ${row.provincia || ''} ${row.region || ''}`);
    if (q && !haystack.includes(q)) return false;
    seen.add(cui);
    return true;
  }).sort((a, b) => String(a.cui).localeCompare(String(b.cui), 'es', { numeric: true })).slice(0, 14);
}

function renderCuiSuggestions(query = '') {
  const panel = document.getElementById('cuiSuggestions');
  const rows = suggestionRows(query);
  if (!rows.length) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }
  panel.innerHTML = rows.map(row => `
    <button type="button" class="map-cui-suggestion" data-cui-option="${escapeHtml(row.cui)}">
      <span class="map-cui-suggestion__cui">${escapeHtml(row.cui)}</span>
      <span class="map-cui-suggestion__meta">
        <strong>${escapeHtml(shortInvestmentName(row))}</strong>
        <small>${escapeHtml(`${territoryLabel(territoryForRow(row))} · ${toTitleCase(row.distrito)}, ${toTitleCase(row.provincia)}`)}</small>
      </span>
    </button>`).join('');
  panel.hidden = false;
}

function searchCui() {
  const input = document.getElementById('cuiSearchInput');
  const query = cleanText(input.value).replace(/\D/g, '');
  input.classList.remove('is-error');
  if (!query) { renderCuiSuggestions(''); return; }
  const row = app.data.find(item => String(item.cui) === query);
  if (!row) { input.classList.add('is-error'); renderCuiSuggestions(query); return; }
  cancelMapTransition();
  const territory = territoryForRow(row);
  if (territory !== app.territory) {
    app.territory = territory;
    app.territoryRows = territoryRows(app.data, app.territory);
    rebuildIndexes();
    document.getElementById('territorioSelect').value = app.territory;
    applyTerritoryTheme();
  }
  setHierarchyFromRow(row);
  applyFilters({ fit: false, animate: false, resetSelection: true });
  app.weather?.setBounds(weatherBoundsForTerritory());
  selectInvestment(row, { zoom: true });
  input.value = query;
  document.getElementById('cuiSuggestions').hidden = true;
  persistSharedState();
  preserveLinks();
}

/* =========================================================
   FOTOS
   ========================================================= */

function photoEntry(cui) {
  return app.photoManifest?.items?.[String(cui)] || null;
}

function photoCacheKey(cui) {
  return `vraem_photo_entry_${String(cui)}`;
}

function restorePhotoEntry(cui) {
  try {
    const raw = sessionStorage.getItem(photoCacheKey(cui));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (entry) {
      app.photoManifest.items = app.photoManifest.items || {};
      app.photoManifest.items[String(cui)] = entry;
    }
    return entry;
  } catch {
    return null;
  }
}

function savePhotoEntry(cui, entry) {
  if (!entry) return;
  app.photoManifest.items = app.photoManifest.items || {};
  app.photoManifest.items[String(cui)] = entry;
  try { sessionStorage.setItem(photoCacheKey(cui), JSON.stringify(entry)); } catch {}
}

function fetchPhotoEntry(cui) {
  const cached = photoEntry(cui) || restorePhotoEntry(cui);
  if (cached) return Promise.resolve(cached);
  if (app.photoRequests.has(String(cui))) return app.photoRequests.get(String(cui));
  const apiUrl = cleanText(app.photoManifest?.apiUrl);
  if (!apiUrl || !/^https:\/\//i.test(apiUrl)) return Promise.resolve(null);

  const promise = new Promise(resolve => {
    const callback = `__vraemPhotos_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    let done = false;
    const finish = entry => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      try { delete window[callback]; } catch {}
      script.remove();
      app.photoRequests.delete(String(cui));
      if (entry) savePhotoEntry(cui, entry);
      resolve(entry || null);
    };
    const timeout = setTimeout(() => finish(null), 9000);
    window[callback] = payload => finish(payload?.items?.[String(cui)] || payload?.item || null);
    script.onerror = () => finish(null);
    const url = new URL(apiUrl);
    url.searchParams.set('cui', String(cui));
    url.searchParams.set('callback', callback);
    script.src = url.toString();
    document.head.appendChild(script);
  });
  app.photoRequests.set(String(cui), promise);
  return promise;
}

function prefetchPhotoMetadata(cui) {
  fetchPhotoEntry(cui).then(entry => {
    const photo = entry?.photos?.[0];
    if (!photo?.id) return;
    const img = new Image();
    img.decoding = 'async';
    img.src = `https://lh3.googleusercontent.com/d/${encodeURIComponent(photo.id)}=w900`;
  }).catch(() => null);
}

function photoUrls(photo, size = 1000) {
  if (!photo) return [];
  const urls = [];
  if (photo.id) {
    urls.push(`https://lh3.googleusercontent.com/d/${encodeURIComponent(photo.id)}=w${size}`);
    urls.push(`https://drive.google.com/thumbnail?id=${encodeURIComponent(photo.id)}&sz=w${size}`);
  }
  if (photo.thumbnailUrl) urls.push(photo.thumbnailUrl);
  if (photo.url) urls.push(photo.url);
  return [...new Set(urls.filter(Boolean))];
}

function setImageFallback(img, photo, size = 1000, onFail = null) {
  const urls = photoUrls(photo, size);
  let index = 0;
  img.onload = () => document.getElementById('photoStage')?.classList.remove('is-loading');
  img.onerror = () => {
    index += 1;
    if (index < urls.length) img.src = urls[index];
    else {
      document.getElementById('photoStage')?.classList.remove('is-loading');
      if (onFail) onFail();
    }
  };
  if (urls[0]) img.src = urls[0];
  else if (onFail) onFail();
}

async function renderPhotoGallery(cui, requestedIndex = 0) {
  const image = document.getElementById('selectedPhoto');
  const empty = document.getElementById('photoEmpty');
  const counter = document.getElementById('photoCounter');
  const prev = document.getElementById('photoPrev');
  const next = document.getElementById('photoNext');
  const thumbs = document.getElementById('photoThumbs');
  const stage = document.getElementById('photoStage');
  const folder = document.getElementById('photoFolderLink');

  stage.classList.add('is-loading');
  image.hidden = true;
  empty.hidden = false;
  empty.querySelector('span:last-child').textContent = `Preparando fotos del CUI ${cui}`;
  counter.textContent = 'Preparando imágenes';
  thumbs.innerHTML = '';

  const entry = photoEntry(cui) || restorePhotoEntry(cui) || await fetchPhotoEntry(cui);
  if (String(app.selectedCui) !== String(cui)) return;
  const photos = Array.isArray(entry?.photos) ? entry.photos : [];
  folder.href = entry?.folderUrl || app.photoManifest.rootFolder || folder.href;

  if (!photos.length) {
    stage.classList.remove('is-loading');
    image.hidden = true;
    empty.hidden = false;
    empty.querySelector('span:last-child').textContent = `No se encontraron imágenes para el CUI ${cui}.`;
    counter.textContent = 'Sin imágenes disponibles';
    prev.hidden = true;
    next.hidden = true;
    return;
  }

  app.photoIndex = (requestedIndex + photos.length) % photos.length;
  const photo = photos[app.photoIndex];
  image.hidden = false;
  image.alt = photo.name ? `${photo.name} · CUI ${cui}` : `Foto CUI ${cui}`;
  empty.hidden = true;
  counter.textContent = `${app.photoIndex + 1} de ${photos.length}`;
  prev.hidden = photos.length < 2;
  next.hidden = photos.length < 2;
  setImageFallback(image, photo, 1000, () => {
    image.hidden = true;
    empty.hidden = false;
    empty.querySelector('span:last-child').textContent = 'La imagen no pudo cargarse desde Google Drive.';
  });

  thumbs.innerHTML = photos.map((item, index) => `<button type="button" class="investment-photos__thumb${index === app.photoIndex ? ' is-active' : ''}" data-photo-index="${index}"><img alt=""></button>`).join('');
  thumbs.querySelectorAll('[data-photo-index]').forEach((button, index) => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      renderPhotoGallery(cui, Number(button.dataset.photoIndex));
    });
    const thumb = button.querySelector('img');
    setImageFallback(thumb, photos[index], 320, () => button.remove());
  });
}

function stepPhoto(delta) {
  if (!app.selectedCui) return;
  const entry = photoEntry(app.selectedCui);
  const photos = Array.isArray(entry?.photos) ? entry.photos : [];
  if (photos.length < 2) return;
  renderPhotoGallery(app.selectedCui, app.photoIndex + delta);
}

function ensurePhotoLightbox() {
  if (document.getElementById('photoLightbox')) return;
  const box = document.createElement('div');
  box.id = 'photoLightbox';
  box.className = 'photo-lightbox';
  box.hidden = true;
  box.innerHTML = `
    <div class="photo-lightbox__backdrop" data-lightbox-close></div>
    <div class="photo-lightbox__dialog" role="dialog" aria-modal="true">
      <button type="button" class="photo-lightbox__close" data-lightbox-close aria-label="Cerrar"><i class="bi bi-x-lg"></i></button>
      <img id="photoLightboxImage" alt="Fotografía ampliada">
      <div id="photoLightboxCaption" class="photo-lightbox__caption"></div>
    </div>`;
  document.body.appendChild(box);
  box.addEventListener('click', event => {
    if (event.target.closest('[data-lightbox-close]')) closePhotoLightbox();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !box.hidden) closePhotoLightbox();
  });
}

function openPhotoLightbox() {
  const source = document.getElementById('selectedPhoto');
  if (!source || source.hidden || !source.src) return;
  ensurePhotoLightbox();
  const box = document.getElementById('photoLightbox');
  const image = document.getElementById('photoLightboxImage');
  image.src = source.currentSrc || source.src;
  image.alt = source.alt;
  document.getElementById('photoLightboxCaption').textContent = source.alt;
  box.hidden = false;
  document.body.classList.add('photo-lightbox-open');
}

function closePhotoLightbox() {
  const box = document.getElementById('photoLightbox');
  if (!box) return;
  box.hidden = true;
  document.body.classList.remove('photo-lightbox-open');
  document.getElementById('photoLightboxImage')?.removeAttribute('src');
}

/* =========================================================
   EVENTOS
   ========================================================= */

function wireEvents() {
  const territorySelect = document.getElementById('territorioSelect');
  const dept = document.getElementById('departamentoSelect');
  const prov = document.getElementById('provinciaSelect');
  const dist = document.getElementById('distritoSelect');
  const color = document.getElementById('colorSelect');
  const cui = document.getElementById('cuiSearchInput');
  territorySelect.addEventListener('change', () => switchTerritory(territorySelect.value));
  dept.addEventListener('change', () => {
    cancelMapTransition();
    const deptRows = app.territoryRows.filter(row => !dept.value || normalizeText(row.region) === normalizeText(dept.value));
    populateSelect(prov, uniqueSorted(deptRows, 'provincia'), 'Todas', '');
    populateSelect(dist, [], 'Todos', '');
    document.getElementById('provinciaField').hidden = !dept.value;
    document.getElementById('distritoField').hidden = true;
    applyFilters({ fit: true, animate: true, resetSelection: true });
  });
  prov.addEventListener('change', () => {
    cancelMapTransition();
    const provRows = app.territoryRows.filter(row => (!dept.value || normalizeText(row.region) === normalizeText(dept.value)) && (!prov.value || normalizeText(row.provincia) === normalizeText(prov.value)));
    populateSelect(dist, uniqueSorted(provRows, 'distrito'), 'Todos', '');
    document.getElementById('distritoField').hidden = !(dept.value && prov.value);
    applyFilters({ fit: true, animate: true, resetSelection: true });
  });
  dist.addEventListener('change', () => { cancelMapTransition(); applyFilters({ fit: true, animate: true, resetSelection: true }); });
  color.addEventListener('change', () => { renderLegend(); updateVisibleMarkers(); persistSharedState(); updateUrl(); });
  document.getElementById('legendConfigButton').addEventListener('click', event => { event.stopPropagation(); const panel = document.getElementById('legendConfigPanel'); panel.hidden = !panel.hidden; });
  document.getElementById('resetMapFilters').addEventListener('click', () => {
    cancelMapTransition(); dept.value = ''; prov.value = ''; dist.value = ''; cui.value = ''; color.value = 'departamento'; syncFilterOptions(); applyFilters({ fit: true, animate: true, resetSelection: true });
  });
  document.getElementById('fitScopeButton').addEventListener('click', () => fitCurrentView({ animate: true, includeSelected: Boolean(app.selectedCui) }));
  document.getElementById('drillTrail').addEventListener('click', event => { const button = event.target.closest('[data-trail-level]'); if (button) navigateTrail(button.dataset.trailLevel); });
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setBaseMap(button.dataset.mode)));
  document.getElementById('clearSelection').addEventListener('click', () => { clearSelection(true); fitCurrentView({ animate: true, includeSelected: false }); });
  document.getElementById('cuiSearchButton').addEventListener('click', searchCui);
  cui.addEventListener('focus', () => renderCuiSuggestions(cui.value));
  cui.addEventListener('input', () => { cui.classList.remove('is-error'); renderCuiSuggestions(cui.value); });
  cui.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); searchCui(); } else if (event.key === 'Escape') document.getElementById('cuiSuggestions').hidden = true; });
  document.getElementById('cuiSuggestions').addEventListener('mousedown', event => { const option = event.target.closest('[data-cui-option]'); if (!option) return; event.preventDefault(); cui.value = option.dataset.cuiOption; document.getElementById('cuiSuggestions').hidden = true; searchCui(); });
  document.addEventListener('pointerdown', event => { const suggestions = document.getElementById('cuiSuggestions'); if (!event.target.closest('.map-cui-search')) suggestions.hidden = true; if (!event.target.closest('.map-overlay-card--legend')) document.getElementById('legendConfigPanel').hidden = true; });
  document.getElementById('photoPrev').addEventListener('click', event => { event.stopPropagation(); stepPhoto(-1); });
  document.getElementById('photoNext').addEventListener('click', event => { event.stopPropagation(); stepPhoto(1); });
  document.getElementById('photoStage').addEventListener('click', event => { if (event.target.closest('.investment-photos__nav')) return; openPhotoLightbox(); });
  window.addEventListener('resize', () => { app.map?.invalidateSize(false); updatePeruLocator(); });
}

/* =========================================================
   CARGA DE DATOS
   ========================================================= */

async function loadJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`No se pudo cargar ${url}`);
  return response.json();
}


async function loadCompleteDistrictGeo(data, localGeo) {
  const localFeatures = Array.isArray(localGeo?.features) ? localGeo.features : [];
  const neededCodes = new Set(
    data.map(row => normalizeCode(row.ubigeo_distrito, 6)).filter(Boolean)
  );
  const localByCode = new Map();
  localFeatures.forEach(feature => {
    const code = featureDistrictCode(feature);
    if (code) localByCode.set(code, feature);
  });

  // La vista Territorio usa primero la geometría topológica simplificada y
  // deja el GeoJSON local únicamente como respaldo. El mapa debe hacer lo mismo
  // para que ambos módulos dibujen exactamente la misma capa territorial.
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(TOPOLOGY_SOURCE_URL, {
      cache: 'force-cache',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const remoteGeo = await response.json();
    if (!Array.isArray(remoteGeo?.features) || !remoteGeo.features.length) {
      throw new Error('GeoJSON topológico remoto inválido');
    }

    const remoteByCode = new Map();
    remoteGeo.features.forEach(feature => {
      const code = featureDistrictCode(feature);
      if (code && neededCodes.has(code)) remoteByCode.set(code, feature);
    });

    let fallbackCount = 0;
    const features = [...neededCodes].map(code => {
      if (remoteByCode.has(code)) return remoteByCode.get(code);
      if (localByCode.has(code)) {
        fallbackCount += 1;
        return localByCode.get(code);
      }
      return null;
    }).filter(Boolean);

    const unresolved = [...neededCodes].filter(code => !remoteByCode.has(code) && !localByCode.has(code));
    if (unresolved.length) console.warn('[Mapa V29] Distritos sin geometría:', unresolved);
    console.info(`[Mapa V29] Capa territorial: ${features.length} distritos · ${features.length - fallbackCount} topológicos · ${fallbackCount} respaldo local.`);
    return { type: 'FeatureCollection', features };
  } catch (error) {
    console.warn('[Mapa V29] No se pudo cargar la geometría topológica. Se usa el GeoJSON local como respaldo.', error);
    return localGeo;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function initMapPage() {
  app.territory = selectedTerritory();
  const ui = readMapUiState();
  app.mapMode = ['detailed', 'cartographic', 'satellite'].includes(ui.mapMode) ? ui.mapMode : 'detailed';
  const [data, districtGeo, provinceGeo, photoManifest] = await Promise.all([
    loadJson('data/puentes.json', { cache: 'no-store' }),
    loadJson('data/territorio-distritos.geojson', { cache: 'force-cache' }),
    loadJson('data/territorio-provincias.geojson', { cache: 'force-cache' }).catch(() => null),
    loadJson(PHOTO_MANIFEST_URL, { cache: 'force-cache' }).catch(() => ({ rootFolder: '', apiUrl: '', items: {} }))
  ]);
  app.data = data;
  app.localDistrictGeo = await loadCompleteDistrictGeo(app.data, districtGeo);
  app.localProvinceGeo = provinceGeo;
  app.photoManifest = photoManifest || { rootFolder: '', apiUrl: '', items: {} };
  app.territoryRows = territoryRows(app.data, app.territory);
  rebuildIndexes();
  rebuildFeatureIndex();
  applyTerritoryTheme();
  document.getElementById('territorioSelect').value = app.territory;
  document.getElementById('colorSelect').value = new URLSearchParams(window.location.search).get('color') || ui.color || 'departamento';
  syncFilterOptions({ restore: true }); app.filteredRows = filteredRows();
  initLeaflet(); wireEvents(); updateHeaderAndStats(); renderLegend(); renderPolygons(); buildTerritoryMarkers(); updateVisibleMarkers(); updatePeruLocator(); preserveLinks(); persistSharedState();
  app.weather = window.VraemWeatherLayer ? new window.VraemWeatherLayer(app.map, { pane: 'weatherPane', toggleId: 'weatherToggle', playId: 'weatherPlay', rangeId: 'weatherHourRange', timeLabelId: 'weatherTimeLabel', statusId: 'weatherStatus' }) : null;
  app.weather?.setBounds(weatherBoundsForTerritory());
  app.initialized = true;
  fitCurrentView({ animate: false, includeSelected: false });
  const cuiFromUrl = new URLSearchParams(window.location.search).get('cui');
  if (cuiFromUrl) { const row = app.filteredRows.find(item => String(item.cui) === String(cuiFromUrl)); if (row) selectInvestment(row, { zoom: true }); }
}

function showLoadError(error) {
  console.error('[Mapa]', error);
  const wrap = document.querySelector('.map-canvas-wrap');
  if (!wrap) return;
  const box = document.createElement('div');
  box.className = 'map-error-overlay';
  box.innerHTML = `<i class="bi bi-exclamation-triangle"></i><strong>No se pudo inicializar el mapa</strong><span>${escapeHtml(error?.message || 'Verifica los archivos del proyecto.')}</span>`;
  wrap.appendChild(box);
}

window.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('vraem-map-module')) return;
  initMapPage().catch(showLoadError);
});
