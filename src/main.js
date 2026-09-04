import { invoke, Channel } from "@tauri-apps/api/core";
import { createAudioViz } from "./audio-viz.js";
import { attachFrameBins } from "./frame-decode.js";
import { bindSpectrumContextMenu } from "./context-menu.js";
import {
  SpectrumDisplay,
  bindVizControls,
  bindSpectrumInteraction,
  bindWaterfallInteraction,
  resetVizControls,
} from "./spectrum.js";
import { bindRangeSliders, initRangeSliders } from "./range-sliders.js";
import { createNameDialog, createConfirmDialog } from "./name-dialog.js";
import { bindOverlayScrollbars } from "./overlay-scrollbars.js";

const promptName = createNameDialog();
const confirmDialog = createConfirmDialog();

const BW_KEY = "rtl-radio-bw";
const USER_PRESETS_KEY = "rtl-radio-user-presets";
const SETTINGS_KEY = "rtl-radio-settings";
const FAVORITES_KEY = "rtl-radio-favorites";
const SCAN_RESULTS_KEY = "rtl-radio-scan-results";

const MODES = {
  wbfm: {
    label: "FM 广播",
    min: 87.5,
    max: 108,
    step: 0.1,
    stepLabel: "0.1",
    fineStep: 0.01,
    fineStepLabel: "10k",
    decimals: 1,
    defaultFreq: 89.7,
    bandwidthHz: 200_000,
    bandwidthMin: 100_000,
    bandwidthMax: 250_000,
    deemph: true,
    presetsTitle: "南京 FM",
    presets: [
      { label: "苏音乐", mhz: 89.7 },
      { label: "苏新闻", mhz: 93.7 },
      { label: "经典", mhz: 97.5 },
      { label: "苏交通", mhz: 101.1 },
      { label: "宁交通", mhz: 102.4 },
      { label: "宁音乐", mhz: 105.8 },
      { label: "宁新闻", mhz: 106.9 },
    ],
  },
  am: {
    label: "航空 AM",
    min: 118,
    max: 137,
    step: 0.025,
    stepLabel: "25k",
    fineStep: 0.001,
    fineStepLabel: "1k",
    decimals: 3,
    defaultFreq: 118.85,
    bandwidthHz: 8_000,
    bandwidthMin: 4_000,
    bandwidthMax: 16_000,
    presetsTitle: "南京航空",
    presets: [
      { label: "塔台北", mhz: 118.85 },
      { label: "塔台南", mhz: 118.475 },
      { label: "进近", mhz: 119.25 },
      { label: "进近B", mhz: 120.35 },
      { label: "区调A", mhz: 119.9 },
      { label: "区调B", mhz: 121.3 },
      { label: "区调C", mhz: 126.55 },
      { label: "上海区调", mhz: 124.55 },
      { label: "地面北", mhz: 121.7 },
      { label: "地面南", mhz: 121.6 },
      { label: "放行", mhz: 121.9 },
      { label: "ATIS", mhz: 126.25 },
      { label: "紧急", mhz: 121.5 },
    ],
  },
  nfm: {
    label: "火腿 NFM",
    min: 50,
    max: 470,
    step: 0.0125,
    stepLabel: "12.5k",
    fineStep: 0.001,
    fineStepLabel: "1k",
    decimals: 4,
    defaultFreq: 430.61,
    bandwidthHz: 12_500,
    bandwidthMin: 6_250,
    bandwidthMax: 50_000,
    deemph: true,
    presetsTitle: "南京业余",
    presets: [
      { label: "0.7m中继", mhz: 430.61 },
      { label: "0.7m中继2", mhz: 439.475 },
      { label: "2m中继", mhz: 145.475 },
      { label: "行知中继", mhz: 438.85 },
      { label: "2m直频", mhz: 145.0 },
      { label: "70cm直频", mhz: 433.5 },
      { label: "UHF守候", mhz: 431.288 },
      { label: "APRS", mhz: 144.64 },
    ],
  },
  usb: {
    label: "USB",
    min: 1.8,
    max: 30,
    step: 0.001,
    stepLabel: "1k",
    fineStep: 0.0001,
    fineStepLabel: "100Hz",
    decimals: 3,
    defaultFreq: 14.074,
    bandwidthHz: 2_700,
    bandwidthMin: 1_500,
    bandwidthMax: 6_000,
    presetsTitle: "HF USB",
    presets: [
      { label: "20m FT8", mhz: 14.074 },
      { label: "20m CW", mhz: 14.070 },
      { label: "40m", mhz: 7.074 },
      { label: "15m", mhz: 21.074 },
    ],
  },
  lsb: {
    label: "LSB",
    min: 1.8,
    max: 30,
    step: 0.001,
    stepLabel: "1k",
    fineStep: 0.0001,
    fineStepLabel: "100Hz",
    decimals: 3,
    defaultFreq: 3.573,
    bandwidthHz: 2_700,
    bandwidthMin: 1_500,
    bandwidthMax: 6_000,
    presetsTitle: "HF LSB",
    presets: [
      { label: "80m", mhz: 3.573 },
      { label: "40m LSB", mhz: 7.150 },
      { label: "160m", mhz: 1.900 },
    ],
  },
  dsb: {
    label: "DSB",
    min: 1.8,
    max: 30,
    step: 0.001,
    stepLabel: "1k",
    fineStep: 0.0001,
    fineStepLabel: "100Hz",
    decimals: 3,
    defaultFreq: 7.100,
    bandwidthHz: 12_000,
    bandwidthMin: 4_000,
    bandwidthMax: 20_000,
    presetsTitle: "DSB",
    presets: [{ label: "40m", mhz: 7.100 }],
  },
};

const host = document.getElementById("host");
const port = document.getElementById("port");
const mode = document.getElementById("mode");
const freq = document.getElementById("freq");
const gainAuto = document.getElementById("gain-auto");
const gain = document.getElementById("gain");
const gainLabel = document.getElementById("gain-label");
const ppm = document.getElementById("ppm");
const ppmLabel = document.getElementById("ppm-label");
const playBtn = document.getElementById("play");
const statusText = document.getElementById("status-text");
const subtitle = document.getElementById("subtitle");
const levelMono = document.getElementById("level-mono");
const levelStereo = document.getElementById("level-stereo");
const levelFill = document.getElementById("level-fill");
const levelFillL = document.getElementById("level-fill-l");
const levelFillR = document.getElementById("level-fill-r");
const freqReadout = document.getElementById("freq-readout");
const spanReadout = document.getElementById("span-readout");
const presets = document.getElementById("presets");
const presetsSectionTitle = document.getElementById("presets-section-title");
const stepDown = document.getElementById("step-down");
const stepUp = document.getElementById("step-up");
function deemphasisEnabled() {
  return !!currentMode().deemph;
}
const recordBtn = document.getElementById("record");
const connDot = document.getElementById("conn-dot");
const linkQuality = document.getElementById("link-quality");
const bandwidthEl = document.getElementById("bandwidth-khz");
const bwLabel = document.getElementById("bw-label");
const bufferPreset = document.getElementById("buffer-preset");
const squelchBtn = document.getElementById("squelch");
const squelchLevel = document.getElementById("squelch-level");
const squelchLabel = document.getElementById("squelch-label");
const stepFineDown = document.getElementById("step-fine-down");
const stepFineUp = document.getElementById("step-fine-up");
const scanResultsEl = document.getElementById("scan-results");
const scanSectionTitle = document.getElementById("scan-section-title");
const favoriteHeartBtn = document.getElementById("favorite-heart");
const favoritesEl = document.getElementById("favorites");
const favoritesSectionTitle = document.getElementById("favorites-section-title");
const openFreqListBtn = document.getElementById("open-freq-list");
const freqSheet = document.getElementById("freq-sheet");
const freqSheetClose = document.getElementById("freq-sheet-close");
const freqSheetTitle = document.getElementById("freq-sheet-title");
const voiceRecordBtn = document.getElementById("voice-record");
const resetSettingsBtn = document.getElementById("reset-settings");
const revealFinderBtn = document.getElementById("reveal-finder");

