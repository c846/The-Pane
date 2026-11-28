// Brief things shown with the pane only partly open (Slide.glance; the
// backend decides when, see pane.rs):
//
// Volume popup  "volume-popup" {level, muted}: a volume key was pressed.
//               Just a vertical bar with the level above it. The backend
//               slides it away shortly after the last press.
// Low battery   "battery-low": the battery just got low. A battery with a
//               "!" beside it that bounces twice; the backend slides it
//               away after a few seconds.
//               ("volume-changed" instead, when the pane is fully open:
//               only the volume widgets move; they listen for both.)
// Switcher      "switcher-open" {windows, selected}: Alt+Space. A preview
//               and the name of each open window, front to back.
//               "switcher-select" i: Space pressed again, highlight window i.
//               Letting go of Alt switches; the backend does that.
// Overview      "overview-open" selected: Space was held down. The pane
//               slides on across the whole screen, showing the same windows
//               in a grid. Click one to switch to it (`overview_pick`), or
//               the background to close it (`overview_close`); the backend
//               closes it on Esc or Home.
window.Glance = (() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const $ = (id) => document.getElementById(id);
  const sheet = $("sheet");

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
  }

  // ---- Volume popup ------------------------------------------------------------

  const volumePop = $("volume-pop");
  const volumeValue = $("volume-pop-value");
  const volumeFill = $("volume-pop-fill");

  function showVolume({ level, muted }, animate) {
    const changed = volumeValue.textContent !== String(level);
    volumeValue.textContent = level;
    volumePop.classList.toggle("muted", muted);
    if (!animate) volumeFill.style.transition = "none";
    volumeFill.style.height = `${level}%`;
    if (!animate) {
      volumeFill.getBoundingClientRect(); // apply the height before transitions return
      volumeFill.style.transition = "";
    } else if (changed) {
      window.Motion.pulse(volumeValue, [{ transform: "scale(1)" }, { transform: "scale(1.08)", offset: 0.35 }, { transform: "scale(1)" }], 220);
    }
  }

  listen("volume-popup", ({ payload }) => {
    // Already showing: the bar moves. Appearing: it starts at the new level.
    showVolume(payload, sheet.dataset.glance === "volume");
    window.Backdrop.refresh(); // in case the wallpaper (and so the theme) changed
    window.Slide.glance("volume");
  });

  // ---- Low battery ---------------------------------------------------------------

  const batteryAlert = $("battery-pop-alert");

  listen("battery-low", () => {
    // Restart the bounce.
    batteryAlert.classList.remove("bounce");
    batteryAlert.getBoundingClientRect();
    batteryAlert.classList.add("bounce");
    window.Backdrop.refresh();
    window.Slide.glance("battery");
  });

  // ---- Window switcher -----------------------------------------------------------

  const list = $("switcher-list");
  // The last preview of each window, shown straight away next time while a
  // fresh one is taken.
  const previews = new Map(); // window id -> canvas
  let items = [];
  let shownWindows = []; // as last sent by "switcher-open" (the overview shows them too)

  // The backend sends width and height (u32 each), then RGBA pixels.
  function previewCanvas(buffer) {
    if (!buffer || buffer.byteLength < 8) return null;
    const view = new DataView(buffer);
    const w = view.getUint32(0, true);
    const h = view.getUint32(4, true);
    const pixels = new Uint8ClampedArray(buffer, 8);
    if (!w || !h || pixels.length !== w * h * 4) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").putImageData(new ImageData(pixels, w, h), 0, 0);
    return canvas;
  }

  function makeItem(win) {
    const item = el("li", "switcher-item glass");
    item.setAttribute("role", "option");

    // Preview, or the app's icon if there is none (e.g. minimised).
    const preview = el("div", "switcher-preview");
    const bigIcon = el("img", "switcher-preview-icon");
    bigIcon.alt = "";
    preview.append(bigIcon);
    const cached = previews.get(win.id);
    if (cached) preview.append(cached);

    const label = el("div", "switcher-label");
    const icon = el("img", "switcher-icon");
    icon.alt = "";
    icon.hidden = true;
    const text = el("div", "switcher-text");
    text.append(el("div", "switcher-name", win.name));
    if (win.title && win.title !== win.name) text.append(el("div", "switcher-title", win.title));
    label.append(icon, text);
    item.append(preview, label);

    invoke("window_icon", { id: win.id })
      .then((buf) => {
        const url = window.Icons.pixelsToUrl(buf, 64);
        if (!url) return;
        icon.src = bigIcon.src = url;
        icon.hidden = false;
      })
      .catch(() => {});

    invoke("window_preview", { id: win.id })
      .then((buf) => {
        const canvas = previewCanvas(buf);
        if (canvas) {
          previews.set(win.id, canvas);
          preview.replaceChildren(bigIcon, canvas);
        } else {
          // Minimised now: an old snapshot would be misleading.
          previews.delete(win.id);
          preview.replaceChildren(bigIcon);
        }
      })
      .catch(() => {});

    return item;
  }

  function select(index, smooth) {
    items.forEach((item, i) => {
      item.classList.toggle("selected", i === index);
      item.setAttribute("aria-selected", String(i === index));
    });
    items[index]?.scrollIntoView({ block: "nearest", behavior: smooth ? "smooth" : "instant" });
  }

  listen("switcher-open", ({ payload }) => {
    const { windows, selected } = payload;
    for (const id of previews.keys()) {
      if (!windows.some((w) => w.id === id)) previews.delete(id); // closed since
    }
    shownWindows = windows;
    items = windows.map(makeItem);
    list.replaceChildren(...items);
    select(selected, false);
    window.Backdrop.refresh();
    window.Slide.glance("switcher");
  });

  listen("switcher-select", ({ payload }) => select(payload, true));

  // ---- Overview ----------------------------------------------------------------

  const grid = $("overview-grid");
  const overview = grid.closest(".glance-overview");

  listen("overview-open", ({ payload: selected }) => {
    const tiles = shownWindows.map((win, i) => {
      const tile = makeItem(win);
      tile.classList.toggle("selected", i === selected);
      tile.addEventListener("click", () => invoke("overview_pick", { id: win.id }).catch(console.error));
      return tile;
    });
    grid.replaceChildren(...tiles);
    overview.scrollTop = 0;
    window.Slide.glance("overview");
  });

  // Clicking anywhere but a window closes it.
  overview.addEventListener("click", (e) => {
    if (!e.target.closest(".switcher-item")) invoke("overview_close").catch(console.error);
  });

  return {};
})();
