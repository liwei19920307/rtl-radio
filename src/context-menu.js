let menuEl = null;
let hideHandler = null;

function ensureMenu() {
  if (menuEl) return menuEl;
  menuEl = document.createElement("div");
  menuEl.id = "spectrum-context-menu";
  menuEl.className = "context-menu hidden";
  menuEl.setAttribute("role", "menu");
  document.body.appendChild(menuEl);
  return menuEl;
}

function hideMenu() {
  if (!menuEl) return;
  menuEl.classList.add("hidden");
  if (hideHandler) {
    document.removeEventListener("mousedown", hideHandler);
    document.removeEventListener("keydown", hideHandler);
    hideHandler = null;
  }
}

function showMenu(x, y, items) {
  const menu = ensureMenu();
  menu.replaceChildren();
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "context-menu-sep";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "context-menu-item";
    btn.textContent = item.label;
    btn.disabled = !!item.disabled;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      hideMenu();
      item.action?.();
    });
    menu.appendChild(btn);
  }

  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;

  hideHandler = (e) => {
    if (e.type === "keydown" && e.key !== "Escape") return;
    hideMenu();
  };
  setTimeout(() => {
    document.addEventListener("mousedown", hideHandler);
    document.addEventListener("keydown", hideHandler);
  }, 0);
}

/** Right-click menu on spectrum / waterfall canvases. */
export function bindSpectrumContextMenu(canvas, { getFrame, getFreqHz, onSetCenter, onSavePreset }) {
  if (!canvas) return;

  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const frame = getFrame();
    if (!frame) return;
    const hz = getFreqHz(e.clientX, canvas, frame);
    if (hz == null) return;

    const mhz = hz / 1_000_000;
    showMenu(e.clientX, e.clientY, [
      {
        label: `设为中心频率 (${mhz.toFixed(4)} MHz)`,
        action: () => onSetCenter(mhz),
      },
      {
        label: "保存为预设…",
        action: () => onSavePreset(mhz),
      },
    ]);
  });
}