function isToggleOn(el) {
  return !!el?.classList.contains("active");
}

function setToggleOn(el, on) {
  if (!el) return;
  const active = !!on;
  el.classList.toggle("active", active);
  el.setAttribute("aria-pressed", active ? "true" : "false");
}

function bindToggle(el, onChange) {
  if (!el) return;
  el.addEventListener("click", () => {
    setToggleOn(el, !isToggleOn(el));
    onChange(isToggleOn(el));
  });
}

let spectrumView = null;
const specEl = document.getElementById("spectrum-canvas");
const wfEl = document.getElementById("waterfall-canvas");
if (specEl && wfEl) {
  spectrumView = new SpectrumDisplay(specEl, wfEl);
  bindVizControls(spectrumView);
}

const audioViz = createAudioViz(
  document.getElementById("audio-viz"),
  document.getElementById("audio-viz-mode"),
);

function loadBandwidthStore() {
  try {
    return JSON.parse(localStorage.getItem(BW_KEY) || "{}");
  } catch {
    return {};
  }
}

function loadUserPresets() {
  try {
    return JSON.parse(localStorage.getItem(USER_PRESETS_KEY) || "{}");
  } catch {
    return {};
  }
}

function loadScanResultsStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(SCAN_RESULTS_KEY) || "{}");
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    for (const [key, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      out[key] = list
        .filter((h) => h && Number.isFinite(h.mhz))
        .map((h) => ({
          mhz: h.mhz,
          peak: Number(h.peak) || 0,
          ...(h.unit != null ? { unit: h.unit } : {}),
        }));
    }
    return out;
  } catch {
    return {};
  }
}

function saveScanResultsStore() {
  scanResultsByMode[mode.value] = scanResults;
  localStorage.setItem(SCAN_RESULTS_KEY, JSON.stringify(scanResultsByMode));
}

function syncScanResultsForMode(modeKey = mode.value) {
  if (!scanResultsByMode[modeKey]) scanResultsByMode[modeKey] = [];
  scanResults = scanResultsByMode[modeKey];
}

function loadSettingsStore() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveSettingsStore() {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      host: host.value.trim(),
      port: Number(port.value),
      mode: mode.value,
      freqHz: exactFreqHz(),
      gain: Number(gain.value),
      gainAuto: isToggleOn(gainAuto),
      ppm: Number(ppm.value),
      bufferPreset: bufferPreset?.value ?? "balanced",
      squelch: isToggleOn(squelchBtn),
      squelchLevel: squelchUiValue(),
      voiceRecord: isToggleOn(voiceRecordBtn),
      revealFinder: isToggleOn(revealFinderBtn),
    }),
  );
}

function updateSquelchLabel() {
  if (squelchLabel && squelchLevel) {
    squelchLabel.textContent = `${Math.round(Number(squelchLevel.value))}`;
  }
}

function squelchUiValue() {
  return Math.max(0, Math.min(100, Number(squelchLevel?.value ?? 30)));
}

/** Map stored level → 0…100 UI (migrates old 0.5–15% scale). */
function normalizeSquelchUi(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return 30;
  if (v > 0 && v <= 15) return Math.round(Math.max(0, Math.min(100, v * (100 / 15))));
  return Math.round(Math.max(0, Math.min(100, v)));
}

function applySavedSettings(s) {
  if (!s || typeof s !== "object") return;
  if (s.host) host.value = s.host;
  if (s.port) port.value = s.port;
  if (s.mode && MODES[s.mode]) mode.value = s.mode;
  applyModeUi({ keepFreq: true });
  if (s.freqHz) setExactFreqHz(s.freqHz);
  if (s.gain != null) {
    gain.value = s.gain;
    gainLabel.textContent = Number(s.gain).toFixed(1);
  }
  if (s.gainAuto != null) setToggleOn(gainAuto, s.gainAuto);
  gain.disabled = isToggleOn(gainAuto);
  if (s.ppm != null) {
    ppm.value = s.ppm;
    if (ppmLabel) ppmLabel.textContent = s.ppm;
  }
  if (s.bufferPreset && bufferPreset) bufferPreset.value = s.bufferPreset;
  if (s.squelch != null) setToggleOn(squelchBtn, s.squelch);
  if (s.squelchLevel != null && squelchLevel) {
    squelchLevel.value = String(normalizeSquelchUi(s.squelchLevel));
    updateSquelchLabel();
  }
  if (s.voiceRecord != null && voiceRecordBtn) setToggleOn(voiceRecordBtn, s.voiceRecord);
  if (s.revealFinder != null && revealFinderBtn) setToggleOn(revealFinderBtn, s.revealFinder);
  updateReadouts();
}

function loadFavoritesStore() {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
  } catch {
    return [];
  }
}

let favorites = loadFavoritesStore();

function favoritesForCurrentMode() {
  return favorites.filter((f) => f.mode === mode.value);
}

function saveFavoritesStore() {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
}

function updateListSectionTitles() {
  const m = currentMode();
  const favN = favoritesForCurrentMode().length;
  const presetN = m.presets.length + (userPresets[mode.value]?.length ?? 0);
  if (favoritesSectionTitle) {
    favoritesSectionTitle.textContent = favN
      ? `${m.label} 收藏 (${favN})`
      : `${m.label} 收藏`;
  }
  if (presetsSectionTitle) {
    presetsSectionTitle.textContent = presetN
      ? `${m.presetsTitle} (${presetN})`
      : m.presetsTitle;
  }
}

function openFreqSheet() {
  if (!freqSheet) return;
  renderFavorites();
  renderScanResults();
  applyModeUi({ keepFreq: true });
  if (freqSheetTitle) freqSheetTitle.textContent = `${currentMode().label} · 频率列表`;
  freqSheet.hidden = false;
  document.body.classList.add("modal-open");
}

function closeFreqSheet() {
  if (!freqSheet) return;
  freqSheet.hidden = true;
  document.body.classList.remove("modal-open");
}

function fillGridRow(el) {
  const cells = [...el.children].filter(
    (c) => c.classList.contains("preset-cell") && !c.classList.contains("preset-cell-filler")
  );
  const rem = cells.length % 4;
  if (!rem) return;
  for (let i = 0; i < 4 - rem; i++) {
    const li = document.createElement("li");
    li.className = "preset-cell preset-cell-filler";
    li.setAttribute("aria-hidden", "true");
    el.appendChild(li);
  }
}

function isCurrentFavorited() {
  const hz = exactFreqHz();
  const key = mode.value;
  return favorites.some(
    (f) => f.mode === key && Math.abs(Math.round(f.mhz * 1e6) - hz) <= 100,
  );
}

function syncFavoriteHeart() {
  if (!favoriteHeartBtn) return;
  const on = isCurrentFavorited();
  favoriteHeartBtn.classList.toggle("is-on", on);
  favoriteHeartBtn.textContent = on ? "♥" : "♡";
  favoriteHeartBtn.title = on ? "已收藏当前频率" : "收藏当前频率";
  favoriteHeartBtn.setAttribute("aria-pressed", on ? "true" : "false");
}

