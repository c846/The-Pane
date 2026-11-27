// Weather data from weather.gov, shared by every weather widget (in the pane
// and on the desktop).
//
// The forecast is cached in localStorage. Both windows share it, so when
// any widget downloads a new forecast, every other one hears about it
// through onUpdate and shows it without downloading again.
//
//   WeatherData.cached(zip)    the cached forecast for that ZIP code, or null
//   WeatherData.download(zip)  download a fresh forecast (and cache it); a
//                              download already under way is shared
//   WeatherData.isStale(data)  older than REFRESH_AFTER?
//   WeatherData.onUpdate(fn)   fn(data) whenever a new forecast is cached, in
//                              this window or the other; returns an unsubscribe
//   WeatherData.iconUrl(text, isDay)  CSS url() of the icon for a forecast
window.WeatherData = (() => {
  const { invoke } = window.__TAURI__.core;

  const API = "https://api.weather.gov";
  const REFRESH_AFTER = 30 * 60 * 1000;
  const CACHE_KEY = "weather-cache";
  const POINT_KEY = "weather-point";
  // Absolute, so icons work from pages in any folder.
  const ICONS = new URL("../icons/", document.currentScript.src).href;

  const readStore = (k) => {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch {
      return null;
    }
  };
  const writeStore = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  async function getJson(url) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { Accept: "application/geo+json" } });
      if (res.ok) return res.json();
      // weather.gov has occasional hiccups; one retry usually fixes them.
      if (res.status >= 500 && attempt === 0) continue;
      throw new Error(`weather.gov answered ${res.status}`);
    }
  }

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

  const listeners = new Set();
  const inFlight = new Map(); // zip -> Promise

  function download(zip) {
    if (!inFlight.has(zip)) {
      const p = fetchForecast(zip)
        .then((data) => {
          for (const fn of listeners) fn(data);
          return data;
        })
        .finally(() => inFlight.delete(zip));
      inFlight.set(zip, p);
    }
    return inFlight.get(zip);
  }

  async function fetchForecast(zip) {
    const point = await pointFor(zip);
    const [daily, hourly, alerts] = await Promise.all([
      getJson(point.forecast),
      getJson(point.hourly),
      // Alerts are a bonus; don't fail the whole forecast over them.
      getJson(`${API}/alerts/active?point=${point.lat.toFixed(4)},${point.lon.toFixed(4)}`).catch(() => null),
    ]);
    const data = {
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
    writeStore(CACHE_KEY, data);
    return data;
  }

  function cached(zip) {
    const data = readStore(CACHE_KEY);
    return data && (zip == null || data.zip === zip) ? data : null;
  }

  const isStale = (data) => !data || Date.now() - data.at >= REFRESH_AFTER;

  function onUpdate(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // The other window cached a new forecast.
  window.addEventListener("storage", (e) => {
    if (e.key !== CACHE_KEY || !e.newValue) return;
    let data;
    try {
      data = JSON.parse(e.newValue);
    } catch {
      return;
    }
    for (const fn of listeners) fn(data);
  });

  // Pick one of the icons in the icons folder from weather.gov's description,
  // e.g. "Chance Rain Showers then Mostly Cloudy" -> rainy.
  function iconUrl(text, isDay) {
    const t = (text ?? "").toLowerCase().split(" then ")[0];
    const time = isDay ? "day" : "night";
    let name;
    if (/thunder|t-storm/.test(t)) name = "thunderstorm";
    else if (/snow|sleet|flurr|blizzard|ice|freezing|wintry/.test(t)) name = "snowy";
    else if (/rain|shower|drizzle/.test(t)) name = "rainy";
    else if (/fog|haze|smoke|dust|mist|ash/.test(t)) name = "smoggy";
    else if (/cloud|overcast|partly/.test(t)) name = `cloudy-${time}`;
    else name = `clear-${time}`;
    return `url("${ICONS}${name}.png")`;
  }

  return { REFRESH_AFTER, cached, download, isStale, onUpdate, iconUrl };
})();
