// A popup menu: right-click menus and the favorites overflow list.
//
// Menu.open(at, items)
//   at:    { x, y } (e.g. the mouse) or { anchor: element } (opens below it).
//          Add `keyboard: true` to start with the first item selected.
//   items: [{ label, icon?: appId, action, onContext?(event) } | { separator: true }]
// Opening it again for the same anchor closes it (so the anchor toggles it).
// It slides out of its anchor (or from the mouse) and back in when closed.
window.Menu = (() => {
  const EDGE = 8; // keep this far from the window edges

  let el = null;
  let anchor = null;
  let entries = []; // [{ item, li }] for the clickable items
  let active = -1;

  function setActive(i) {
    entries[active]?.li.classList.remove("active");
    active = i;
    entries[active]?.li.classList.add("active");
  }

  function run(entry) {
    close();
    entry.item.action?.();
  }

  function onKey(e) {
    const n = entries.length;
    switch (e.key) {
      case "ArrowDown":
        setActive((active + 1) % n);
        break;
      case "ArrowUp":
        setActive((active - 1 + n) % n);
        break;
      case "Home":
        setActive(0);
        break;
      case "End":
        setActive(n - 1);
        break;
      case "Enter":
      case " ":
        if (entries[active]) run(entries[active]);
        break;
      case "Escape":
        close();
        break;
      default:
        // Anything else (e.g. typing to search) closes the menu and carries on.
        close();
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerDown(e) {
    if (el.contains(e.target)) return;
    // Clicks on the anchor are left to it, so it can toggle the menu.
    if (anchor && anchor.contains(e.target)) return;
    close();
  }

  // Place the menu; returns which way it opens ("down", or "up" if there
  // was no room below).
  function position(at) {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x;
    let y;
    let dir = "down";
    if (at.anchor) {
      const r = at.anchor.getBoundingClientRect();
      x = r.left;
      y = r.bottom + 6;
      if (y + h > innerHeight - EDGE) {
        y = r.top - h - 6; // no room below: open above
        dir = "up";
      }
    } else {
      x = at.x;
      y = at.y;
      if (y + h > innerHeight - EDGE) {
        y = y - h;
        dir = "up";
      }
    }
    x = Math.min(x, innerWidth - w - EDGE);
    y = Math.min(y, innerHeight - h - EDGE);
    el.style.left = `${Math.max(EDGE, x)}px`;
    el.style.top = `${Math.max(EDGE, y)}px`;
    return dir;
  }

  function open(at, items) {
    if (el && at.anchor && at.anchor === anchor) {
      close();
      return;
    }
    close();
    anchor = at.anchor ?? null;
    anchor?.setAttribute("aria-expanded", "true");

    el = document.createElement("ul");
    el.className = "menu";
    el.setAttribute("role", "menu");
    entries = [];
    for (const item of items) {
      const li = document.createElement("li");
      if (item.separator) {
        li.className = "menu-separator";
        li.setAttribute("role", "separator");
        el.append(li);
        continue;
      }
      const index = entries.length;
      li.className = "menu-item";
      li.setAttribute("role", "menuitem");
      if (item.icon) {
        const img = document.createElement("img");
        img.className = "menu-icon";
        img.alt = "";
        window.Icons.show(img, item.icon);
        li.append(img);
      }
      const label = document.createElement("span");
      label.className = "menu-label";
      label.textContent = item.label;
      li.append(label);
      li.addEventListener("mousemove", () => setActive(index));
      li.addEventListener("click", () => run(entries[index]));
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        item.onContext?.(e);
      });
      entries.push({ item, li });
      el.append(li);
    }
    document.body.append(el);
    el.dataset.dir = position(at);
    window.Motion.slideIn(el, el.dataset.dir);
    active = -1;
    if (at.keyboard) setActive(0);

    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", close);
  }

  function close() {
    if (!el) return;
    // Slide away, then remove. The menu is finished with straight away, so
    // a new one can open while this one is still leaving.
    const leaving = el;
    leaving.style.pointerEvents = "none";
    window.Motion.slideOut(leaving, leaving.dataset.dir).then(() => leaving.remove());
    el = null;
    anchor?.setAttribute("aria-expanded", "false");
    anchor = null;
    entries = [];
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("blur", close);
  }

  return { open, close };
})();