function renderFavorites() {
  if (!favoritesEl) return;
  updateListSectionTitles();
  const list = favoritesForCurrentMode();
  favoritesEl.replaceChildren();
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "favorites-empty";
    li.textContent = "点 ♡ 收藏当前频率";
    favoritesEl.appendChild(li);
    syncFavoriteHeart();
    return;
  }
  for (const f of list) {
    const li = document.createElement("li");
    li.className = "preset-cell favorite-item";
    const tuneBtn = document.createElement("button");
    tuneBtn.type = "button";
    tuneBtn.className = "preset-btn";
    tuneBtn.textContent = f.label;
    tuneBtn.title = `${formatMhzForMode(f.mhz, f.mode)} MHz`;
    tuneBtn.addEventListener("click", () => {
      tune(f.mhz, true);
      closeFreqSheet();
    });
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "favorite-rm";
    rm.textContent = "×";
    rm.title = "移除";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      favorites = favorites.filter((x) => x.id !== f.id);
      saveFavoritesStore();
      renderFavorites();
    });
    li.append(tuneBtn, rm);
    favoritesEl.appendChild(li);
  }
  fillGridRow(favoritesEl);
  syncFavoriteHeart();
}

function renderScanResults() {
  if (!scanResultsEl) return;
  if (scanSectionTitle) {
    const n = scanResults.length;
    scanSectionTitle.textContent = n ? `搜台 (${n})` : "搜台";
  }
  scanResultsEl.replaceChildren();

  const actionLi = document.createElement("li");
  actionLi.className = "preset-cell scan-action-cell";
  const actionBtn = document.createElement("button");
  actionBtn.type = "button";
  actionBtn.className = "preset-btn scan-action-btn";
  actionBtn.textContent = scanning ? "停止搜台" : "开始搜台";
  actionBtn.classList.toggle("active", scanning);
  actionBtn.addEventListener("click", () => autoScan());
  actionLi.appendChild(actionBtn);
  scanResultsEl.appendChild(actionLi);

  if (scanning && !scanResults.length) {
    const li = document.createElement("li");
    li.className = "favorites-empty";
    li.textContent = "正在扫描当前频段…";
    scanResultsEl.appendChild(li);
    return;
  }

  const sorted = [...scanResults].sort((a, b) => a.mhz - b.mhz);
  for (const r of sorted) {
    const li = document.createElement("li");
    li.className = "preset-cell";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-btn";
    btn.textContent = `${formatMhz(r.mhz)} MHz`;
    btn.title =
      r.unit === "snr" ? `SNR ${r.peak.toFixed(0)} dB` : `信号 ${(r.peak * 100).toFixed(0)}%`;
    btn.addEventListener("click", () => {
      tune(r.mhz, true);
      closeFreqSheet();
    });
    li.appendChild(btn);
    scanResultsEl.appendChild(li);
  }
  fillGridRow(scanResultsEl);
}

function formatMhzForMode(mhz, modeKey) {
  const d = MODES[modeKey]?.decimals ?? 3;
  return mhz.toFixed(d);
}

async function resetToDefaults() {
  const ok = await confirmDialog({
    title: "恢复默认",
    message: "将恢复连接、频率、增益等设置。收藏和搜台结果会保留。",
    okLabel: "恢复设置",
    cancelLabel: "取消",
    danger: true,
  });
  if (!ok) return;

  if (scanning) scanAbort = true;

  const keepKeys = new Set([FAVORITES_KEY, SCAN_RESULTS_KEY]);
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("rtl-radio") && !keepKeys.has(key)) {
      localStorage.removeItem(key);
    }
  }
  bandwidthStore = {};
  userPresets = {};
  favorites = loadFavoritesStore();

  if (host) host.value = "127.0.0.1";
  if (port) port.value = "1234";
  mode.value = "wbfm";
  gain.value = 30;
  gainLabel.textContent = "30.0";
  setToggleOn(gainAuto, false);
  gain.disabled = false;
  ppm.value = 0;
  if (ppmLabel) ppmLabel.textContent = "0";

  setToggleOn(squelchBtn, false);
  if (squelchLevel) squelchLevel.value = 30;
  updateSquelchLabel();

  if (voiceRecordBtn) setToggleOn(voiceRecordBtn, false);
  voiceAboveSince = 0;
  voiceBelowSince = 0;
  voiceHitStreak = 0;
  voiceMissStreak = 0;
  if (revealFinderBtn) setToggleOn(revealFinderBtn, false);
  if (bufferPreset) bufferPreset.value = "balanced";

  resetLevelSquelch();
  applyModeUi();
  setBandwidthHz(currentMode().bandwidthHz, playing);
  resetVizControls(spectrumView);
  if (!playing) spectrumView?.clear();
  renderFavorites();
  renderScanResults();
  initRangeSliders();

  saveSettingsStore();
  resetSettingsBtn?.classList.add("flash");
  setTimeout(() => resetSettingsBtn?.classList.remove("flash"), 600);
  if (playing) {
    setStatus("已恢复默认设置 · 重新调谐…");
    retune();
  } else {
    setStatus("已恢复默认设置 · FM 89.7 MHz");
  }
}

async function addFavoriteCurrent(opts = {}) {
  const mhz = exactFreqHz() / 1e6;
  let label = opts.quick ? `${formatMhz(mhz)} MHz` : null;
  if (!opts.quick) {
    label = await promptName({
      title: "收藏名称",
      defaultValue: `${formatMhz(mhz)} MHz`,
    });
    if (label === null) return;
  }
  const entry = {
    id: Date.now(),
    mhz,
    mode: mode.value,
    label: (label || `${formatMhz(mhz)} MHz`).trim(),
  };
  favorites = favorites.filter(
    (f) => !(f.mode === entry.mode && Math.abs(f.mhz - entry.mhz) < 1e-7),
  );
  favorites.unshift(entry);
  saveFavoritesStore();
  renderFavorites();
  setStatus(`已收藏 · ${entry.label}`);
}

let bandwidthStore = loadBandwidthStore();
let userPresets = loadUserPresets();
let recording = false;
let recordBusy = false;
let recordTimer = null;
let recordStartedAt = 0;

