(() => {
  const TOPOLOGY_SOURCE_URL = 'https://raw.githubusercontent.com/Rodasluis/Peru-maps/main/salida/distrito_simplificado.geojson';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const TERRITORIES = {
    VRAEM: { label: 'VRAEM', field: 'es_vraem', slug: 'vraem' },
    NORVRAEM: { label: 'NORVRAEM', field: 'es_norvraem', slug: 'norvraem' },
    AMUVRAEM: { label: 'AMUVRAE', field: 'es_amuvraem', slug: 'amuvrae' }
  };

  // La vista comparativa es ejecutiva: no hereda territorio, provincia, distrito, CUI ni hash.
  if (window.location.search || window.location.hash) {
    history.replaceState(null, '', 'comparativo.html');
  }

  window.addEventListener('DOMContentLoaded', init);

  async function init() {
    try {
      const [dataResponse, fallbackGeoResponse] = await Promise.all([
        fetch('data/puentes.json', { cache: 'no-store' }),
        fetch('data/territorio-distritos.geojson', { cache: 'force-cache' })
      ]);

      if (!dataResponse.ok) throw new Error(`puentes.json: HTTP ${dataResponse.status}`);
      if (!fallbackGeoResponse.ok) throw new Error(`territorio-distritos.geojson: HTTP ${fallbackGeoResponse.status}`);

      const [data, fallbackGeo] = await Promise.all([
        dataResponse.json(),
        fallbackGeoResponse.json()
      ]);

      const rows = Array.isArray(data) ? data : [];
      const topologyFeatures = await loadTopologyFeatures(fallbackGeo);
      const metrics = Object.entries(TERRITORIES).map(([key, config]) => summarizeTerritory(rows, key, config));

      paintGlobalSummary(rows);
      metrics.forEach(metric => paintTerritory(metric));
      paintBars(metrics);
      paintInsight(metrics);

      metrics.forEach(metric => {
        const svg = document.querySelector(`[data-map="${metric.key}"]`);
        if (svg) renderMiniMap(svg, metric.key, metric.rows, topologyFeatures, fallbackGeo);
      });
    } catch (error) {
      console.error('[Comparativo] No se pudo cargar la vista ejecutiva:', error);
      setText('insightTitle', 'No se pudo cargar la vista');
      setText('insightText', 'Verifique la disponibilidad de los archivos de datos y cartografía.');
    } finally {
      document.body.classList.remove('is-loading');
    }
  }

  function summarizeTerritory(allRows, key, config) {
    const rows = allRows.filter(row => normalizeText(row[config.field]) === 'SI');
    const resources = rows.filter(needsResources);
    return {
      key,
      label: config.label,
      slug: config.slug,
      rows,
      ioarr: uniqueCount(rows, 'cui'),
      bridges: rows.reduce((sum, row) => sum + number(row.n_puentes), 0),
      districts: uniqueCount(rows, 'ubigeo_distrito'),
      agreements: rows.filter(isSigned).length,
      resources: resources.length,
      deficit: resources.reduce((sum, row) => sum + Math.max(0, number(row.deficit)), 0)
    };
  }

  function paintGlobalSummary(rows) {
    const resources = rows.filter(needsResources);
    setText('totalInversiones', uniqueCount(rows, 'cui').toLocaleString('es-PE'));
    setText('totalPuentes', rows.reduce((sum, row) => sum + number(row.n_puentes), 0).toLocaleString('es-PE'));
    setText('totalConvenios', rows.filter(isSigned).length.toLocaleString('es-PE'));
    setText('totalDeficit', formatMoneyShort(resources.reduce((sum, row) => sum + Math.max(0, number(row.deficit)), 0)));
  }

  function paintTerritory(metric) {
    const s = metric.slug;
    setText(`${s}-puentes`, metric.bridges.toLocaleString('es-PE'));
    setText(`${s}-ioarr`, metric.ioarr.toLocaleString('es-PE'));
    setText(`${s}-distritos`, metric.districts.toLocaleString('es-PE'));
    setText(`${s}-convenios`, metric.agreements.toLocaleString('es-PE'));
    setText(`${s}-recursos`, metric.resources.toLocaleString('es-PE'));
    setText(`${s}-deficit`, formatMoneyShort(metric.deficit));
  }

  function paintBars(metrics) {
    const host = document.getElementById('comparisonBars');
    if (!host) return;
    const max = Math.max(...metrics.map(item => item.deficit), 1);
    host.innerHTML = metrics.map(item => `
      <div class="comparison-bar comparison-bar--${item.key.toLowerCase()}">
        <span class="comparison-bar__label">${item.label}</span>
        <div class="comparison-bar__track"><div class="comparison-bar__fill" style="width:${Math.max(5, (item.deficit / max) * 100).toFixed(1)}%"></div></div>
        <strong class="comparison-bar__value">${formatMoneyShort(item.deficit)}</strong>
      </div>
    `).join('');
  }

  function paintInsight(metrics) {
    const topDeficit = [...metrics].sort((a, b) => b.deficit - a.deficit)[0];
    const topResources = [...metrics].sort((a, b) => b.resources - a.resources)[0];
    if (!topDeficit || !topResources) return;
    setText('insightTitle', `${topDeficit.label} concentra la mayor brecha financiera`);
    setText('insightText', `${topDeficit.label} registra ${formatMoneyShort(topDeficit.deficit)} de déficit estimado. ${topResources.label} presenta ${topResources.resources.toLocaleString('es-PE')} inversiones que requieren recursos adicionales.`);
  }

  function rowsDistrictStats(rows) {
    const grouped = new Map();
    rows.forEach(row => {
      const code = normalizeCode(row.ubigeo_distrito, 6);
      if (!code) return;
      if (!grouped.has(code)) {
        grouped.set(code, { code, name: row.distrito || 'Distrito', province: row.provincia || '', bridges: 0, cuis: new Set() });
      }
      const item = grouped.get(code);
      item.bridges += number(row.n_puentes);
      if (row.cui != null && row.cui !== '') item.cuis.add(String(row.cui));
    });
    grouped.forEach(item => { item.ioarr = item.cuis.size; });
    return grouped;
  }

  function renderMiniMap(svg, territory, rows, topologyFeatures, fallbackGeo) {
    svg.replaceChildren();
    const stats = rowsDistrictStats(rows);
    const selectedCodes = new Set(stats.keys());
    const fallbackIndex = new Map((fallbackGeo.features || []).map(feature => [normalizeCode(feature.properties?.ubigeo_distrito, 6), feature]));

    const fromTopology = topologyFeatures.filter(feature => selectedCodes.has(featureDistrictCode(feature)));
    const available = new Set(fromTopology.map(featureDistrictCode));
    const fallbackSelected = [...selectedCodes].filter(code => !available.has(code) && fallbackIndex.has(code)).map(code => fallbackIndex.get(code));
    const selected = [...fromTopology, ...fallbackSelected];
    if (!selected.length) return;

    const selectedBounds = boundsFrom(selected);
    const viewport = expandBounds(selectedBounds, territory === 'AMUVRAEM' ? 0.16 : 0.11, territory === 'AMUVRAEM' ? 0.18 : 0.13);
    const context = topologyFeatures.filter(feature => {
      const code = featureDistrictCode(feature);
      return code && !selectedCodes.has(code) && featureIntersectsBounds(feature, viewport);
    });
    const project = makeProjector(viewport, 320, 230, 10);

    context.forEach(feature => {
      svg.appendChild(svgElement('path', { d: geometryToSvgPath(feature.geometry, project), class: 'cmp-map__context' }));
    });

    selected.forEach(feature => {
      const code = featureDistrictCode(feature) || normalizeCode(feature.properties?.ubigeo_distrito, 6);
      const path = svgElement('path', { d: geometryToSvgPath(feature.geometry, project), class: 'cmp-map__selected' });
      wireHover(path, svg, stats.get(code));
      svg.appendChild(path);
    });
  }

  function wireHover(path, svg, stat) {
    if (!stat) return;
    const wrap = svg.closest('.territory-panel__map-wrap');
    if (!wrap) return;
    let tooltip = wrap.querySelector('.cmp-map-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'cmp-map-tooltip';
      wrap.appendChild(tooltip);
    }

    path.addEventListener('pointerenter', event => {
      svg.querySelectorAll('.cmp-map__selected').forEach(other => { if (other !== path) other.classList.add('is-dimmed'); });
      path.classList.add('is-hovered');
      tooltip.innerHTML = `<strong>${escapeHtml(stat.name)}</strong><span>${escapeHtml(stat.province)} · ${stat.ioarr} IOARR · ${stat.bridges} puentes</span>`;
      tooltip.classList.add('is-visible');
      moveTooltip(tooltip, wrap, event);
    });
    path.addEventListener('pointermove', event => moveTooltip(tooltip, wrap, event));
    path.addEventListener('pointerleave', () => {
      svg.querySelectorAll('.cmp-map__selected').forEach(other => other.classList.remove('is-dimmed'));
      path.classList.remove('is-hovered');
      tooltip.classList.remove('is-visible');
    });
  }

  function moveTooltip(tooltip, wrap, event) {
    const rect = wrap.getBoundingClientRect();
    const tip = tooltip.getBoundingClientRect();
    let x = event.clientX - rect.left + 12;
    let y = event.clientY - rect.top + 12;
    x = Math.max(8, Math.min(x, rect.width - tip.width - 8));
    y = Math.max(8, Math.min(y, rect.height - tip.height - 8));
    tooltip.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  async function loadTopologyFeatures(fallbackGeo) {
    try {
      const response = await fetch(TOPOLOGY_SOURCE_URL, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const geo = await response.json();
      if (!Array.isArray(geo.features) || !geo.features.length) throw new Error('Sin geometrías');
      return geo.features;
    } catch (error) {
      console.warn('[Comparativo] Se usa GeoJSON local como respaldo.', error);
      return fallbackGeo.features || [];
    }
  }

  function geometryCoordinates(geometry) {
    const output = [];
    const walk = node => {
      if (!Array.isArray(node)) return;
      if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') { output.push(node); return; }
      node.forEach(walk);
    };
    walk(geometry?.coordinates);
    return output;
  }

  function boundsFrom(features) {
    const coords = features.flatMap(feature => geometryCoordinates(feature.geometry));
    if (!coords.length) return null;
    return {
      minX: Math.min(...coords.map(c => c[0])), maxX: Math.max(...coords.map(c => c[0])),
      minY: Math.min(...coords.map(c => c[1])), maxY: Math.max(...coords.map(c => c[1]))
    };
  }

  function expandBounds(bounds, rx = .11, ry = .13) {
    const sx = Math.max(bounds.maxX - bounds.minX, .001);
    const sy = Math.max(bounds.maxY - bounds.minY, .001);
    return { minX: bounds.minX - sx * rx, maxX: bounds.maxX + sx * rx, minY: bounds.minY - sy * ry, maxY: bounds.maxY + sy * ry };
  }

  function featureIntersectsBounds(feature, bounds) {
    const b = boundsFrom([feature]);
    return b && !(b.maxX < bounds.minX || b.minX > bounds.maxX || b.maxY < bounds.minY || b.minY > bounds.maxY);
  }

  function makeProjector(bounds, width, height, padding) {
    const sx = Math.max(bounds.maxX - bounds.minX, .001);
    const sy = Math.max(bounds.maxY - bounds.minY, .001);
    const scale = Math.min((width - padding * 2) / sx, (height - padding * 2) / sy);
    const rw = sx * scale, rh = sy * scale;
    const ox = (width - rw) / 2, oy = (height - rh) / 2;
    return ([lon, lat]) => [ox + (lon - bounds.minX) * scale, oy + (bounds.maxY - lat) * scale];
  }

  function geometryToSvgPath(geometry, project) {
    const ringPath = ring => ring.map((coord, index) => {
      const [x, y] = project(coord);
      return `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ') + ' Z';
    if (geometry?.type === 'Polygon') return geometry.coordinates.map(ringPath).join(' ');
    if (geometry?.type === 'MultiPolygon') return geometry.coordinates.flatMap(poly => poly.map(ringPath)).join(' ');
    return '';
  }

  function svgElement(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    Object.entries(attrs || {}).forEach(([key, value]) => el.setAttribute(key, String(value)));
    return el;
  }

  function featureDistrictCode(feature) {
    const p = feature?.properties || {};
    return normalizeCode(p.ubigeo_distrito ?? p.UBIGEO_DISTRITO ?? p.ubigeo ?? p.UBIGEO, 6);
  }

  function uniqueCount(rows, field) {
    return new Set(rows.map(row => row[field]).filter(value => value != null && value !== '').map(String)).size;
  }

  function needsResources(row) {
    return bool(row.requiere_recursos) || number(row.deficit) > 0;
  }

  function isSigned(row) {
    return normalizeText(row.estado_convenio) === 'CONVENIO SUSCRITO' || normalizeText(row.estado_convenio) === 'SUSCRITO';
  }

  function normalizeText(value) { return String(value ?? '').trim().toUpperCase(); }
  function normalizeCode(value, digits) { return value == null || value === '' ? '' : String(value).trim().padStart(digits, '0'); }
  function number(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
  function bool(value) { return value === true || ['SI', 'TRUE', '1'].includes(normalizeText(value)); }
  function setText(id, value) { const node = document.getElementById(id); if (node) node.textContent = value; }

  function formatMoneyShort(value) {
    const amount = number(value);
    if (Math.abs(amount) >= 1_000_000) return `S/ ${(amount / 1_000_000).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} M`;
    if (Math.abs(amount) >= 1_000) return `S/ ${(amount / 1_000).toLocaleString('es-PE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} mil`;
    return `S/ ${amount.toLocaleString('es-PE', { maximumFractionDigits: 0 })}`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }
})();
