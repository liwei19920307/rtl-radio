/** Thin overlay scrollbars — visible only while scrolling. */
export function bindOverlayScrollbars() {
  const timers = new WeakMap();

  document.addEventListener(
    "scroll",
    (e) => {
      const el = e.target;
      if (!(el instanceof Element) || el === document.documentElement) return;
      if (getComputedStyle(el).overflowY === "visible" && getComputedStyle(el).overflowX === "visible") {
        return;
      }
      el.classList.add("overlay-scroll", "is-scrolling");
      const prev = timers.get(el);
      if (prev) clearTimeout(prev);
      timers.set(
        el,
        setTimeout(() => el.classList.remove("is-scrolling"), 900),
      );
    },
    true,
  );
}
