// Calendar (right side of the top-right quadrant).
//
// Shows a month; ‹ › (or the mouse wheel) change month, clicking the title
// goes back to today. Holidays and your own events show as small squares
// under the date; hover the date to see them. Right-click a date to add an
// event or remove one. Changing month slides the old one out and the new
// one in.
window.CalendarPanel = (() => {
  const { invoke } = window.__TAURI__.core;
  const $ = (id) => document.getElementById(id);

  const panel = $("calendar");
  const title = $("cal-title");
  const grid = $("cal-grid");
  const dialog = $("event-dialog");
  const eventTitle = $("event-title");
  const eventDate = $("event-date");
  const eventYearly = $("event-yearly");

  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const SLIDE_MS = 320;
  const SLIDE_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

  // Weekday names stay put; the weeks below them ("pages", one per month)
  // slide.
  const weekdays = document.createElement("div");
  weekdays.className = "cal-weekdays";
  weekdays.setAttribute("aria-hidden", "true");
  weekdays.append(
    ...WEEKDAYS.map((d) => Object.assign(document.createElement("div"), { className: "cal-weekday", textContent: d.slice(0, 2) })),
  );
  const pages = document.createElement("div");
  pages.className = "cal-pages";
  grid.append(weekdays, pages);
  const key = window.Holidays.key;

  const today = () => new Date();
  let view = { y: today().getFullYear(), m: today().getMonth() };
  let events = [];

  // Your events on a date, including yearly ones from other years.
  function eventsOn(k) {
    return events.filter((e) => e.date === k || (e.yearly && e.date.slice(5) === k.slice(5) && e.date <= k));
  }

  const longDate = (d) => d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  // dir: 1 = moved forward (new month slides in from the right), -1 = back,
  // 0 = no slide.
  function render(dir = 0) {
    const now = today();
    const todayKey = key(now.getFullYear(), now.getMonth(), now.getDate());
    const first = new Date(view.y, view.m, 1);
    title.textContent = first.toLocaleDateString([], { month: "long", year: "numeric" });

    const cells = [];

    // Always 6 weeks, starting on the Sunday on or before the 1st, so the
    // calendar keeps the same height every month.
    const start = new Date(view.y, view.m, 1 - first.getDay());
    for (let i = 0; i < 42; i++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const k = key(date.getFullYear(), date.getMonth(), date.getDate());
      const holidays = window.Holidays.on(k);
      const mine = eventsOn(k);

      const cell = document.createElement("div");
      cell.className = "cal-day";
      if (date.getMonth() !== view.m) cell.classList.add("other-month");
      if (k === todayKey) cell.classList.add("today");
      cell.setAttribute("aria-label", [longDate(date), ...holidays, ...mine.map((e) => e.title)].join(", "));

      const num = document.createElement("span");
      num.className = "cal-num";
      num.textContent = date.getDate();
      const marks = document.createElement("span");
      marks.className = "cal-marks";
      marks.setAttribute("aria-hidden", "true");
      for (const _ of holidays) marks.append(Object.assign(document.createElement("span"), { className: "cal-mark holiday" }));
      for (const _ of mine) marks.append(Object.assign(document.createElement("span"), { className: "cal-mark event" }));
      cell.append(num, marks);

      if (holidays.length || mine.length) {
        cell.tabIndex = 0;
        window.Tooltip.attach(cell, () =>
          window.Tooltip.content(longDate(date), [
            ...holidays,
            ...mine.map((e) => (e.yearly ? `${e.title} (every year)` : e.title)),
          ]),
        );
      }
      cell.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        window.Tooltip.hide();
        window.Menu.open({ x: e.clientX, y: e.clientY }, [
          { label: "Add event…", action: () => openEventDialog(date) },
          ...mine.map((ev) => ({ label: `Remove “${ev.title}”`, action: () => removeEvent(ev.id) })),
        ]);
      });
      cells.push(cell);
    }
    const page = document.createElement("div");
    page.className = "cal-page";
    page.append(...cells);
    showPage(page, dir);
  }

  function showPage(page, dir) {
    const old = [...pages.querySelectorAll(".cal-page:not(.leaving)")];
    pages.append(page);
    if (!dir) {
      for (const p of old) p.remove();
      return;
    }
    const timing = { duration: SLIDE_MS, easing: SLIDE_EASE };
    for (const p of old) {
      p.classList.add("leaving");
      p.animate([{ translate: "0 0", opacity: 1 }, { translate: `${-dir * 100}% 0`, opacity: 0 }], { ...timing, fill: "forwards" })
        .finished.then(() => p.remove(), () => p.remove());
    }
    page.animate([{ translate: `${dir * 100}% 0`, opacity: 0 }, { translate: "0 0", opacity: 1 }], timing);
    title.animate([{ translate: `${dir * 16}px 0`, opacity: 0 }, { translate: "0 0", opacity: 1 }], timing);
  }

  function move(months) {
    const d = new Date(view.y, view.m + months, 1);
    view = { y: d.getFullYear(), m: d.getMonth() };
    render(Math.sign(months));
  }

  // Back to this month (sliding there, unless `slide` is false).
  function goToToday(slide = true) {
    const now = { y: today().getFullYear(), m: today().getMonth() };
    const dir = Math.sign(now.y * 12 + now.m - (view.y * 12 + view.m));
    view = now;
    render(slide ? dir : 0);
  }

  // ---- Events --------------------------------------------------------------------

  async function loadEvents() {
    try {
      events = await invoke("get_events");
    } catch (err) {
      console.error("Could not load events", err);
    }
    render();
  }

  let dialogDate = null;
  function openEventDialog(date) {
    dialogDate = date;
    eventDate.textContent = longDate(date);
    eventTitle.value = "";
    eventYearly.checked = false;
    dialog.returnValue = ""; // otherwise Escape would reuse the last button's value
    dialog.showModal();
    eventTitle.focus();
  }

  dialog.addEventListener("close", async () => {
    if (dialog.returnValue !== "add") return;
    const name = eventTitle.value.trim();
    if (!name || !dialogDate) return;
    try {
      await invoke("add_event", {
        date: key(dialogDate.getFullYear(), dialogDate.getMonth(), dialogDate.getDate()),
        title: name,
        yearly: eventYearly.checked,
      });
    } catch (err) {
      console.error("Could not add event", err);
    }
    loadEvents();
  });

  // Clicking the dimmed area around the dialog cancels it.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  async function removeEvent(id) {
    try {
      await invoke("remove_event", { id });
    } catch (err) {
      console.error("Could not remove event", err);
    }
    loadEvents();
  }

  // ---- Controls ------------------------------------------------------------------

  $("cal-prev").addEventListener("click", () => move(-1));
  $("cal-next").addEventListener("click", () => move(1));
  title.addEventListener("click", () => goToToday());
  // Mouse wheel changes month (one month per notch, even on touchpads).
  let lastWheel = 0;
  grid.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (e.timeStamp - lastWheel < 200 || Math.abs(e.deltaY) < 4) return;
      lastWheel = e.timeStamp;
      move(e.deltaY > 0 ? 1 : -1);
    },
    { passive: false },
  );

  window.PaneSettings.onChange((s) => {
    panel.hidden = !s.panels.calendar;
  });

  loadEvents();

  return {
    // Each time the pane opens: back to this month (and today may have changed).
    refresh: () => goToToday(false),
  };
})();