function formatRecordElapsed(ms) {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function updateRecordBtnLabel() {
  if (!recordBtn || !recording) return;
  recordBtn.textContent = `● ${formatRecordElapsed(Date.now() - recordStartedAt)}`;
}

function startRecordTimer() {
  stopRecordTimer();
  recordStartedAt = Date.now();
  updateRecordBtnLabel();
  recordTimer = setInterval(updateRecordBtnLabel, 250);
}

function stopRecordTimer() {
  if (recordTimer) {
    clearInterval(recordTimer);
    recordTimer = null;
  }
  recordStartedAt = 0;
}

function bandwidthLimits() {
  const sr = latestSpec?.sample_rate_hz ?? defaultSampleRateHz();
  return { min: 200, max: Math.floor(sr) };
}

function currentBandwidthHz() {
  const m = currentMode();
  return bandwidthStore[mode.value] ?? m.bandwidthHz;
}

function formatBwLabel(hz) {
  if (hz >= 100_000) return (hz / 1000).toFixed(0);
  if (hz >= 10_000) return (hz / 1000).toFixed(1);
  if (hz >= 1000) return (hz / 1000).toFixed(2);
  return hz.toFixed(0);
}

function formatBwInputKhz(hz) {
  if (hz >= 100_000) return (hz / 1000).toFixed(0);
  if (hz >= 10_000) return (hz / 1000).toFixed(1);
  return (hz / 1000).toFixed(3);
}

function updateBwLabel(hz) {
  if (bwLabel) bwLabel.textContent = formatBwLabel(hz);
}

async function pushAudioSettings() {
  if (!playing) return;
  try {
    await invoke("radio_set_audio", {
      patch: {
        squelchEnabled: isToggleOn(squelchBtn),
        squelchLevel: squelchUiValue() / 100,
      },
    });
  } catch (e) {
    setStatus(`静噪更新失败: ${e}`, true);
  }
}

let demodPushTimer = null;

async function pushDemodSettings() {
  if (!playing) return;
  const m = currentMode();
  const bandwidthHz = currentBandwidthHz();
  try {
    await invoke("radio_set_demod", {
      patch: {
        bandwidthHz,
        deemphasis: deemphasisEnabled(),
      },
    });
  } catch (e) {
    setStatus(`频宽更新失败: ${e}`, true);
  }
}

function scheduleDemodSettings(ms = 40) {
  clearTimeout(demodPushTimer);
  demodPushTimer = setTimeout(() => pushDemodSettings(), ms);
}

function setBandwidthHz(hz, immediate = false) {
  const { min, max } = bandwidthLimits();
  const clamped = Math.round(Math.max(min, Math.min(max, hz)));
  bandwidthStore[mode.value] = clamped;
  localStorage.setItem(BW_KEY, JSON.stringify(bandwidthStore));
  spectrumView?.setBandwidthHz(clamped);
  if (bandwidthEl) bandwidthEl.value = formatBwInputKhz(clamped);
  updateBwLabel(clamped);
  updateSpanReadout(latestSpec?.sample_rate_hz);
  if (immediate) pushDemodSettings();
  else scheduleDemodSettings();
}

function updateSpanReadout(sampleRateHz) {
  if (!sampleRateHz) {
    spanReadout.textContent = "— kHz";
    return;
  }
  const span = spectrumView?.getSpanLabel(sampleRateHz) ?? "— kHz";
  const bw = (currentBandwidthHz() / 1000).toFixed(currentMode().decimals <= 1 ? 0 : 1);
  spanReadout.textContent = `${span} · BW ${bw} kHz`;
}

let playing = false;
let latestSpec = null;
let spectrumChannel = null;
let lastLevelUi = 0;
/** 自适应静噪：底噪跟踪 + 超过 margin 变绿 */
const LEVEL_HANG_MS = 180;
const LEVEL_MARGIN = {
  am: 0.02,
  nfm: 0.022,
  dsb: 0.018,
  usb: 0.016,
  lsb: 0.016,
  wbfm: 0.09,
};
let levelHot = false;
let levelSignalUntil = 0;
let levelNoiseFloor = 0.008;

const SCAN_THRESH = {
  wbfm: 12,
  am: 0.028,
  nfm: 0.032,
  usb: 0.02,
  lsb: 0.02,
  dsb: 0.025,
};
const VOICE_ON_MS = 450;
const VOICE_OFF_MS = 1800;
const VOICE_ON_MS_WBFM = 550;
const VOICE_OFF_MS_WBFM = 3600;
/** FM 广播：宽带载波形态 */
const WBFM_VOICE_SNR_WIDE_DB = 15;
const WBFM_VOICE_SNR_MID_DB = 12;
const WBFM_VOICE_MIN_OCCUPANCY = 0.28;
/** 各模式自动录：连续命中帧数 / 开停等待（火腿要快） */
const VOICE_DETECT = {
  wbfm: { hits: 6, onMs: 550, offMs: 3600 },
  nfm: { hits: 2, onMs: 140, offMs: 900 },
  am: { hits: 4, onMs: 320, offMs: 2000 },
  usb: { hits: 3, onMs: 280, offMs: 1400 },
  lsb: { hits: 3, onMs: 280, offMs: 1400 },
  dsb: { hits: 3, onMs: 280, offMs: 1500 },
};
const SCAN_DWELL_MS = 280;

function scanPlan() {
  const m = currentMode();
  const key = mode.value;
  const here = Number(freq.value);
  if (key === "wbfm") {
    // 0.1 MHz China FM grid; merge 0.4 keeps one peak per station (skirts collapse).
    return {
      min: m.min,
      max: m.max,
      step: 0.1,
      merge: 0.4,
      dwell: 500,
      useSpectrum: true,
      centerHz: 40_000,
    };
  }
  if (key === "am") {
    return { min: m.min, max: m.max, step: m.step, merge: m.step * 0.4, dwell: SCAN_DWELL_MS };
  }
  if (key === "nfm") {
    const c = Number.isFinite(here) ? here : m.defaultFreq;
    return {
      min: Math.max(m.min, c - 1.5),
      max: Math.min(m.max, c + 1.5),
      step: m.step,
      merge: m.step * 0.4,
      dwell: 220,
    };
  }
  const c = Number.isFinite(here) ? here : m.defaultFreq;
  return {
    min: Math.max(m.min, c - 0.015),
    max: Math.min(m.max, c + 0.015),
    step: 0.001,
    merge: 0.002,
    dwell: 220,
  };
}

function spectrumNoiseDb(bins, dc, binHz) {
  const vals = [];
  const lo = Math.max(1, Math.round(280_000 / binHz));
  const hi = Math.min(dc - 2, Math.round(900_000 / binHz));
  for (let d = lo; d < hi; d += 6) {
    const left = dc - d;
    const right = dc + d;
    if (left >= 0) vals.push(bins[left]);
    if (right < bins.length) vals.push(bins[right]);
  }
  if (vals.length < 8) return -80;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.25)];
}

/** RF power near DC vs noise — strongest when tuned on the station center. */
function centerChannelSnr(frame, halfBwHz = 40_000) {
  const bins = frame?._bins;
  const sr = frame?.sample_rate_hz;
  if (!bins?.length || !sr) return 0;
  const n = bins.length;
  const dc = n / 2;
  const binHz = sr / n;
  const halfBins = Math.max(1, Math.round(halfBwHz / binHz));
  let peak = -1e9;
  for (let i = dc - halfBins; i <= dc + halfBins; i++) {
    if (i >= 0 && i < n) peak = Math.max(peak, bins[i]);
  }
  if (peak < -500) return 0;
  return peak - spectrumNoiseDb(bins, dc, binHz);
}

/** FM 广播：宽带载波 + 频道内能量占比，过滤噪声/窄 spur */
function wbfmCarrierPresent(frame) {
  const bins = frame?._bins;
  const sr = frame?.sample_rate_hz;
  if (!bins?.length || !sr) return false;

  const snrWide = centerChannelSnr(frame, 80_000);
  if (snrWide < WBFM_VOICE_SNR_WIDE_DB) return false;

  const snrMid = centerChannelSnr(frame, 22_000);
  if (snrMid < WBFM_VOICE_SNR_MID_DB) return false;

  const n = bins.length;
  const dc = n / 2;
  const binHz = sr / n;
  const floor = spectrumNoiseDb(bins, dc, binHz);
  const thresh = floor + 10;

  const halfBins = Math.max(1, Math.round(95_000 / binHz));
  let above = 0;
  let total = 0;
  for (let d = -halfBins; d <= halfBins; d++) {
    const i = dc + d;
    if (i < 0 || i >= n) continue;
    total++;
    if (bins[i] >= thresh) above++;
  }
  if (total === 0 || above / total < WBFM_VOICE_MIN_OCCUPANCY) return false;

  // 真 FM 台：±30…95 kHz 有持续能量，不是单点尖峰
  let wideSum = 0;
  let wideN = 0;
  const lo = Math.max(0, dc - halfBins);
  const hi = Math.min(n - 1, dc + halfBins);
  const skip = Math.max(1, Math.round(18_000 / binHz));
  for (let i = lo; i <= hi; i++) {
    if (Math.abs(i - dc) < skip) continue;
    wideSum += bins[i];
    wideN++;
  }
  if (wideN > 0 && wideSum / wideN < floor + 7) return false;

  return true;
}

