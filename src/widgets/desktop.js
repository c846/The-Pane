// The desktop window: always behind every app, never takes focus. Draws the
// wallpaper and hosts the desktop's widgets.
//
// The widgets themselves, and arranging them, are shared with the pane: see
// shared/widget-host.js. The desktop's grid reaches MARGIN from the screen's
// edges, and new widgets go in its top-right corner first.
//
// The wallpaper is drawn once into a canvas at the screen's size, so a large
// image costs only a screen's worth of memory. Widgets add no work of their
// own while idle: nothing animates, and each refreshes on its own schedule.
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  // Average wallpaper brightness (0-1) above which it counts as light.
  const LIGHT_THRESHOLD = 0.5;
  // Space kept between the grid and the screen's edges.
  const MARGIN = 10;

  const canvas = document.getElementById("wallpaper");

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
    // No wallpaper (as on a fresh install): solid white.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    if (!wallpaper) {
      setTheme(true);
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

  // ---- Start ---------------------------------------------------------------------

  window.addEventListener("resize", drawWallpaper);
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  listen("wallpaper-changed", loadWallpaper);
  loadWallpaper();

  // ---- Welcome (first run only; see first_run.rs) --------------------------------

  invoke("welcome")
    .then((name) => {
      if (name != null) showWelcome(name);
    })
    .catch(() => {});

  // A card in the middle of the screen. Clicking Close dismisses it for good.
  // (The desktop never takes the keyboard, so it's closed with the mouse.)
  function showWelcome(name) {
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };
    const card = el("section", "welcome");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-labelledby", "welcome-title");
    const title = el("h1", "welcome-title", name ? `Welcome to the Pane ${name}!` : "Welcome to the Pane!");
    title.id = "welcome-title";
    const close = el("button", "button welcome-close", "Close");
    close.type = "button";
    close.addEventListener("click", () => {
      invoke("welcome_done").catch(() => {});
      card.classList.add("leaving");
      card.addEventListener("animationend", () => card.remove(), { once: true });
    });
    const actions = el("div", "welcome-actions");
    actions.append(close);
    card.append(
      title,
      el("p", "welcome-text", 'Moving your mouse to the left edge of the screen, or pressing "home" can open and close the Pane.'),
      el(
        "p",
        "welcome-text",
        "Feel free to take some time and explore the Pane's features and different widgets! To make yourself at home, you can set a wallpaper by opening the Pane and going to settings.",
      ),
      actions,
    );
    document.body.append(card);
  }

  // The desktop is always in view, and can't take typing (it never takes
  // the keyboard, so clicking it leaves the current app in front).
  window.Widgets.host({
    surface: "desktop",
    layer: document.getElementById("widgets"),
    margin: MARGIN,
    fillFrom: "top-right",
    visible: true,
    canType: false,
  });
})();
