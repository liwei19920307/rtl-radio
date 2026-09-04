/**
 * Topbar mini spectrum — real IQ FFT bins around tuned channel (SDR#-style strip).
 * No synthetic wobble / horizontal chase; heights follow live spectrum only.
 */

const VIZ_MODE_KEY = "rtl-radio-viz-mode";

export const VIZ_MODES = [
  { id: "bars", label: "柱状" },
  { id: "mirror", label: "镜像" },
  { id: "wave", label: "波形" },
  { id: "radial", label: "径向" },
  { id: "dots", label: "粒子" },
  { id: "line", label: "频谱线" },
  { id: "rgb", label: "RGB" },
];

const BAR_N = 40;

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function hsla(h, s, l, a) {
  return `hsla(${((h % 360) + 360) % 360}, ${s}%, ${l}%, ${a})`;
}

function loadMode() {
  const id = localStorage.getItem(VIZ_MODE_KEY);
  return VIZ_MODES.some((m) => m.id === id) ? id : "bars";
}

function saveMode(id) {
  localStorage.setItem(VIZ_MODE_KEY, id);
}

function specDbScale() {
  const offset = Number(document.getElementById("spec-offset")?.value ?? 0);
  const range = Number(document.getElementById("spec-range")?.value ?? 100);
  return {
    offset: Number.isFinite(offset) ? offset : 0,
    range: Number.isFinite(range) && range > 1 ? range : 100,
  };
}

function dbToNorm(db, offset, range) {
  const bottom = offset - range;
  return clamp01((db - bottom) / range);
}

