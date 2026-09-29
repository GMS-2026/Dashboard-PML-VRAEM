/* =========================================================
   PRECIPITACION HORARIA V29
   ---------------------------------------------------------
   Pronostico intradia suavizado sobre una malla meteorologica.
   La capa se renderiza con dos ImageOverlay y cambio de frame
   solo despues de que la nueva imagen esta cargada.
   ========================================================= */

(function () {
  'use strict';

  const API_URL = 'https://api.open-meteo.com/v1/forecast';
  const STORAGE_KEY = 'vraem_weather_enabled_v28';
  const GRID_COLS = 11;
  const GRID_ROWS = 8;
  const FRAME_WIDTH = 286;
  const FRAME_HEIGHT = 196;
  const PLAY_STEP = 0.25;
  const FADE_MS = 150;
  const PLAY_PAUSE_MS = 90;
  const MIN_VISIBLE_MM = 0.10;
  const CACHE_LIMIT = 28;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function numberValue(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function bilinear(a, b, c, d, tx, ty) {
    return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
  }

  function delay(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  function peruHour() {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Lima',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      }).formatToParts(new Date());
      const hour = Number(parts.find(part => part.type === 'hour')?.value) || 0;
      const minute = Number(parts.find(part => part.type === 'minute')?.value) || 0;
      return clamp(hour + minute / 60, 0, 23.75);
    } catch {
      const now = new Date();
      return clamp(now.getHours() + now.getMinutes() / 60, 0, 23.75);
    }
  }

  function expandedBounds(bounds) {
    if (!bounds?.isValid?.()) return null;
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const latPad = Math.max((north - south) * 0.02, 0.02);
    const lonPad = Math.max((east - west) * 0.02, 0.02);
    return {
      south: south - latPad,
      north: north + latPad,
      west: west - lonPad,
      east: east + lonPad
    };
  }

  function smoothstep(edge0, edge1, value) {
    const x = clamp((value - edge0) / Math.max(edge1 - edge0, 0.0001), 0, 1);
    return x * x * (3 - 2 * x);
  }

  function rgbaForIntensity(value) {
    if (!Number.isFinite(value) || value < MIN_VISIBLE_MM) return [0, 0, 0, 0];

    const stops = [
      { v: 0.10, c: [176, 224, 255], a: 0.13 },
      { v: 0.30, c: [104, 190, 249], a: 0.23 },
      { v: 0.70, c: [42, 144, 229], a: 0.34 },
      { v: 1.50, c: [22, 91, 194], a: 0.46 },
      { v: 3.20, c: [20, 177, 188], a: 0.53 },
      { v: 6.00, c: [72, 193, 111], a: 0.60 },
      { v: 10.0, c: [176, 202, 65], a: 0.67 },
      { v: 16.0, c: [245, 210, 51], a: 0.74 }
    ];

    for (let i = 1; i < stops.length; i += 1) {
      const a = stops[i - 1];
      const b = stops[i];
      if (value <= b.v) {
        const t = smoothstep(a.v, b.v, value);
        return [
          Math.round(lerp(a.c[0], b.c[0], t)),
          Math.round(lerp(a.c[1], b.c[1], t)),
          Math.round(lerp(a.c[2], b.c[2], t)),
          Math.round(lerp(a.a, b.a, t) * 255)
        ];
      }
    }

    const last = stops[stops.length - 1];
    return [...last.c, Math.round(last.a * 255)];
  }

  class VraemWeatherLayer {
    constructor(map, options = {}) {
      this.map = map;
      this.pane = options.pane || 'weatherPane';
      this.toggle = document.getElementById(options.toggleId || 'weatherToggle');
      this.playButton = document.getElementById(options.playId || 'weatherPlay');
      this.range = document.getElementById(options.rangeId || 'weatherHourRange');
      this.timeLabel = document.getElementById(options.timeLabelId || 'weatherTimeLabel');
      this.status = document.getElementById(options.statusId || 'weatherStatus');

      this.bounds = null;
      this.grid = null;
      this.times = [];
      this.frameCache = new Map();
      this.overlayFront = null;
      this.overlayBack = null;
      this.abortController = null;
      this.loadPromise = null;
      this.playTimer = null;
      this.retryTimer = null;
      this.isPlaying = false;
      this.renderPromise = null;
      this.requestedTime = null;
      this.revision = 0;
      this.currentTime = Math.round(peruHour() / PLAY_STEP) * PLAY_STEP;
      this.hasAutoPositioned = false;

      if (this.range) {
        this.range.min = '0';
        this.range.max = '23.75';
        this.range.step = String(PLAY_STEP);
        this.range.value = String(this.currentTime);
        this.range.disabled = true;
      }
      if (this.playButton) this.playButton.disabled = true;

      const saved = localStorage.getItem(STORAGE_KEY);
      if (this.toggle) this.toggle.checked = saved !== '0';

      this.updateTimeLabel();
      this.updateControls(false);
      this.wire();
      this.setStatus(this.toggle?.checked
        ? 'Preparando precipitación pronosticada de hoy.'
        : 'Activa la capa para ver la precipitación de hoy.');
    }

    wire() {
      this.toggle?.addEventListener('change', () => {
        localStorage.setItem(STORAGE_KEY, this.toggle.checked ? '1' : '0');
        if (this.toggle.checked) this.enable();
        else this.disable();
      });

      this.playButton?.addEventListener('click', () => {
        if (this.isPlaying) this.stop();
        else this.play();
      });

      this.range?.addEventListener('input', () => {
        this.stop();
        this.currentTime = clamp(Number(this.range.value) || 0, 0, 23.75);
        this.updateTimeLabel();
        if (this.toggle?.checked) this.showTime(this.currentTime);
      });
    }

    setBounds(bounds) {
      const next = expandedBounds(bounds);
      if (!next) return;
      const key = [next.south, next.north, next.west, next.east]
        .map(value => value.toFixed(3)).join('|');
      const currentKey = this.bounds
        ? [this.bounds.south, this.bounds.north, this.bounds.west, this.bounds.east]
            .map(value => value.toFixed(3)).join('|')
        : '';

      if (key === currentKey) {
        if (this.toggle?.checked && !this.grid) this.enable();
        return;
      }

      this.revision += 1;
      this.stop();
      this.cancelRetry();
      this.abortController?.abort();
      this.abortController = null;
      this.loadPromise = null;
      this.grid = null;
      this.times = [];
      this.requestedTime = null;
      this.renderPromise = null;
      this.hasAutoPositioned = false;
      this.frameCache.clear();
      this.removeOverlays();
      this.bounds = next;

      if (this.toggle?.checked) this.enable();
      else this.setStatus('Activa la capa para ver la precipitación de hoy.');
    }

    setStatus(text) {
      if (this.status) this.status.textContent = text;
    }

    updateControls(ready) {
      if (this.playButton) this.playButton.disabled = !ready;
      if (this.range) this.range.disabled = !ready;
      this.updatePlayIcon();
    }

    updateTimeLabel() {
      if (!this.timeLabel) return;
      let totalMinutes = Math.round(this.currentTime * 60);
      totalMinutes = ((totalMinutes % 1440) + 1440) % 1440;
      const hour = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      this.timeLabel.textContent = `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }

    updatePlayIcon() {
      const icon = this.playButton?.querySelector('i');
      if (!icon) return;
      icon.className = this.isPlaying ? 'bi bi-pause-fill' : 'bi bi-play-fill';
      this.playButton.title = this.isPlaying ? 'Pausar pronóstico' : 'Reproducir pronóstico';
    }

    cancelRetry() {
      if (this.retryTimer) window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    scheduleRetry() {
      this.cancelRetry();
      if (!this.toggle?.checked || !this.bounds) return;
      this.retryTimer = window.setTimeout(() => {
        this.retryTimer = null;
        if (!this.toggle?.checked || this.grid) return;
        this.enable({ retry: true });
      }, 3500);
    }

    async enable({ retry = false } = {}) {
      if (!this.toggle || !this.bounds) return;
      this.toggle.checked = true;
      localStorage.setItem(STORAGE_KEY, '1');
      const revision = this.revision;
      this.setStatus(retry ? 'Reintentando pronóstico de hoy.' : 'Descargando precipitación de hoy.');

      try {
        await this.ensureData();
        if (revision !== this.revision || !this.toggle.checked) return;

        if (!this.hasAutoPositioned) {
          this.currentTime = this.bestInitialTime(this.currentTime);
          this.hasAutoPositioned = true;
        }

        if (this.range) this.range.value = String(this.currentTime);
        this.updateTimeLabel();
        this.updateControls(true);
        await this.showTime(this.currentTime);
      } catch (error) {
        if (error?.name === 'AbortError') return;
        console.warn('[Precipitación V29] No se pudo cargar el pronóstico.', error);
        this.updateControls(false);
        this.removeOverlays();
        this.setStatus('No se pudo actualizar la precipitación. Reintentando automáticamente.');
        this.scheduleRetry();
      }
    }

    disable() {
      this.revision += 1;
      if (this.toggle) this.toggle.checked = false;
      localStorage.setItem(STORAGE_KEY, '0');
      this.stop();
      this.cancelRetry();
      this.abortController?.abort();
      this.abortController = null;
      this.loadPromise = null;
      this.requestedTime = null;
      this.renderPromise = null;
      this.removeOverlays();
      this.updateControls(false);
      this.setStatus('Precipitación desactivada.');
    }

    async play() {
      if (!this.toggle?.checked) {
        this.toggle.checked = true;
        await this.enable();
      } else if (!this.grid) {
        await this.enable();
      }
      if (!this.grid || this.isPlaying) return;
      this.isPlaying = true;
      this.updatePlayIcon();
      this.playTick();
    }

    async playTick() {
      if (!this.isPlaying || !this.grid || !this.toggle?.checked) return;
      this.currentTime += PLAY_STEP;
      if (this.currentTime > 23.75) this.currentTime = 0;
      if (this.range) this.range.value = String(this.currentTime);
      this.updateTimeLabel();
      try {
        await this.showTime(this.currentTime);
      } catch {}
      if (!this.isPlaying) return;
      this.playTimer = window.setTimeout(() => this.playTick(), PLAY_PAUSE_MS);
    }

    stop() {
      this.isPlaying = false;
      if (this.playTimer) window.clearTimeout(this.playTimer);
      this.playTimer = null;
      this.updatePlayIcon();
    }

    gridPoints() {
      const points = [];
      for (let row = 0; row < GRID_ROWS; row += 1) {
        const fy = row / (GRID_ROWS - 1);
        const lat = lerp(this.bounds.north, this.bounds.south, fy);
        for (let col = 0; col < GRID_COLS; col += 1) {
          const fx = col / (GRID_COLS - 1);
          const lon = lerp(this.bounds.west, this.bounds.east, fx);
          points.push({ row, col, lat, lon });
        }
      }
      return points;
    }

    async ensureData() {
      if (this.grid) return this.grid;
      if (this.loadPromise) return this.loadPromise;
      if (!this.bounds) throw new Error('Sin límites meteorológicos.');

      const controller = new AbortController();
      this.abortController?.abort();
      this.abortController = controller;
      const revision = this.revision;

      this.loadPromise = this.fetchGrid(controller.signal)
        .then(grid => {
          if (revision !== this.revision) throw new DOMException('Capa reemplazada', 'AbortError');
          this.grid = grid;
          return grid;
        })
        .finally(() => {
          if (this.abortController === controller) this.abortController = null;
          this.loadPromise = null;
        });

      return this.loadPromise;
    }

    async fetchForecastBatch(points, signal, includeProbability = true) {
      const hourly = includeProbability
        ? 'precipitation,precipitation_probability'
        : 'precipitation';
      const params = new URLSearchParams({
        latitude: points.map(point => point.lat.toFixed(5)).join(','),
        longitude: points.map(point => point.lon.toFixed(5)).join(','),
        hourly,
        timezone: 'America/Lima',
        forecast_days: '1'
      });

      const response = await fetch(`${API_URL}?${params.toString()}`, {
        signal,
        cache: 'no-store',
        mode: 'cors'
      });
      if (!response.ok) throw new Error(`Open-Meteo ${response.status}`);

      let payload = await response.json();
      if (!Array.isArray(payload)) payload = [payload];
      if (payload.length !== points.length) {
        throw new Error(`Respuesta meteorológica incompleta: ${payload.length}/${points.length}`);
      }
      return payload;
    }

    async fetchGrid(signal) {
      const points = this.gridPoints();
      const grid = Array.from({ length: GRID_ROWS }, () =>
        Array.from({ length: GRID_COLS }, () => null));
      let canonicalTimes = [];

      // Peticiones pequeñas y secuenciales: evita URLs excesivamente largas y
      // hace la capa mucho más estable en navegadores/redes restrictivas.
      const BATCH_SIZE = 18;
      for (let offset = 0; offset < points.length; offset += BATCH_SIZE) {
        if (signal.aborted) throw new DOMException('Solicitud cancelada', 'AbortError');
        const batch = points.slice(offset, offset + BATCH_SIZE);
        let payload;
        try {
          payload = await this.fetchForecastBatch(batch, signal, true);
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          console.warn('[Precipitación V29] Reintentando lote sin probabilidad.', error);
          payload = await this.fetchForecastBatch(batch, signal, false);
        }

        batch.forEach((point, index) => {
          const item = payload[index];
          if (!item?.hourly?.precipitation) return;
          if (!canonicalTimes.length) canonicalTimes = item.hourly.time || [];
          grid[point.row][point.col] = {
            precipitation: item.hourly.precipitation || Array(24).fill(0),
            probability: item.hourly.precipitation_probability || null
          };
        });
      }

      const valid = grid.flat().filter(Boolean).length;
      if (valid < Math.ceil(points.length * 0.8)) {
        throw new Error(`Malla meteorológica incompleta: ${valid}/${points.length}`);
      }

      this.times = canonicalTimes;
      return grid;
    }

    hourlySample(row, col, hour) {
      const item = this.grid?.[row]?.[col];
      if (!item) return 0;

      const precipitation = numberValue(item.precipitation?.[hour]);
      if (precipitation < 0.06) return 0;

      const rawProbability = item.probability?.[hour];
      const probability = rawProbability === null || rawProbability === undefined
        ? 100
        : numberValue(rawProbability);
      if (probability < 15 && precipitation < 0.55) return 0;

      const probabilityWeight = clamp((probability - 12) / 88, 0, 1);
      return precipitation * (0.64 + 0.36 * probabilityWeight);
    }

    sample(row, col, timeValue) {
      const hour0 = clamp(Math.floor(timeValue), 0, 23);
      const hour1 = Math.min(23, hour0 + 1);
      const t = clamp(timeValue - hour0, 0, 1);
      return lerp(
        this.hourlySample(row, col, hour0),
        this.hourlySample(row, col, hour1),
        t
      );
    }

    gridPeakAt(timeValue) {
      let peak = 0;
      for (let row = 0; row < GRID_ROWS; row += 1) {
        for (let col = 0; col < GRID_COLS; col += 1) {
          peak = Math.max(peak, this.sample(row, col, timeValue));
        }
      }
      return peak;
    }

    bestInitialTime(preferred) {
      const snapped = clamp(Math.round(preferred / PLAY_STEP) * PLAY_STEP, 0, 23.75);
      if (this.gridPeakAt(snapped) >= MIN_VISIBLE_MM) return snapped;

      let bestTime = snapped;
      let bestPeak = 0;
      for (let hour = 0; hour < 24; hour += 1) {
        const peak = this.gridPeakAt(hour);
        if (peak > bestPeak) {
          bestPeak = peak;
          bestTime = hour;
        }
      }
      return bestPeak >= MIN_VISIBLE_MM ? bestTime : snapped;
    }

    frameKey(timeValue) {
      return clamp(Math.round(timeValue / PLAY_STEP) * PLAY_STEP, 0, 23.75);
    }

    cacheFrame(key, value) {
      if (this.frameCache.has(key)) this.frameCache.delete(key);
      this.frameCache.set(key, value);
      while (this.frameCache.size > CACHE_LIMIT) {
        const first = this.frameCache.keys().next().value;
        this.frameCache.delete(first);
      }
    }

    frameDataUrl(timeValue) {
      const key = this.frameKey(timeValue);
      if (this.frameCache.has(key)) {
        const cached = this.frameCache.get(key);
        this.frameCache.delete(key);
        this.frameCache.set(key, cached);
        return cached;
      }

      const canvas = document.createElement('canvas');
      canvas.width = FRAME_WIDTH;
      canvas.height = FRAME_HEIGHT;
      const ctx = canvas.getContext('2d', { alpha: true });
      const image = ctx.createImageData(FRAME_WIDTH, FRAME_HEIGHT);
      const data = image.data;
      let maxValue = 0;

      for (let y = 0; y < FRAME_HEIGHT; y += 1) {
        const gy = (y / (FRAME_HEIGHT - 1)) * (GRID_ROWS - 1);
        const r0 = Math.floor(gy);
        const r1 = Math.min(GRID_ROWS - 1, r0 + 1);
        const ty = gy - r0;

        for (let x = 0; x < FRAME_WIDTH; x += 1) {
          const gx = (x / (FRAME_WIDTH - 1)) * (GRID_COLS - 1);
          const c0 = Math.floor(gx);
          const c1 = Math.min(GRID_COLS - 1, c0 + 1);
          const tx = gx - c0;
          let value = bilinear(
            this.sample(r0, c0, key),
            this.sample(r0, c1, key),
            this.sample(r1, c0, key),
            this.sample(r1, c1, key),
            tx,
            ty
          );

          if (value < MIN_VISIBLE_MM) value = 0;
          if (value > 0 && value < 0.32) {
            value *= smoothstep(MIN_VISIBLE_MM, 0.32, value);
          }

          maxValue = Math.max(maxValue, value);
          const [r, g, b, a] = rgbaForIntensity(value);
          const index = (y * FRAME_WIDTH + x) * 4;
          data[index] = r;
          data[index + 1] = g;
          data[index + 2] = b;
          data[index + 3] = a;
        }
      }

      ctx.putImageData(image, 0, 0);
      const result = { url: canvas.toDataURL('image/png'), maxValue };
      this.cacheFrame(key, result);
      return result;
    }

    targetOpacity() {
      const zoom = this.map.getZoom();
      if (zoom >= 18) return 0.34;
      if (zoom >= 16) return 0.42;
      if (zoom >= 14) return 0.52;
      return 0.61;
    }

    leafletBounds() {
      return L.latLngBounds(
        [this.bounds.south, this.bounds.west],
        [this.bounds.north, this.bounds.east]
      );
    }

    ensureOverlays() {
      if (!this.bounds) return;
      const bounds = this.leafletBounds();
      const transparentPixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

      if (!this.overlayFront) {
        this.overlayFront = L.imageOverlay(transparentPixel, bounds, {
          pane: this.pane,
          opacity: 0,
          interactive: false,
          className: 'weather-raster-overlay'
        }).addTo(this.map);
      } else {
        this.overlayFront.setBounds(bounds);
      }

      if (!this.overlayBack) {
        this.overlayBack = L.imageOverlay(transparentPixel, bounds, {
          pane: this.pane,
          opacity: 0,
          interactive: false,
          className: 'weather-raster-overlay'
        }).addTo(this.map);
      } else {
        this.overlayBack.setBounds(bounds);
      }
    }

    preload(url) {
      return new Promise(resolve => {
        const image = new Image();
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        image.onload = finish;
        image.onerror = finish;
        image.src = url;
        if (image.decode) image.decode().then(finish).catch(() => {});
        window.setTimeout(finish, 180);
      });
    }

    waitOverlayLoad(overlay, timeout = 180) {
      return new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          try { overlay.off('load', finish); } catch {}
          resolve();
        };
        overlay.once('load', finish);
        window.setTimeout(finish, timeout);
      });
    }

    async commitFrame(frame, revision) {
      this.ensureOverlays();
      if (!this.overlayFront || !this.overlayBack) return;
      await this.preload(frame.url);
      if (revision !== this.revision || !this.toggle?.checked) return;

      const front = this.overlayFront;
      const back = this.overlayBack;
      const opacity = this.targetOpacity();

      back.setOpacity(0);
      back.bringToFront?.();
      const loaded = this.waitOverlayLoad(back);
      back.setUrl(frame.url);
      await loaded;
      if (revision !== this.revision || !this.toggle?.checked) return;

      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      back.setOpacity(opacity);
      front.setOpacity(0);
      await delay(FADE_MS + 20);
      if (revision !== this.revision || !this.toggle?.checked) return;

      this.overlayFront = back;
      this.overlayBack = front;
      this.overlayBack.setOpacity(0);
    }

    async renderRequestedTimes() {
      while (this.requestedTime !== null) {
        const target = this.requestedTime;
        this.requestedTime = null;
        const revision = this.revision;

        await this.ensureData();
        if (revision !== this.revision || !this.toggle?.checked || !this.grid || !this.bounds) continue;

        const safeTime = this.frameKey(target);
        this.currentTime = safeTime;
        if (this.range) this.range.value = String(safeTime);
        this.updateTimeLabel();

        const frame = this.frameDataUrl(safeTime);
        const label = this.timeLabel?.textContent || '';
        if (frame.maxValue < MIN_VISIBLE_MM) {
          this.setStatus(`Sin precipitación significativa prevista a las ${label}.`);
        } else {
          this.setStatus(`Precipitación pronosticada para las ${label}.`);
        }

        await this.commitFrame(frame, revision);

        const nextTime = safeTime + PLAY_STEP <= 23.75 ? safeTime + PLAY_STEP : 0;
        const prefetch = () => {
          if (revision !== this.revision || !this.grid) return;
          try { this.frameDataUrl(nextTime); } catch {}
        };
        if ('requestIdleCallback' in window) window.requestIdleCallback(prefetch, { timeout: 350 });
        else window.setTimeout(prefetch, 30);
      }
    }

    showTime(timeValue) {
      if (!this.toggle?.checked) return Promise.resolve();
      this.requestedTime = this.frameKey(timeValue);
      if (this.renderPromise) return this.renderPromise;

      this.renderPromise = this.renderRequestedTimes()
        .catch(error => {
          if (error?.name !== 'AbortError') console.warn('[Precipitación V29] Error al renderizar frame.', error);
        })
        .finally(() => {
          this.renderPromise = null;
          if (this.requestedTime !== null && this.toggle?.checked) this.showTime(this.requestedTime);
        });
      return this.renderPromise;
    }

    syncZoomOpacity() {
      if (!this.toggle?.checked) return;
      const opacity = this.targetOpacity();
      if (this.overlayFront) this.overlayFront.setOpacity(opacity);
      if (this.overlayBack) this.overlayBack.setOpacity(0);
    }

    removeOverlays() {
      [this.overlayFront, this.overlayBack].forEach(layer => {
        if (layer && this.map.hasLayer(layer)) {
          try { this.map.removeLayer(layer); } catch {}
        }
      });
      this.overlayFront = null;
      this.overlayBack = null;
    }
  }

  window.VraemWeatherLayer = VraemWeatherLayer;
})();
