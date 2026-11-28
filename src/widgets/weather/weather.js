// Weather, from weather.gov. What it shows grows with its size:
//
//   2x1, 3x1    now: temperature, conditions, place, today's high and low
//   3x2         …plus any alert, and the next six hours
//   5x2         now (with an alert badge), and the week as small squares
//               joined by a line, placed by temperature; hover over the
//               graph for the nearest day's details
//   5x3 and up  now, the next 48 hours, hour by hour (scrolls sideways),
//               and the week
//
// The ZIP code comes from Pane settings. The forecast comes from
// WeatherData (shared/weather-data.js), which caches it for every weather
// widget on both surfaces; it's refreshed at most every 30 minutes.
Widgets.define({
  kind: "weather",
  name: "Weather",
  description: "Conditions now, the next hours and the week ahead.",
  sizes: [
    [3, 2],
    [3, 1],
    [2, 1],
    [5, 2],
    [5, 3],
    [6, 3],
    [6, 4],
  ],

  create(body, ctx) {
    const { invoke } = window.__TAURI__.core;
    const { el } = Widgets;
    const WD = window.WeatherData;
    const Tip = window.Tooltip;

    const HOURS = 48;
    const FEW_HOURS = 6;
    const DAYS = 7;
    const CHECK_EVERY = 5 * 60 * 1000;

    let zip = ctx.settings()?.zip ?? "";
    let data = null;
    let note = null; // why an old forecast is showing
    let shownData = null; // the forecast and key the last render showed,
    let shownKey = ""; //    so identical renders can be skipped

    // ---- Layout by size ----------------------------------------------------------

    const layout = () => {
      const { w, h } = ctx.size;
      if (w >= 5) return { hours: h >= 3 ? "strip" : null, badge: true, week: true };
      if (h >= 2) return { hours: "few", badge: false, week: false };
      return { hours: null, badge: false, week: false };
    };

    // ---- Pieces --------------------------------------------------------------------

    const deg = (t) => (t == null ? "–" : `${Math.round(t)}°`);
    const chance = (p) => p?.probabilityOfPrecipitation?.value ?? 0;

    function weatherIcon(text, isDay, extraClass = "") {
      const span = el("span", `icon wx-icon ${extraClass}`.trim());
      span.setAttribute("aria-hidden", "true");
      span.style.setProperty("--icon", WD.iconUrl(text, isDay));
      return span;
    }

    function openForecast() {
      const p = data?.point;
      if (p) invoke("open_forecast_page", { lat: p.lat, lon: p.lon }).catch((err) => console.error(err));
    }

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

    // The hours that haven't ended yet, the current one first.
    function upcomingHours() {
      const now = Date.now();
      const i = data.hourly.findIndex((h) => Date.parse(h.endTime) > now);
      return i === -1 ? [] : data.hourly.slice(i);
    }

    function nowRow(days, upcoming, withBadge) {
      const now = upcoming[0] ?? data.hourly[0];
      const row = el("div", "wx-now");
      if (!now) return row;
      const today = days[0];

      const text = el("div", "wx-now-text");
      text.append(el("div", "wx-summary", now.shortForecast));
      const place = el("button", "wx-place", data.point.place || `ZIP ${data.zip}`);
      place.type = "button";
      place.title = "Open the full forecast on weather.gov";
      place.addEventListener("click", openForecast);
      const range = [today?.day && `H ${deg(today.day.temperature)}`, today?.night && `L ${deg(today.night.temperature)}`]
        .filter(Boolean)
        .join("  ");
      const sub = el("div", "wx-sub");
      sub.append(place);
      if (range) sub.append(el("span", "wx-range", range));
      text.append(sub);
      row.append(weatherIcon(now.shortForecast, now.isDaytime, "wx-now-icon"), el("div", "wx-temp", deg(now.temperature)), text);

      if (withBadge && data.alerts.length) row.append(alertBadge());
      return row;
    }

    // Weather alert (e.g. "Coastal Flood Warning"); hover for details.
    function alertBadge() {
      const badge = el("button", "wx-alert glass");
      badge.type = "button";
      const icon = el("span", "icon icon-danger wx-alert-icon");
      icon.setAttribute("aria-hidden", "true");
      const more = data.alerts.length > 1 ? ` +${data.alerts.length - 1}` : "";
      badge.append(icon, el("span", "wx-alert-text", data.alerts[0].event + more));
      badge.addEventListener("click", openForecast);
      Tip.attach(badge, () => data.alerts.map((a) => Tip.content(a.event, [a.headline])).flat());
      return badge;
    }

    function hourInfo(h, start) {
      return Tip.content(
        `${start.toLocaleDateString([], { weekday: "long" })} ${start.toLocaleTimeString([], { hour: "numeric" })}`,
        [
          `${deg(h.temperature)} · ${h.shortForecast}`,
          chance(h) ? `${chance(h)}% chance of precipitation` : "",
          h.relativeHumidity?.value != null ? `Humidity ${h.relativeHumidity.value}%` : "",
          h.windSpeed ? `Wind ${h.windDirection ?? ""} ${h.windSpeed}`.replace(/\s+/g, " ") : "",
        ],
        WD.iconUrl(h.shortForecast, h.isDaytime),
      );
    }

    // The next few hours, evenly across the bottom.
    function fewHours(upcoming) {
      const row = el("div", "wx-few");
      for (const h of upcoming.slice(1, FEW_HOURS + 1)) {
        const start = new Date(h.startTime);
        const cell = el("div", "wx-few-hour");
        cell.append(
          el("span", "wx-hour-time", start.toLocaleTimeString([], { hour: "numeric" })),
          weatherIcon(h.shortForecast, h.isDaytime),
          el("span", "", deg(h.temperature)),
        );
        Tip.attach(cell, () => hourInfo(h, start));
        row.append(cell);
      }
      return row;
    }

    // The next 48 hours, scrolling sideways.
    function hourStrip(upcoming) {
      const strip = el("div", "wx-hours");
      const hours = upcoming.slice(0, HOURS);
      hours.forEach((h, i) => {
        const start = new Date(h.startTime);

        // A thin line between days, with the new day's name running down beside it.
        if (i > 0 && start.getHours() === 0) {
          const divider = el("div", "wx-hour-divider");
          divider.append(el("span", "wx-hour-divider-day", start.toLocaleDateString([], { weekday: "long" })));
          strip.append(divider);
        }

        const cell = el("div", "wx-hour");
        cell.tabIndex = 0;
        cell.append(
          el("span", i === 0 ? "wx-hour-time strong" : "wx-hour-time", i === 0 ? "Now" : start.toLocaleTimeString([], { hour: "numeric" })),
          weatherIcon(h.shortForecast, h.isDaytime),
          el("span", "wx-hour-temp", deg(h.temperature)),
          el("span", "wx-hour-rain", chance(h) >= 10 ? `${chance(h)}%` : ""),
        );
        Tip.attach(cell, () => hourInfo(h, start));
        strip.append(cell);
      });

      // Fade whichever edge has more hours beyond it: checked at most once a
      // frame while scrolling, and the mask only changed when a fade turns on
      // or off.
      let fadeL = null;
      let fadeR = null;
      let pending = false;
      const fades = () => {
        pending = false;
        const hidden = strip.scrollWidth - strip.clientWidth;
        const l = strip.scrollLeft > 2;
        const r = strip.scrollLeft < hidden - 2;
        if (l !== fadeL) strip.style.setProperty("--fade-left", (fadeL = l) ? "40px" : "0px");
        if (r !== fadeR) strip.style.setProperty("--fade-right", (fadeR = r) ? "40px" : "0px");
      };
      const fadesSoon = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(fades);
      };
      // The mouse wheel scrolls it sideways.
      strip.addEventListener(
        "wheel",
        (e) => {
          if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
          e.preventDefault();
          strip.scrollLeft += e.deltaY;
        },
        { passive: false },
      );
      strip.addEventListener("scroll", fadesSoon, { passive: true });
      fadesSoon();
      return strip;
    }

    function weekGraph(days) {
      const week = el("div", "wx-week");
      if (!days.length) return week;

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

      const wrap = el("div", "wx-week-body");
      const plot = el("div", "wx-week-plot");

      // Horizontal temperature lines, every 5° (or 10° for a wide range).
      const step = tempAt(0) - tempAt(100) > 40 ? 10 : 5;
      for (let t = Math.ceil(tempAt(100) / step) * step; t <= tempAt(0); t += step) {
        const yy = y(t);
        if (yy < 3 || yy > 97) continue;
        const rule = el("div", "wx-week-rule");
        rule.style.top = `${yy}%`;
        rule.append(el("span", "wx-week-rule-label", deg(t)));
        plot.append(rule);
      }

      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("class", "wx-week-line");
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");
      const line = document.createElementNS(svgNS, "polyline");
      line.setAttribute("points", days.map((d, i) => `${x(i)},${y(value(d))}`).join(" "));
      line.setAttribute("vector-effect", "non-scaling-stroke");
      svg.append(line);
      plot.append(svg);

      const labels = el("div", "wx-week-days");
      labels.style.gridTemplateColumns = `repeat(${n}, 1fr)`;

      // A vertical line through the selected (hovered) day, lining it up
      // with its name below. It slides from day to day.
      const cursor = el("div", "wx-week-cursor");
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
        Tip.show(points[i].point, points[i].info);
      }

      function unselect() {
        if (selected === -1) return;
        cursor.classList.remove("shown");
        points[selected].point.classList.remove("selected");
        points[selected].label.classList.remove("selected");
        Tip.hide(points[selected].point);
        selected = -1;
      }

      // Anywhere over the graph picks the nearest day, so the info follows
      // the mouse from day to day. Where the plot is gets measured once each
      // time the mouse comes in, not on every move.
      let rect = null;
      wrap.addEventListener("mouseenter", () => {
        rect = null;
      });
      wrap.addEventListener("mousemove", (e) => {
        if (body.closest(".dragging")) return;
        rect ??= plot.getBoundingClientRect();
        if (!rect.width) return;
        select(Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - rect.left) / rect.width) * n))));
      });
      wrap.addEventListener("mouseleave", unselect);

      days.forEach((d, i) => {
        const main = d.day ?? d.night;
        const start = new Date(main.startTime);
        const short = i === 0 ? (d.day ? "Today" : "Tonight") : start.toLocaleDateString([], { weekday: "short" });
        const dayLabel = el("span", i === 0 ? "wx-week-day strong" : "wx-week-day", short);

        const point = el("div", "wx-week-point");
        point.style.left = `${x(i)}%`;
        point.style.top = `${y(value(d))}%`;
        point.tabIndex = 0;
        point.setAttribute("aria-label", `${main.name}: ${main.shortForecast}`);
        point.append(
          el("span", "wx-week-high", deg(d.day?.temperature ?? d.night.temperature)),
          el("span", "wx-week-square"),
          el("span", "wx-week-low", d.day && d.night ? deg(d.night.temperature) : ""),
        );
        point.addEventListener("focus", () => select(i));
        point.addEventListener("blur", unselect);

        const info = () =>
          Tip.content(
            main.name,
            [
              [d.day && `High ${deg(d.day.temperature)}`, d.night && `Low ${deg(d.night.temperature)}`].filter(Boolean).join(" · "),
              main.shortForecast,
              chance(main) ? `${chance(main)}% chance of precipitation` : "",
              main.windSpeed ? `Wind ${main.windDirection ?? ""} ${main.windSpeed}`.replace(/\s+/g, " ") : "",
              main.detailedForecast,
              d.day && d.night?.detailedForecast ? `Night: ${d.night.detailedForecast}` : "",
            ],
            WD.iconUrl(main.shortForecast, main.isDaytime),
          );
        points.push({ point, label: dayLabel, info });
        plot.append(point);
        labels.append(dayLabel);
      });

      wrap.append(cursor, plot, labels); // cursor first, so it sits behind the points
      week.append(wrap);
      return week;
    }

    // ---- Rendering -----------------------------------------------------------------

    function message(text, withSettings = false) {
      const box = el("div", "widget-message");
      box.append(el("p", "", text));
      if (withSettings && ctx.openSettings) {
        const b = el("button", "button glass", "Pane settings");
        b.type = "button";
        b.addEventListener("click", ctx.openSettings);
        box.append(b);
      }
      body.replaceChildren(box);
      shownData = null;
    }

    // Rebuilt only when something it shows would change: a new forecast,
    // another size, an old-forecast note, or the hour moving on.
    function render() {
      if (!data) return;
      const upcoming = upcomingHours();
      const key = [ctx.size.w, ctx.size.h, note, upcoming[0]?.startTime].join("|");
      if (data === shownData && key === shownKey) return;
      shownData = data;
      shownKey = key;

      Tip.hide();
      const shape = layout();
      const days = toDays(data.daily);
      const parts = [nowRow(days, upcoming, shape.badge)];
      if (shape.hours === "few") {
        if (data.alerts.length) parts.push(alertBadge());
        parts.push(fewHours(upcoming));
      }
      if (shape.hours === "strip") parts.push(hourStrip(upcoming));
      if (shape.week) parts.push(weekGraph(days));
      body.replaceChildren(...parts);
      body.classList.toggle("stale", !!note);
      body.title = note ?? "";
    }

    async function update(force = false) {
      if (!zip) return message("Add your ZIP code in Pane settings to see the weather.", true);
      const mine = WD.cached(zip);
      if (mine && mine !== data) {
        data = mine;
        render();
      }
      if (!force && !WD.isStale(mine)) return;
      try {
        await WD.download(zip); // shown through onUpdate
        note = null;
      } catch (err) {
        console.error("Weather update failed", err);
        if (data) {
          note = "Couldn't update the weather; showing the last forecast.";
          render();
        } else {
          message(err.message?.startsWith("ZIP code") ? err.message : "Couldn't reach weather.gov. It'll try again soon.");
        }
      }
    }

    // A new forecast, from this widget or any other.
    ctx.onDestroy(
      WD.onUpdate((fresh) => {
        if (fresh.zip !== zip) return;
        data = fresh;
        note = null;
        render();
      }),
    );

    // Every few minutes while in view: refresh if due, otherwise re-render so
    // "now" and the hours move along as time passes.
    ctx.every(CHECK_EVERY, () => (data && !WD.isStale(data) ? render() : update()));
    update();

    return {
      resized: render,
      settingsChanged(s) {
        if (s.zip === zip) return;
        zip = s.zip;
        data = null;
        update(true); // the cache belongs to one ZIP code, so a new one always downloads
      },
    };
  },
});
