import { WebGLWaterfall } from "./webgl-waterfall.js";
import { WebGLSpectrum } from "./webgl-spectrum.js";
import { frameBins, sampleBin } from "./frame-decode.js";

const PALETTE = [
  [0, 0, 8],
  [0, 0, 48],
  [0, 24, 96],
  [0, 80, 140],
  [0, 140, 140],
  [20, 170, 60],
  [120, 200, 20],
  [220, 210, 0],
  [255, 140, 0],
  [255, 40, 0],
  [255, 255, 220],
];

const LS_KEY = "rtl-radio-viz";

export class SpectrumDisplay {
  constructor(spectrumCanvas, waterfallCanvas) {
    this.specCanvas = spectrumCanvas;
    this.wfCanvas = waterfallCanvas;
    this.specGl = new WebGLSpectrum(spectrumCanvas);
    this.specCanvas2d = !this.specGl.ok;
    this.specCtx = this.specCanvas2d ? spectrumCanvas.getContext("2d") : null;
    this.wfGl = new WebGLWaterfall(waterfallCanvas);
    this.wfCanvas2d = !this.wfGl.ok;
    if (this.wfCanvas2d) {
      this.wfCtx = waterfallCanvas.getContext("2d");
    } else {
      this.wfCtx = null;
    }
    this.wfImage = null;
    this.lastFrameId = 0;
    this.lastFrame = null;
    this._wfBins = null;
    this._wfActive = false;
    this._wfLastTs = 0;
    this._wfRaf = 0;

    // Semi-transparent frequency axis overlay (WebGL canvas can't draw text)
    this.axisCanvas = document.createElement("canvas");
    this.axisCanvas.id = "spec-axis";
    this.axisCanvas.setAttribute("aria-hidden", "true");
    const specParent = spectrumCanvas?.parentElement;
    if (specParent) {
      specParent.style.position = "relative";
      specParent.appendChild(this.axisCanvas);
    }
    this.axisCtx = this.axisCanvas.getContext("2d");

    // SDR#-style hover preview (dashed bandwidth ghost follows cursor)
    this.hoverXNorm = { spec: null, wf: null };
    this.previewSpecCanvas = this._createPreviewOverlay(specParent);
    this.previewSpecCtx = this.previewSpecCanvas?.getContext("2d") ?? null;
    const wfParent = waterfallCanvas?.parentElement;
    if (wfParent) wfParent.style.position = "relative";
    this.previewWfCanvas = this._createPreviewOverlay(wfParent);
    this.previewWfCtx = this.previewWfCanvas?.getContext("2d") ?? null;

    // SDR# ZOOM: 1 = full IQ span (~0…2M), 100 = ±100 Hz window
    this.specZoom = 1;
    this.specRange = 100;
    this.specOffset = 0;
    this.wfContrast = 50;
    this.wfSpeed = 16;
    this.bandwidthHz = 0;
    this.panOffsetHz = 0;
    this._axisKey = "";

    this.loadSettings();
    this.wfGl.setContrast(this.wfContrast);
    this.wfGl.setDbScale?.(this.specOffset, this.specRange);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
        this._resizeRaf = requestAnimationFrame(() => this.resize());
      });
      const specParent = spectrumCanvas?.parentElement;
      const wfParent = waterfallCanvas?.parentElement;
      if (specParent) this.resizeObserver.observe(specParent);
      if (wfParent) this.resizeObserver.observe(wfParent);
    }
    this.resize();
  }

  loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      if (s.specZoom) this.specZoom = Math.max(1, Math.min(100, s.specZoom));
      // Old 1…64 zoom factor → reset to full span (SDR#-style slider is 1…100).
      if (s.zoomV !== 1) {
        this.specZoom = 1;
        this.saveSettings({ zoomV: 1, specZoom: 1 });
      }
      if (s.specRange) this.specRange = s.specRange;
      if (s.specOffset !== undefined) this.specOffset = s.specOffset;
      // v7: SDR# Range 10…160, Offset 0…−150; default 0…−100.
      if (s.dbfsV !== 7) {
        this.specOffset = 0;
        this.specRange = 100;
        this.saveSettings({
          dbfsV: 7,
          specOffset: this.specOffset,
          specRange: this.specRange,
        });
      }
      this.specRange = Math.max(10, Math.min(160, this.specRange));
      this.specOffset = Math.max(-150, Math.min(0, this.specOffset));
      if (s.wfContrast) this.wfContrast = s.wfContrast;
      if (s.wfSpeed) this.wfSpeed = Math.max(8, s.wfSpeed);
      if (s.specPane) {
        document.documentElement.style.setProperty("--spec-pane", `${s.specPane}%`);
      }
    } catch {
      /* ignore */
    }
  }

  saveSettings(patch) {
    try {
      const cur = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      localStorage.setItem(LS_KEY, JSON.stringify({ ...cur, ...patch }));
    } catch {
      /* ignore */
    }
  }

  setBandwidthHz(hz) {
    this.bandwidthHz = hz;
    this.redraw();
    this._redrawHoverPreviews();
  }

  resetPan() {
    this.panOffsetHz = 0;
    this._axisKey = "";
    this.redraw();
  }

  setPanOffsetHz(hz, frame = null) {
    if (frame?.sample_rate_hz) {
      const span = this.effectiveSpanHz(frame.sample_rate_hz);
      const max = span * 0.45;
      this.panOffsetHz = Math.max(-max, Math.min(max, hz));
    } else {
      this.panOffsetHz = hz;
    }
    this._axisKey = "";
    this.redraw();
  }

  displayCenterHz(frame) {
    return (frame?.center_hz ?? 0) + this.panOffsetHz;
  }

  panFrac(frame) {
    if (!frame?.sample_rate_hz) return 0;
    return this.panOffsetHz / this.effectiveSpanHz(frame.sample_rate_hz);
  }

  /** Screen X (0–1) where the tuned center frequency sits while panning. */
  tunedXNorm(frame) {
    if (!frame?.sample_rate_hz) return 0.5;
    return 0.5 - this.panOffsetHz / this.effectiveSpanHz(frame.sample_rate_hz);
  }

  /** Bandwidth used for on-screen band width (may cap to visible span). */
  effectiveBandwidthHz(frame) {
    if (!this.bandwidthHz) return 0;
    if (!frame?.sample_rate_hz) return this.bandwidthHz;
    const span = this.effectiveSpanHz(frame.sample_rate_hz);
    return Math.min(this.bandwidthHz, span);
  }

  /** Band rectangle in CSS pixels; centerXNorm is 0–1 along canvas width. */
  bandRectCss(canvas, frame, centerXNorm) {
    if (!frame?.sample_rate_hz || !this.bandwidthHz) return null;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(rect.width, 1);
    const span = this.effectiveSpanHz(frame.sample_rate_hz);
    const bw = this.effectiveBandwidthHz(frame);
    if (bw <= 0 || span <= 0) return null;
    const bandW = (bw / span) * w;
    const cx = centerXNorm * w;
    return { cx, x1: cx - bandW / 2, x2: cx + bandW / 2, bandW, rect, w };
  }

  bandwidthEdgePx(canvas, frame) {
    const tunedXNorm = this.tunedXNorm(frame);
    const band = this.bandRectCss(canvas, frame, tunedXNorm);
    if (!band) return null;
    return { x1: band.x1, x2: band.x2 };
  }

  hitBandwidthEdge(canvas, clientX, frame, tol = 12) {
    const edge = this.bandwidthEdgePx(canvas, frame);
    if (!edge) return null;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    if (Math.abs(px - edge.x1) <= tol) return "left";
    if (Math.abs(px - edge.x2) <= tol) return "right";
    return null;
  }

  /** Hit the thick gold handle blocks on the tuned band (only these resize BW). */
  hitBandwidthHandle(canvas, clientX, clientY, frame) {
    const tunedXNorm = this.tunedXNorm(frame);
    const band = this.bandRectCss(canvas, frame, tunedXNorm);
    if (!band) return null;
    const px = clientX - band.rect.left;
    const py = clientY - band.rect.top;
    const handleH = Math.min(band.rect.height * 0.22, 28);
    const handleY = (band.rect.height - handleH) / 2;
    const handleW = 6;
    const pad = 2;
    for (const [x, side] of [
      [band.x1, "left"],
      [band.x2, "right"],
    ]) {
      const x1 = x - handleW / 2 - pad;
      const x2 = x + handleW / 2 + pad;
      const y1 = handleY - pad;
      const y2 = handleY + handleH + pad;
      if (px >= x1 && px <= x2 && py >= y1 && py <= y2) return side;
    }
    return null;
  }

  hitPreviewBandwidthEdge(canvas, clientX, frame, xNorm, tol = 12) {
    const band = this.bandRectCss(canvas, frame, xNorm);
    if (!band) return null;
    const px = clientX - band.rect.left;
    if (Math.abs(px - band.x1) <= tol) return "left";
    if (Math.abs(px - band.x2) <= tol) return "right";
    return null;
  }

  bandwidthFromEdgePx(canvas, clientX, frame, centerXNorm, side, limits) {
    const band = this.bandRectCss(canvas, frame, centerXNorm);
    if (!band) return limits.min;
    const px = clientX - band.rect.left;
    const halfPx = side === "left" ? band.cx - px : px - band.cx;
    const span = this.effectiveSpanHz(frame.sample_rate_hz);
    const bw = (Math.max(0, halfPx) / band.w) * span * 2;
    return Math.round(Math.max(limits.min, Math.min(limits.max, bw)));
  }

  bandwidthFromEdge(canvas, clientX, frame, side, limits) {
    return this.bandwidthFromEdgePx(canvas, clientX, frame, this.tunedXNorm(frame), side, limits);
  }

  bandwidthFromPreviewEdge(canvas, clientX, frame, centerXNorm, side, limits) {
    return this.bandwidthFromEdgePx(canvas, clientX, frame, centerXNorm, side, limits);
  }

  /** Map a screen click to RF frequency (Hz) using the latest spectrum frame. */
  freqHzAtClick(canvas, clientX, frame) {
    if (!frame?.center_hz || !frame?.sample_rate_hz) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const span = this.effectiveSpanHz(frame.sample_rate_hz);
    return this.displayCenterHz(frame) + (x - 0.5) * span;
  }

  setSpecZoom(n) {
    this.specZoom = Math.max(1, Math.min(100, n));
    this._axisKey = "";
    this.saveSettings({ specZoom: this.specZoom });
    this.redraw();
    this._redrawHoverPreviews();
  }

  setSpecRange(n) {
    this.specRange = Math.max(10, Math.min(160, n));
    this._axisKey = "";
    this.saveSettings({ specRange: this.specRange, dbfsV: 7 });
    this.wfGl.setDbScale?.(this.specOffset, this.specRange);
    this.redraw();
  }

  setSpecOffset(n) {
    this.specOffset = Math.max(-150, Math.min(0, n));
    this._axisKey = "";
    this.saveSettings({ specOffset: this.specOffset, dbfsV: 7 });
    this.wfGl.setDbScale?.(this.specOffset, this.specRange);
    this.redraw();
  }

  setWfContrast(n) {
    this.wfContrast = Math.max(10, Math.min(100, n));
    this.saveSettings({ wfContrast: this.wfContrast });
    this.wfGl.setContrast(this.wfContrast);
    this.wfGl.setDbScale?.(this.specOffset, this.specRange);
  }

  setWfSpeed(n) {
    this.wfSpeed = Math.max(4, Math.min(32, n));
    this.saveSettings({ wfSpeed: this.wfSpeed });
  }

  setWaterfallActive(active) {
    this._wfActive = active;
  }

  setSpecPanePercent(pct) {
    const v = Math.max(25, Math.min(75, pct));
    document.documentElement.style.setProperty("--spec-pane", `${v}%`);
    this.saveSettings({ specPane: v });
    this.resize();
  }

  viewBins(bins, sampleRateHz = null) {
    const n = bins.length;
    if (n < 2) return bins;
    const sr = sampleRateHz ?? this.lastFrame?.sample_rate_hz ?? 2_048_000;
    const z = this.zoomFactor(sr);
    const half = n / (2 * z);
    const c = n / 2;
    const s = Math.max(0, Math.floor(c - half));
    const e = Math.min(n, Math.ceil(c + half));
    return bins.subarray(s, e);
  }

  /** Resample zoomed bins to `outLen` with linear interpolation (anti-mosaic). */
  resampleBins(bins, outLen) {
    const view = this.viewBins(bins);
    const n = view.length;
    if (n < 2 || outLen < 2) return view;
    if (n >= outLen && n < outLen * 1.5) return view;
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const t = (i / (outLen - 1)) * (n - 1);
      out[i] = sampleBin(view, t);
    }
    return out;
  }

  dbToY(db, h) {
    const top = this.specOffset;
    const bottom = this.specOffset - this.specRange;
    const clamped = Math.max(bottom, Math.min(top, db));
    return h - ((clamped - bottom) / (top - bottom)) * h;
  }

  /**
   * Visible RF span. ZOOM 1 → full sample rate (~0…2 MHz);
   * ZOOM 100 → ±100 Hz (SDR# max zoom).
   */
  effectiveSpanHz(sampleRateHz) {
    const sr = Math.max(1, sampleRateHz || 1);
    const minSpan = Math.min(200, sr); // ±100 Hz
    const t = (Math.max(1, Math.min(100, this.specZoom)) - 1) / 99;
    // Exponential ease: more resolution near the narrow end
    const eased = t * t;
    return sr * (1 - eased) + minSpan * eased;
  }

  /** Zoom factor used by WebGL bin slicing (sr / visible span). */
  zoomFactor(sampleRateHz) {
    const sr = Math.max(1, sampleRateHz || 1);
    return sr / Math.max(1, this.effectiveSpanHz(sr));
  }

  _createPreviewOverlay(parent) {
    if (!parent) return null;
    const c = document.createElement("canvas");
    c.className = "viz-preview";
    c.setAttribute("aria-hidden", "true");
    parent.appendChild(c);
    return c;
  }

  _syncWfPreviewLayout() {
    const parent = this.wfCanvas?.parentElement;
    if (!this.previewWfCanvas || !this.wfCanvas || !parent) return;
    const pr = parent.getBoundingClientRect();
    const tr = this.wfCanvas.getBoundingClientRect();
    this.previewWfCanvas.style.left = `${tr.left - pr.left}px`;
    this.previewWfCanvas.style.top = `${tr.top - pr.top}px`;
    this.previewWfCanvas.style.width = `${tr.width}px`;
    this.previewWfCanvas.style.height = `${tr.height}px`;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(tr.width * dpr));
    const h = Math.max(1, Math.floor(tr.height * dpr));
    if (this.previewWfCanvas.width !== w || this.previewWfCanvas.height !== h) {
      this.previewWfCanvas.width = w;
      this.previewWfCanvas.height = h;
    }
  }

  /** Map normalized X (0–1) to preview band pixel edges on an overlay canvas. */
  previewBandPx(overlayW, frame, xNorm) {
    if (!frame?.sample_rate_hz || !this.bandwidthHz) return null;
    const span = this.effectiveSpanHz(frame.sample_rate_hz);
    const bw = this.effectiveBandwidthHz(frame);
    if (bw <= 0 || span <= 0) return null;
    const bandW = (bw / span) * overlayW;
    const cx = xNorm * overlayW;
    return { cx, x1: cx - bandW / 2, x2: cx + bandW / 2 };
  }

  setHoverPreview(which, clientX, canvas, frame) {
    if (!frame?.sample_rate_hz || !this.bandwidthHz) {
      this.clearHoverPreview(which);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const xNorm = (clientX - rect.left) / rect.width;
    if (xNorm < 0 || xNorm > 1) {
      this.clearHoverPreview(which);
      return;
    }
    const other = which === "spec" ? "wf" : "spec";
    if (this.hoverXNorm[other] != null) this.clearHoverPreview(other);
    this.hoverXNorm[which] = xNorm;
    this.drawHoverPreview(which, frame);
  }

  clearHoverPreview(which) {
    this.hoverXNorm[which] = null;
    const canvas = which === "spec" ? this.previewSpecCanvas : this.previewWfCanvas;
    const ctx = which === "spec" ? this.previewSpecCtx : this.previewWfCtx;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  clearAllHoverPreviews() {
    this.clearHoverPreview("spec");
    this.clearHoverPreview("wf");
  }

  drawHoverPreview(which, frame) {
    const xNorm = this.hoverXNorm[which];
    const overlay = which === "spec" ? this.previewSpecCanvas : this.previewWfCanvas;
    const ctx = which === "spec" ? this.previewSpecCtx : this.previewWfCtx;
    if (xNorm == null || !ctx || !overlay || !frame?.sample_rate_hz) return;

    const w = overlay.width;
    const h = overlay.height;
    ctx.clearRect(0, 0, w, h);
    const band = this.previewBandPx(w, frame, xNorm);
    if (!band) return;

    const x1 = Math.max(0, band.x1);
    const x2 = Math.min(w, band.x2);
    const dpr = window.devicePixelRatio || 1;

    ctx.fillStyle = "rgba(130, 135, 145, 0.24)";
    ctx.fillRect(x1, 0, x2 - x1, h);

    const dash = [7 * dpr, 5 * dpr];
    const drawVLine = (x, solid) => {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.strokeStyle = solid ? "rgba(224, 82, 82, 0.92)" : "rgba(224, 82, 82, 0.62)";
      ctx.lineWidth = Math.max(1, dpr * (solid ? 1.2 : 1));
      ctx.setLineDash(solid ? [] : dash);
      ctx.stroke();
    };
    drawVLine(band.cx, true);
    if (band.x1 >= 0) drawVLine(band.x1, false);
    if (band.x2 <= w) drawVLine(band.x2, false);
    ctx.setLineDash([]);

    const span = this.effectiveSpanHz(frame.sample_rate_hz);
    const hz = this.displayCenterHz(frame) + (xNorm - 0.5) * span;
    const mhz = hz / 1e6;
    const bwLabel =
      this.bandwidthHz >= 1_000_000
        ? `${(this.bandwidthHz / 1_000_000).toFixed(2)} MHz`
        : `${(this.bandwidthHz / 1000).toFixed(2)} kHz`;
    const freqLabel = mhz >= 100 ? mhz.toFixed(3) : mhz >= 10 ? mhz.toFixed(4) : mhz.toFixed(6);
    const text = `${freqLabel} MHz · BW ${bwLabel}`;

    const fontPx = Math.max(10, Math.min(12, w * 0.011));
    ctx.font = `${fontPx}px IBM Plex Mono, ui-monospace, monospace`;
    const tw = ctx.measureText(text).width;
    const pad = 5 * dpr;
    const labelX = Math.max(pad, Math.min(w - tw - pad * 2, band.cx - tw / 2));
    const labelTop = which === "spec" ? h * 0.08 : h * 0.06;

    ctx.fillStyle = "rgba(5, 6, 10, 0.78)";
    ctx.fillRect(labelX - pad, labelTop, tw + pad * 2, fontPx + pad * 1.4);
    ctx.fillStyle = "rgba(230, 236, 245, 0.94)";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(text, labelX, labelTop + pad * 0.4);
  }

  _redrawHoverPreviews() {
    if (!this.lastFrame) return;
    if (this.hoverXNorm.spec != null) this.drawHoverPreview("spec", this.lastFrame);
    if (this.hoverXNorm.wf != null) this.drawHoverPreview("wf", this.lastFrame);
  }

  resize() {
    for (const c of [this.specCanvas, this.wfCanvas, this.axisCanvas, this.previewSpecCanvas]) {
      if (!c) continue;
      const rect = c === this.axisCanvas
        ? this.specCanvas.getBoundingClientRect()
        : c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
    this._syncWfPreviewLayout();
    if (this.wfGl.ok) {
      this.wfGl.setContrast(this.wfContrast);
      this.wfGl.setDbScale?.(this.specOffset, this.specRange);
      this.wfGl.resize(this.wfCanvas.width, this.wfCanvas.height);
    } else {
      this.initWaterfallImage();
    }
    if (this.specGl.ok) {
      this.specGl.resize(this.specCanvas.width, this.specCanvas.height);
    }
    this.resetPan();
    this._axisKey = "";
    this.redraw();
    this._redrawHoverPreviews();
  }

  redraw() {
    if (this.lastFrame) {
      this.lastFrameId = 0;
      this.update(this.lastFrame);
    }
  }

  initWaterfallImage() {
    if (!this.wfCtx) return;
    const w = this.wfCanvas.width;
    const h = this.wfCanvas.height;
    this.wfImage = this.wfCtx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      this.wfImage.data[i * 4] = 5;
      this.wfImage.data[i * 4 + 1] = 6;
      this.wfImage.data[i * 4 + 2] = 8;
      this.wfImage.data[i * 4 + 3] = 255;
    }
    this.wfCtx.putImageData(this.wfImage, 0, 0);
  }

  dbToColor(db) {
    // Absolute dBFS — map through current OFFSET/RANGE, contrast stretches the floor.
    const top = this.specOffset;
    const span = this.specRange / Math.max(0.35, this.wfContrast / 50);
    const bottom = top - span;
    const norm = Math.max(0, Math.min(1, (db - bottom) / Math.max(1e-6, top - bottom)));
    const idx = norm * (PALETTE.length - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(PALETTE.length - 1, i0 + 1);
    const f = idx - i0;
    const a = PALETTE[i0];
    const b = PALETTE[i1];
    return [
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f),
    ];
  }

  drawBandwidthShade(ctx, w, h, centerHz, sampleRateHz) {
    if (!this.bandwidthHz || !centerHz || !sampleRateHz) return;
    const span = this.effectiveSpanHz(sampleRateHz);
    const frame = { center_hz: centerHz, sample_rate_hz: sampleRateHz };
    const bw = this.effectiveBandwidthHz(frame);
    if (bw <= 0) return;
    const tunedX = this.tunedXNorm(frame) * w;
    const bandW = (bw / span) * w;
    const x1 = tunedX - bandW / 2;
    const x2 = tunedX + bandW / 2;
    ctx.fillStyle = "rgba(212, 160, 23, 0.14)";
    ctx.fillRect(x1, 0, x2 - x1, h);
    ctx.strokeStyle = "rgba(212, 160, 23, 0.4)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x1 + 0.5, 0.5, x2 - x1 - 1, h - 1);
    const handleH = Math.min(h * 0.22, 28);
    const handleY = (h - handleH) / 2;
    ctx.fillStyle = "rgba(212, 160, 23, 0.55)";
    for (const x of [x1, x2]) {
      ctx.fillRect(x - 3, handleY, 6, handleH);
    }
  }

  /** Nice MHz step for ~6–10 labels across the span. */
  niceFreqStepMhz(spanHz) {
    const spanMhz = Math.max(spanHz / 1e6, 0.01);
    const target = spanMhz / 8;
    const candidates = [0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20];
    for (const c of candidates) {
      if (c >= target) return c;
    }
    return 50;
  }

  /** Nice step (Hz) for relative axis (−100 … +100 / −2.5k …). */
  niceFreqStepHz(spanHz) {
    const target = Math.max(spanHz / 8, 1);
    const candidates = [
      1, 2, 5, 10, 20, 25, 50, 100, 200, 500,
      1e3, 2e3, 5e3, 10e3, 20e3, 25e3, 50e3, 100e3, 200e3, 500e3, 1e6,
    ];
    for (const c of candidates) {
      if (c >= target) return c;
    }
    return 2e6;
  }

  /** SDR#-style relative label: 0, ±25, ±2.5k, ±1M */
  formatAxisRelHz(relHz, stepHz) {
    const v = Math.round(relHz / stepHz) * stepHz;
    if (Math.abs(v) < 1e-6) return "0";
    const sign = v > 0 ? "" : "-";
    const a = Math.abs(v);
    if (a >= 1e6 && a % 1e6 === 0) return `${sign}${(a / 1e6).toFixed(0)}M`;
    if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(3)}M`;
    if (a >= 1000) {
      const k = a / 1000;
      return `${sign}${Number.isInteger(k) || stepHz >= 1000 ? k.toFixed(k >= 100 ? 0 : 1) : k.toFixed(1)}k`;
    }
    return `${sign}${a.toFixed(0)}`;
  }

  formatAxisMhz(mhz, stepMhz) {
    if (stepMhz >= 1) return mhz.toFixed(0);
    if (stepMhz >= 0.1) return mhz.toFixed(1);
    if (stepMhz >= 0.05) return mhz.toFixed(2);
    return mhz.toFixed(3);
  }

  /** Skip axis 2D redraw when layout / scale / tune marker unchanged. */
  _axisCacheKey(frame) {
    const w = this.axisCanvas?.width || 0;
    const h = this.axisCanvas?.height || 0;
    if (!frame?.sample_rate_hz) return `${w}x${h}|${this.specOffset}|${this.specRange}|${this.specZoom}`;
    const span = this.effectiveSpanHz(frame.sample_rate_hz);
    const relative = span < frame.sample_rate_hz * 0.85;
    const tuned = Math.round(this.tunedXNorm(frame) * w);
    return `${w}x${h}|${this.specOffset}|${this.specRange}|${this.specZoom}|${relative ? 1 : 0}|${frame.center_hz}|${tuned}`;
  }

  _updateAxis(frame) {
    const key = this._axisCacheKey(frame);
    if (key === this._axisKey) return;
    this._axisKey = key;
    this.drawFreqAxis(frame);
  }

  /** Left Y scale (dBFS) + bottom frequency X-axis on the spectrum overlay. */
  drawFreqAxis(frame) {
    const ctx = this.axisCtx;
    const canvas = this.axisCanvas;
    if (!ctx || !canvas) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    this.drawDbAxis(ctx, w, h);
    if (!frame?.center_hz || !frame?.sample_rate_hz) return;

    const span = this.effectiveSpanHz(frame.sample_rate_hz);
    const center = this.displayCenterHz(frame);
    const startHz = center - span / 2;
    const endHz = center + span / 2;
    const barH = Math.max(18, Math.min(28, h * 0.09));
    const y0 = h - barH;
    // Near full span + low CF → 0…2M style; otherwise relative to center when zoomed.
    const relative = span < frame.sample_rate_hz * 0.85;

    ctx.fillStyle = "rgba(5, 6, 10, 0.55)";
    ctx.fillRect(0, y0, w, barH);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.beginPath();
    ctx.moveTo(0, y0 + 0.5);
    ctx.lineTo(w, y0 + 0.5);
    ctx.stroke();

    const fontPx = Math.max(10, Math.min(13, w * 0.011));
    ctx.font = `${fontPx}px IBM Plex Mono, ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (relative) {
      const stepHz = this.niceFreqStepHz(span);
      const first = Math.ceil((startHz - center) / stepHz) * stepHz;
      for (let rel = first; rel <= span / 2 + stepHz * 0.5; rel += stepHz) {
        const hz = center + rel;
        const x = ((hz - startHz) / span) * w;
        if (x < 8 || x > w - 8) continue;
        const isMajor = Math.abs((rel / stepHz) % 2) < 0.001 || Math.abs(rel) < 1;
        ctx.strokeStyle = isMajor ? "rgba(212, 160, 23, 0.45)" : "rgba(255, 255, 255, 0.18)";
        ctx.beginPath();
        ctx.moveTo(x + 0.5, y0);
        ctx.lineTo(x + 0.5, y0 + (isMajor ? 8 : 5));
        ctx.stroke();
        ctx.fillStyle = "rgba(230, 236, 245, 0.78)";
        ctx.fillText(this.formatAxisRelHz(rel, stepHz), x, y0 + barH * 0.62);
      }
    } else {
      const stepMhz = this.niceFreqStepMhz(span);
      const stepHz = stepMhz * 1e6;
      const first = Math.ceil(startHz / stepHz) * stepHz;
      for (let hz = first; hz <= endHz + 1; hz += stepHz) {
        const x = ((hz - startHz) / span) * w;
        if (x < 8 || x > w - 8) continue;
        const isMajor = Math.abs((hz / stepHz) % 2) < 0.001;
        ctx.strokeStyle = isMajor ? "rgba(212, 160, 23, 0.45)" : "rgba(255, 255, 255, 0.18)";
        ctx.beginPath();
        ctx.moveTo(x + 0.5, y0);
        ctx.lineTo(x + 0.5, y0 + (isMajor ? 8 : 5));
        ctx.stroke();
        if (!isMajor && stepMhz < 0.1) continue;
        const mhz = hz / 1e6;
        ctx.fillStyle = "rgba(230, 236, 245, 0.78)";
        ctx.fillText(this.formatAxisMhz(mhz, stepMhz), x, y0 + barH * 0.62);
      }
    }

    // Tuned frequency marker on axis
    const tunedX = this.tunedXNorm(frame) * w;
    ctx.fillStyle = "rgba(224, 82, 82, 0.9)";
    ctx.beginPath();
    ctx.moveTo(tunedX, y0);
    ctx.lineTo(tunedX - 5, y0 + 7);
    ctx.lineTo(tunedX + 5, y0 + 7);
    ctx.closePath();
    ctx.fill();
  }

  /** dBFS labels aligned with RANGE / OFFSET (top = offset, bottom = offset − range). */
  drawDbAxis(ctx, w, h) {
    const topDb = this.specOffset;
    const bottomDb = this.specOffset - this.specRange;
    const barH = Math.max(18, Math.min(28, h * 0.09));
    const plotH = Math.max(1, h - barH);
    const fontPx = Math.max(9, Math.min(12, w * 0.01));
    const labelW = Math.max(36, Math.min(52, fontPx * 4.2));

    ctx.fillStyle = "rgba(5, 6, 10, 0.42)";
    ctx.fillRect(0, 0, labelW, plotH);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
    ctx.beginPath();
    ctx.moveTo(labelW + 0.5, 0);
    ctx.lineTo(labelW + 0.5, plotH);
    ctx.stroke();

    ctx.font = `${fontPx}px IBM Plex Mono, ui-monospace, monospace`;
    ctx.textAlign = "right";

    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const db = topDb - (topDb - bottomDb) * t;
      const y = t * plotH;
      const isMajor = i === 0 || i === steps || i === steps / 2;
      ctx.strokeStyle = isMajor ? "rgba(212, 160, 23, 0.35)" : "rgba(255, 255, 255, 0.14)";
      ctx.beginPath();
      ctx.moveTo(labelW - (isMajor ? 8 : 5), y + 0.5);
      ctx.lineTo(labelW, y + 0.5);
      ctx.stroke();

      ctx.fillStyle = "rgba(230, 236, 245, 0.72)";
      ctx.textBaseline = i === 0 ? "top" : i === steps ? "bottom" : "middle";
      const text = db > 0 ? `+${db.toFixed(0)}` : `${db.toFixed(0)}`;
      const labelY = i === 0 ? y + 3 : i === steps ? y - 3 : y;
      ctx.fillText(text, labelW - 6, labelY);
    }

    ctx.fillStyle = "rgba(168, 178, 196, 0.55)";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `${Math.max(8, fontPx - 1)}px IBM Plex Mono, ui-monospace, monospace`;
    ctx.fillText("dBFS", 4, 3);
  }

  drawGrid(ctx, w, h, centerHz, sampleRateHz) {
    ctx.fillStyle = "#050608";
    ctx.fillRect(0, 0, w, h);
    this.drawBandwidthShade(ctx, w, h, centerHz, sampleRateHz);

    ctx.strokeStyle = "#1a2030";
    ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const x = (w * i) / 8;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let i = 1; i < 5; i++) {
      const y = (h * i) / 5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    if (!centerHz || !sampleRateHz) return;
    const cx = this.tunedXNorm({ center_hz: centerHz, sample_rate_hz: sampleRateHz }) * w;
    ctx.strokeStyle = "#e05252";
    ctx.lineWidth = Math.max(1, w / 600);
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();
  }

  update(frame) {
    const raw = frameBins(frame);
    if (!raw?.length) return;
    if (frame.frame_id === this.lastFrameId) return;
    this.lastFrameId = frame.frame_id;
    this.lastFrame = frame;
    this._wfBins = raw;
    if (this._wfActive) {
      // One unique FFT line per frame (duplicating rows washed out detail).
      // High SPEED may add a second copy for faster scroll feel only.
      const rows = this.wfSpeed >= 20 ? 2 : 1;
      this._scrollWaterfallRows(raw, rows);
    }

    const w = this.specCanvas.width;
    const h = this.specCanvas.height;

    if (this.specGl.ok) {
      this.specGl.draw({
        bins: raw,
        sampleRateHz: frame.sample_rate_hz,
        specZoom: this.zoomFactor(frame.sample_rate_hz),
        specRange: this.specRange,
        specOffset: this.specOffset,
        bandwidthHz: this.bandwidthHz,
        panOffsetHz: this.panOffsetHz,
      });
    } else if (this.specCtx) {
      const bins = this.viewBins(raw, frame.sample_rate_hz);
      const ctx = this.specCtx;
      this.drawGrid(ctx, w, h, frame.center_hz, frame.sample_rate_hz);
      const panPx = (this.tunedXNorm(frame) - 0.5) * w;
      ctx.strokeStyle = "#4fa8ff";
      ctx.lineWidth = Math.max(1, w / 800);
      ctx.beginPath();
      for (let i = 0; i < bins.length; i++) {
        const x = (i / (bins.length - 1)) * w + panPx;
        const y = this.dbToY(bins[i], h);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      const fill = ctx.createLinearGradient(0, 0, 0, h);
      fill.addColorStop(0, "rgba(79,168,255,0.28)");
      fill.addColorStop(1, "rgba(79,168,255,0)");
      ctx.fillStyle = fill;
      ctx.fill();
    }

    this._updateAxis(frame);
  }

  _scrollWaterfallRows(rawBins, count) {
    const n = Math.max(1, count | 0);
    const w = this.wfCanvas.width;
    // Interpolate to pixel width so ZOOM doesn't look mosaic
    const bins = this.resampleBins(rawBins, Math.max(w, 256));
    const panFrac = this.lastFrame ? this.tunedXNorm(this.lastFrame) - 0.5 : 0;
    if (this.wfGl.ok) {
      for (let i = 0; i < n; i++) {
        if (!this.wfGl.pushRow(bins, panFrac)) {
          this.wfGl.ok = false;
          break;
        }
      }
      if (this.wfGl.ok) {
        this.wfGl.draw();
        return;
      }
    }
    if (!this.wfCtx) return;
    const h = this.wfCanvas.height;
    if (!this.wfImage || this.wfImage.width !== w || this.wfImage.height !== h) {
      this.initWaterfallImage();
    }

    const row = new Uint8ClampedArray(w * 4);
    for (let x = 0; x < w; x++) {
      const rel = x / w - 0.5 - panFrac;
      const bi = Math.max(0, Math.min(bins.length - 1, (rel + 0.5) * (bins.length - 1)));
      const db = sampleBin(bins, bi);
      const [r, g, b] = this.dbToColor(db);
      row[x * 4] = r;
      row[x * 4 + 1] = g;
      row[x * 4 + 2] = b;
      row[x * 4 + 3] = 255;
    }

    const data = this.wfImage.data;
    for (let step = 0; step < n; step++) {
      data.copyWithin(0, w * 4, w * h * 4);
      data.set(row, (h - 1) * w * 4);
    }
    this.wfCtx.putImageData(this.wfImage, 0, 0);
  }

  _scrollWaterfallRow(rawBins) {
    this._scrollWaterfallRows(rawBins, 1);
  }

  scrollWaterfall(rawBins) {
    this._scrollWaterfallRows(rawBins, Math.max(4, this.wfSpeed | 0));
  }

  clear() {
    this.lastFrameId = 0;
    this.lastFrame = null;
    this._wfBins = null;
    this.clearAllHoverPreviews();
    this.axisCtx?.clearRect(0, 0, this.axisCanvas?.width || 0, this.axisCanvas?.height || 0);
    this.resize();
    if (this.specGl.ok) {
      this.specGl.clear();
    } else if (this.specCtx) {
      this.drawGrid(this.specCtx, this.specCanvas.width, this.specCanvas.height, 0, 0);
    }
    if (this.wfGl.ok) {
      this.wfGl.clear();
    } else {
      this.initWaterfallImage();
    }
  }

  getSpanLabel(sampleRateHz) {
    if (!sampleRateHz) return "— kHz";
    return `${(this.effectiveSpanHz(sampleRateHz) / 1000).toFixed(0)} kHz`;
  }
}