/** 窄带模式：中心 SNR + 可选占用率（火腿/AM/SSB） */
function narrowCarrierPresent(frame, halfBwHz, minSnrDb, minOccupancy = 0) {
  const bins = frame?._bins;
  const sr = frame?.sample_rate_hz;
  if (!bins?.length || !sr) return false;

  const snr = centerChannelSnr(frame, halfBwHz);
  if (snr < minSnrDb) return false;
  if (minOccupancy <= 0) return true;

  const n = bins.length;
  const dc = n / 2;
  const binHz = sr / n;
  const floor = spectrumNoiseDb(bins, dc, binHz);
  const thresh = floor + 8;
  const halfBins = Math.max(1, Math.round(halfBwHz / binHz));
  let above = 0;
  let total = 0;
  for (let d = -halfBins; d <= halfBins; d++) {
    const i = dc + d;
    if (i < 0 || i >= n) continue;
    total++;
    if (bins[i] >= thresh) above++;
  }
  return total > 0 && above / total >= minOccupancy;
}

function voiceCarrierPresent(frame) {
  const m = mode.value;
  const bw = currentBandwidthHz();

  if (m === "wbfm") return wbfmCarrierPresent(frame);

  if (m === "nfm") {
    const half = Math.max(3_000, bw * 0.55);
    return narrowCarrierPresent(frame, half, 6, 0.1);
  }
  if (m === "am") {
    return narrowCarrierPresent(frame, Math.max(2_500, bw * 0.45), 6.5, 0.1);
  }
  if (m === "usb" || m === "lsb") {
    return narrowCarrierPresent(frame, Math.max(1_200, bw * 0.5), 5.5, 0);
  }
  if (m === "dsb") {
    return narrowCarrierPresent(frame, Math.max(1_800, bw * 0.45), 6, 0.08);
  }
  return narrowCarrierPresent(frame, Math.max(2_000, bw * 0.5), 7, 0);
}

function collapseScanHits(radiusMhz) {
  if (scanResults.length < 2) return;
  const sorted = [...scanResults].sort((a, b) => a.mhz - b.mhz);
  scanResults = sorted.filter(
    (h) =>
      !sorted.some(
        (o) => o !== h && Math.abs(o.mhz - h.mhz) <= radiusMhz + 1e-9 && o.peak > h.peak,
      ),
  );
  scanResultsByMode[mode.value] = scanResults;
}

function pushScanHit(mhz, peak, mergeMhz, extra = {}) {
  const last = scanResults[scanResults.length - 1];
  if (last && Math.abs(last.mhz - mhz) <= mergeMhz + 1e-9) {
    if (peak > last.peak) {
      last.mhz = mhz;
      last.peak = peak;
      Object.assign(last, extra);
    }
    return;
  }
  scanResults.push({ mhz, peak, ...extra });
  scanResultsByMode[mode.value] = scanResults;
}

async function waitScanPeak(expectHz, plan, thresh = 0) {
  const dwellMs = plan.dwell ?? SCAN_DWELL_MS;
  const matchHz = Math.min(35_000, Math.round((plan.step || 0.1) * 1e6 * 0.35));
  const start = performance.now();
  const deadline = start + Math.max(dwellMs, 420);
  const earlyExitAt = start + Math.min(dwellMs - 40, 450);
  const useSpec = !!plan.useSpectrum;
  let bestAudio = 0;
  let bestSnr = 0;

  while (performance.now() < deadline) {
    const fr = latestSpec;
    if (fr && Math.abs((fr.center_hz ?? 0) - expectHz) <= matchHz) {
      if (useSpec && fr._bins) {
        bestSnr = Math.max(bestSnr, centerChannelSnr(fr, plan.centerHz ?? 40_000));
      } else {
        bestAudio = Math.max(bestAudio, fr.level ?? 0);
      }
    }
    if (
      useSpec &&
      thresh > 0 &&
      performance.now() >= earlyExitAt &&
      bestSnr < thresh * 0.55
    ) {
      break;
    }
    await delay(35);
  }
  if (useSpec) {
    return { mhz: Number((expectHz / 1e6).toFixed(1)), peak: bestSnr, unit: "snr" };
  }
  return { mhz: expectHz / 1e6, peak: bestAudio, unit: "audio" };
}

let scanning = false;
let scanAbort = false;
let scanResultsByMode = loadScanResultsStore();
let scanResults = [];
let voiceAboveSince = 0;
let voiceBelowSince = 0;
let voiceHitStreak = 0;
let voiceMissStreak = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function levelMargin() {
  return LEVEL_MARGIN[mode?.value] || LEVEL_MARGIN.wbfm;
}

function resetLevelSquelch() {
  levelHot = false;
  levelSignalUntil = 0;
  levelNoiseFloor = 0.008;
  if (levelMono) levelMono.classList.remove("has-signal");
}

function currentMode() {
  return MODES[mode.value] || MODES.wbfm;
}

function formatMhz(mhz) {
  return mhz.toFixed(currentMode().decimals ?? 1);
}

function updateReadouts() {
  const mhz = Number(freq.value);
  freqReadout.textContent = `${formatMhz(mhz)} MHz`;
  const m = currentMode();
  subtitle.textContent = `${m.label.toUpperCase()} · RTL_TCP`;
}

function saveUserPreset(mhz, label) {
  const key = mode.value;
  if (!userPresets[key]) userPresets[key] = [];
  userPresets[key].push({ label, mhz });
  localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(userPresets));
  applyModeUi();
}

function applySpectrumZoomForMode() {
  if (!spectrumView) return;
  const z = {
    wbfm: 1,
    am: 1,
    nfm: 1,
    usb: 1,
    lsb: 1,
    dsb: 1,
  }[mode.value] ?? 1;
  spectrumView.setSpecZoom(z);
  const zoomEl = document.getElementById("spec-zoom");
  if (zoomEl) zoomEl.value = String(z);
}

function spectrumFrameMatchesMode(frame) {
  if (!frame?.sample_rate_hz || !frame?.center_hz) return false;
  const expectSr = defaultSampleRateHz();
  if (Math.abs(frame.sample_rate_hz - expectSr) > expectSr * 0.05) return false;
  const expectHz = exactFreqHz();
  return Math.abs(frame.center_hz - expectHz) < expectSr * 0.55;
}

function applyModeUi(opts = {}) {
  const m = currentMode();
  freq.min = m.min;
  freq.max = m.max;
  freq.step = m.step;
  if (!opts.keepFreq) {
    freq.value = formatMhz(m.defaultFreq);
    setExactFreqHz(Math.round(m.defaultFreq * 1_000_000));
  }
  stepDown.textContent = `−${m.stepLabel}`;
  stepUp.textContent = `+${m.stepLabel}`;
  stepFineDown.title = `细调 ${m.fineStepLabel ?? ""}`;
  stepFineUp.title = `细调 ${m.fineStepLabel ?? ""}`;
  updateListSectionTitles();
  spectrumView?.setBandwidthHz(currentBandwidthHz());
  spectrumView?.resetPan();
  if (bandwidthEl) {
    const { min, max } = bandwidthLimits();
    const bw = currentBandwidthHz();
    bandwidthEl.min = String(min / 1000);
    bandwidthEl.max = String(max / 1000);
    bandwidthEl.step = "any";
    bandwidthEl.value = formatBwInputKhz(bw);
    updateBwLabel(bw);
  }
  // Narrow modes need more ZOOM so the yellow BW band is visible / readable
  applySpectrumZoomForMode();
  updateReadouts();

  const isWbfm = mode.value === "wbfm";
  if (levelMono) levelMono.hidden = isWbfm;
  if (levelStereo) levelStereo.hidden = !isWbfm;
  if (isWbfm) resetLevelSquelch();

  presets.replaceChildren();
  const all = [...m.presets, ...(userPresets[mode.value] || [])];
  for (const p of all) {
    const li = document.createElement("li");
    li.className = "preset-cell";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-btn";
    btn.textContent = p.label;
    btn.title = `${formatMhz(p.mhz)} MHz`;
    btn.addEventListener("click", () => {
      tune(p.mhz, true);
      closeFreqSheet();
    });
    li.appendChild(btn);
    presets.appendChild(li);
  }
  fillGridRow(presets);
}

