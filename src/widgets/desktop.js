// The desktop window: always behind every app, never takes focus. Draws the
// wallpaper and hosts the widgets.
//
// Widgets sit on a grid of square cells, each the size of an app tile in the
// pane's apps panel. Every widget covers a whole number of cells, at one of
// the sizes listed for it in shared/widget-catalog.js. Which widgets are
// placed, where and at what size is kept by the backend (widgets.rs); this
// page shows them and saves the user's changes:
//
// - Drag a widget (by any part that isn't a control) to move it. The grid's
//   cells show as small squares while dragging; the ones it would land on
//   grow. It snaps into place when let go, or goes back if it doesn't fit.
// - Drag its bottom-right corner to resize it; it snaps to the nearest of
//   its sizes.
// - The × in its top-right corner removes it.
// None of these work while the layout is locked (from the pane's settings).
//
// A widget is a script in its own folder that calls:
//
//   Desktop.register({
//     kind: "weather",                // as in the catalog
//     create(el, settings, size) {    // el: the widget's (empty) body
//       ...build into el...           // size: {w, h} in cells; also
//       return {                      //   el.dataset.size, e.g. "3x2"
//         settingsChanged(settings),  // optional
//         resized(size),              // optional
//         destroy(),                  // optional: stop timers etc.
//       };
//     },
//   });
//
// The wallpaper is drawn once into a canvas at the screen's size, so a large
// image costs only a screen's worth of memory. Widgets add no work of their
// own while idle: nothing animates, and each refreshes on its own schedule.
window.Desktop = (() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  // Average wallpaper brightness (0-1) above which it counts as light.
  const LIGHT_THRESHOLD = 0.5;
  // Space kept between the grid and the screen's edges.
  const MARGIN = 10;
  // The least space between cells (as between the pane's app tiles). Any
  // space left over across the screen is shared out between the cells, so
  // the grid always reaches MARGIN from every edge.
  const GAP = 10;
  // How far the pointer moves before a press becomes a drag.
  const DRAG_SLOP = 4;

  const canvas = document.getElementById("wallpaper");
  const dotsLayer = document.getElementById("grid");
  const layer = document.getElementById("widgets");

  // ---- Wallpaper -----------------------------------------------------------------

  let wallpaper = null; // decoded image (ImageBitmap), kept for redraws on resize

  async function loadWallpaper() {
    const bytes = await invoke("get_wallpaper").catch(() => null);
    if (wallpaper) wallpaper.close();
    wallpaper = null;
    if (bytes && bytes.byteLength) {
      try {
        wallpaper = await createImageBitmap(new Blob([bytes]));
      } catch (err) {
        console.error("Couldn't decode the wallpaper", err);
      }
    }
    drawWallpaper();
  }

  // Cover the screen (cropping the edges, like Windows' "Fill"), then shrink
  // the kept copy to the screen's size so the original can be let go.
  function drawWallpaper() {
    const w = Math.round(innerWidth * devicePixelRatio);
    const h = Math.round(innerHeight * devicePixelRatio);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    if (!wallpaper) {
      setTheme(false);
      return;
    }
    const scale = Math.max(w / wallpaper.width, h / wallpaper.height);
    const dw = wallpaper.width * scale;
    const dh = wallpaper.height * scale;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(wallpaper, (w - dw) / 2, (h - dh) / 2, dw, dh);
    if (wallpaper.width > w || wallpaper.height > h) {
      // Keep a screen-sized copy instead of the full-size original.
      const full = wallpaper;
      createImageBitmap(canvas).then((small) => {
        if (wallpaper === full) {
          wallpaper = small;
          full.close();
        } else small.close();
      });
    }
    setTheme(isLight());
  }

  // Light wallpaper -> black text; dark wallpaper -> white text.
  function setTheme(light) {
    document.documentElement.dataset.wallpaper = light ? "light" : "dark";
  }

  function isLight() {
    const sample = document.createElement("canvas");
    sample.width = 64;
    sample.height = 36;
    const ctx = sample.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
    const px = ctx.getImageData(0, 0, sample.width, sample.height).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) {
      sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    }
    return sum / (px.length / 4) / 255 > LIGHT_THRESHOLD;
  }


  // ---- Grid ----------------------------------------------------------------------

  // A cell is an app tile of the pane's apps panel: that column is
  // clamp(380px, 26vw, 480px) wide, holding three tiles 10px apart inside
  // 16px of padding (see style.css). As many cells fit as can, MARGIN from
  // the edges; the gaps between them widen a little (across and down
  // separately) to use up the rest of the screen.
  let grid = null;

  function measureGrid() {
    const column = Math.min(Math.max(380, innerWidth * 0.26), 480);
    const cell = (column - 2 * 16 - 2 * GAP) / 3;
    const axis = (length) => {
      const room = length - 2 * MARGIN;
      const count = Math.max(1, Math.floor((room + GAP) / (cell + GAP)));
      const gap = count > 1 ? (room - count * cell) / (count - 1) : GAP;
      // A single cell (a tiny screen) sits in the middle.
      const start = count > 1 ? MARGIN : (length - cell) / 2;
      return { count, gap, pitch: cell + gap, start };
    };
    const x = axis(innerWidth);
    const y = axis(innerHeight);
    return {
      cell,
      cols: x.count,
      rows: y.count,
      gapX: x.gap,
      gapY: y.gap,
      pitchX: x.pitch,
      pitchY: y.pitch,
      left: x.start,
      top: y.start,
    };
  }

  // One small square per cell, shown while arranging.
  function buildDots() {
    const { cols, rows, cell, pitchX, pitchY, left, top } = grid;
    dotsLayer.style.setProperty("--cell", `${cell}px`);
    const dots = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const d = document.createElement("div");
        d.className = "grid-cell";
        d.style.left = `${left + c * pitchX}px`;
        d.style.top = `${top + r * pitchY}px`;
        dots.push(d);
      }
    }
    dotsLayer.replaceChildren(...dots);
  }

  // Grow the squares under a rectangle of cells (null: none). `fits` says
  // whether the widget could go there.
  function highlight(rect, fits = true) {
    const { cols } = grid;
    dotsLayer.classList.toggle("blocked", !fits);
    dotsLayer.childNodes.forEach((d, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const on = rect && c >= rect.col && c < rect.col + rect.w && r >= rect.row && r < rect.row + rect.h;
      d.classList.toggle("on", !!on);
    });
  }

  function arranging(on) {
    document.documentElement.classList.toggle("arranging", on);
    if (!on) highlight(null);
  }

  const pxRect = ({ col, row, w, h }) => ({
    x: grid.left + col * grid.pitchX,
    y: grid.top + row * grid.pitchY,
    width: w * grid.pitchX - grid.gapX,
    height: h * grid.pitchY - grid.gapY,
  });

  const inside = ({ col, row, w, h }) => col >= 0 && row >= 0 && col + w <= grid.cols && row + h <= grid.rows;
  const overlaps = (a, b) =>
    a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;

  // Whether a rectangle of cells is on the grid and clear of every other
  // shown widget (all but `id`).
  function free(rect, id) {
    if (!inside(rect)) return false;
    for (const [other, w] of live) {
      if (other !== id && w.spot && overlaps(rect, w.spot)) return false;
    }
    return true;
  }

  // A free spot for a new widget: the top-right corner first, then down
  // and to the left. Null if there's no room.
  function findSpot(w, h, id) {
    for (let col = grid.cols - w; col >= 0; col--) {
      for (let row = 0; row + h <= grid.rows; row++) {
        if (free({ col, row, w, h }, id)) return { col, row, w, h };
      }
    }
    return null;
  }

  // ---- Widgets -------------------------------------------------------------------

  const defs = new Map(); // kind -> definition (see register)
  const catalog = new Map((window.WidgetCatalog ?? []).map((c) => [c.kind, c]));
  // id -> { kind, el, body, instance, spot: {col, row, w, h} as shown }
  const live = new Map();
  let settings = null;
  let layout = null; // from the backend: { locked, widgets: [...] }

  const locked = () => layout?.locked ?? false;
  const sizesOf = (kind) => catalog.get(kind)?.sizes ?? [];

  // Put a widget where its spot says, animating there if asked.
  function show(w, animate = false) {
    const r = pxRect(w.spot);
    w.el.classList.toggle("settling", animate);
    Object.assign(w.el.style, {
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    const size = `${w.spot.w}x${w.spot.h}`;
    if (w.body.dataset.size !== size) {
      w.body.dataset.size = size;
      w.instance.resized?.({ w: w.spot.w, h: w.spot.h });
    }
  }

  function save(id, spot) {
    invoke("place_widget", { id, ...spot }).catch((err) => console.error("Couldn't save the widget", err));
  }

  function mount(placed) {
    const def = defs.get(placed.kind);
    const el = document.createElement("section");
    el.className = `widget widget-${placed.kind}`;
    el.dataset.id = placed.id;
    const body = document.createElement("div");
    body.className = "widget-body";
    body.dataset.size = `${placed.w}x${placed.h}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "widget-remove";
    remove.title = "Remove widget";
    remove.setAttribute("aria-label", "Remove widget");
    remove.addEventListener("click", () => {
      invoke("remove_widget", { id: placed.id }).catch((err) => console.error("Couldn't remove the widget", err));
    });
    el.append(body, remove);
    if (sizesOf(placed.kind).length > 1) {
      const grip = document.createElement("div");
      grip.className = "widget-resize";
      grip.title = "Drag to resize";
      el.append(grip);
      makeResizable(placed.id, grip);
    }
    layer.append(el);

    const w = { kind: placed.kind, el, body, instance: {}, spot: null };
    live.set(placed.id, w);
    try {
      w.instance = def.create(body, settings, { w: placed.w, h: placed.h }) ?? {};
    } catch (err) {
      console.error(`Widget "${placed.kind}" failed to start`, err);
    }
    makeDraggable(placed.id, el);
  }

  function unmount(id) {
    const w = live.get(id);
    if (!w) return;
    w.instance.destroy?.();
    w.el.remove();
    live.delete(id);
  }

  // Show the layout: mount what's new, drop what's gone, place the rest.
  function render() {
    if (!layout || !settings) return;
    document.documentElement.classList.toggle("locked", locked());
    const wanted = layout.widgets.filter((p) => defs.has(p.kind));
    const ids = new Set(wanted.map((p) => p.id));
    for (const id of [...live.keys()]) if (!ids.has(id)) unmount(id);

    // Widgets with a spot first, so new ones find room around them.
    const ordered = [...wanted.filter((p) => p.col != null), ...wanted.filter((p) => p.col == null)];
    for (const p of ordered) {
      if (!live.has(p.id)) mount(p);
      const w = live.get(p.id);
      if (w.el.classList.contains("dragging") || w.el.classList.contains("resizing")) continue;
      if (p.col == null || p.row == null) {
        // Just added: find it a spot, and save that. If there's no room it
        // goes in the top-left corner, on top of whatever's there.
        w.spot = findSpot(p.w, p.h, p.id) ?? { col: 0, row: 0, w: p.w, h: p.h };
        save(p.id, w.spot);
      } else {
        // Kept on the grid if the screen got smaller (without saving, so
        // it's back where it was if the screen grows again).
        w.spot = {
          col: Math.min(Math.max(0, p.col), Math.max(0, grid.cols - p.w)),
          row: Math.min(Math.max(0, p.row), Math.max(0, grid.rows - p.h)),
          w: p.w,
          h: p.h,
        };
      }
      show(w);
    }
  }

  // Drag a widget by any part of it that isn't a control. A press that
  // doesn't move is left alone, so clicks inside widgets still work.
  function makeDraggable(id, el) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || locked()) return;
      if (e.target.closest("button, a, input, select, textarea, .widget-resize")) return;
      const w = live.get(id);
      const offX = e.clientX - el.offsetLeft;
      const offY = e.clientY - el.offsetTop;
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      let target = null;
      el.setPointerCapture(e.pointerId);

      const move = (m) => {
        if (!dragging) {
          if (Math.hypot(m.clientX - startX, m.clientY - startY) < DRAG_SLOP) return;
          dragging = true;
          el.classList.remove("settling");
          el.classList.add("dragging");
          arranging(true);
        }
        const x = m.clientX - offX;
        const y = m.clientY - offY;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        // The cells it's over: nearest its top-left corner, kept on the grid.
        const { w: cw, h: ch } = w.spot;
        const col = Math.min(Math.max(0, Math.round((x - grid.left) / grid.pitchX)), Math.max(0, grid.cols - cw));
        const row = Math.min(Math.max(0, Math.round((y - grid.top) / grid.pitchY)), Math.max(0, grid.rows - ch));
        target = { col, row, w: cw, h: ch };
        highlight(target, free(target, id));
      };
      const end = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", end);
        el.removeEventListener("pointercancel", end);
        if (!dragging) return;
        el.classList.remove("dragging");
        arranging(false);
        const moved = target && (target.col !== w.spot.col || target.row !== w.spot.row);
        if (moved && free(target, id)) {
          w.spot = target;
          save(id, target);
        }
        show(w, true); // snap into place, or back where it was
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    });
  }

  // Drag the bottom-right corner to pick another of the widget's sizes: the
  // one nearest the pointer that fits where the widget is.
  function makeResizable(id, grip) {
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || locked()) return;
      e.stopPropagation();
      const w = live.get(id);
      const from = w.spot;
      grip.setPointerCapture(e.pointerId);
      w.el.classList.add("resizing");
      arranging(true);
      highlight(from);

      const move = (m) => {
        const r = pxRect(w.spot);
        // How many cells the pointer asks for, as fractions.
        const wantW = (m.clientX - r.x + grid.gapX / 2) / grid.pitchX;
        const wantH = (m.clientY - r.y + grid.gapY / 2) / grid.pitchY;
        let best = null;
        let bestDist = Infinity;
        for (const [sw, sh] of sizesOf(w.kind)) {
          const spot = { col: w.spot.col, row: w.spot.row, w: sw, h: sh };
          if (!free(spot, id)) continue;
          const dist = (sw - wantW) ** 2 + (sh - wantH) ** 2;
          if (dist < bestDist) [best, bestDist] = [spot, dist];
        }
        if (best && (best.w !== w.spot.w || best.h !== w.spot.h)) {
          w.spot = best;
          show(w, true);
        }
        highlight(w.spot);
      };
      const end = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", end);
        grip.removeEventListener("pointercancel", end);
        w.el.classList.remove("resizing");
        arranging(false);
        if (w.spot.w !== from.w || w.spot.h !== from.h) save(id, w.spot);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", end);
      grip.addEventListener("pointercancel", end);
    });
  }

  function applySettings(next) {
    settings = next;
    for (const w of live.values()) w.instance.settingsChanged?.(settings);
    render();
  }

  function applyLayout(next) {
    layout = next;
    render();
  }

  function register(def) {
    defs.set(def.kind, def);
    render();
  }

  // ---- Start ---------------------------------------------------------------------

  grid = measureGrid();
  buildDots();

  window.addEventListener("resize", () => {
    drawWallpaper();
    grid = measureGrid();
    buildDots();
    render();
  });
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  listen("wallpaper-changed", loadWallpaper);
  listen("settings-changed", (e) => applySettings(e.payload));
  listen("widgets-changed", (e) => applyLayout(e.payload));

  loadWallpaper();
  // Widgets register as their scripts load; they're shown once the settings
  // and the layout have arrived.
  invoke("get_settings")
    .catch(() => ({}))
    .then(applySettings);
  invoke("get_widgets")
    .catch(() => ({ locked: false, widgets: [] }))
    .then(applyLayout);

  return { register, settings: () => settings };
})();
