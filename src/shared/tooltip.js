// A hover tooltip shared by the whole pane (weather days, calendar dates…).
//
// Tooltip.attach(element, build) shows build()'s content while the element is
// hovered or focused. Tooltip.show(element, build) / Tooltip.hide(element)
// do the same by hand. Tooltip.content(title, rows) makes simple content.
// Content is built with textContent only, so data from the web is never
// treated as HTML.
window.Tooltip = (() => {
  const EDGE = 8;
  const GAP = 8;

  const el = document.createElement("div");
  el.className = "tooltip";
  el.setAttribute("role", "tooltip");
  el.hidden = true;
  document.body.append(el);

  let current = null;

  function position(target) {
    const r = target.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = r.left + r.width / 2 - w / 2;
    let y = r.top - h - GAP; // above, if there's room
    if (y < EDGE) y = r.bottom + GAP;
    x = Math.max(EDGE, Math.min(x, innerWidth - w - EDGE));
    y = Math.max(EDGE, Math.min(y, innerHeight - h - EDGE));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  function show(target, build) {
    const content = build();
    if (!content) return;
    current = target;
    el.replaceChildren(...[content].flat());
    el.hidden = false;
    position(target);
  }

  function hide(target) {
    if (target && target !== current) return;
    el.hidden = true;
    current = null;
  }

  function attach(target, build) {
    target.addEventListener("mouseenter", () => show(target, build));
    target.addEventListener("mouseleave", () => hide(target));
    target.addEventListener("focus", () => show(target, build));
    target.addEventListener("blur", () => hide(target));
  }

  // A bold title line followed by plain lines (empty ones are skipped).
  // `icon` (optional) is a CSS image, e.g. 'url("icons/rainy.png")', shown
  // beside the title.
  function content(title, rows = [], icon = null) {
    const nodes = [];
    if (title) {
      const t = document.createElement("div");
      t.className = "tooltip-title";
      t.textContent = title;
      if (icon) {
        const head = document.createElement("div");
        head.className = "tooltip-head";
        const img = document.createElement("span");
        img.className = "icon tooltip-icon";
        img.setAttribute("aria-hidden", "true");
        img.style.setProperty("--icon", icon);
        head.append(img, t);
        nodes.push(head);
      } else {
        nodes.push(t);
      }
    }
    for (const row of rows) {
      if (!row) continue;
      const r = document.createElement("div");
      r.className = "tooltip-row";
      r.textContent = row;
      nodes.push(r);
    }
    return nodes;
  }

  // Elements get re-rendered; don't leave a tooltip pointing at nothing.
  window.addEventListener("blur", () => hide());
  document.addEventListener("wheel", () => hide(), { passive: true });

  return { attach, content, show, hide };
})();
