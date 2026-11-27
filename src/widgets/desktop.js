// The desktop window: always behind every app, never takes focus. Draws the
// wallpaper and hosts the widgets.
//
// A widget is a script in its own folder that calls:
//
//   Desktop.register({
//     id: "weather",                  // also its switch in settings.widgets
//     create(el, settings) {          // el: the widget's (empty) card
//       ...build into el...
//       return {
//         settingsChanged(settings),  // optional
//         destroy(),                  // optional: stop timers etc.
//       };
//     },
//     defaultPosition(screen, size),  // optional: {x, y} for its first placement
//   });
//
// Widgets are shown or hidden to match the settings. Each can be dragged
// anywhere; its position is remembered.
//
// The wallpaper is drawn once into a canvas at the screen's size, so a large
// image costs only a screen's worth of memory. Widgets add no work of their
// own while idle: nothing animates, and each refreshes on its own schedule.
window.Desktop = (() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const POSITIONS_KEY = "widget-positions";
  // Average wallpaper brightness (0-1) above which it counts as light.
  const LIGHT_THRESHOLD = 0.5;
  // Space kept between widgets and the screen's edges.
  const MARGIN = 24;

  const canvas = document.getElementById("wallpaper");
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

  // ---- Widgets -------------------------------------------------------------------

  const defs = new Map(); // id -> definition
  const live = new Map(); // id -> { el, instance }
  let settings = null;

  const readPositions = () => {
    try {
      return JSON.parse(localStorage.getItem(POSITIONS_KEY)) ?? {};
    } catch {
      return {};
    }
  };

  function savePosition(id, x, y) {
    const all = readPositions();
    all[id] = { x, y };
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(all));
  }

  // Keep a widget fully on screen.
  function place(el, x, y) {
    const maxX = Math.max(0, innerWidth - el.offsetWidth);
    const maxY = Math.max(0, innerHeight - el.offsetHeight);
    el.style.left = `${Math.round(Math.min(Math.max(0, x), maxX))}px`;
    el.style.top = `${Math.round(Math.min(Math.max(0, y), maxY))}px`;
  }

  function position(id, el) {
    const saved = readPositions()[id];
    const screen = { width: innerWidth, height: innerHeight, margin: MARGIN };
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const def = defs.get(id);
    // Default: the top-right corner.
    const { x, y } = saved ?? def.defaultPosition?.(screen, size) ?? { x: innerWidth - size.width - MARGIN, y: MARGIN };
    place(el, x, y);
  }

  // Drag a widget by any part of it that isn't a control.
  function makeDraggable(id, el) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button, a, input, select, textarea")) return;
      const startX = e.clientX - el.offsetLeft;
      const startY = e.clientY - el.offsetTop;
      el.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
      const move = (m) => place(el, m.clientX - startX, m.clientY - startY);
      const end = () => {
        el.classList.remove("dragging");
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", end);
        el.removeEventListener("pointercancel", end);
        savePosition(id, el.offsetLeft, el.offsetTop);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    });
  }

  function mount(id) {
    const el = document.createElement("section");
    el.className = `widget widget-${id}`;
    el.dataset.widget = id;
    layer.append(el);
    let instance = {};
    try {
      instance = defs.get(id).create(el, settings) ?? {};
    } catch (err) {
      console.error(`Widget "${id}" failed to start`, err);
    }
    live.set(id, { el, instance });
    makeDraggable(id, el);
    // Place once it has its size; and again whenever its size changes, so it
    // stays on screen.
    position(id, el);
    new ResizeObserver(() => place(el, el.offsetLeft, el.offsetTop)).observe(el);
  }

  function unmount(id) {
    const w = live.get(id);
    if (!w) return;
    w.instance.destroy?.();
    w.el.remove();
    live.delete(id);
  }

  const enabled = (id) => settings?.widgets?.[id] ?? true;

  function applySettings(next) {
    settings = next;
    for (const id of defs.keys()) {
      if (enabled(id) && !live.has(id)) mount(id);
      else if (!enabled(id) && live.has(id)) unmount(id);
      else live.get(id)?.instance.settingsChanged?.(settings);
    }
  }

  function register(def) {
    defs.set(def.id, def);
    if (settings && enabled(def.id)) mount(def.id);
  }

  // ---- Start ---------------------------------------------------------------------

  window.addEventListener("resize", () => {
    drawWallpaper();
    for (const { el } of live.values()) place(el, el.offsetLeft, el.offsetTop);
  });
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  listen("wallpaper-changed", loadWallpaper);
  listen("settings-changed", (e) => applySettings(e.payload));

  loadWallpaper();
  // Widgets register as their scripts load; start them once settings arrive.
  invoke("get_settings")
    .catch(() => ({}))
    .then(applySettings);

  return { register, settings: () => settings };
})();
