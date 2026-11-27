// Widgets: the one way content gets into the pane and onto the desktop.
//
// Every widget is written once, in its own folder (src/widgets/<kind>/,
// listed in src/widgets/list.js), and runs on either surface. Both windows
// load every widget, and each runs a host for its own surface:
//
//   Widgets.host({ surface: "pane", layer, ... })   in the pane (pane.js)
//   Widgets.host({ surface: "desktop", layer, ... }) on the desktop (desktop.js)
//
// A host lays its widgets out on a grid of square cells, each the size of an
// app tile (so a widget is the same size on both surfaces), and lets the user
// arrange them:
// - Drag a widget (by any part that isn't a control) to move it. The grid's
//   cells show as small squares while dragging; the ones it would land on
//   grow. It snaps into place when let go, or goes back if it doesn't fit.
// - Drag its bottom-right corner to resize it; it snaps to the nearest of
//   its sizes.
// - The × in its top-right corner removes it.
// None of these work while that surface's layout is locked (Pane settings).
// Which widgets are where is kept by the backend (widgets.rs).
//
// ---- Writing a widget ----------------------------------------------------------
//
// src/widgets/<kind>/<kind>.js (and <kind>.css, loaded with it) calls:
//
//   Widgets.define({
//     kind: "weather",                  // = its folder
//     name: "Weather",                  // shown in the widget picker
//     description: "…",
//     sizes: [[3, 2], [3, 1]],          // [columns, rows]; the first is the
//                                       //   default, the one it's added at
//     create(body, ctx) {               // body: the widget's (empty) element;
//       ...build into body...           //   body.dataset.size is e.g. "3x2"
//       return {                        // all optional:
//         resized(size),                //   {w, h}: picked another size
//         shown(), hidden(),            //   the surface came into / went out of view
//         settingsChanged(settings),    //   Pane settings changed
//         destroy(),                    //   removed: stop anything still running
//       };
//     },
//   });
//
// ctx gives it what differs between surfaces, and tidies up after it:
//   ctx.surface          "pane" or "desktop"
//   ctx.visible          whether its surface is in view (the pane is only
//                        while it's open; the desktop always is)
//   ctx.canType          false on the desktop, which never takes the keyboard
//   ctx.size             {w, h} in cells
//   ctx.settings()       the Pane settings (e.g. .zip)
//   ctx.openSettings     opens Pane settings, or null where it can't (desktop)
//   ctx.listen(ev, fn)   a backend event, unlistened when the widget goes
//   ctx.every(ms, fn)    fn every ms while visible (and once each time the
//                        surface comes back into view); stopped when it goes
//   ctx.onDestroy(fn)
// Shared helpers: Widgets.el(tag, className, text), Widgets.latestOnly(send).
window.Widgets = (() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  // ---- Registry --------------------------------------------------------------------

  const defs = new Map(); // kind -> definition
  const base = new URL("../widgets/", document.currentScript.src).href;

  function define(def) {
    if (!def?.kind || !Array.isArray(def.sizes) || !def.sizes.length) {
      console.error("Not a widget definition", def);
      return;
    }
    defs.set(def.kind, def);
  }

  // Load every widget's script and styles (in list order); `ready` resolves
  // once all have loaded (or failed to).
  const ready = new Promise((resolve) => {
    const kinds = window.WidgetList ?? [];
    let left = kinds.length;
    if (!left) resolve();
    for (const kind of kinds) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `${base}${kind}/${kind}.css`;
      document.head.append(link);
      const script = document.createElement("script");
      script.src = `${base}${kind}/${kind}.js`;
      script.async = false;
      script.onload = script.onerror = () => --left || resolve();
      document.head.append(script);
    }
  });

  // Defined widgets, in list order (for the widget picker).
  const catalog = () => (window.WidgetList ?? []).map((k) => defs.get(k)).filter(Boolean);

  // ---- Helpers for widgets ---------------------------------------------------------

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  // Dragging a slider fires many changes. Send them one at a time, skipping
  // stale ones, so the backend always ends on the latest value.
  function latestOnly(send) {
    let busy = false;
    let next = null;
    return async (value) => {
      next = value;
      if (busy) return;
      busy = true;
      while (next !== null) {
        const v = next;
        next = null;
        await send(v).catch((err) => console.error(err));
      }
      busy = false;
    };
  }

  // ---- Host ------------------------------------------------------------------------

  // Space kept between cells (as between the pane's old app tiles). Any space
  // left over is shared out between the cells, so the grid always reaches
  // `margin` from every edge of the layer.
  const GAP = 10;
  // How far the pointer moves before a press becomes a drag.
  const DRAG_SLOP = 4;

  // options:
  //   surface      "pane" | "desktop"
  //   layer        the element the widgets go in (positioned; they fill it)
  //   margin       px kept clear around the grid's edge
  //   fillFrom     where new widgets go first: "top-right" (going down, then
  //                left) or "top-left" (going down, then right)
  //   visible      whether the surface starts in view
  //   canType      whether the surface can take keyboard input
  //   openSettings opens Pane settings (or null)
  function host({ surface, layer, margin = 0, fillFrom = "top-left", visible = true, canType = true, openSettings = null }) {
    layer.classList.add("widget-layer");
    const dotsLayer = el("div", "widget-grid");
    dotsLayer.setAttribute("aria-hidden", "true");
    layer.append(dotsLayer);

    // id -> { kind, def, el, body, instance, ctx, spot: {col, row, w, h} as shown }
    const live = new Map();
    let settings = null;
    let layout = null; // from the backend: { locked, paneLocked, widgets: [...] }
    let grid = null;
    let loaded = false;

    const locked = () => (surface === "pane" ? layout?.paneLocked : layout?.locked) ?? false;
    const sizesOf = (kind) => defs.get(kind)?.sizes ?? [];

    // ---- Grid --------------------------------------------------------------------

    // A cell is an app tile as the pane always had them: a column of
    // clamp(380px, 26vw, 480px), holding three tiles 10px apart inside 16px
    // of padding. Both windows cover the screen, so cells come out the same
    // size on both surfaces. As many fit in the layer as can; the gaps widen
    // a little to use up the room, by the same amount across and down (so
    // the spacing is even): as much as the tighter direction allows. The
    // grid sits at the top, and to the right where widgets fill from the
    // right (the desktop), otherwise centred.
    function measureGrid() {
      const column = Math.min(Math.max(380, innerWidth * 0.26), 480);
      const cell = (column - 2 * 16 - 2 * GAP) / 3;
      const width = layer.clientWidth;
      const height = layer.clientHeight;
      const count = (length) => Math.max(1, Math.floor((length - 2 * margin + GAP) / (cell + GAP)));
      const cols = count(width);
      const rows = count(height);
      const spread = (length, n) => (n > 1 ? (length - 2 * margin - n * cell) / (n - 1) : Infinity);
      let gap = Math.min(spread(width, cols), spread(height, rows));
      if (!Number.isFinite(gap)) gap = GAP;
      const span = (n) => n * cell + (n - 1) * gap;
      // A single cell (a tiny screen) sits in the middle.
      const left =
        cols === 1 ? (width - cell) / 2 : fillFrom === "top-right" ? width - margin - span(cols) : (width - span(cols)) / 2;
      const top = rows === 1 ? (height - cell) / 2 : margin;
      return {
        cell,
        cols,
        rows,
        gapX: gap,
        gapY: gap,
        pitchX: cell + gap,
        pitchY: cell + gap,
        left,
        top,
      };
    }

    // One small square per cell, shown while arranging.
    function buildDots() {
      const { cols, rows, cell, pitchX, pitchY, left, top } = grid;
      dotsLayer.style.setProperty("--cell", `${cell}px`);
      const dots = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const d = el("div", "widget-grid-cell");
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
      layer.classList.toggle("arranging", on);
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
    // placed widget (all but `id`).
    function free(rect, id) {
      if (!inside(rect)) return false;
      for (const [other, w] of live) {
        if (other !== id && w.spot && overlaps(rect, w.spot)) return false;
      }
      return true;
    }

    // A free spot for a widget, column by column from `fillFrom`. Null if
    // there's no room.
    function findSpot(w, h, id) {
      const cols = [];
      for (let col = 0; col + w <= grid.cols; col++) cols.push(col);
      if (fillFrom === "top-right") cols.reverse();
      for (const col of cols) {
        for (let row = 0; row + h <= grid.rows; row++) {
          if (free({ col, row, w, h }, id)) return { col, row, w, h };
        }
      }
      return null;
    }

    // ---- Widgets -----------------------------------------------------------------

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
        w.ctx.size = { w: w.spot.w, h: w.spot.h };
        call(w, "resized", w.ctx.size);
      }
    }

    // Run one of a widget's hooks, keeping a broken widget from breaking the rest.
    function call(w, hook, ...args) {
      try {
        w.instance[hook]?.(...args);
      } catch (err) {
        console.error(`Widget "${w.kind}" failed in ${hook}`, err);
      }
    }

    function save(id, spot) {
      invoke("place_widget", { id, ...spot }).catch((err) => console.error("Couldn't save the widget", err));
    }

    // What a widget gets to work with (see the top of this file).
    function makeContext(w, placed) {
      const cleanups = [];
      const repeats = new Set(); // { ms, fn, timer }
      const startRepeat = (r) => {
        clearInterval(r.timer);
        r.timer = setInterval(r.fn, r.ms);
      };
      const ctx = {
        surface,
        canType,
        openSettings,
        size: { w: placed.w, h: placed.h },
        get visible() {
          return visible;
        },
        settings: () => settings,
        listen(event, fn) {
          const off = listen(event, fn);
          cleanups.push(() => off.then((un) => un()));
        },
        every(ms, fn) {
          const r = { ms, fn, timer: null };
          repeats.add(r);
          if (visible) startRepeat(r);
        },
        onDestroy(fn) {
          cleanups.push(fn);
        },
      };
      w.ctx = ctx;
      w.shown = () => {
        for (const r of repeats) {
          try {
            r.fn();
          } catch (err) {
            console.error(err);
          }
          startRepeat(r);
        }
        call(w, "shown");
      };
      w.hidden = () => {
        for (const r of repeats) clearInterval(r.timer);
        call(w, "hidden");
      };
      w.cleanup = () => {
        for (const r of repeats) clearInterval(r.timer);
        repeats.clear();
        for (const fn of cleanups) fn();
      };
      return ctx;
    }

    function mount(placed) {
      const def = defs.get(placed.kind);
      const card = el("section", `widget glass widget-${placed.kind}`);
      card.dataset.id = placed.id;
      card.setAttribute("aria-label", def.name);
      const body = el("div", "widget-body");
      body.dataset.size = `${placed.w}x${placed.h}`;

      const remove = el("button", "widget-remove");
      remove.type = "button";
      remove.title = "Remove widget";
      remove.setAttribute("aria-label", `Remove ${def.name}`);
      remove.addEventListener("click", () => {
        invoke("remove_widget", { id: placed.id }).catch((err) => console.error("Couldn't remove the widget", err));
      });
      card.append(body, remove);
      if (def.sizes.length > 1) {
        const grip = el("div", "widget-resize");
        grip.title = "Drag to resize";
        card.append(grip);
        makeResizable(placed.id, grip);
      }
      layer.append(card);

      const w = { kind: placed.kind, def, el: card, body, instance: {}, spot: null };
      live.set(placed.id, w);
      const ctx = makeContext(w, placed);
      try {
        w.instance = def.create(body, ctx) ?? {};
      } catch (err) {
        console.error(`Widget "${placed.kind}" failed to start`, err);
        body.replaceChildren(el("p", "widget-message", `${def.name} couldn't start.`));
      }
      makeDraggable(placed.id, card);
    }

    function unmount(id) {
      const w = live.get(id);
      if (!w) return;
      call(w, "destroy");
      w.cleanup();
      w.el.remove();
      live.delete(id);
    }

    // Show the layout: mount what's new, drop what's gone, place the rest.
    function render() {
      if (!layout || !settings || !loaded) return;
      layer.classList.toggle("locked", locked());
      const wanted = layout.widgets.filter((p) => p.surface === surface && defs.has(p.kind));
      layer.classList.toggle("empty", wanted.length === 0);
      const ids = new Set(wanted.map((p) => p.id));
      for (const id of [...live.keys()]) if (!ids.has(id)) unmount(id);

      // Placed afresh, one at a time, so each finds room around the ones
      // before it. A widget being dragged or resized keeps its spot.
      const busy = (w) => w.el.classList.contains("dragging") || w.el.classList.contains("resizing");
      for (const w of live.values()) if (!busy(w)) w.spot = null;

      // Widgets with a spot first, so new ones find room around them.
      const ordered = [...wanted.filter((p) => p.col != null), ...wanted.filter((p) => p.col == null)];
      for (const p of ordered) {
        if (!live.has(p.id)) mount(p);
        const w = live.get(p.id);
        if (busy(w)) continue;
        if (p.col == null || p.row == null) {
          // Just added: find it a spot, and save that. If there's no room it
          // goes in the top-left corner, on top of whatever's there.
          w.spot = findSpot(p.w, p.h, p.id) ?? { col: 0, row: 0, w: p.w, h: p.h };
          save(p.id, w.spot);
        } else {
          // Kept on the grid if the grid is smaller than when it was placed
          // (without saving, so it's back where it was if it grows again),
          // and moved to a free spot if that lands it on another widget.
          const kept = {
            col: Math.min(Math.max(0, p.col), Math.max(0, grid.cols - p.w)),
            row: Math.min(Math.max(0, p.row), Math.max(0, grid.rows - p.h)),
            w: p.w,
            h: p.h,
          };
          w.spot = free(kept, p.id) ? kept : (findSpot(p.w, p.h, p.id) ?? kept);
        }
        show(w);
      }
    }

    // Where a pointer is, in the layer's coordinates.
    function local(e) {
      const r = layer.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    // Drag a widget by any part of it that isn't a control. A press that
    // doesn't move is left alone, so clicks inside widgets still work.
    function makeDraggable(id, card) {
      card.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || locked()) return;
        if (e.target.closest("button, a, input, select, textarea, [tabindex], .widget-resize")) return;
        const w = live.get(id);
        const start = local(e);
        const offX = start.x - card.offsetLeft;
        const offY = start.y - card.offsetTop;
        let dragging = false;
        let target = null;
        card.setPointerCapture(e.pointerId);

        const move = (m) => {
          const at = local(m);
          if (!dragging) {
            if (Math.hypot(at.x - start.x, at.y - start.y) < DRAG_SLOP) return;
            dragging = true;
            card.classList.remove("settling");
            card.classList.add("dragging");
            window.Tooltip?.hide();
            arranging(true);
          }
          const x = at.x - offX;
          const y = at.y - offY;
          card.style.left = `${x}px`;
          card.style.top = `${y}px`;
          // The cells it's over: nearest its top-left corner, kept on the grid.
          const { w: cw, h: ch } = w.spot;
          const col = Math.min(Math.max(0, Math.round((x - grid.left) / grid.pitchX)), Math.max(0, grid.cols - cw));
          const row = Math.min(Math.max(0, Math.round((y - grid.top) / grid.pitchY)), Math.max(0, grid.rows - ch));
          target = { col, row, w: cw, h: ch };
          highlight(target, free(target, id));
        };
        const end = () => {
          card.removeEventListener("pointermove", move);
          card.removeEventListener("pointerup", end);
          card.removeEventListener("pointercancel", end);
          if (!dragging) return;
          card.classList.remove("dragging");
          arranging(false);
          const moved = target && (target.col !== w.spot.col || target.row !== w.spot.row);
          if (moved && free(target, id)) {
            w.spot = target;
            save(id, target);
          }
          show(w, true); // snap into place, or back where it was
        };
        card.addEventListener("pointermove", move);
        card.addEventListener("pointerup", end);
        card.addEventListener("pointercancel", end);
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
          const at = local(m);
          const r = pxRect(w.spot);
          // How many cells the pointer asks for, as fractions.
          const wantW = (at.x - r.x + grid.gapX / 2) / grid.pitchX;
          const wantH = (at.y - r.y + grid.gapY / 2) / grid.pitchY;
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

    // ---- Start -------------------------------------------------------------------

    function remeasure() {
      const next = measureGrid();
      if (grid && ["cols", "rows", "cell", "pitchX", "pitchY", "left", "top"].every((k) => next[k] === grid[k])) return;
      grid = next;
      buildDots();
      render();
    }

    grid = measureGrid();
    buildDots();
    new ResizeObserver(remeasure).observe(layer);
    window.addEventListener("resize", remeasure);

    listen("settings-changed", (e) => {
      settings = e.payload;
      for (const w of live.values()) call(w, "settingsChanged", settings);
      render();
    });
    listen("widgets-changed", (e) => {
      layout = e.payload;
      render();
    });

    // Widgets are shown once they've all loaded and the settings and the
    // layout have arrived.
    ready.then(() => {
      loaded = true;
      render();
    });
    invoke("get_settings")
      .catch(() => ({}))
      .then((s) => {
        settings = s;
        render();
      });
    invoke("get_widgets")
      .catch(() => ({ locked: false, paneLocked: false, widgets: [] }))
      .then((l) => {
        layout = l;
        render();
      });

    return {
      // The surface came into view (true) or went out of it (false).
      setVisible(on) {
        if (on === visible) return;
        visible = on;
        for (const w of live.values()) (on ? w.shown : w.hidden)();
      },
    };
  }

  return { define, catalog, ready, host, el, latestOnly };
})();
