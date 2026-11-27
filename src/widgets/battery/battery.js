// Battery: how much charge is left, whether it's charging, and battery
// saver. Checks every 30 seconds while in view. A PC without a battery
// (most desktops) says so.
Widgets.define({
  kind: "battery",
  name: "Battery",
  description: "Charge left, charging and battery saver.",
  sizes: [
    [1, 1],
    [2, 1],
    [3, 1],
  ],

  create(body, ctx) {
    const { invoke } = window.__TAURI__.core;
    const { el } = Widgets;
    const EVERY_MS = 30 * 1000;

    const top = el("div", "battery-top");
    const percent = el("span", "battery-percent");
    const saver = el("span", "icon icon-battery-saver battery-saver");
    saver.title = "Battery saver is on";
    top.append(percent, saver);
    const bar = el("div", "battery-bar");
    const fill = el("div", "battery-fill");
    bar.append(fill);
    const status = el("div", "battery-status");
    const message = el("p", "widget-message", "No battery");
    body.append(top, bar, status, message);

    async function refresh() {
      let b = null;
      try {
        b = await invoke("get_battery");
      } catch (err) {
        console.error("Could not read the battery", err);
      }
      body.classList.toggle("unavailable", !b);
      if (!b) return;
      percent.textContent = `${b.percent}%`;
      fill.style.width = `${b.percent}%`;
      saver.hidden = !b.saver;
      const low = b.percent <= 15 && !b.pluggedIn;
      body.classList.toggle("low", low);
      body.classList.toggle("charging", b.charging);
      status.textContent = b.charging ? "Charging" : b.pluggedIn ? "Plugged in" : low ? "Low" : "On battery";
      body.title = b.charging ? `${b.percent}%, charging` : b.pluggedIn ? `${b.percent}%, plugged in` : `${b.percent}% remaining`;
    }

    ctx.every(EVERY_MS, refresh);
    refresh();
  },
});
