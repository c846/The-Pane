// Weather widget: the temperature and conditions now, today's high and low,
// any alerts, and the next few hours.
//
// The forecast comes from WeatherData (shared/weather-data.js), the same
// cache the pane's weather panel uses, so the two never download twice.
// It checks every few minutes whether the forecast is due a refresh (every
// 30 minutes); otherwise it does nothing.
Desktop.register({
  kind: "weather",

  create(root, settings) {
    const { invoke } = window.__TAURI__.core;
    const WD = window.WeatherData;
    const HOURS = 6;
    const CHECK_EVERY = 5 * 60 * 1000;

    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };
    const deg = (t) => (t == null ? "–" : `${Math.round(t)}°`);
    const icon = (text, isDay, cls = "") => {
      const span = el("span", `wxw-icon ${cls}`.trim());
      span.setAttribute("aria-hidden", "true");
      span.style.backgroundImage = WD.iconUrl(text, isDay);
      return span;
    };

    let zip = settings?.zip ?? "";
    let data = null;
    let busy = false;

    function openForecast() {
      const p = data?.point;
      if (p) invoke("open_forecast_page", { lat: p.lat, lon: p.lon }).catch(console.error);
    }

    function message(text) {
      root.replaceChildren(el("p", "wxw-message", text));
    }

    function render() {
      const upcoming = data.hourly.filter((h) => new Date(h.endTime) > Date.now());
      const now = upcoming[0] ?? data.hourly[0];
      if (!now) return message("No forecast right now.");

      // Today's high and low: the first day and night periods.
      const day = data.daily.find((p) => p.isDaytime);
      const night = data.daily.find((p) => !p.isDaytime);
      const range = [day && `H ${deg(day.temperature)}`, night && `L ${deg(night.temperature)}`].filter(Boolean).join("  ");

      const top = el("div", "wxw-now");
      const text = el("div", "wxw-text");
      const place = el("button", "wxw-place", data.point.place || `ZIP ${data.zip}`);
      place.type = "button";
      place.title = "Open the full forecast on weather.gov";
      place.addEventListener("click", openForecast);
      const sub = el("div", "wxw-sub");
      sub.append(place);
      if (range) sub.append(el("span", "", range));
      text.append(el("div", "wxw-summary", now.shortForecast), sub);
      top.append(icon(now.shortForecast, now.isDaytime, "wxw-icon-big"), el("div", "wxw-temp", deg(now.temperature)), text);

      const hours = el("div", "wxw-hours");
      for (const h of upcoming.slice(1, HOURS + 1)) {
        const cell = el("div", "wxw-hour");
        cell.title = h.shortForecast;
        const time = new Date(h.startTime).toLocaleTimeString([], { hour: "numeric" });
        cell.append(el("span", "wxw-hour-time", time), icon(h.shortForecast, h.isDaytime), el("span", "", deg(h.temperature)));
        hours.append(cell);
      }

      const parts = [top];
      if (data.alerts.length) {
        const alert = el("button", "wxw-alert", data.alerts.map((a) => a.event).join(" · "));
        alert.type = "button";
        alert.title = data.alerts.map((a) => a.headline).join("\n");
        alert.addEventListener("click", openForecast);
        parts.push(alert);
      }
      parts.push(hours);
      root.replaceChildren(...parts);
      root.classList.toggle("stale", WD.isStale(data) && Date.now() - data.at > 2 * WD.REFRESH_AFTER);
    }

    async function update(force = false) {
      if (!zip) return message("Add your ZIP code in Pane settings to see the weather.");
      const mine = WD.cached(zip);
      if (mine && mine !== data) {
        data = mine;
        render();
      }
      if (busy || (!force && !WD.isStale(mine))) return;
      busy = true;
      try {
        data = await WD.download(zip);
        render();
      } catch (err) {
        console.error("Weather widget update failed", err);
        if (!data) message(err.message?.startsWith("ZIP code") ? err.message : "Couldn't reach weather.gov.");
      } finally {
        busy = false;
      }
    }

    // The pane downloaded a newer forecast.
    WD.onUpdate((fresh) => {
      if (fresh.zip !== zip) return;
      data = fresh;
      render();
    });

    // Every few minutes: refresh if due, otherwise just re-render so "now"
    // and the hours move along as time passes.
    const timer = setInterval(() => (data ? (WD.isStale(data) ? update() : render()) : update()), CHECK_EVERY);
    update();

    return {
      settingsChanged(s) {
        if (s.zip === zip) return;
        zip = s.zip;
        data = null;
        update(true);
      },
      destroy() {
        clearInterval(timer);
      },
    };
  },
});
