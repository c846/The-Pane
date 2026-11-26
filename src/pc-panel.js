// Bottom-left quadrant: volume, brightness, Windows Settings and power.
window.PcPanel = (() => {
  const { invoke } = window.__TAURI__.core;
  const $ = (id) => document.getElementById(id);

  const volumeRow = $("volume-row");
  const volume = $("volume");
  const volumeValue = $("volume-value");
  const mute = $("mute");
  const brightnessRow = $("brightness-row");
  const brightness = $("brightness");
  const brightnessValue = $("brightness-value");
  const WHEEL_STEP = 2;

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
  const sendVolume = latestOnly((level) => invoke("set_volume", { level }));
  const sendBrightness = latestOnly((level) => invoke("set_brightness", { level }));

  function showSlider(input, label, value) {
    input.value = value;
    input.style.setProperty("--fill", `${value}%`);
    label.textContent = value;
  }

  // ---- Volume ----------------------------------------------------------------

  let muted = false;
  function showMuted(m) {
    muted = m;
    volumeRow.classList.toggle("muted", m);
    mute.setAttribute("aria-pressed", String(m));
    mute.title = m ? "Unmute" : "Mute";
    mute.setAttribute("aria-label", mute.title);
  }

  volume.addEventListener("input", () => {
    const level = Number(volume.value);
    showSlider(volume, volumeValue, level);
    if (level > 0) showMuted(false); // the backend unmutes too
    sendVolume(level);
  });

  mute.addEventListener("click", () => {
    showMuted(!muted);
    invoke("set_muted", { muted }).catch((err) => console.error(err));
  });

  // ---- Brightness --------------------------------------------------------------

  brightness.addEventListener("input", () => {
    const level = Number(brightness.value);
    showSlider(brightness, brightnessValue, level);
    sendBrightness(level);
  });

  // Scrolling over a slider nudges it.
  for (const input of [volume, brightness]) {
    input.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const step = e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP;
        input.value = Math.max(0, Math.min(100, Number(input.value) + step));
        input.dispatchEvent(new Event("input"));
      },
      { passive: false },
    );
  }

  // ---- Settings and power --------------------------------------------------

  // One Settings tile for both The Pane's settings and Windows Settings.
  const settings = $("settings-tile");
  settings.addEventListener("click", (e) => {
    window.Menu.open({ anchor: settings, keyboard: e.detail === 0 }, [
      { label: "Pane settings", action: () => window.PaneSettings.open() },
      {
        label: "Windows Settings",
        action: () => invoke("open_windows_settings").catch((err) => console.error(err)),
      },
    ]);
  });

  const power = $("power");
  const powerAction = (action) => () => invoke("power", { action }).catch((err) => console.error(err));
  power.addEventListener("click", (e) => {
    window.Menu.open({ anchor: power, keyboard: e.detail === 0 }, [
      { label: "Lock", action: powerAction("lock") },
      { label: "Sleep", action: powerAction("sleep") },
      { separator: true },
      { label: "Sign out", action: powerAction("signout") },
      { label: "Restart", action: powerAction("restart") },
      { label: "Shut down", action: powerAction("shutdown") },
    ]);
  });

  // ---- Refresh -----------------------------------------------------------------

  // Read the current levels (they may have changed while the pane was closed).
  // A row is hidden if there's nothing to control (no speakers, or no screen
  // whose brightness can be set, e.g. many desktop monitors).
  async function refresh() {
    const [vol, level] = await Promise.all([
      invoke("get_volume").catch(() => null),
      invoke("get_brightness").catch(() => null),
    ]);
    volumeRow.hidden = !vol;
    if (vol) {
      showSlider(volume, volumeValue, vol.level);
      showMuted(vol.muted);
    }
    brightnessRow.hidden = level === null;
    if (level !== null) showSlider(brightness, brightnessValue, level);
  }

  // The volume changed elsewhere (the volume keys; see glance.js).
  function showVolume(vol) {
    volumeRow.hidden = false;
    showSlider(volume, volumeValue, vol.level);
    showMuted(vol.muted);
  }

  refresh();

  return { refresh, showVolume };
})();