export function createAudioViz(canvas, modeBtn) {
  if (!canvas) return null;

  const ctx = canvas.getContext("2d");
  const bars = new Float32Array(BAR_N);
  const targets = new Float32Array(BAR_N);
  const peaks = new Float32Array(BAR_N);
  let modeIdx = Math.max(0, VIZ_MODES.findIndex((m) => m.id === loadMode()));
  let running = false;
  let raf = 0;
  let dpr = 1;
  let w = 0;
  let h = 0;
  let lastFrameMs = 0;
  let gradBars = null;
  let gradMirror = null;
  let gradLine = null;
  let gradWave = null;

  function currentMode() {
    return VIZ_MODES[modeIdx];
  }

  function updateModeLabel() {
    if (!modeBtn) return;
    const m = currentMode();
    modeBtn.title = `可视化：${m.label}（点击切换）`;
    modeBtn.setAttribute("aria-label", `可视化模式 ${m.label}`);
    modeBtn.dataset.mode = m.id;
  }

  function rebuildGradients() {
    gradBars = null;
    gradMirror = null;
    gradLine = null;
    gradWave = null;
    if (w < 1 || h < 1) return;
    gradBars = ctx.createLinearGradient(0, h, 0, 0);
    gradBars.addColorStop(0, "rgba(61, 214, 198, 0.15)");
    gradBars.addColorStop(0.45, "rgba(212, 160, 23, 0.55)");
    gradBars.addColorStop(1, "rgba(232, 185, 51, 0.95)");
    const mid = h * 0.5;
    gradMirror = ctx.createLinearGradient(0, mid + h * 0.48, 0, mid - h * 0.48);
    gradMirror.addColorStop(0, "rgba(61, 214, 198, 0.15)");
    gradMirror.addColorStop(0.5, "rgba(212, 160, 23, 0.55)");
    gradMirror.addColorStop(1, "rgba(232, 185, 51, 0.95)");
    gradLine = ctx.createLinearGradient(0, 0, 0, h);
    gradLine.addColorStop(0, "rgba(212, 160, 23, 0.28)");
    gradLine.addColorStop(1, "rgba(212, 160, 23, 0.02)");
    gradWave = ctx.createLinearGradient(0, mid - h * 0.2, 0, mid + h * 0.2);
    gradWave.addColorStop(0, "rgba(212, 160, 23, 0.12)");
    gradWave.addColorStop(1, "rgba(212, 160, 23, 0.02)");
  }

  function resize() {
    const parent = canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.max(1, Math.floor(rect.width));
    h = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rebuildGradients();
  }

  /** Map center RF passband bins → bar targets (same dB scale as main spectrum). */
  function pushSpectrum(frame, bandwidthHz = 200_000) {
    const bins = frame?._bins;
    const sr = frame?.sample_rate_hz;
    if (!bins?.length || !sr) return;

    const { offset, range } = specDbScale();
    const n = bins.length;
    const dc = n / 2;
    const binHz = sr / n;
    const halfBw = Math.max(binHz * 2, (bandwidthHz || sr * 0.1) * 0.5);
    const halfBins = Math.max(1, Math.round(halfBw / binHz));
    const lo = Math.max(0, dc - halfBins);
    const hi = Math.min(n - 1, dc + halfBins);
    const span = hi - lo;

    for (let i = 0; i < BAR_N; i++) {
      const t = BAR_N > 1 ? i / (BAR_N - 1) : 0;
      const idx = Math.round(lo + t * span);
      targets[i] = dbToNorm(bins[idx], offset, range);
    }

    if (!running) start();
  }

  /** Legacy L/R peak — only used when no spectrum yet. */
  function pushLevels(l, r) {
    const peak = clamp01(Math.max(Number(l) || 0, Number(r) || 0) * 2.2);
    for (let i = 0; i < BAR_N; i++) {
      const t = i / (BAR_N - 1);
      const envelope = 0.5 + 0.5 * Math.sin(Math.PI * t);
      targets[i] = Math.max(targets[i], peak * envelope);
    }
    if (!running) start();
  }

  function smoothBars(dt) {
    const attack = 22;
    const decay = 9;
    const peakFall = 1.8;
    for (let i = 0; i < BAR_N; i++) {
      const tgt = targets[i];
      const cur = bars[i];
      const rate = tgt > cur ? attack : decay;
      bars[i] += (tgt - cur) * Math.min(1, rate * dt);
      if (bars[i] > peaks[i]) peaks[i] = bars[i];
      else peaks[i] = Math.max(0, peaks[i] - peakFall * dt);
      targets[i] *= Math.max(0, 1 - 2.5 * dt);
    }
  }

  function clear() {
    ctx.clearRect(0, 0, w, h);
  }

  function drawBars(mirrored) {
    const gap = 1;
    const barW = Math.max(2, (w - gap * (BAR_N - 1)) / BAR_N);
    const midY = h * 0.5;
    ctx.fillStyle = mirrored ? gradMirror : gradBars;
    for (let i = 0; i < BAR_N; i++) {
      const x = i * (barW + gap);
      const v = bars[i];
      const bh = Math.max(1, v * (mirrored ? h * 0.5 : h * 0.98));
      if (mirrored) ctx.fillRect(x, midY - bh, barW, bh * 2);
      else ctx.fillRect(x, h - bh, barW, bh);
      const py = mirrored ? midY - peaks[i] * h * 0.5 : h - peaks[i] * h * 0.98;
      ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
      ctx.fillRect(x, Math.max(0, py - 1), barW, 1);
      ctx.fillStyle = mirrored ? gradMirror : gradBars;
    }
  }

  function drawWave() {
    const mid = h * 0.5;
    ctx.beginPath();
    ctx.strokeStyle = "rgba(212, 160, 23, 0.9)";
    ctx.lineWidth = 1.5;
    for (let i = 0; i < BAR_N; i++) {
      const x = (i / (BAR_N - 1)) * w;
      const amp = bars[i] * h * 0.46;
      const y = mid - amp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.lineTo(w, mid);
    ctx.lineTo(0, mid);
    ctx.closePath();
    ctx.fillStyle = gradWave;
    ctx.fill();
  }

  function drawRadial() {
    const cx = w * 0.5;
    const cy = h * 0.5;
    const r0 = Math.min(w, h) * 0.1;
    const r1 = Math.min(w, h) * 0.48;
    const n = 28;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 0.72) / n) * Math.PI * 2;
      const v = bars[Math.floor((i / n) * BAR_N)];
      const rr = r0 + v * (r1 - r0);
      ctx.beginPath();
      ctx.arc(cx, cy, rr, a0, a1);
      ctx.strokeStyle = `rgba(212, 160, 23, ${0.25 + v * 0.7})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  function drawDots() {
    const cols = BAR_N;
    const rows = 4;
    const cellW = w / cols;
    const cellH = h / (rows + 0.5);
    for (let c = 0; c < cols; c++) {
      const v = bars[c];
      for (let r = 0; r < rows; r++) {
        const thresh = (rows - r) / rows;
        if (v < thresh * 0.5 && r > 0) continue;
        const x = c * cellW + cellW * 0.5;
        const y = h - (r + 0.6) * cellH;
        const rad = Math.max(1.2, cellW * 0.24 * (0.4 + v));
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fillStyle =
          r === rows - 1
            ? `rgba(232, 185, 51, ${0.5 + v * 0.5})`
            : `rgba(61, 214, 198, ${0.2 + v * 0.55})`;
        ctx.fill();
      }
    }
  }

  function drawLine() {
    ctx.beginPath();
    ctx.strokeStyle = "rgba(212, 160, 23, 0.95)";
    ctx.lineWidth = 1.25;
    for (let i = 0; i < BAR_N; i++) {
      const x = (i / (BAR_N - 1)) * w;
      const y = h - bars[i] * h * 0.98 - 1;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = gradLine;
    ctx.fill();
  }

  function drawRgb() {
    const gap = 1;
    const barW = Math.max(2, (w - gap * (BAR_N - 1)) / BAR_N);
    for (let i = 0; i < BAR_N; i++) {
      const x = i * (barW + gap);
      const v = bars[i];
      const bh = Math.max(1, v * h * 0.98);
      const hue = (i / BAR_N) * 300 + 30;
      const lit = 36 + v * 38;
      ctx.fillStyle = hsla(hue, 96, lit, 0.65 + v * 0.35);
      ctx.fillRect(x, h - bh, barW, bh);
      if (v > 0.04) {
        ctx.fillStyle = hsla(hue + 36, 100, Math.min(90, lit + 24), 0.9);
        ctx.fillRect(x, Math.max(0, h - bh - 1), barW, 2);
      }
    }
  }

  function frame(now) {
    raf = 0;
    const dt = lastFrameMs ? Math.min(0.05, (now - lastFrameMs) / 1000) : 1 / 60;
    lastFrameMs = now;

    smoothBars(dt);
    clear();
    const id = currentMode().id;
    if (id === "mirror") drawBars(true);
    else if (id === "wave") drawWave();
    else if (id === "radial") drawRadial();
    else if (id === "dots") drawDots();
    else if (id === "line") drawLine();
    else if (id === "rgb") drawRgb();
    else drawBars(false);

    const still = bars.some((b) => b > 0.008) || targets.some((t) => t > 0.008);
    if (running && still) raf = requestAnimationFrame(frame);
    else if (!still) {
      clear();
      ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
      ctx.fillRect(0, h * 0.5 - 0.5, w, 1);
      running = false;
      lastFrameMs = 0;
    } else if (running) {
      raf = requestAnimationFrame(frame);
    }
  }

  function start() {
    if (running) return;
    running = true;
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    bars.fill(0);
    targets.fill(0);
    peaks.fill(0);
    lastFrameMs = 0;
    clear();
  }

  function nextMode() {
    modeIdx = (modeIdx + 1) % VIZ_MODES.length;
    saveMode(currentMode().id);
    updateModeLabel();
    start();
  }

  updateModeLabel();
  resize();
  const ro = new ResizeObserver(() => resize());
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  modeBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    nextMode();
  });

  return {
    pushSpectrum,
    pushLevels,
    nextMode,
    stop,
    start,
    resize,
    mode: () => currentMode().id,
  };
}
