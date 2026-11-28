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

  // ---- Popup cards ---------------------------------------------------------------
  // Cards in the middle of the screen, one at a time: a later one waits until
  // the one showing is closed. (The desktop never takes the keyboard, so
  // they're closed with the mouse.)

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  let popupShowing = false;
  const popupQueue = [];

  function showPopup(card) {
    if (popupShowing) {
      popupQueue.push(card);
      return;
    }
    popupShowing = true;
    document.body.append(card);
  }

  function closePopup(card) {
    card.classList.add("leaving");
    card.addEventListener(
      "animationend",
      () => {
        card.remove();
        popupShowing = false;
        const next = popupQueue.shift();
        if (next) showPopup(next);
      },
      { once: true },
    );
  }

  // ---- Welcome (first run only; see first_run.rs) --------------------------------

  invoke("welcome")
    .then((name) => {
      if (name != null) showWelcome(name);
    })
    .catch(() => {});

  // Clicking Close dismisses it for good.
  function showWelcome(name) {
    const card = el("section", "popup");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-labelledby", "welcome-title");
    const title = el("h1", "popup-title", name ? `Welcome to the Pane ${name}!` : "Welcome to the Pane!");
    title.id = "welcome-title";
    const close = el("button", "button", "Close");
    close.type = "button";
    close.addEventListener("click", () => {
      invoke("welcome_done").catch(() => {});
      closePopup(card);
    });
    const actions = el("div", "popup-actions");
    actions.append(close);
    card.append(
      title,
      el("p", "popup-text", 'Moving your mouse to the left edge of the screen, or pressing "home" can open and close the Pane.'),
      el(
        "p",
        "popup-text",
        "Feel free to take some time and explore the Pane's features and different widgets! To make yourself at home, you can set a wallpaper by opening the Pane and going to settings.",
      ),
      actions,
    );
    showPopup(card);
  }

  // ---- Update (checked once per start; see updater.rs) ---------------------------

  let updateShown = false;
  listen("update-available", (e) => showUpdate(e.payload));
  invoke("pending_update")
    .then((info) => {
      if (info) showUpdate(info);
    })
    .catch(() => {});

  // "Later" puts it off until The Pane next starts. "Update now" downloads
  // it, then The Pane closes while the installer runs and starts again after.
  function showUpdate(info) {
    if (updateShown) return;
    updateShown = true;

    const card = el("section", "popup");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-labelledby", "update-title");
    const title = el("h1", "popup-title", "An update is ready");
    title.id = "update-title";
    const status = el(
      "p",
      "popup-text",
      `Version ${info.version} is available (you have ${info.current_version}). ` +
        "The Pane will close for a moment while it installs, then start again.",
    );
    card.append(title, status);
    if (info.notes) {
      card.append(el("p", "popup-label", "What's new"), el("pre", "popup-notes", info.notes));
    }
    const bar = el("div", "popup-progress");
    const fill = el("div");
    bar.append(fill);
    bar.hidden = true;

    const later = el("button", "button", "Later");
    later.type = "button";
    later.addEventListener("click", () => closePopup(card));
    const now = el("button", "button", "Update now");
    now.type = "button";
    now.addEventListener("click", async () => {
      later.disabled = now.disabled = true;
      status.textContent = "Downloading the update…";
      bar.hidden = false;
      const unlisten = await listen("update-progress", ({ payload: p }) => {
        if (p.total) {
          const pct = Math.min(100, Math.round((p.downloaded / p.total) * 100));
          fill.style.width = `${pct}%`;
          status.textContent = pct < 100 ? `Downloading the update… ${pct}%` : "Installing…";
        }
      });
      try {
        // On success The Pane quits here and the installer takes over.
        await invoke("install_update");
      } catch (err) {
        unlisten();
        bar.hidden = true;
        fill.style.width = "0";
        status.textContent = `Couldn't update: ${err}`;
        now.textContent = "Try again";
        later.disabled = now.disabled = false;
      }
    });
    const actions = el("div", "popup-actions");
    actions.append(later, now);
    card.append(bar, actions);
    showPopup(card);
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
