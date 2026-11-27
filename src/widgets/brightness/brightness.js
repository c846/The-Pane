// Brightness: one slider for every screen whose brightness can be set
// (a laptop's own screen, and monitors that support it). Scroll over it to
// nudge it. Many desktop monitors can't be dimmed; then it says so.
Widgets.define({
  kind: "brightness",
  name: "Brightness",
  description: "Your screen's brightness.",
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
    const sun = el("span", "level-icon");
    sun.setAttribute("aria-hidden", "true");
    sun.innerHTML = `<svg class="sun" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="4.5" />
        <g stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
          <line x1="12" y1="1.8" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="22.2" />
          <line x1="1.8" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="22.2" y2="12" />
          <line x1="4.8" y1="4.8" x2="6.3" y2="6.3" /><line x1="17.7" y1="17.7" x2="19.2" y2="19.2" />
          <line x1="4.8" y1="19.2" x2="6.3" y2="17.7" /><line x1="17.7" y1="6.3" x2="19.2" y2="4.8" />
        </g>
      </svg>`;
    const slider = el("input", "slider");
    Object.assign(slider, { type: "range", min: 0, max: 100 });
    slider.setAttribute("aria-label", "Brightness");
    const value = el("span", "level-value");
    value.setAttribute("aria-hidden", "true");
    row.append(sun, slider, value);
    const message = el("p", "widget-message", "This screen's brightness can't be set from here.");
    body.append(el("h3", "group-label", "Brightness"), row, message);

    const send = Widgets.latestOnly((level) => invoke("set_brightness", { level }));
    let dragging = false;

    function showLevel(level) {
      slider.value = level;
      slider.style.setProperty("--fill", `${level}%`);
      value.textContent = level;
    }

    function show(level) {
      body.classList.toggle("unavailable", level == null);
      if (level != null && !dragging) showLevel(level);
    }

    const refresh = () => invoke("get_brightness").catch(() => null).then(show);

    slider.addEventListener("input", () => {
      const level = Number(slider.value);
      showLevel(level);
      send(level);
    });
    slider.addEventListener("pointerdown", () => (dragging = true));
    slider.addEventListener("pointerup", () => (dragging = false));
    slider.addEventListener("change", () => (dragging = false));

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

    // Set by another brightness widget, on either surface.
    ctx.listen("brightness-changed", (e) => show(e.payload));
    refresh();

    return { shown: refresh };
  },
});