export function bindVizControls(spectrumView) {
  const specZoom = document.getElementById("spec-zoom");
  const specRange = document.getElementById("spec-range");
  const specOffset = document.getElementById("spec-offset");
  const wfContrast = document.getElementById("wf-contrast");
  const wfSpeed = document.getElementById("wf-speed");
  const splitter = document.getElementById("viz-splitter");
  const vizBody = document.getElementById("viz-body");
  if (!specZoom || !specRange || !specOffset || !wfContrast || !wfSpeed || !splitter || !vizBody) {
    return;
  }

  const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  if (saved.specZoom) specZoom.value = saved.specZoom;
  if (saved.wfContrast) wfContrast.value = saved.wfContrast;
  if (saved.wfSpeed) wfSpeed.value = String(Math.max(8, Number(saved.wfSpeed) || 16));
  else wfSpeed.value = "16";

  // Prefer display object's scale (already migrated/clamped to −30…−190 window).
  specRange.value = String(spectrumView.specRange);
  specOffset.value = String(spectrumView.specOffset);

  spectrumView.setSpecZoom(Number(specZoom.value));
  spectrumView.setSpecRange(Number(specRange.value));
  spectrumView.setSpecOffset(Number(specOffset.value));
  spectrumView.setWfContrast(Number(wfContrast.value));
  spectrumView.setWfSpeed(Number(wfSpeed.value));
  if (saved.specPane) spectrumView.setSpecPanePercent(saved.specPane);
  wfSpeed.min = "4";
  wfSpeed.max = "32";

  specZoom.addEventListener("input", () => spectrumView.setSpecZoom(Number(specZoom.value)));
  specRange.addEventListener("input", () => spectrumView.setSpecRange(Number(specRange.value)));
  specOffset.addEventListener("input", () => spectrumView.setSpecOffset(Number(specOffset.value)));
  wfContrast.addEventListener("input", () => spectrumView.setWfContrast(Number(wfContrast.value)));
  wfSpeed.addEventListener("input", () => spectrumView.setWfSpeed(Number(wfSpeed.value)));

  let dragging = false;
  splitter.addEventListener("mousedown", (e) => {
    dragging = true;
    splitter.classList.add("dragging");
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = vizBody.getBoundingClientRect();
    const pct = Math.round(((e.clientY - rect.top) / rect.height) * 100);
    spectrumView.setSpecPanePercent(pct);
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    splitter.classList.remove("dragging");
  });
}

