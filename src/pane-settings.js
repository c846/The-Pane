// The Pane's own settings: wallpaper, weather ZIP code, and the widgets in
// the pane and on the desktop (adding them, and locking each layout).
// Changes save as soon as they're made.
//
// Other parts of the pane can read the settings with PaneSettings.get(), or follow
// changes with PaneSettings.onChange(fn) (fn is also called right away).
window.PaneSettings = (() => {
  const { invoke } = window.__TAURI__.core;
  const $ = (id) => document.getElementById(id);

  const dialog = $("settings");
  const zip = $("zip");
  const zipError = $("zip-error");

  let current = { zip: "" };
  const listeners = [];

  function apply() {
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
    preview.classList.toggle("blank", !url);
    // Windows keeps a converted copy called "TranscodedWallpaper"; its name means nothing.
    const name = path.split("\\").pop();
    wallpaperName.textContent = !path ? "Solid white" : /^TranscodedWallpaper/i.test(name) ? "Current wallpaper" : name;
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
    showSettingsView();
    loadWidgetLocks();
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

  // ---- Widgets -------------------------------------------------------------------
  // One section each for the pane and the desktop: a Widgets button, which
  // turns the settings into a widget picker for that surface, and a switch
  // to lock its layout. The layout lives in the backend (widgets.rs), which
  // tells both windows about every change.

  const settingsView = dialog.querySelector(".settings-form:not(.widget-picker)");
  const picker = $("widget-picker");
  const pickerTitle = $("widget-picker-title");
  const pickerNote = $("widget-picker-note");
  const widgetList = $("widget-list");
  const locks = [...dialog.querySelectorAll("[data-widgets-lock]")];
  const ADDED_FOR = 1500; // ms the "Added" note shows
  const SURFACE = {
    pane: { title: "Pane widgets", note: "Pick one to add it to the pane." },
    desktop: { title: "Desktop widgets", note: "Pick one to add it to the desktop." },
  };
  let pickingFor = "pane";
  let opener = null;

  function showSettingsView() {
    picker.hidden = true;
    settingsView.hidden = false;
  }

  function showPicker(surface) {
    pickingFor = surface;
    pickerTitle.textContent = SURFACE[surface].title;
    pickerNote.textContent = `${SURFACE[surface].note} Drag it to move it, or its corner to resize it.`;
    for (const status of widgetList.querySelectorAll(".widget-option-status")) status.textContent = "";
    settingsView.hidden = true;
    picker.hidden = false;
    widgetList.querySelector("button")?.focus();
  }

  function showLocks(layout) {
    for (const input of locks) {
      input.checked = input.dataset.widgetsLock === "pane" ? layout.paneLocked : layout.locked;
    }
  }

  async function loadWidgetLocks() {
    try {
      showLocks(await invoke("get_widgets"));
    } catch (err) {
      console.error("Could not load the widgets", err);
    }
  }

  for (const input of locks) {
    input.addEventListener("change", () => {
      invoke("lock_widgets", { surface: input.dataset.widgetsLock, locked: input.checked }).catch((err) => {
        console.error("Could not lock the widgets", err);
        input.checked = !input.checked;
      });
    });
  }

  window.__TAURI__.event.listen("widgets-changed", (e) => showLocks(e.payload));

  // A small picture of a size: one square per cell.
  function sizePicture([w, h]) {
    const pic = document.createElement("span");
    pic.className = "size-picture";
    pic.style.gridTemplateColumns = `repeat(${w}, 8px)`;
    pic.setAttribute("aria-hidden", "true");
    for (let i = 0; i < w * h; i++) pic.append(document.createElement("span"));
    return pic;
  }

  function buildPicker() {
    const items = window.Widgets.catalog().map((def) => {
      const [w, h] = def.sizes[0];
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "widget-option glass";
      const text = document.createElement("span");
      text.className = "widget-option-text";
      const name = document.createElement("span");
      name.className = "widget-option-name";
      name.textContent = def.name;
      const description = document.createElement("span");
      description.className = "widget-option-description";
      description.textContent = def.description ?? "";
      text.append(name, description);
      const status = document.createElement("span");
      status.className = "widget-option-status";
      button.append(sizePicture(def.sizes[0]), text, status);

      let timer = 0;
      button.addEventListener("click", async () => {
        try {
          await invoke("add_widget", { surface: pickingFor, kind: def.kind, w, h });
          status.textContent = "Added";
        } catch (err) {
          console.error("Could not add the widget", err);
          status.textContent = "Couldn't add";
        }
        clearTimeout(timer);
        timer = setTimeout(() => (status.textContent = ""), ADDED_FOR);
      });
      li.append(button);
      return li;
    });
    widgetList.replaceChildren(...items);
  }

  for (const button of dialog.querySelectorAll("[data-widgets-open]")) {
    button.addEventListener("click", () => {
      opener = button;
      showPicker(button.dataset.widgetsOpen);
    });
  }
  $("widgets-back").addEventListener("click", () => {
    showSettingsView();
    opener?.focus();
  });
  window.Widgets.ready.then(buildPicker);

  // Clicking the dimmed area around the dialog closes it.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  load();

  return {
    open,
    // Open the settings at the widget picker for "pane" or "desktop".
    openPicker(surface) {
      open();
      opener = dialog.querySelector(`[data-widgets-open="${surface}"]`);
      showPicker(surface);
    },
    close: () => dialog.open && dialog.close(),
    isOpen: () => dialog.open,
    get: () => current,
    onChange(fn) {
      listeners.push(fn);
      fn(current);
    },
  };
})();
