// US holidays and observances, worked out for any year.
// Holidays.on("2026-11-26") -> ["Thanksgiving"] (or [] if none).
window.Holidays = (() => {
  const pad = (n) => String(n).padStart(2, "0");
  const key = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`; // m is 0-based

  // The nth `weekday` (0 = Sunday) of a month; n = -1 for the last one.
  function nthWeekday(y, m, weekday, n) {
    if (n > 0) {
      const first = new Date(y, m, 1).getDay();
      return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    }
    const lastDate = new Date(y, m + 1, 0).getDate();
    const last = new Date(y, m, lastDate).getDay();
    return lastDate - ((last - weekday + 7) % 7);
  }

  // Western (Gregorian) Easter Sunday: the "anonymous Gregorian" algorithm.
  function easter(y) {
    const a = y % 19;
    const b = Math.floor(y / 100);
    const c = y % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31) - 1; // 0-based
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, month, day);
  }

  const cache = new Map(); // year -> Map(dateKey -> [names])

  function forYear(y) {
    if (cache.has(y)) return cache.get(y);
    const map = new Map();
    const add = (m, d, name) => {
      const k = key(y, m, d);
      map.set(k, [...(map.get(k) ?? []), name]);
    };
    const JAN = 0, FEB = 1, MAR = 2, MAY = 4, JUN = 5, JUL = 6, SEP = 8, OCT = 9, NOV = 10, DEC = 11;
    const SUN = 0, MON = 1, THU = 4;

    add(JAN, 1, "New Year's Day");
    add(FEB, nthWeekday(y, FEB, MON, 3), "Presidents' Day");
    add(MAR, 17, "St. Patrick's Day");
    const e = easter(y);
    const palmSunday = new Date(y, e.getMonth(), e.getDate() - 7);
    add(palmSunday.getMonth(), palmSunday.getDate(), "Palm Sunday");
    const goodFriday = new Date(y, e.getMonth(), e.getDate() - 2);
    add(goodFriday.getMonth(), goodFriday.getDate(), "Good Friday");
    add(e.getMonth(), e.getDate(), "Easter");
    add(MAY, nthWeekday(y, MAY, SUN, 2), "Mother's Day");
    add(MAY, nthWeekday(y, MAY, MON, -1), "Memorial Day");
    add(JUN, nthWeekday(y, JUN, SUN, 3), "Father's Day");
    add(JUL, 4, "Independence Day");
    add(SEP, nthWeekday(y, SEP, MON, 1), "Labor Day");
    add(OCT, nthWeekday(y, OCT, MON, 2), "Columbus Day");
    // Halloween and All Hallows' Eve are the same day.
    add(OCT, 31, "Halloween (All Hallows' Eve)");
    add(NOV, 11, "Veterans Day");
    add(NOV, nthWeekday(y, NOV, THU, 4), "Thanksgiving");
    add(DEC, 24, "Christmas Eve");
    add(DEC, 25, "Christmas");
    add(DEC, 31, "New Year's Eve");

    cache.set(y, map);
    return map;
  }

  function on(dateKey) {
    return forYear(Number(dateKey.slice(0, 4))).get(dateKey) ?? [];
  }

  return { on, key };
})();
