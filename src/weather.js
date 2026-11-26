// Weather (left side of the top-right quadrant), from weather.gov.
//
//   Now:  current temperature and conditions, place, today's high/low, alerts.
//   Top:  the next 48 hours, hour by hour (scrolls sideways).
//   Bottom: the week as small squares joined by a line, placed by temperature;
//           hover over the graph for the nearest day's details. Each time the
//           pane opens the line draws itself in, then the squares pop up.
//
// The ZIP code comes from Pane settings. Forecasts are cached (also across
// restarts) and refreshed when the pane opens, at most every 30 minutes.
window.WeatherPanel = (() => {
  const { invoke } = window.__TAURI__.core;
  const $ = (id) => document.getElementById(id);

  const API = "https://api.weather.gov";
  const REFRESH_AFTER = 30 * 60 * 1000;
  const HOURS = 48;
  const DAYS = 7;
  const CACHE_KEY = "weather-cache";
  // Opening animation: wait for the pane to slide in, then draw the line.
  const INTRO_DELAY_MS = 180;
  const DRAW_MS = 700;
  const POINT_KEY = "weather-point";

  const panel = $("weather");
  const nowEl = $("weather-now");
  const hoursEl = $("weather-hours");
  const weekEl = $("weather-week");
  const messageEl = $("weather-message");

  // ---- Data ----------------------------------------------------------------------

  async function getJson(url) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { Accept: "application/geo+json" } });
      if (res.ok) return res.json();
      // weather.gov has occasional hiccups; one retry usually fixes them.
      if (res.status >= 500 && attempt === 0) continue;
      throw new Error(`weather.gov answered ${res.status}`);
    }
  }

  const readStore = (k) => {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch {
      return null;
    }
  };
  const writeStore = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  // weather.gov's forecast addresses for a ZIP code (these rarely change).
  async function pointFor(zip) {
    const saved = readStore(POINT_KEY);
    if (saved?.zip === zip) return saved;
    const loc = await invoke("zip_location", { zip });
    if (!loc) throw new Error(`ZIP code ${zip} wasn't found.`);
    const lat = loc.lat.toFixed(4);
    const lon = loc.lon.toFixed(4);
    const p = (await getJson(`${API}/points/${lat},${lon}`)).properties;
    const where = p.relativeLocation?.properties ?? {};
    const point = {
      zip,
      lat: loc.lat,
      lon: loc.lon,
      forecast: p.forecast,
      hourly: p.forecastHourly,
      place: [where.city, where.state].filter(Boolean).join(", "),
    };
    writeStore(POINT_KEY, point);
    return point;
  }

  async function download(zip) {
    const point = await pointFor(zip);
    const [daily, hourly, alerts] = await Promise.all([
      getJson(point.forecast),
      getJson(point.hourly),
      // Alerts are a bonus; don't fail the whole forecast over them.
      getJson(`${API}/alerts/active?point=${point.lat.toFixed(4)},${point.lon.toFixed(4)}`).catch(() => null),
    ]);
    return {
      zip,
      at: Date.now(),
      point,
      daily: daily.properties.periods,
      hourly: hourly.properties.periods,
      alerts: (alerts?.features ?? []).map((f) => ({
        event: f.properties.event,
        headline: f.properties.headline,
        ends: f.properties.ends ?? f.properties.expires,
      })),
    };
  }

  // ---- Icons ---------------------------------------------------------------------

  // Pick one of the icons in the icons folder from weather.gov's description,
  // e.g. "Chance Rain Showers then Mostly Cloudy" -> rainy.
  function iconFor(text, isDay) {
    const t = (text ?? "").toLowerCase().split(" then ")[0];
    const time = isDay ? "day" : "night";
    let name;
    if (/thunder|t-storm/.test(t)) name = "thunderstorm";
    else if (/snow|sleet|flurr|blizzard|ice|freezing|wintry/.test(t)) name = "snowy";
    else if (/rain|shower|drizzle/.test(t)) name = "rainy";
    else if (/fog|haze|smoke|dust|mist|ash/.test(t)) name = "smoggy";
    else if (/cloud|overcast|partly/.test(t)) name = `cloudy-${time}`;
    else name = `clear-${time}`;
    return `url("icons/${name}.png")`;
  }

  function weatherIcon(text, isDay, extraClass = "") {
    const span = document.createElement("span");
    span.className = `icon wx-icon ${extraClass}`.trim();
    span.setAttribute("aria-hidden", "true");
    span.style.setProperty("--icon", iconFor(text, isDay));
    return span;
  }

  // ---- Rendering -----------------------------------------------------------------

  const deg = (t) => (t == null ? "–" : `${Math.round(t)}°`);
  const chance = (p) => p?.probabilityOfPrecipitation?.value ?? 0;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // Pair weather.gov's day and night periods into days.
  function toDays(periods) {
    const days = [];
    for (let i = 0; i < periods.length && days.length < DAYS; i++) {
      const p = periods[i];
      if (p.isDaytime) {
        const next = periods[i + 1];
        const night = next && !next.isDaytime ? next : null;
        days.push({ day: p, night });
        if (night) i++;
      } else {
        days.push({ day: null, night: p }); // e.g. "Tonight", when it's already evening
      }
    }
    return days;
  }

  function renderNow(data, days) {
    const now = data.hourly.find((h) => new Date(h.endTime) > Date.now()) ?? data.hourly[0];
    const today = days[0];
    nowEl.replaceChildren();
    if (!now) return;

    const summary = el("div", "now-text");
    summary.append(el("div", "now-summary", now.shortForecast));
    const place = el("button", "now-place", data.point.place || `ZIP ${data.zip}`);
    place.type = "button";
    place.title = "Open the full forecast on weather.gov";
    place.addEventListener("click", openForecastPage);
    const range = [today?.day && `H ${deg(today.day.temperature)}`, today?.night && `L ${deg(today.night.temperature)}`]
      .filter(Boolean)
      .join("  ");
    const sub = el("div", "now-sub");
    sub.append(place);
    if (range) sub.append(el("span", "now-range", range));
    summary.append(sub);

    nowEl.append(weatherIcon(now.shortForecast, now.isDaytime, "now-icon"), el("div", "now-temp", deg(now.temperature)), summary);

    if (data.alerts.length) {
      const badge = el("button", "alert-badge");
      badge.type = "button";
      const icon = el("span", "icon alert-icon");
      icon.setAttribute("aria-hidden", "true");
      const more = data.alerts.length > 1 ? ` +${data.alerts.length - 1}` : "";
      badge.append(icon, el("span", "alert-text", data.alerts[0].event + more));
      badge.addEventListener("click", openForecastPage);
      window.Tooltip.attach(badge, () =>
        data.alerts.map((a) => window.Tooltip.content(a.event, [a.headline])).flat(),
      );
      nowEl.append(badge);
    }
  }

  // Fade whichever edge of the hours strip has more hours beyond it.
  function updateHourFades() {
    const hidden = hoursEl.scrollWidth - hoursEl.clientWidth;
    hoursEl.style.setProperty("--fade-left", hoursEl.scrollLeft > 2 ? "40px" : "0px");
    hoursEl.style.setProperty("--fade-right", hoursEl.scrollLeft < hidden - 2 ? "40px" : "0px");
  }

  function renderHours(data) {
    const hours = data.hourly.filter((h) => new Date(h.endTime) > Date.now()).slice(0, HOURS);
    const items = [];
    hours.forEach((h, i) => {
      const start = new Date(h.startTime);

      // A thin line between days, with the new day's name running down beside it.
      if (i > 0 && start.getHours() === 0) {
        const divider = el("div", "hour-divider");
        divider.append(el("span", "hour-divider-day", start.toLocaleDateString([], { weekday: "long" })));
        items.push(divider);
      }

      const cell = el("div", "hour");
      cell.tabIndex = 0;
      cell.append(
        el("span", i === 0 ? "hour-time strong" : "hour-time", i === 0 ? "Now" : start.toLocaleTimeString([], { hour: "numeric" })),
        weatherIcon(h.shortForecast, h.isDaytime),
        el("span", "hour-temp", deg(h.temperature)),
        el("span", "hour-rain", chance(h) >= 10 ? `${chance(h)}%` : ""),
      );
      window.Tooltip.attach(cell, () =>
        window.Tooltip.content(
          `${start.toLocaleDateString([], { weekday: "long" })} ${start.toLocaleTimeString([], { hour: "numeric" })}`,
          [
            `${deg(h.temperature)} · ${h.shortForecast}`,
            chance(h) ? `${chance(h)}% chance of precipitation` : "",
            h.relativeHumidity?.value != null ? `Humidity ${h.relativeHumidity.value}%` : "",
            h.windSpeed ? `Wind ${h.windDirection ?? ""} ${h.windSpeed}`.replace(/\s+/g, " ") : "",
          ],
          iconFor(h.shortForecast, h.isDaytime),
        ),
      );
      items.push(cell);
    });
    hoursEl.replaceChildren(...items);
    hoursEl.scrollLeft = 0;
    updateHourFades();
  }

  function renderWeek(days) {
    weekEl.replaceChildren();
    if (!days.length) return;

    // Each day is placed by its high (or the low, for a night-only first day).
    const value = (d) => (d.day ?? d.night).temperature;
    const temps = days.map(value);
    const min = Math.min(...temps);
    const max = Math.max(...temps);
    const n = days.length;
    const x = (i) => ((i + 0.5) / n) * 100;
    // Points sit between 28% and 72% of the height, leaving room for the
    // labels above and below them. With all days equal, use a 10° span.
    const lo = max === min ? min - 5 : min;
    const hi = max === min ? max + 5 : max;
    const y = (t) => 28 + (1 - (t - lo) / (hi - lo)) * 44;
    const tempAt = (yy) => lo + (1 - (yy - 28) / 44) * (hi - lo);

    const body = el("div", "week-body");
    const plot = el("div", "week-plot");

    // Horizontal temperature lines, every 5° (or 10° for a wide range).
    const step = tempAt(0) - tempAt(100) > 40 ? 10 : 5;
    for (let t = Math.ceil(tempAt(100) / step) * step; t <= tempAt(0); t += step) {
      const yy = y(t);
      if (yy < 3 || yy > 97) continue;
      const rule = el("div", "week-rule");
      rule.style.top = `${yy}%`;
      rule.append(el("span", "week-rule-label", deg(t)));
      plot.append(rule);
    }

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "week-line");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    const line = document.createElementNS(svgNS, "polyline");
    line.setAttribute("points", days.map((d, i) => `${x(i)},${y(value(d))}`).join(" "));
    line.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(line);
    plot.append(svg);

    const labels = el("div", "week-days");
    labels.style.gridTemplateColumns = `repeat(${n}, 1fr)`;

    // A vertical line through the selected (hovered) day, lining it up
    // with its name below. It slides from day to day.
    const cursor = el("div", "week-cursor");
    const points = [];
    let selected = -1;

    function select(i) {
      if (i === selected) return;
      if (selected === -1) {
        // Appearing: start at the day rather than sliding in from the last one.
        cursor.style.transition = "none";
        cursor.style.left = `${x(i)}%`;
        void cursor.offsetWidth;
        cursor.style.transition = "";
      }
      unselect();
      selected = i;
      cursor.style.left = `${x(i)}%`;
      cursor.classList.add("shown");
      points[i].point.classList.add("selected");
      points[i].label.classList.add("selected");
      window.Tooltip.show(points[i].point, points[i].info);
    }

    function unselect() {
      if (selected === -1) return;
      cursor.classList.remove("shown");
      points[selected].point.classList.remove("selected");
      points[selected].label.classList.remove("selected");
      window.Tooltip.hide(points[selected].point);
      selected = -1;
    }

    // Anywhere over the graph picks the nearest day, so the info follows the
    // mouse from day to day.
    body.addEventListener("mousemove", (e) => {
      const r = plot.getBoundingClientRect();
      if (!r.width) return;
      select(Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n))));
    });
    body.addEventListener("mouseleave", unselect);

    days.forEach((d, i) => {
      const main = d.day ?? d.night;
      const start = new Date(main.startTime);
      const short = i === 0 ? (d.day ? "Today" : "Tonight") : start.toLocaleDateString([], { weekday: "short" });
      const dayLabel = el("span", i === 0 ? "week-day strong" : "week-day", short);

      const point = el("div", "week-point");
      point.style.left = `${x(i)}%`;
      point.style.top = `${y(value(d))}%`;
      point.tabIndex = 0;
      point.setAttribute("aria-label", `${main.name}: ${main.shortForecast}`);
      point.append(
        el("span", "week-high", deg(d.day?.temperature ?? d.night.temperature)),
        el("span", "week-square"),
        el("span", "week-low", d.day && d.night ? deg(d.night.temperature) : ""),
      );

      point.addEventListener("focus", () => select(i));
      point.addEventListener("blur", unselect);

      const info = () =>
        window.Tooltip.content(
          main.name,
          [
            [d.day && `High ${deg(d.day.temperature)}`, d.night && `Low ${deg(d.night.temperature)}`].filter(Boolean).join(" · "),
            main.shortForecast,
            chance(main) ? `${chance(main)}% chance of precipitation` : "",
            main.windSpeed ? `Wind ${main.windDirection ?? ""} ${main.windSpeed}`.replace(/\s+/g, " ") : "",
            main.detailedForecast,
            d.day && d.night?.detailedForecast ? `Night: ${d.night.detailedForecast}` : "",
          ],
          iconFor(main.shortForecast, main.isDaytime),
        );
      points.push({ point, label: dayLabel, info });
      plot.append(point);
      labels.append(dayLabel);
    });

    body.append(cursor, plot, labels); // cursor first, so it sits behind the points
    weekEl.append(body);
  }

  // Draw the week's line in from left to right, popping each day's square
  // up as the line reaches it. Called each time the pane opens.
  function intro() {
    const line = weekEl.querySelector(".week-line");
    if (!line || panel.hidden) return;
    line.animate([{ clipPath: "inset(-10px 100% -10px 0)" }, { clipPath: "inset(-10px 0 -10px 0)" }], {
      duration: DRAW_MS,
      delay: INTRO_DELAY_MS,
      easing: "cubic-bezier(0.45, 0, 0.25, 1)",
      fill: "backwards",
    });
    for (const point of weekEl.querySelectorAll(".week-point")) {
      const at = parseFloat(point.style.left) / 100; // how far along the line
      const delay = INTRO_DELAY_MS + at * DRAW_MS;
      point.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay, fill: "backwards" });
      point.querySelector(".week-square").animate(
        [{ scale: "0" }, { scale: "1.5", offset: 0.6 }, { scale: "1" }],
        { duration: 320, delay, easing: "ease-out", fill: "backwards" },
      );
    }
  }

  function showMessage(text, action) {
    nowEl.replaceChildren();
    hoursEl.replaceChildren();
    weekEl.replaceChildren();
    messageEl.replaceChildren(el("p", "", text));
    if (action) {
      const b = el("button", "button glass", action.label);
      b.type = "button";
      b.addEventListener("click", action.run);
      messageEl.append(b);
    }
    messageEl.hidden = false;
  }

  function render(data, note) {
    messageEl.hidden = true;
    const days = toDays(data.daily);
    renderNow(data, days);
    renderHours(data);
    renderWeek(days);
    panel.dataset.stale = note ? "true" : "false";
    panel.title = note ?? "";
  }

  // ---- Refresh -------------------------------------------------------------------

  let cache = readStore(CACHE_KEY);
  let inFlight = null;

  function openForecastPage() {
    const p = cache?.point;
    if (p) invoke("open_forecast_page", { lat: p.lat, lon: p.lon }).catch((err) => console.error(err));
  }

  async function update(force = false) {
    const { zip, panels } = window.PaneSettings.get();
    if (!panels.weather) return;
    if (!zip) {
      showMessage("Add your ZIP code in Pane settings to see the weather.", {
        label: "Pane settings",
        run: () => window.PaneSettings.open(),
      });
      return;
    }
    const mine = cache?.zip === zip ? cache : null;
    if (mine) render(mine); // show what we have straight away
    if (mine && !force && Date.now() - mine.at < REFRESH_AFTER) return;

    try {
      cache = await download(zip);
      writeStore(CACHE_KEY, cache);
      render(cache);
    } catch (err) {
      console.error("Weather update failed", err);
      if (mine) render(mine, "Couldn't update the weather; showing the last forecast.");
      else showMessage(err.message?.startsWith("ZIP code") ? err.message : "Couldn't reach weather.gov. It'll try again next time the pane opens.");
    }
  }

  // One update at a time; a request that comes in meanwhile (e.g. the ZIP
  // code changed) runs once the current one is done.
  let again = false;
  function refresh(force = false) {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = update(force).finally(() => {
      inFlight = null;
      if (again) {
        again = false;
        refresh();
      }
    });
    return inFlight;
  }

  // Scrolling the mouse wheel over the hours moves them sideways.
  hoursEl.addEventListener(
    "wheel",
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      hoursEl.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
  hoursEl.addEventListener("scroll", updateHourFades, { passive: true });

  // Follow the settings: show/hide, and reload when the ZIP code changes.
  let lastZip;
  window.PaneSettings.onChange((s) => {
    const turnedOn = panel.hidden && s.panels.weather;
    panel.hidden = !s.panels.weather;
    if (s.zip !== lastZip || turnedOn) {
      lastZip = s.zip;
      refresh(); // the cache belongs to one ZIP code, so a new one always downloads
    }
  });

  return { refresh, intro };
})();