/** Click to tune; drag gold handle blocks only to resize bandwidth. */
const CLICK_SLOP_PX = 14;

function updateHoverPreview(spectrumView, which, clientX, canvas, getFrame, active) {
  if (!active) return;
  const frame = getFrame();
  if (frame) spectrumView.setHoverPreview(which, clientX, canvas, frame);
}

function bindBandResize(spectrumView, canvas, { getFrame, getLimits, onBandwidth, onTune, which }) {
  let bwDrag = null;
  let pendingClick = null;

  const pickHandle = (clientX, clientY, frame) => {
    const side = spectrumView.hitBandwidthHandle(canvas, clientX, clientY, frame);
    if (!side) return null;
    return { edge: side, anchor: "tuned" };
  };

  const applyBwDrag = (clientX) => {
    const frame = getFrame();
    if (!frame || !bwDrag) return;
    const limits = getLimits();
    onBandwidth(spectrumView.bandwidthFromEdge(canvas, clientX, frame, bwDrag.edge, limits));
  };

  canvas.addEventListener("mousemove", (e) => {
    if (bwDrag) {
      canvas.style.cursor = "ew-resize";
      applyBwDrag(e.clientX);
      return;
    }
    const frame = getFrame();
    if (!frame) {
      canvas.style.cursor = "";
      return;
    }
    const hit = pickHandle(e.clientX, e.clientY, frame);
    canvas.style.cursor = hit ? "ew-resize" : "crosshair";
    if (!hit && !pendingClick) {
      updateHoverPreview(spectrumView, which, e.clientX, canvas, getFrame, true);
    }
  });

  canvas.addEventListener("mouseleave", () => {
    spectrumView.clearHoverPreview(which);
    if (!bwDrag) canvas.style.cursor = "";
  });

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const frame = getFrame();
    if (!frame) return;

    const hit = pickHandle(e.clientX, e.clientY, frame);
    if (hit) {
      spectrumView.clearHoverPreview(which);
      bwDrag = hit;
      canvas.style.cursor = "ew-resize";
      applyBwDrag(e.clientX);
      e.preventDefault();
      return;
    }
    pendingClick = { startX: e.clientX, startY: e.clientY };
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!pendingClick || bwDrag) return;
    const dx = Math.abs(e.clientX - pendingClick.startX);
    const dy = Math.abs(e.clientY - pendingClick.startY);
    if (dx > CLICK_SLOP_PX || dy > CLICK_SLOP_PX) pendingClick = null;
  });

  window.addEventListener("mouseup", (e) => {
    if (bwDrag) {
      applyBwDrag(e.clientX);
      bwDrag = null;
      pendingClick = null;
      canvas.style.cursor = getFrame() ? "crosshair" : "";
      return;
    }
    if (!pendingClick) return;
    const x = pendingClick.startX;
    pendingClick = null;
    spectrumView.clearHoverPreview(which);
    onTune(x, canvas);
  });
}

