// Volume: a slider for the speakers' volume, with the speaker icon as the
// mute button. Scroll over it to nudge the volume. Follows changes made
// anywhere (the volume keys, the other surface, Windows).
Widgets.define({
  kind: "volume",
  name: "Volume",
  description: "Your speakers' volume, and mute.",
  sizes: [
    [3, 1],
    [2, 1],
    [1, 1],
  ],

  create(body, ctx) {
    const { invoke } = window.__TAURI__.core;
    const { el } = Widgets;
    const WHEEL_STEP = 2;

    const row = el("div", "level-row");
    const mute = el("button", "level-icon glass");
    mute.type = "button";
    mute.setAttribute("aria-pressed", "false");
    const icon = el("span", "icon icon-volume");
    icon.setAttribute("aria-hidden", "true");
    mute.append(icon);
    const slider = el("input", "slider");
    Object.assign(slider, { type: "range", min: 0, max: 100 });
    slider.setAttribute("aria-label", "Volume");
    const value = el("span", "level-value");
    value.setAttribute("aria-hidden", "true");
    row.append(mute, slider, value);
    const message = el("p", "widget-message", "No speakers or headphones found.");
    body.append(el("h3", "group-label", "Volume"), row, message);

    const send = Widgets.latestOnly((level) => invoke("set_volume", { level }));
    let muted = false;
    let dragging = false;

    function showLevel(level) {
      slider.value = level;
      slider.style.setProperty("--fill", `${level}%`);
      value.textContent = level;
    }

    function showMuted(m) {
      muted = m;
      body.classList.toggle("muted", m);
      mute.setAttribute("aria-pressed", String(m));
      mute.title = m ? "Unmute" : "Mute";
      mute.setAttribute("aria-label", mute.title);
    }

    function show(vol) {
      body.classList.toggle("unavailable", !vol);
      if (!vol) return;
      // While dragging, the slider is ahead of what the backend reports.
      if (!dragging) showLevel(vol.level);
      showMuted(vol.muted);
    }

    const refresh = () => invoke("get_volume").catch(() => null).then(show);

    slider.addEventListener("input", () => {
      const level = Number(slider.value);
      showLevel(level);
      if (level > 0) showMuted(false); // the backend unmutes too
      send(level);
    });
    slider.addEventListener("pointerdown", () => (dragging = true));
    slider.addEventListener("pointerup", () => (dragging = false));
    slider.addEventListener("change", () => (dragging = false));

    mute.addEventListener("click", () => {
      showMuted(!muted);
      invoke("set_muted", { muted }).catch((err) => console.error(err));
    });

    body.addEventListener(
      "wheel",
      (e) => {
        if (body.classList.contains("unavailable")) return;
        e.preventDefault();
        const step = e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP;
        slider.value = Math.max(0, Math.min(100, Number(slider.value) + step));
        slider.dispatchEvent(new Event("input"));
      },
      { passive: false },
    );

    // Changed anywhere: the volume keys, another widget, either surface
    // (the backend tells every window).
    ctx.listen("volume-changed", (e) => show(e.payload));
    ctx.listen("volume-popup", (e) => show(e.payload));
    refresh();

    // It may have changed while out of view (e.g. in Windows).
    return { shown: refresh };
  },
});
