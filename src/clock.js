// Day, time and battery on one line above the calendar, e.g. "Wed  7:02 PM  17%".
// Ticks only while the pane is open.
window.ClockPanel = (() => {
  const { invoke } = window.__TAURI__.core;
  const $ = (id) => document.getElementById(id);

  const BATTERY_EVERY_MS = 30 * 1000;

  const dayEl = $("clock-day");
  const timeEl = $("clock-time");
  const battery = $("battery");
  const text = $("battery-text");
  const saver = $("battery-saver");

  let clockTimer = null;
  let batteryTimer = null;

  function showTime() {
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    dayEl.textContent = now.toLocaleDateString([], { weekday: "short" });
    dayEl.title = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }

  async function showBattery() {
    let b = null;
    try {
      b = await invoke("get_battery");
    } catch (err) {
      console.error("Could not read the battery", err);
    }
    battery.hidden = !b; // no battery (e.g. a desktop PC): show nothing
    if (!b) return;
    text.textContent = `${b.percent}%`;
    battery.classList.toggle("charging", b.charging);
    battery.classList.toggle("low", b.percent <= 15 && !b.pluggedIn);
    saver.hidden = !b.saver;
    battery.title = b.charging ? `${b.percent}%, charging` : b.pluggedIn ? `${b.percent}%, plugged in` : `${b.percent}% remaining`;
  }

  function start() {
    stop();
    showTime();
    showBattery();
    // Tick on the next whole second, then every second, so the minute
    // changes on time.
    clockTimer = setTimeout(function tick() {
      showTime();
      clockTimer = setTimeout(tick, 1000 - (Date.now() % 1000));
    }, 1000 - (Date.now() % 1000));
    batteryTimer = setInterval(showBattery, BATTERY_EVERY_MS);
  }

  function stop() {
    clearTimeout(clockTimer);
    clearInterval(batteryTimer);
    clockTimer = batteryTimer = null;
  }

  showTime();
  showBattery();

  return { start, stop };
})();