export function bindWaterfallInteraction(spectrumView, wfCanvas, { getFrame, onTune, onBandwidth, getLimits }) {
  if (!wfCanvas) return;
  bindBandResize(spectrumView, wfCanvas, {
    getFrame,
    getLimits,
    onBandwidth,
    onTune,
    which: "wf",
  });
}

export function bindSpectrumInteraction(spectrumView, specCanvas, { getFrame, onTune, onBandwidth, getLimits }) {
  if (!specCanvas) return;
  bindBandResize(spectrumView, specCanvas, {
    getFrame,
    getLimits,
    onBandwidth,
    onTune,
    which: "spec",
  });
}

const VIZ_DEFAULTS = {
  specZoom: 1,
  specRange: 100,
  specOffset: 0,
  wfContrast: 50,
  wfSpeed: 16,
  specPane: 45,
};

/** Reset spectrum/waterfall display sliders and pane split to factory defaults. */
export function resetVizControls(spectrumView) {
  localStorage.removeItem(LS_KEY);
  const specZoom = document.getElementById("spec-zoom");
  const specRange = document.getElementById("spec-range");
  const specOffset = document.getElementById("spec-offset");
  const wfContrast = document.getElementById("wf-contrast");
  const wfSpeed = document.getElementById("wf-speed");
  if (specZoom) specZoom.value = String(VIZ_DEFAULTS.specZoom);
  if (specRange) specRange.value = String(VIZ_DEFAULTS.specRange);
  if (specOffset) specOffset.value = String(VIZ_DEFAULTS.specOffset);
  if (wfContrast) wfContrast.value = String(VIZ_DEFAULTS.wfContrast);
  if (wfSpeed) wfSpeed.value = String(VIZ_DEFAULTS.wfSpeed);
  if (!spectrumView) return;
  spectrumView.setSpecZoom(VIZ_DEFAULTS.specZoom);
  spectrumView.setSpecRange(VIZ_DEFAULTS.specRange);
  spectrumView.setSpecOffset(VIZ_DEFAULTS.specOffset);
  spectrumView.setWfContrast(VIZ_DEFAULTS.wfContrast);
  spectrumView.setWfSpeed(VIZ_DEFAULTS.wfSpeed);
  spectrumView.setSpecPanePercent(VIZ_DEFAULTS.specPane);
  spectrumView.resetPan();
  spectrumView.redraw();
}