function config() {
  const m = currentMode();
  return {
    host: host.value.trim(),
    port: Number(port.value),
    freq_hz: exactFreqHz(),
    gain_db: Number(gain.value),
    gain_auto: isToggleOn(gainAuto),
    ppm: Number(ppm.value),
    mode: mode.value,
    bandwidth_hz: currentBandwidthHz(),
    deemphasis: deemphasisEnabled(),
    buffer_preset: bufferPreset?.value ?? "balanced",
    squelch_enabled: isToggleOn(squelchBtn),
    squelch_level: squelchUiValue() / 100,
  };
}

function setStatus(text, isError = false) {
  if (statusText.textContent === text && statusText.classList.contains("error") === !!isError) {
    return;
  }
  statusText.textContent = text;
  statusText.classList.toggle("error", isError);
}

let lastLiveMhz = null;
function setStatusLive(mhz) {
  if (lastLiveMhz === mhz && statusText.textContent.startsWith("LIVE")) return;
  lastLiveMhz = mhz;
  setStatus(`LIVE · ${formatMhz(mhz)} MHz`);
}

function setConnState(connected, reconnecting = false) {
  if (!connDot) return;
  connDot.classList.toggle("connected", connected && !reconnecting);
  connDot.classList.toggle("reconnecting", reconnecting);
  connDot.title = reconnecting ? "重连中…" : connected ? "已连接 rtl_tcp" : "未连接";
}

let lastLinkUi = 0;
function applyLinkQuality(frame) {
  if (!linkQuality) return;
  const now = performance.now();
  if (now - lastLinkUi < 400) return;
  lastLinkUi = now;
  if (!playing) {
    linkQuality.textContent = "链路 —";
    linkQuality.classList.remove("warn", "bad");
    linkQuality.title = "链路质量：未在收听";
    return;
  }
  const iq = frame.iq_drops ?? 0;
  const audDrop = frame.audio_drops ?? 0;
  const audUnder = frame.audio_underruns ?? 0;
  const aud = audDrop + audUnder;
  const total = iq + aud;
  linkQuality.textContent = `IQ丢${iq} · 音${aud}`;
  linkQuality.classList.toggle("warn", total > 4 && total <= 25);
  linkQuality.classList.toggle("bad", total > 25);
  linkQuality.title =
    `链路质量（累计，越小越稳）\n` +
    `IQ丢 ${iq}：网络空档或队列溢出（转发家里时常见）\n` +
    `音频丢块 ${audDrop}：播放来不及，丢掉旧音频\n` +
    `音频欠载 ${audUnder}：播放缓冲空了，断续/滋啦`;
}

function applyLevelUi(level, levelL, levelR) {
  const now = performance.now();
  const peak = level ?? 0;
  const margin = levelMargin();

  if (!levelHot) {
    levelNoiseFloor = levelNoiseFloor * 0.95 + peak * 0.05;
  }
  const on = levelNoiseFloor + margin;
  const off = levelNoiseFloor + margin * 0.4;

  if (peak >= on) {
    levelHot = true;
    levelSignalUntil = now + LEVEL_HANG_MS;
  } else if (peak < off && now >= levelSignalUntil) {
    levelHot = false;
  }
  if (levelMono) levelMono.classList.toggle("has-signal", levelHot);

  if (now - lastLevelUi < 32) return;
  lastLevelUi = now;
  const pct = (v) => `${Math.min(100, (v ?? 0) * 100)}%`;
  if (levelFill) levelFill.style.width = pct(level);
  if (levelFillL) levelFillL.style.width = pct(levelL);
  if (levelFillR) levelFillR.style.width = pct(levelR);
}

function voiceOnMs() {
  return VOICE_DETECT[mode.value]?.onMs ?? VOICE_ON_MS;
}

function voiceOffMs() {
  return VOICE_DETECT[mode.value]?.offMs ?? VOICE_OFF_MS;
}

/** 有声自动录：先 RF 有载波，开静噪时还要静噪开门 */
function voiceActivityRaw(frame) {
  if (!voiceCarrierPresent(frame)) return false;
  if (isToggleOn(squelchBtn)) return frame?.signal_open === true;
  return true;
}

function voiceActivityActive(frame) {
  const raw = voiceActivityRaw(frame);
  const need = VOICE_DETECT[mode.value]?.hits ?? 4;

  if (raw) {
    voiceMissStreak = 0;
    voiceHitStreak++;
  } else {
    voiceHitStreak = 0;
    voiceMissStreak++;
  }
  if (raw) return voiceHitStreak >= need;
  return voiceMissStreak < 2;
}

function handleVoiceRecord(frame) {
  if (!isToggleOn(voiceRecordBtn) || !playing || recordBusy) return;
  const active = voiceActivityActive(frame);
  const now = Date.now();
  const onMs = voiceOnMs();
  const offMs = voiceOffMs();

  if (active) {
    voiceBelowSince = 0;
    if (!voiceAboveSince) voiceAboveSince = now;
    if (!recording && now - voiceAboveSince >= onMs) {
      toggleRecord();
    }
  } else if (recording) {
    voiceAboveSince = 0;
    if (!voiceBelowSince) voiceBelowSince = now;
    if (now - voiceBelowSince >= offMs) {
      toggleRecord();
    }
  } else {
    voiceAboveSince = 0;
    voiceBelowSince = 0;
  }
}


function attachSpectrumChannel() {
  spectrumChannel = new Channel();
  spectrumChannel.onmessage = (frame) => {
    applyLinkQuality(frame);
    if (playing && !spectrumFrameMatchesMode(frame)) return;
    attachFrameBins(frame);
    latestSpec = frame;
    applyLevelUi(frame.level, frame.level_l ?? frame.level, frame.level_r ?? frame.level);
    handleVoiceRecord(frame);
    audioViz?.pushSpectrum(frame, currentBandwidthHz());
    const reconnecting = !!frame.error?.includes("重连") || !!frame.error?.includes("连接");
    setConnState(!!frame.connected, reconnecting);
    if (frame.error) setStatus(frame.error, true);
    else if (playing) setStatusLive(Number(freq.value));
    updateSpanReadout(frame.sample_rate_hz);
    if (bandwidthEl && frame.sample_rate_hz) {
      bandwidthEl.min = "0.2";
      bandwidthEl.max = String(frame.sample_rate_hz / 1000);
    }
    requestAnimationFrame(() => spectrumView?.update(frame));
  };
  return spectrumChannel;
}

function snapFreqMhz(mhz) {
  const m = currentMode();
  const snapped = Math.round(mhz / m.step) * m.step;
  return Math.max(m.min, Math.min(m.max, snapped));
}

/** Exact tuned frequency in Hz (avoids float round-trip via MHz input). */
function exactFreqHz() {
  const stored = Number(freq?.dataset?.hzHz);
  if (Number.isFinite(stored) && stored > 0) return Math.round(stored);
  return Math.round(Number(freq.value) * 1_000_000);
}

function setExactFreqHz(hz) {
  const m = currentMode();
  const clamped = Math.round(Math.max(m.min * 1e6, Math.min(m.max * 1e6, hz)));
  freq.dataset.hzHz = String(clamped);
  freq.value = formatMhz(clamped / 1e6);
  updateReadouts();
  syncFavoriteHeart();
  return clamped;
}

