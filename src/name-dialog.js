/** In-app dialogs (window.prompt / window.confirm are unreliable in Tauri webviews). */

function bindDialogClose(wrap, close) {
  const backdrop = wrap.querySelector(".name-dialog-backdrop");
  const cancelBtn = wrap.querySelector(".name-dialog-cancel");
  cancelBtn?.addEventListener("click", () => close(false));
  backdrop?.addEventListener("click", () => close(false));
  window.addEventListener("keydown", (e) => {
    if (wrap.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close(false);
    }
  });
}

export function createNameDialog(root = document.body) {
  const wrap = document.createElement("div");
  wrap.id = "name-dialog";
  wrap.className = "name-dialog";
  wrap.hidden = true;
  wrap.innerHTML = `
    <div class="name-dialog-backdrop" tabindex="-1"></div>
    <form class="name-dialog-panel" role="dialog" aria-modal="true" aria-labelledby="name-dialog-title">
      <div id="name-dialog-title" class="name-dialog-title"></div>
      <input id="name-dialog-input" class="name-dialog-input" type="text" autocomplete="off" />
      <div class="name-dialog-actions">
        <button type="button" class="btn name-dialog-cancel">取消</button>
        <button type="submit" class="btn btn-accent name-dialog-ok">确定</button>
      </div>
    </form>
  `;
  root.appendChild(wrap);

  const titleEl = wrap.querySelector("#name-dialog-title");
  const inputEl = wrap.querySelector("#name-dialog-input");
  const formEl = wrap.querySelector("form");

  let resolveFn = null;
  let defaultValue = "";

  function close(result) {
    wrap.hidden = true;
    document.body.classList.remove("modal-open");
    if (resolveFn) {
      resolveFn(result);
      resolveFn = null;
    }
  }

  bindDialogClose(wrap, close);
  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const trimmed = inputEl.value.trim();
    close(trimmed || defaultValue);
  });

  return function promptName({ title = "名称", defaultValue: def = "" } = {}) {
    return new Promise((resolve) => {
      resolveFn = resolve;
      defaultValue = def;
      titleEl.textContent = title;
      inputEl.value = def;
      wrap.hidden = false;
      document.body.classList.add("modal-open");
      requestAnimationFrame(() => {
        inputEl.focus();
        inputEl.select();
      });
    });
  };
}

export function createConfirmDialog(root = document.body) {
  const wrap = document.createElement("div");
  wrap.id = "confirm-dialog";
  wrap.className = "name-dialog confirm-dialog";
  wrap.hidden = true;
  wrap.innerHTML = `
    <div class="name-dialog-backdrop" tabindex="-1"></div>
    <div class="name-dialog-panel" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
      <div id="confirm-dialog-title" class="name-dialog-title"></div>
      <p id="confirm-dialog-message" class="confirm-dialog-message"></p>
      <div class="name-dialog-actions">
        <button type="button" class="btn name-dialog-cancel">取消</button>
        <button type="button" class="btn btn-accent confirm-dialog-ok">确定</button>
      </div>
    </div>
  `;
  root.appendChild(wrap);

  const titleEl = wrap.querySelector("#confirm-dialog-title");
  const messageEl = wrap.querySelector("#confirm-dialog-message");
  const okBtn = wrap.querySelector(".confirm-dialog-ok");
  const cancelBtn = wrap.querySelector(".name-dialog-cancel");

  let resolveFn = null;

  function close(result) {
    wrap.hidden = true;
    document.body.classList.remove("modal-open");
    if (resolveFn) {
      resolveFn(result);
      resolveFn = null;
    }
  }

  bindDialogClose(wrap, close);
  okBtn.addEventListener("click", () => close(true));

  return function confirmDialog({
    title = "确认",
    message = "",
    okLabel = "确定",
    cancelLabel = "取消",
    danger = false,
  } = {}) {
    return new Promise((resolve) => {
      resolveFn = resolve;
      titleEl.textContent = title;
      messageEl.textContent = message;
      okBtn.textContent = okLabel;
      cancelBtn.textContent = cancelLabel;
      okBtn.classList.toggle("confirm-danger", danger);
      wrap.hidden = false;
      document.body.classList.add("modal-open");
      requestAnimationFrame(() => okBtn.focus());
    });
  };
}
