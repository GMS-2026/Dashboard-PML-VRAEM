const DATA_URL = 'data/puentes.json';
const PHOTO_MANIFEST_URL = 'data/fotos-manifest.json';
const DOCUMENT_CONFIG = {
  apiUrl: 'https://script.google.com/macros/s/AKfycbwG5AGahup-QcZQjtBamqxqPkVLy-f0HhBcX9yvA6xORETGMYtxTmFs4-KYKx1cFQqxDA/exec',
  timeoutMs: 9000
};

const TERRITORY_CONFIG = {
  VRAEM: { field: 'es_vraem', label: 'VRAEM' },
  NORVRAEM: { field: 'es_norvraem', label: 'NORVRAEM' },
  AMUVRAEM: { field: 'es_amuvraem', label: 'AMUVRAEM' }
};

const state = {
  data: [],
  rows: [],
  currentIndex: 0,
  currentRow: null,
  territory: 'VRAEM',
  filters: { departamento: '', provincia: '', distrito: '' },
  photoManifest: { rootFolder: '', apiUrl: '', items: {} },
  photos: [],
  photoIndex: 0,
  photoDataCache: {},
  toastTimer: null
};

function cleanText(value) {
  return String(value ?? '').trim();
}

function normalizeText(value) {
  return cleanText(value).toUpperCase();
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
    .replace(/(^|[\s/\-()])([a-záéíóúüñ])/g, (_, p1, p2) => p1 + p2.toLocaleUpperCase('es-PE'));
}

function numberValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value, decimals = 0) {
  const n = numberValue(value);
  if (n === null) return '-';
  return n.toLocaleString('es-PE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function formatMoney(value) {
  const n = numberValue(value);
  if (n === null) return '-';
  return `S/ ${n.toLocaleString('es-PE', { maximumFractionDigits: 0 })}`;
}

function formatCoord(value) {
  const n = numberValue(value);
  if (n === null) return '-';
  return n.toLocaleString('es-PE', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function agreementSerial(row) {
  const text = cleanText(row?.numero_convenio);
  if (!text) return '';

  const match =
    text.match(/(?:N[°º]?\s*)?(\d+)\s*[-–]?\s*2026/i) ||
    text.match(/CV[-_\s]*2026[-_\s]*(\d{1,5})/i) ||
    text.match(/(\d{1,5})/);

  if (!match) return '';
  const serial = Number(match[1]);
  return Number.isFinite(serial) && serial > 0 ? String(Math.trunc(serial)) : '';
}

function expectedAgreementPdfName(row) {
  const serial = agreementSerial(row);
  return serial ? `CV-2026-${serial.padStart(5, '0')}-000.pdf` : '';
}

function statusKey(row) {
  const raw = normalizeText(row?.estado_convenio);
  if (raw === 'CONVENIO SUSCRITO' || raw === 'SUSCRITO') return 'SUSCRITO';
  if (raw === 'EN TRÁMITE' || raw === 'EN TRAMITE') return 'EN TRÁMITE';
  return 'NO PRESENTADO';
}

function extractDriveId(value) {
  const text = String(value || '');
  if (!text) return '';

  const direct = text.match(/\/file\/d\/([^/?#]+)/i);
  if (direct) return direct[1];

  const query = text.match(/[?&]id=([^&#]+)/i);
  if (query) return decodeURIComponent(query[1]);

  if (/^[\w-]{20,}$/.test(text)) return text;
  return '';
}

class DriveConventionResolver {
  constructor(config) {
    this.config = config;
    this.cache = new Map();
  }

  jsonp(params) {
    return new Promise(resolve => {
      const callbackName = `__bridgeConvPdf_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement('script');
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
          if (value !== null && value !== undefined && String(value) !== '') {
            url.searchParams.set(key, String(value));
          }
        });
        url.searchParams.set('callback', callbackName);
        url.searchParams.set('_ts', String(Date.now()));
        script.src = url.toString();
        document.head.appendChild(script);
      } catch (_) {
        finish(null);
      }
    });
  }

  normalize(file, row) {
    if (!file) return null;
    const id = cleanText(file.id || file.fileId) || extractDriveId(file.viewUrl || file.url || file.link);
    const name = cleanText(file.name || file.fileName) || expectedAgreementPdfName(row) || 'Convenio.pdf';

    if (!id) return null;
    const encoded = encodeURIComponent(id);
    return {
      id,
      name,
      viewUrl: `https://drive.google.com/file/d/${encoded}/view`,
      previewUrl: `https://drive.google.com/file/d/${encoded}/preview`,
      downloadUrl: cleanText(file.downloadUrl) || `https://drive.google.com/uc?export=download&id=${encoded}`
    };
  }

  async resolve(row) {
    const cui = cleanText(row?.cui);
    const expected = expectedAgreementPdfName(row);
    if (!cui || !expected || statusKey(row) !== 'SUSCRITO') return null;

    const cacheKey = `${cui}|${expected}`;
    if (this.cache.has(cacheKey)) return await this.cache.get(cacheKey);

    const serial = agreementSerial(row);
    const task = this.jsonp({ action: 'convenio', numero: serial, cui })
      .then(payload => {
        if (!payload?.ok || !payload?.found) return null;
        return this.normalize(payload?.file || payload?.data?.file || null, row);
      })
      .catch(() => null);

    this.cache.set(cacheKey, task);
    const resolved = await task;
    this.cache.set(cacheKey, resolved);
    return resolved;
  }
}

const conventionResolver = new DriveConventionResolver(DOCUMENT_CONFIG);

function params() {
  return new URLSearchParams(window.location.search);
}

function getTerritory() {
  const fromUrl = normalizeText(params().get('territorio'));
  if (TERRITORY_CONFIG[fromUrl]) return fromUrl;
  const fromStorage = normalizeText(localStorage.getItem('territorio_dashboard'));
  if (TERRITORY_CONFIG[fromStorage]) return fromStorage;
  return 'VRAEM';
}

function readFilters() {
  const p = params();
  return {
    departamento: cleanText(p.get('departamento')),
    provincia: cleanText(p.get('provincia')),
    distrito: cleanText(p.get('distrito'))
  };
}

function rowMatchesTerritory(row) {
  const cfg = TERRITORY_CONFIG[state.territory];
  return normalizeText(row?.[cfg.field]) === 'SI';
}

function rowMatchesFilters(row) {
  if (state.filters.departamento && normalizeText(row.region) !== normalizeText(state.filters.departamento)) return false;
  if (state.filters.provincia && normalizeText(row.provincia) !== normalizeText(state.filters.provincia)) return false;
  if (state.filters.distrito && normalizeText(row.distrito) !== normalizeText(state.filters.distrito)) return false;
  return true;
}

function buildRows() {
  state.rows = state.data.filter(row => rowMatchesTerritory(row) && rowMatchesFilters(row));
  if (!state.rows.length) {
    state.rows = state.data.filter(rowMatchesTerritory);
  }
  state.rows.sort((a, b) => String(a.cui).localeCompare(String(b.cui), 'es', { numeric: true }));
}

function bridgeName(row) {
  const source = cleanText(row?.denominacion_inversion);
  if (!source) return `Puente CUI ${row?.cui || '-'}`;

  const patterns = [
    /PUENTE\s+[“\"']?([^,;]+?)[”\"']?(?:\s+EN\s+EL|\s+EN\s+LA|\s+DEL\s+|\s+DE\s+LA\s+LOCALIDAD|,|;|$)/i,
    /EN EL\(LA\)\s+([^,;]+?)(?:\s+EN\s+LA|\s+EN\s+EL|,|;|$)/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      let name = match[1].replace(/^PUENTE\s+/i, '').replace(/\s+/g, ' ').trim();
      return /^puente\b/i.test(name) ? toTitleCase(name) : `Puente ${toTitleCase(name)}`;
    }
  }

  const cleaned = source
    .replace(/^RENOVACION DE PUENTE;?\s*/i, '')
    .replace(/^RENOVACIÓN DE PUENTE;?\s*/i, '')
    .replace(/^REPARACION DE PUENTE;?\s*/i, '')
    .replace(/^REPARACIÓN DE PUENTE;?\s*/i, '')
    .replace(/^EN EL\(LA\)\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const first = cleaned.split(/\s+EN\s+LA\s+|\s+EN\s+EL\s+|,|;/i)[0]?.trim() || cleaned;
  const result = toTitleCase(first);
  return result;
}

function statusInfo(row) {
  const stage = normalizeText(row?.etapa);
  const situation = normalizeText(row?.estado_situacional);
  const detail = normalizeText(row?.detalle_estado);

  if (stage.includes('EJECUCIÓN') || situation.includes('EJECUCIÓN') || detail.includes('EJECUCIÓN')) {
    return { text: 'En ejecución', tone: 'success' };
  }
  if (situation.includes('SELECCIÓN') || detail.includes('ADJUDIC')) {
    return { text: 'Proceso de selección', tone: 'warning' };
  }
  if (situation.includes('CULMIN') || stage.includes('CULMIN')) {
    return { text: 'Culminado', tone: 'success' };
  }
  if (situation.includes('PARAL') || situation.includes('OBSERV')) {
    return { text: toTitleCase(row.estado_situacional), tone: 'danger' };
  }

  const fallback = cleanText(row?.estado_situacional || row?.detalle_estado || row?.etapa);
  return { text: fallback ? toTitleCase(fallback) : 'Sin estado', tone: 'neutral' };
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value ?? '-';
}

function currentUrlParams(row = state.currentRow) {
  const p = new URLSearchParams();
  p.set('territorio', state.territory);
  if (row?.cui) p.set('cui', String(row.cui));
  if (state.filters.departamento) p.set('departamento', state.filters.departamento);
  if (state.filters.provincia) p.set('provincia', state.filters.provincia);
  if (state.filters.distrito) p.set('distrito', state.filters.distrito);
  return p;
}

function preserveLinks() {
  document.querySelectorAll('[data-preserve-territory]').forEach(link => {
    const href = link.getAttribute('href');
    if (!href) return;
    const url = new URL(href, window.location.href);
    url.searchParams.set('territorio', state.territory);
    link.setAttribute('href', `${url.pathname.split('/').pop()}?${url.searchParams.toString()}${url.hash || ''}`);
  });

  const back = document.getElementById('backToMap');
  if (back) {
    const p = currentUrlParams();
    p.delete('cui');
    back.href = `mapa.html?${p.toString()}`;
  }
}

function updateHistory(row) {
  const p = currentUrlParams(row);
  // Versión canónica de la ficha. Mantenerla en la URL evita que una recarga
  // reutilice una copia anterior del documento o sus recursos.
  p.set('vista', 'detalle-v2');
  history.replaceState(null, '', `${window.location.pathname}?${p.toString()}`);
}

function renderFacts(row) {
  setText('factCui', row.cui || '-');
  setText('factDistrict', toTitleCase(row.distrito) || '-');
  setText('factProvince', toTitleCase(row.provincia) || '-');
  setText('factDepartment', toTitleCase(row.region) || '-');
  setText('factLength', numberValue(row.longitud) !== null ? `${formatNumber(row.longitud)} m` : '-');
  setText('factCost', formatMoney(row.costo_actualizado));
  setText('factPim', formatMoney(row.pim));
  setText('factDevengado', formatMoney(row.devengado_acumulado));
  setText('factAgreement', row.estado_convenio ? toTitleCase(row.estado_convenio) : '-');
}

function renderTabsData(row) {
  setText('detailUtmEast', formatCoord(row.este_utm));
  setText('detailUtmNorth', formatCoord(row.norte_utm));
  setText('detailLat', numberValue(row.latitud) !== null ? Number(row.latitud).toFixed(7) : '-');
  setText('detailLon', numberValue(row['LONGITUD.1']) !== null ? Number(row['LONGITUD.1']).toFixed(7) : '-');
  setText('detailPliego', toTitleCase(row.pliego) || '-');
  setText('detailScope', row.ambito_vraem ? toTitleCase(row.ambito_vraem) : '-');

  setText('detailCost', formatMoney(row.costo_actualizado));
  setText('detailPim', formatMoney(row.pim));
  setText('detailSpent', formatMoney(row.devengado_acumulado));
  setText('detailDeficit', formatMoney(row.deficit));
  setText('detailResources', row.requiere_recursos ? 'Sí' : 'No');
  setText('detailPackage', row.paquete ? toTitleCase(row.paquete) : '-');

  setText('detailStage', row.etapa ? toTitleCase(row.etapa) : '-');
  setText('detailSituation', row.estado_situacional ? toTitleCase(row.estado_situacional) : '-');
  setText('detailSituationDetail', row.detalle_estado ? toTitleCase(row.detalle_estado) : '-');
  setText('detailDependency', row.dependencia ? toTitleCase(row.dependencia) : '-');

  setText('detailAgreementNumber', row.numero_convenio || '-');
  setText('detailAgreementStage', row.etapa_convenio || '-');
  setText('detailNotification', row.oficio_notificacion || '-');
  setText('detailLegal', row.dispositivo_legal_2026 || '-');
}

function renderRecord(row) {
  state.currentRow = row;
  state.currentIndex = Math.max(0, state.rows.findIndex(item => String(item.cui) === String(row.cui)));
  updateHistory(row);
  preserveLinks();

  setText('bridgeName', bridgeName(row));
  setText('bridgeSubtitle', `${toTitleCase(row.distrito)}, ${toTitleCase(row.provincia)} · ${toTitleCase(row.region)} · CUI ${row.cui}`);

  const status = statusInfo(row);
  const statusEl = document.getElementById('bridgeStatus');
  statusEl.textContent = status.text;
  statusEl.dataset.tone = status.tone;

  setText('bridgePosition', `${state.currentIndex + 1} de ${state.rows.length}`);
  document.getElementById('previousBridge').disabled = state.currentIndex <= 0;
  document.getElementById('nextBridge').disabled = state.currentIndex >= state.rows.length - 1;

  renderFacts(row);
  renderTabsData(row);
  updateAgreementDownloadButton(row);
  resetPhotoStage(row.cui);
  loadPhotos(row.cui);
}

function goRelative(delta) {
  const next = state.currentIndex + delta;
  if (next < 0 || next >= state.rows.length) return;
  renderRecord(state.rows[next]);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function activateTab(key) {
  document.querySelectorAll('.bridge-tab').forEach(button => {
    const active = button.dataset.tab === key;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.bridge-tab-panel').forEach(panel => {
    const active = panel.dataset.panel === key;
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  });
}

function photoEntry(cui) {
  return state.photoManifest?.items?.[String(cui)] || null;
}

function fetchPhotoEntryFromApi(cui) {
  const apiUrl = cleanText(state.photoManifest?.apiUrl);
  if (!apiUrl || !/^https:\/\//i.test(apiUrl)) return Promise.resolve(null);

  return new Promise(resolve => {
    const callbackName = `__bridgePhotos_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    let settled = false;

    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { delete window[callbackName]; } catch {}
      script.remove();
      resolve(value);
    };

    const timeout = setTimeout(() => finish(null), 30000);

    window[callbackName] = payload => {
      const entry = payload?.items?.[String(cui)] || payload?.item || null;
      if (entry) {
        state.photoManifest.items = state.photoManifest.items || {};
        state.photoManifest.items[String(cui)] = entry;
      }
      finish(entry);
    };

    script.onerror = () => finish(null);
    const url = new URL(apiUrl);
    url.searchParams.set('cui', String(cui));
    url.searchParams.set('callback', callbackName);
    url.searchParams.set('_ts', String(Date.now()));
    script.src = url.toString();
    document.head.appendChild(script);
  });
}

function photoUrlCandidates(photo, size = 1800) {
  if (!photo) return [];
  const urls = [];
  if (photo.url) urls.push(photo.url);
  if (photo.thumbnailUrl) urls.push(photo.thumbnailUrl);
  if (photo.id) {
    urls.push(`https://lh3.googleusercontent.com/d/${encodeURIComponent(photo.id)}=w${size}`);
    urls.push(`https://drive.google.com/thumbnail?id=${encodeURIComponent(photo.id)}&sz=w${size}`);
    urls.push(`https://drive.google.com/uc?export=view&id=${encodeURIComponent(photo.id)}`);
  }
  return [...new Set(urls.filter(Boolean))];
}

function fetchPhotoDataUrlFromApi(photo, size = 1800) {
  const apiUrl = cleanText(state.photoManifest?.apiUrl);
  const fileId = cleanText(photo?.id);
  if (!apiUrl || !/^https:\/\//i.test(apiUrl) || !fileId) return Promise.resolve('');

  const requestSize = Math.max(240, Math.min(2200, Math.round(size || 1600)));
  const cacheKey = `${fileId}|${requestSize}`;
  if (state.photoDataCache[cacheKey]) return Promise.resolve(state.photoDataCache[cacheKey]);

  return new Promise(resolve => {
    const callbackName = `__bridgePhotoData_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    let settled = false;

    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { delete window[callbackName]; } catch {}
      script.remove();
      if (value) state.photoDataCache[cacheKey] = value;
      resolve(value || '');
    };

    const timeout = setTimeout(() => finish(''), 45000);
    window[callbackName] = payload => finish(payload?.ok ? cleanText(payload.dataUrl) : '');
    script.onerror = () => finish('');

    const url = new URL(apiUrl);
    url.searchParams.set('action', 'image');
    url.searchParams.set('fileId', fileId);
    url.searchParams.set('size', String(requestSize));
    url.searchParams.set('callback', callbackName);
    url.searchParams.set('_ts', String(Date.now()));
    script.src = url.toString();
    document.head.appendChild(script);
  });
}

function setImageWithFallback(img, photo, size = 1800, onFailure = null) {
  const candidates = photoUrlCandidates(photo, size);
  const loadToken = `${photo?.id || photo?.name || 'photo'}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  img.dataset.photoLoadToken = loadToken;
  let index = 0;
  let proxyTried = false;

  const fail = () => {
    if (img.dataset.photoLoadToken !== loadToken) return;
    img.onerror = null;
    if (typeof onFailure === 'function') onFailure();
  };

  const tryProxy = () => {
    if (proxyTried) {
      fail();
      return;
    }
    proxyTried = true;
    fetchPhotoDataUrlFromApi(photo, size).then(dataUrl => {
      if (img.dataset.photoLoadToken !== loadToken) return;
      if (!dataUrl) {
        fail();
        return;
      }
      img.onerror = fail;
      img.src = dataUrl;
    }).catch(fail);
  };

  img.onerror = () => {
    index += 1;
    if (index < candidates.length) {
      img.src = candidates[index];
      return;
    }
    tryProxy();
  };

  if (candidates[0]) img.src = candidates[0];
  else tryProxy();
}

function resetPhotoStage(cui) {
  state.photos = [];
  state.photoIndex = 0;

  const image = document.getElementById('mainBridgePhoto');
  const empty = document.getElementById('mainPhotoEmpty');
  image.hidden = true;
  image.removeAttribute('src');
  empty.hidden = false;
  empty.querySelector('strong').textContent = 'Buscando fotografías…';
  setText('mainPhotoEmptyText', `Consultando Google Drive por CUI ${cui}.`);
  document.getElementById('expandPhoto').hidden = true;
  document.getElementById('mainPhotoPrev').hidden = true;
  document.getElementById('mainPhotoNext').hidden = true;
  document.getElementById('mainPhotoCounter').hidden = true;
  document.getElementById('bridgeThumbs').innerHTML = '';
  document.getElementById('bridgeGallery').innerHTML = '<div class="bridge-gallery__empty">Consultando fotografías…</div>';
  document.getElementById('photoFolderLink').hidden = true;
}

async function loadPhotos(cui) {
  let entry = photoEntry(cui);
  if (!entry && cleanText(state.photoManifest?.apiUrl)) {
    entry = await fetchPhotoEntryFromApi(cui);
  }

  if (!state.currentRow || String(state.currentRow.cui) !== String(cui)) return;

  const photos = Array.isArray(entry?.photos) ? entry.photos : [];
  state.photos = photos;
  state.photoIndex = 0;

  const folderLink = document.getElementById('photoFolderLink');
  const folderUrl = entry?.folderUrl || state.photoManifest?.rootFolder;
  if (folderUrl) {
    folderLink.href = folderUrl;
    folderLink.hidden = false;
  }

  if (!photos.length) {
    const empty = document.getElementById('mainPhotoEmpty');
    empty.hidden = false;
    empty.querySelector('strong').textContent = 'Sin fotografías disponibles';
    setText('mainPhotoEmptyText', `La carpeta ${cui} no devolvió archivos JPG/JPEG/PNG desde Google Drive.`);
    document.getElementById('bridgeGallery').innerHTML = '<div class="bridge-gallery__empty">No se encontraron fotografías para este CUI.</div>';
    return;
  }

  renderPhoto(0);
  renderPhotoCollections();
}

function renderPhoto(index) {
  if (!state.photos.length) return;
  state.photoIndex = (index + state.photos.length) % state.photos.length;
  const photo = state.photos[state.photoIndex];
  const image = document.getElementById('mainBridgePhoto');
  const empty = document.getElementById('mainPhotoEmpty');

  image.hidden = false;
  empty.hidden = true;
  image.alt = photo.name ? `${photo.name} · CUI ${state.currentRow.cui}` : `Foto CUI ${state.currentRow.cui}`;
  setImageWithFallback(image, photo, 1800, () => {
    image.hidden = true;
    empty.hidden = false;
    empty.querySelector('strong').textContent = 'No se pudo mostrar la fotografía';
    setText('mainPhotoEmptyText', 'Google Drive localizó el archivo, pero bloqueó las URL disponibles para mostrarlo en el navegador.');
  });

  document.getElementById('expandPhoto').hidden = false;
  document.getElementById('mainPhotoPrev').hidden = state.photos.length < 2;
  document.getElementById('mainPhotoNext').hidden = state.photos.length < 2;
  const counter = document.getElementById('mainPhotoCounter');
  counter.hidden = false;
  counter.textContent = `${state.photoIndex + 1} / ${state.photos.length}`;

  document.querySelectorAll('.bridge-thumb').forEach((thumb, thumbIndex) => {
    thumb.classList.toggle('is-active', thumbIndex === state.photoIndex);
  });
}

function renderPhotoCollections() {
  const thumbs = document.getElementById('bridgeThumbs');
  const gallery = document.getElementById('bridgeGallery');

  thumbs.innerHTML = state.photos.slice(0, 8).map((photo, index) => `
    <button class="bridge-thumb${index === state.photoIndex ? ' is-active' : ''}" type="button" data-photo-index="${index}" title="${escapeHtml(photo.name || `Foto ${index + 1}`)}">
      <img data-photo-thumb="${index}" alt="Miniatura ${index + 1}">
    </button>`).join('');

  thumbs.querySelectorAll('[data-photo-index]').forEach(button => {
    button.addEventListener('click', () => renderPhoto(Number(button.dataset.photoIndex)));
  });
  thumbs.querySelectorAll('[data-photo-thumb]').forEach(img => {
    const index = Number(img.dataset.photoThumb);
    setImageWithFallback(img, state.photos[index], 420, () => img.closest('.bridge-thumb')?.remove());
  });

  gallery.innerHTML = state.photos.map((photo, index) => `
    <button class="bridge-gallery__item" type="button" data-gallery-index="${index}" title="Ampliar ${escapeHtml(photo.name || `Foto ${index + 1}`)}">
      <img data-gallery-image="${index}" alt="${escapeHtml(photo.name || `Foto ${index + 1}`)}">
    </button>`).join('');

  gallery.querySelectorAll('[data-gallery-index]').forEach(button => {
    button.addEventListener('click', () => openLightbox(Number(button.dataset.galleryIndex)));
  });
  gallery.querySelectorAll('[data-gallery-image]').forEach(img => {
    const index = Number(img.dataset.galleryImage);
    setImageWithFallback(img, state.photos[index], 700, () => img.closest('.bridge-gallery__item')?.remove());
  });
}

function stepPhoto(delta) {
  if (!state.photos.length) return;
  renderPhoto(state.photoIndex + delta);
}

function openLightbox(index = state.photoIndex) {
  if (!state.photos.length) return;
  state.photoIndex = (index + state.photos.length) % state.photos.length;
  const photo = state.photos[state.photoIndex];
  const root = document.getElementById('bridgeLightbox');
  const image = document.getElementById('lightboxImage');
  root.hidden = false;
  root.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  document.getElementById('lightboxCaption').textContent = `${photo.name || `Foto ${state.photoIndex + 1}`} · ${state.photoIndex + 1} de ${state.photos.length}`;
  document.getElementById('lightboxPrev').hidden = state.photos.length < 2;
  document.getElementById('lightboxNext').hidden = state.photos.length < 2;
  setImageWithFallback(image, photo, 2200);
}

function closeLightbox() {
  const root = document.getElementById('bridgeLightbox');
  root.hidden = true;
  root.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function stepLightbox(delta) {
  if (!state.photos.length) return;
  openLightbox(state.photoIndex + delta);
  renderPhoto(state.photoIndex);
}

function updateAgreementDownloadButton(row) {
  const button = document.getElementById('downloadAgreement');
  if (!button) return;

  const serial = agreementSerial(row);
  const available = statusKey(row) === 'SUSCRITO' && Boolean(serial);

  button.disabled = !available;
  button.dataset.serial = serial;
  button.title = available
    ? `Descargar ${expectedAgreementPdfName(row)}`
    : (statusKey(row) === 'SUSCRITO'
      ? 'No se pudo determinar el número del convenio PDF.'
      : 'Documento disponible únicamente para convenios suscritos.');
}

async function downloadCurrentAgreement(button) {
  const row = state.currentRow;
  if (!row) return;

  if (statusKey(row) !== 'SUSCRITO') {
    showToast('Esta inversión no tiene un convenio suscrito disponible para descargar.');
    return;
  }

  if (!agreementSerial(row)) {
    showToast('No se pudo determinar el número del convenio PDF.');
    return;
  }

  const label = button?.querySelector('span');
  const originalText = label?.textContent || 'Descargar convenio (PDF)';

  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  }
  if (label) label.textContent = 'Buscando convenio…';

  try {
    const pdf = await conventionResolver.resolve(row);

    if (!pdf?.downloadUrl) {
      showToast(`No se encontró ${expectedAgreementPdfName(row)} en Google Drive.`);
      return;
    }

    // Misma lógica usada en la vista Convenios.
    const link = document.createElement('a');
    link.href = pdf.downloadUrl;
    link.download = pdf.name || `Convenio_${row.cui}.pdf`;
    link.rel = 'noopener';
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (error) {
    console.error('[Convenio puente]', error);
    showToast('No se pudo descargar el convenio. Intenta nuevamente.');
  } finally {
    if (label) label.textContent = originalText;
    if (button) {
      button.removeAttribute('aria-busy');
      updateAgreementDownloadButton(state.currentRow);
    }
  }
}

function showToast(message) {
  const toast = document.getElementById('bridgeToast');
  toast.querySelector('span').textContent = message;
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

function wireEvents() {
  document.getElementById('previousBridge').addEventListener('click', () => goRelative(-1));
  document.getElementById('nextBridge').addEventListener('click', () => goRelative(1));

  document.querySelectorAll('.bridge-tab').forEach(button => {
    button.addEventListener('click', () => activateTab(button.dataset.tab));
  });

  document.getElementById('mainBridgePhoto').addEventListener('click', () => openLightbox(state.photoIndex));
  document.getElementById('expandPhoto').addEventListener('click', () => openLightbox(state.photoIndex));
  document.getElementById('mainPhotoPrev').addEventListener('click', event => { event.stopPropagation(); stepPhoto(-1); });
  document.getElementById('mainPhotoNext').addEventListener('click', event => { event.stopPropagation(); stepPhoto(1); });

  document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
  document.getElementById('lightboxPrev').addEventListener('click', () => stepLightbox(-1));
  document.getElementById('lightboxNext').addEventListener('click', () => stepLightbox(1));
  document.getElementById('bridgeLightbox').addEventListener('click', event => {
    if (event.target === event.currentTarget) closeLightbox();
  });

  document.getElementById('downloadAgreement')?.addEventListener('click', event => {
    downloadCurrentAgreement(event.currentTarget);
  });

  document.querySelectorAll('[data-placeholder-action="expediente"]').forEach(button => {
    button.addEventListener('click', () => {
      showToast('Expediente técnico: funcionalidad preparada para conectar en una siguiente iteración.');
    });
  });

  document.addEventListener('keydown', event => {
    const lightboxOpen = !document.getElementById('bridgeLightbox').hidden;
    if (event.key === 'Escape' && lightboxOpen) closeLightbox();
    if (event.key === 'ArrowLeft' && lightboxOpen) stepLightbox(-1);
    if (event.key === 'ArrowRight' && lightboxOpen) stepLightbox(1);
  });
}

async function init() {
  state.territory = getTerritory();
  state.filters = readFilters();
  localStorage.setItem('territorio_dashboard', state.territory);

  const [dataResponse, manifestResponse] = await Promise.all([
    fetch(DATA_URL, { cache: 'no-store' }),
    fetch(PHOTO_MANIFEST_URL, { cache: 'no-store' }).catch(() => null)
  ]);

  if (!dataResponse.ok) throw new Error('No se pudo cargar data/puentes.json.');
  state.data = await dataResponse.json();
  if (manifestResponse?.ok) state.photoManifest = await manifestResponse.json();

  buildRows();
  if (!state.rows.length) throw new Error('No hay inversiones disponibles para el ámbito seleccionado.');

  const requestedCui = cleanText(params().get('cui'));
  const requestedRow = state.rows.find(row => String(row.cui) === requestedCui)
    || state.data.find(row => String(row.cui) === requestedCui && rowMatchesTerritory(row))
    || state.rows[0];

  if (!state.rows.some(row => String(row.cui) === String(requestedRow.cui))) {
    state.rows = state.data.filter(rowMatchesTerritory).sort((a, b) => String(a.cui).localeCompare(String(b.cui), 'es', { numeric: true }));
  }

  wireEvents();
  preserveLinks();
  renderRecord(requestedRow);
}

function showFatalError(error) {
  console.error('[Ficha puente]', error);
  const card = document.querySelector('.bridge-record');
  if (!card) return;
  card.innerHTML = `
    <div style="min-height:420px;display:grid;place-content:center;text-align:center;padding:32px;color:#64748b">
      <i class="bi bi-exclamation-triangle" style="font-size:34px;color:#8f1733;margin-bottom:10px"></i>
      <strong style="font-size:16px;color:#20364d">No se pudo cargar la ficha</strong>
      <span style="margin-top:8px;font-size:12px">${escapeHtml(error?.message || 'Error desconocido')}</span>
    </div>`;
}

window.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('bridge-detail-module')) return;
  init().catch(showFatalError);
});

// Si el navegador restaura la página desde BFCache, forzamos el documento
// canónico para evitar mezclar un DOM anterior con los estilos actuales.
window.addEventListener('pageshow', event => {
  if (event.persisted) window.location.reload();
});

/* =========================================================
   V16 - FILTROS COMPARTIDOS ENTRE VISTAS
   ========================================================= */

const SHARED_FILTER_STORAGE_KEY = 'dashboard_filter_state';

function readFilters() {
  const p = params();
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SHARED_FILTER_STORAGE_KEY) || '{}') || {};
  } catch (_) {}

  const territory = getTerritory();
  const sameTerritory = normalizeText(saved.territorio || saved.territory || '') === normalizeText(territory);
  const filters = {
    departamento: cleanText(p.get('departamento')) || (sameTerritory ? cleanText(saved.departamento) : ''),
    provincia: cleanText(p.get('provincia')) || (sameTerritory ? cleanText(saved.provincia) : ''),
    distrito: cleanText(p.get('distrito')) || (sameTerritory ? cleanText(saved.distrito) : '')
  };

  try {
    localStorage.setItem(SHARED_FILTER_STORAGE_KEY, JSON.stringify({
      territorio: territory,
      departamento: filters.departamento,
      provincia: filters.provincia,
      distrito: filters.distrito
    }));
  } catch (_) {}

  return filters;
}

function preserveLinks() {
  const baseParams = currentUrlParams();
  baseParams.delete('cui');

  document.querySelectorAll('[data-preserve-territory]').forEach(link => {
    const href = link.getAttribute('href');
    if (!href) return;
    const url = new URL(href, window.location.href);
    baseParams.forEach((value, key) => url.searchParams.set(key, value));
    link.setAttribute('href', `${url.pathname.split('/').pop()}?${url.searchParams.toString()}${url.hash || ''}`);
  });

  const back = document.getElementById('backToMap');
  if (back) back.href = `mapa.html?${baseParams.toString()}`;
}