/** Click-to-tune: snap to FFT bin width, NOT channel step (12.5/25 kHz). */
function snapClickHz(hz, frame) {
  const m = currentMode();
  const binHz = frame?.sample_rate_hz ? frame.sample_rate_hz / 16384 : 1000;
  const fine = Math.max(25, binHz);
  const snapped = Math.round(hz / fine) * fine;
  return Math.round(Math.max(m.min * 1e6, Math.min(m.max * 1e6, snapped)));
}

/** IQ sample rate for click mapping when no spectrum frame yet. */
function defaultSampleRateHz() {
  const m = mode.value;
  if (m === "wbfm") return 2_048_000;
  if (m === "usb" || m === "lsb") return 192_000;
  return 2_048_000;
}

/** Frame metadata for click-to-tune — must match what's on screen (lastFrame), not optimistic latestSpec. */
function clickFrame() {
  const drawn = spectrumView?.lastFrame;
  if (drawn?.center_hz && drawn?.sample_rate_hz) {
    return { center_hz: drawn.center_hz, sample_rate_hz: drawn.sample_rate_hz };
  }
  const mhz = Number(freq.value);
  if (!Number.isFinite(mhz)) return null;
  return {
    center_hz: exactFreqHz(),
    sample_rate_hz: latestSpec?.sample_rate_hz ?? defaultSampleRateHz(),
  };
}

function onSpectrumClick(clientX, canvas, mhzDirect) {
  const frame = clickFrame();
  if (!frame || !spectrumView) return;
  const hz = mhzDirect != null
    ? mhzDirect * 1_000_000
    : spectrumView.freqHzAtClick(canvas, clientX, frame);
  if (!Number.isFinite(hz)) return;
  const targetHz = snapClickHz(hz, frame);
  spectrumView.setPanOffsetHz(targetHz - frame.center_hz, frame);
  tuneFromHz(targetHz, false, { keepPan: true });
}

function tuneFromHz(hz, playIfStopped = false, opts = {}) {
  setExactFreqHz(hz);
  if (!opts.keepPan) spectrumView?.resetPan();
  saveSettingsStore();
  if (playing) retune();
  else if (playIfStopped) start();
}

function bindContextMenu(canvas) {
  bindSpectrumContextMenu(canvas, {
    getFrame: () => clickFrame(),
    getFreqHz: (clientX, c, frame) => spectrumView?.freqHzAtClick(c, clientX, frame),
    onSetCenter: (mhz) => tuneFromHz(snapClickHz(mhz * 1_000_000, clickFrame())),
    onSavePreset: async (mhz) => {
      const label = await promptName({
        title: "预设名称",
        defaultValue: `${formatMhz(mhz)} MHz`,
      });
      if (label === null) return;
      saveUserPreset(snapFreqMhz(mhz), label.trim() || `${formatMhz(mhz)} MHz`);
    },
  });
}

bindContextMenu(specEl);
bindContextMenu(wfEl);

if (specEl && spectrumView) {
  bindSpectrumInteraction(spectrumView, specEl, {
    getFrame: () => clickFrame(),
    onTune: (clientX, canvas, mhzDirect) => onSpectrumClick(clientX, canvas, mhzDirect),
    onBandwidth: (hz) => setBandwidthHz(hz, true),
    getLimits: () => bandwidthLimits(),
  });
  bindWheelTune(specEl);
}

if (wfEl && spectrumView) {
  bindWaterfallInteraction(spectrumView, wfEl, {
    getFrame: () => clickFrame(),
    onTune: (clientX, canvas) => onSpectrumClick(clientX, canvas),
    onBandwidth: (hz) => setBandwidthHz(hz, true),
    getLimits: () => bandwidthLimits(),
  });
  bindWheelTune(wfEl);
}

function wheelDeltaPixels(e) {
  if (e.deltaMode === 1) return e.deltaY * 16;
  if (e.deltaMode === 2) return e.deltaY * 400;
  return e.deltaY;
}

function bindWheelTune(canvas) {
  if (!canvas) return;
  let accum = 0;
  let resetTimer = null;
  const threshold = 48;

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (e.ctrlKey) return;
      const ax = Math.abs(e.deltaX);
      const ay = Math.abs(e.deltaY);
      if (ax > ay * 0.65) return;

      accum += wheelDeltaPixels(e);
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        accum = 0;
      }, 140);

      const m = currentMode();
      const mult = e.shiftKey ? 10 : 1;
      const useFine = e.altKey;
      const step = useFine ? (m.fineStep ?? m.step / 10) : m.step * mult;

      while (accum <= -threshold) {
        if (useFine) tuneFineStep(1);
        else tune(snapFreqMhz(Number(freq.value) + step));
        accum += threshold;
      }
      while (accum >= threshold) {
        if (useFine) tuneFineStep(-1);
        else tune(snapFreqMhz(Number(freq.value) - step));
        accum -= threshold;
      }
    },
    { passive: false },
  );
}

function stepMult(shift) {
  return shift ? 10 : 1;
}

function tuneStep(direction, shift = false) {
  const m = currentMode();
  tune(snapFreqMhz(Number(freq.value) + direction * m.step * stepMult(shift)));
}

function clampFreqHz(hz) {
  const m = currentMode();
  return Math.round(Math.max(m.min * 1e6, Math.min(m.max * 1e6, hz)));
}

function tuneFineStep(direction) {
  const m = currentMode();
  const deltaHz = Math.round((m.fineStep ?? m.step / 10) * 1_000_000);
  tuneFromHz(clampFreqHz(exactFreqHz() + direction * deltaHz));
}

async function autoScan() {
  if (scanning) {
    scanAbort = true;
    return;
  }
  scanning = true;
  scanAbort = false;
  scanResults = [];
  scanResultsByMode[mode.value] = [];
  saveScanResultsStore();
  renderScanResults();
  const thresh = SCAN_THRESH[mode.value] ?? 0.05;
  const plan = scanPlan();
  try {
    if (!playing) await start();
    const stepHz = Math.round(plan.step * 1e6);
    const minHz = Math.round(plan.min * 1e6);
    const maxHz = Math.round(plan.max * 1e6);
    for (let hz = minHz; hz <= maxHz; hz += stepHz) {
      if (scanAbort) break;
      setExactFreqHz(hz);
      spectrumView?.resetPan();
      updateReadouts();
      if (playing) await invoke("radio_retune", { config: config() });
      setStatus(`搜台… ${formatMhz(hz / 1e6)} MHz`);
      const hit = await waitScanPeak(hz, plan, thresh);
      if (hit.peak >= thresh) {
        const mhz = Math.max(plan.min, Math.min(plan.max, hit.mhz));
        pushScanHit(mhz, hit.peak, plan.merge, { unit: hit.unit });
      }
      collapseScanHits(plan.merge);
      renderScanResults();
    }
    collapseScanHits(plan.merge);
    if (!scanAbort) {
      if (scanResults.length) {
        setStatus(`搜台完成 · 找到 ${scanResults.length} 个台`);
      } else {
        setStatus("搜台完成 · 未找到足够强的信号", true);
      }
    }
  } catch (e) {
    setStatus(`搜台错误: ${e}`, true);
  } finally {
    scanning = false;
    scanAbort = false;
    saveScanResultsStore();
    renderScanResults();
  }
}

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea")) return;
  if (e.key === " " || e.code === "Space") {
    e.preventDefault();
    if (playing) stop();
    else start();
    return;
  }
  if (e.key === "r" || e.key === "R") {
    if (playing) toggleRecord();
    return;
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (e.altKey) tuneFineStep(-1);
    else tuneStep(-1, e.shiftKey);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    if (e.altKey) tuneFineStep(1);
    else tuneStep(1, e.shiftKey);
  }
});

