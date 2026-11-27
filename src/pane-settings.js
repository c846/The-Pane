// The Pane's own settings: wallpaper, weather ZIP code, which panels are shown
// and which desktop widgets are shown.
// Changes save as soon as they're made.
//
// Other panels can read the settings with PaneSettings.get(), or follow
// changes with PaneSettings.onChange(fn) (fn is also called right away).
window.PaneSettings = (() => {
  const { invoke } = window.__TAURI__.core;
  const $ = (id) => document.getElementById(id);

  const dialog = $("settings");
  const zip = $("zip");
  const zipError = $("zip-error");
  const toggles = [...dialog.querySelectorAll("input[data-panel]")];
  const widgetToggles = [...dialog.querySelectorAll("input[data-widget]")];

  let current = {
    zip: "",
    panels: { apps: true, weather: true, calendar: true, music: true },
    widgets: { weather: true },
  };
  const listeners = [];

  // Show or hide quadrants to match the panel switches. Weather and calendar
  // share a quadrant, so it's hidden only when both are off.
  function apply() {
    const p = current.panels;
    const glance = document.querySelector(".q-glance");
    const media = document.querySelector(".q-media");
    document.querySelector(".q-apps").hidden = !p.apps;
    glance.hidden = !p.weather && !p.calendar;
    media.hidden = !p.music;
    document.querySelector(".column-right").hidden = glance.hidden && media.hidden;
    for (const fn of listeners) fn(current);
  }

  async function load() {
    try {
      current = await invoke("get_settings");
    } catch (err) {
      console.error("Could not load settings", err);
    }
    apply();
  }

  async function save(next) {
    try {
      await invoke("save_settings", { settings: next });
      current = next;
    } catch (err) {
      console.error("Could not save settings", err);
    }
    apply();
  }

  const preview = $("wallpaper-preview");
  const wallpaperName = $("wallpaper-name");
  const wallpaperError = $("wallpaper-error");
  const chooseWallpaper = $("wallpaper-choose");

  function showWallpaper() {
    const { url, path } = window.Backdrop;
    preview.style.backgroundImage = url ? `url("${url}")` : "none";
    // Windows keeps a converted copy called "TranscodedWallpaper"; its name means nothing.
    const name = path.split("\\").pop();
    wallpaperName.textContent = !path ? "No wallpaper" : /^TranscodedWallpaper/i.test(name) ? "Current wallpaper" : name;
  }

  chooseWallpaper.addEventListener("click", async () => {
    wallpaperError.hidden = true;
    chooseWallpaper.disabled = true;
    try {
      if (await invoke("pick_wallpaper")) {
        await window.Backdrop.refresh();
        showWallpaper();
      }
    } catch (err) {
      wallpaperError.textContent = String(err);
      wallpaperError.hidden = false;
    } finally {
      chooseWallpaper.disabled = false;
    }
  });

  // Windows shell (Explorer): started on demand, for Windows Settings and
  // Store apps. The backend says when it starts or stops, however that happens.
  const shellStatus = $("shell-status");
  const shellToggle = $("shell-toggle");
  let shellRunning = false;
  let shellBusy = false;

  function showShell() {
    shellStatus.textContent = shellBusy
      ? shellRunning
        ? "Stopping…"
        : "Starting…"
      : shellRunning
        ? "Running"
        : "Not running";
    shellToggle.textContent = shellRunning ? "Stop" : "Start";
    shellToggle.disabled = shellBusy;
  }

  shellToggle.addEventListener("click", async () => {
    shellBusy = true;
    showShell();
    try {
      await invoke(shellRunning ? "stop_windows_shell" : "start_windows_shell");
      shellRunning = await invoke("windows_shell_running");
    } catch (err) {
      console.error(err);
    } finally {
      shellBusy = false;
      showShell();
    }
  });

  window.__TAURI__.event.listen("windows-shell-changed", (e) => {
    shellRunning = e.payload;
    showShell();
  });

  function open() {
    invoke("windows_shell_running").then((running) => {
      shellRunning = running;
      showShell();
    });
    showWallpaper();
    wallpaperError.hidden = true;
    zip.value = current.zip;
    zipError.hidden = true;
    for (const t of toggles) t.checked = current.panels[t.dataset.panel];
    for (const t of widgetToggles) t.checked = current.widgets?.[t.dataset.widget] ?? true;
    dialog.showModal();
  }

  // Digits only, at most 5.
  zip.addEventListener("input", () => {
    zip.value = zip.value.replace(/\D/g, "").slice(0, 5);
    zipError.hidden = true;
  });

  zip.addEventListener("change", () => {
    const value = zip.value;
    if (value && value.length !== 5) {
      zipError.hidden = false;
      return;
    }
    if (value !== current.zip) save({ ...current, zip: value });
  });

  for (const t of toggles) {
    t.addEventListener("change", () => {
      save({ ...current, panels: { ...current.panels, [t.dataset.panel]: t.checked } });
    });
  }

  // Desktop widgets: the desktop window hears about it from the backend.
  for (const t of widgetToggles) {
    t.addEventListener("change", () => {
      save({ ...current, widgets: { ...current.widgets, [t.dataset.widget]: t.checked } });
    });
  }

  // Clicking the dimmed area around the dialog closes it.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  load();

  return {
    open,
    close: () => dialog.open && dialog.close(),
    isOpen: () => dialog.open,
    get: () => current,
    onChange(fn) {
      listeners.push(fn);
      fn(current);
    },
  };
})();
