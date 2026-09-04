function formatEndValue(value, step) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const s = Number(step);
  if (Number.isFinite(s) && s > 0 && s < 1) return n.toFixed(1);
  if (Math.abs(n) >= 100 || Number.isInteger(n)) return String(Math.round(n));
  return n.toFixed(1);
}

function progressPct(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const val = Number(input.value);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0;
  return Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
}

function ensureProgress(shell, vertical) {
  shell.querySelector(".range-ticks")?.remove();

  let track = shell.querySelector(".range-progress");
  if (!track) {
    track = document.createElement("div");
    track.className = `range-progress ${vertical ? "range-progress-v" : "range-progress-h"}`;
    track.setAttribute("aria-hidden", "true");
    const fill = document.createElement("div");
    fill.className = "range-progress-fill";
    track.appendChild(fill);
    shell.insertBefore(track, shell.querySelector('input[type="range"]'));
  }
  return track.querySelector(".range-progress-fill");
}

function updateProgress(shell, input) {
  const vertical = shell.classList.contains("range-v");
  const fill = ensureProgress(shell, vertical);
  const pct = progressPct(input);
  if (vertical) fill.style.height = `${pct}%`;
  else fill.style.width = `${pct}%`;
}

function bindEndLabels(stack, input, vertical) {
  if (!stack) return;
  const shell = stack.querySelector(".range-shell");
  if (!shell) return;

  let minEl = stack.querySelector(".range-end-min");
  let maxEl = stack.querySelector(".range-end-max");
  if (!minEl) {
    minEl = document.createElement("span");
    minEl.className = "range-end range-end-min";
    minEl.setAttribute("aria-hidden", "true");
  }
  if (!maxEl) {
    maxEl = document.createElement("span");
    maxEl.className = "range-end range-end-max";
    maxEl.setAttribute("aria-hidden", "true");
  }

  const step = input.step;
  minEl.textContent = formatEndValue(input.min, step);
  maxEl.textContent = formatEndValue(input.max, step);

  stack.replaceChildren();
  if (vertical) stack.append(maxEl, shell, minEl);
  else stack.append(minEl, shell, maxEl);
}

function layoutShell(shell) {
  const input = shell.querySelector('input[type="range"]');
  if (!input) return;
  const vertical = shell.classList.contains("range-v");
  updateProgress(shell, input);
  bindEndLabels(shell.closest(".range-stack"), input, vertical);

  if (input.dataset.progressBound) return;
  input.dataset.progressBound = "1";
  input.addEventListener("input", () => updateProgress(shell, input));
  input.addEventListener("change", () => updateProgress(shell, input));
}

export function initRangeSliders(root = document) {
  for (const shell of root.querySelectorAll(".range-shell")) {
    layoutShell(shell);
  }
}

export function bindRangeSliders(root = document) {
  initRangeSliders(root);
  window.addEventListener("resize", () => initRangeSliders(root));
}