async function start() {
  try {
    saveSettingsStore();
    spectrumView?.resetPan();
    await invoke("radio_start", { config: config(), spectrumChannel: attachSpectrumChannel() });
    playing = true;
    playBtn.textContent = "停止";
    playBtn.classList.add("active");
    spectrumView?.setWaterfallActive(true);
    setStatus(`LIVE · ${formatMhz(Number(freq.value))} MHz`);
    setConnState(false, true);
  } catch (e) {
    setStatus(`错误: ${e}`, true);
  }
}

async function stop() {
  if (recording) await toggleRecord();
  await invoke("radio_stop");
  playing = false;
  playBtn.textContent = "开始收听";
  playBtn.classList.remove("active");
  spectrumView?.setWaterfallActive(false);
  setStatus("就绪");
  setConnState(false);
  if (linkQuality) {
    linkQuality.textContent = "链路 —";
    linkQuality.classList.remove("warn", "bad");
  }
  voiceAboveSince = 0;
  voiceBelowSince = 0;
  voiceHitStreak = 0;
  voiceMissStreak = 0;
  if (levelFill) levelFill.style.width = "0%";
  if (levelFillL) levelFillL.style.width = "0%";
  if (levelFillR) levelFillR.style.width = "0%";
  levelHot = false;
  levelSignalUntil = 0;
  resetLevelSquelch();
  audioViz?.stop();
  latestSpec = null;
  spectrumChannel = null;
  spectrumView?.clear();
}

let retuneTimer = null;
let retuneInFlight = false;
let retuneAgain = false;

function scheduleRetune(ms = 80) {
  if (!playing) return;
  clearTimeout(retuneTimer);
  retuneTimer = setTimeout(() => retune(), ms);
}

async function retune() {
  if (!playing) return;
  if (retuneInFlight) {
    retuneAgain = true;
    return;
  }
  retuneInFlight = true;
  try {
    do {
      retuneAgain = false;
      updateReadouts();
      await invoke("radio_retune", { config: config() });
      if (!playing) return;
      if (retuneAgain) continue;
      spectrumView?.resetPan();
      setStatus(`LIVE · ${formatMhz(Number(freq.value))} MHz`);
    } while (retuneAgain && playing);
  } catch (e) {
    setStatus(`错误: ${e}`, true);
  } finally {
    retuneInFlight = false;
    if (retuneAgain && playing) retune();
  }
}

function tune(mhz, playIfStopped = false) {
  tuneFromHz(Math.round(mhz * 1_000_000), playIfStopped);
}

async function toggleRecord() {
  if (!playing || recordBusy) return;
  recordBusy = true;
  const stopping = recording;
  try {
    if (stopping) {
      recording = false;
      stopRecordTimer();
      recordBtn.textContent = "录音";
      recordBtn.classList.remove("active");
      const path = await invoke("radio_record_stop");
      if (path) {
        if (isToggleOn(revealFinderBtn)) {
          try {
            await invoke("reveal_path_in_file_manager", { path });
          } catch {
            /* ignore reveal errors */
          }
        }
        setStatus(`已保存 → ${path}`);
      } else {
        setStatus(`LIVE · ${formatMhz(Number(freq.value))} MHz`);
      }
    } else {
      recording = true;
      recordBtn.classList.add("active");
      startRecordTimer();
      setStatus("录音中…");
      const path = await invoke("radio_record_start", { path: null, freqHz: exactFreqHz() });
      if (!recording) {
        await invoke("radio_record_stop").catch(() => {});
        return;
      }
      setStatus(`录音中 → ${path}`);
    }
  } catch (e) {
    recording = false;
    stopRecordTimer();
    recordBtn.textContent = "录音";
    recordBtn.classList.remove("active");
    setStatus(`录音错误: ${e}`, true);
  } finally {
    recordBusy = false;
  }
}

mode.addEventListener("change", () => {
  resetLevelSquelch();
  voiceAboveSince = 0;
  voiceBelowSince = 0;
  voiceHitStreak = 0;
  voiceMissStreak = 0;
  saveSettingsStore();
  clearTimeout(demodPushTimer);
  latestSpec = null;
  spectrumView?.clear();
  if (playing) spectrumView?.setWaterfallActive(true);
  setBandwidthHz(currentMode().bandwidthHz, false);
  applyModeUi();
  syncScanResultsForMode();
  renderFavorites();
  renderScanResults();
  if (playing) {
    setStatus("切换模式…");
    retune();
  }
});

playBtn.addEventListener("click", () => {
  if (playing) stop();
  else start();
});

recordBtn?.addEventListener("click", () => toggleRecord());

bandwidthEl?.addEventListener("change", () => {
  const khz = Number(bandwidthEl.value);
  if (Number.isFinite(khz)) setBandwidthHz(Math.round(khz * 1000), true);
});

gain.addEventListener("input", () => {
  gainLabel.textContent = Number(gain.value).toFixed(1);
  saveSettingsStore();
  if (playing) scheduleRetune(300);
});

bindToggle(gainAuto, () => {
  gain.disabled = isToggleOn(gainAuto);
  saveSettingsStore();
  if (playing) retune();
});

ppm.addEventListener("input", () => {
  if (ppmLabel) ppmLabel.textContent = ppm.value;
  saveSettingsStore();
  if (playing) scheduleRetune(300);
});

freq.addEventListener("input", updateReadouts);
freq.addEventListener("change", () => {
  setExactFreqHz(Math.round(Number(freq.value) * 1_000_000));
  saveSettingsStore();
  if (playing) retune();
});

stepDown.addEventListener("click", () => tuneStep(-1));
stepUp.addEventListener("click", () => tuneStep(1));
stepFineDown?.addEventListener("click", () => tuneFineStep(-1));
stepFineUp?.addEventListener("click", () => tuneFineStep(1));

favoriteHeartBtn?.addEventListener("click", () => addFavoriteCurrent({ quick: true }));
openFreqListBtn?.addEventListener("click", () => openFreqSheet());
freqSheetClose?.addEventListener("click", () => closeFreqSheet());
freqSheet?.querySelector(".freq-sheet-backdrop")?.addEventListener("click", () => closeFreqSheet());
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && freqSheet && !freqSheet.hidden) closeFreqSheet();
});

bindToggle(voiceRecordBtn, () => {
  voiceAboveSince = 0;
  voiceBelowSince = 0;
  voiceHitStreak = 0;
  voiceMissStreak = 0;
  saveSettingsStore();
});

bufferPreset?.addEventListener("change", () => {
  saveSettingsStore();
  if (playing) retune();
});

bindToggle(squelchBtn, () => {
  saveSettingsStore();
  pushAudioSettings();
});

squelchLevel?.addEventListener("input", () => {
  updateSquelchLabel();
  pushAudioSettings();
  scheduleSquelchSave();
});

let squelchSaveTimer = null;
function scheduleSquelchSave(ms = 200) {
  clearTimeout(squelchSaveTimer);
  squelchSaveTimer = setTimeout(() => saveSettingsStore(), ms);
}

let audioPushTimer = null;
function scheduleAudioSettings(ms = 16) {
  clearTimeout(audioPushTimer);
  audioPushTimer = setTimeout(() => pushAudioSettings(), ms);
}

host?.addEventListener("change", saveSettingsStore);
port?.addEventListener("change", saveSettingsStore);

resetSettingsBtn?.addEventListener("click", () => resetToDefaults());

bindToggle(revealFinderBtn, () => saveSettingsStore());

applySavedSettings(loadSettingsStore());
syncScanResultsForMode();
renderFavorites();
renderScanResults();
bindRangeSliders();
bindOverlayScrollbars();
