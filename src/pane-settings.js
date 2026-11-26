// The Pane's own settings: weather ZIP code and which panels are shown.
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

  let current = { zip: "", panels: { apps: true, weather: true, calendar: true, music: true } };
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

  function open() {
    zip.value = current.zip;
    zipError.hidden = true;
    for (const t of toggles) t.checked = current.panels[t.dataset.panel];
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
