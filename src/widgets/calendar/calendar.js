// Calendar: a month at a time. ‹ › (or the mouse wheel) change month;
// clicking the title goes back to today. Holidays and your own events show
// as small squares under the date; hover the date to see them. Right-click
// a date to add an event (in the pane, which can take typing) or remove
// one. Changing month slides the old one out and the new one in.
//
// Events are kept by the backend, which tells every window when they change.
Widgets.define({
  kind: "calendar",
  name: "Calendar",
  description: "The month, with holidays and your own events.",
  sizes: [
    [3, 3],
    [2, 2],
    [4, 3],
    [3, 4],
    [4, 4],
  ],

  create(body, ctx) {
    const { invoke } = window.__TAURI__.core;
    const { el } = Widgets;
    const Tip = window.Tooltip;
    const key = window.Holidays.key;

    const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const SLIDE_MS = 320;
    const SLIDE_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

    // Header: ‹ Month Year ›
    const header = el("div", "cal-header");
    const title = el("button", "cal-title");
    title.type = "button";
    title.title = "Back to today";
    const arrow = (label, points) => {
      const b = el("button", "cal-arrow");
      b.type = "button";
      b.title = label;
      b.setAttribute("aria-label", label);
      b.innerHTML = `<svg class="chevron" viewBox="0 0 12 12" aria-hidden="true"><polyline points="${points}" /></svg>`;
      return b;
    };
    const prev = arrow("Previous month", "8,2 4,6 8,10");
    const next = arrow("Next month", "4,2 8,6 4,10");
    header.append(prev, title, next);

    // Weekday names stay put; the weeks below them ("pages", one per month)
    // slide.
    const grid = el("div", "cal-grid");
    const weekdays = el("div", "cal-weekdays");
    weekdays.setAttribute("aria-hidden", "true");
    weekdays.append(...WEEKDAYS.map((d) => el("div", "cal-weekday", d.slice(0, 2))));
    const pages = el("div", "cal-pages");
    grid.append(weekdays, pages);
    body.append(header, grid);

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

      // Always 6 weeks, starting on the Sunday on or before the 1st, so the
      // calendar keeps the same height every month.
      const cells = [];
      const start = new Date(view.y, view.m, 1 - first.getDay());
      for (let i = 0; i < 42; i++) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const k = key(date.getFullYear(), date.getMonth(), date.getDate());
        const holidays = window.Holidays.on(k);
        const mine = eventsOn(k);

        const cell = el("div", "cal-day");
        if (date.getMonth() !== view.m) cell.classList.add("other-month");
        if (k === todayKey) cell.classList.add("today");
        cell.setAttribute("aria-label", [longDate(date), ...holidays, ...mine.map((e) => e.title)].join(", "));

        const marks = el("span", "cal-marks");
        marks.setAttribute("aria-hidden", "true");
        for (const _ of holidays) marks.append(el("span", "cal-mark"));
        for (const _ of mine) marks.append(el("span", "cal-mark"));
        cell.append(el("span", "cal-num", date.getDate()), marks);

        if (holidays.length || mine.length) {
          cell.tabIndex = 0;
          Tip.attach(cell, () =>
            Tip.content(longDate(date), [...holidays, ...mine.map((e) => (e.yearly ? `${e.title} (every year)` : e.title))]),
          );
        }
        cell.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          Tip.hide();
          const items = mine.map((ev) => ({ label: `Remove “${ev.title}”`, action: () => removeEvent(ev.id) }));
          // Typing a name needs the keyboard, which only the pane can take.
          if (ctx.canType) items.unshift({ label: "Add event…", action: () => addEvent(date) });
          if (items.length) window.Menu.open({ x: e.clientX, y: e.clientY }, items);
        });
        cells.push(cell);
      }
      const page = el("div", "cal-page");
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

    async function addEvent(date) {
      const answer = await askForEvent(date);
      if (!answer) return;
      try {
        await invoke("add_event", {
          date: key(date.getFullYear(), date.getMonth(), date.getDate()),
          title: answer.title,
          yearly: answer.yearly,
        });
      } catch (err) {
        console.error("Could not add event", err);
      }
    }

    async function removeEvent(id) {
      try {
        await invoke("remove_event", { id });
      } catch (err) {
        console.error("Could not remove event", err);
      }
    }

    // ---- Controls ------------------------------------------------------------------

    prev.addEventListener("click", () => move(-1));
    next.addEventListener("click", () => move(1));
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

    // Added or removed anywhere (the backend tells every window).
    ctx.listen("events-changed", loadEvents);
    // Keep "today" right past midnight while it stays in view (the desktop).
    ctx.every(10 * 60 * 1000, () => render());
    loadEvents();

    return {
      // Back to this month each time it comes into view (and today may
      // have changed).
      shown: () => goToToday(false),
    };
  },
});

// The "New event" dialog, shared by every calendar in the window (only ever
// opened in the pane). Resolves to { title, yearly }, or null if cancelled.
function askForEvent(date) {
  let dialog = document.getElementById("event-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "event-dialog";
    dialog.className = "settings-dialog";
    dialog.setAttribute("aria-labelledby", "event-dialog-title");
    dialog.innerHTML = `
      <form method="dialog" class="settings-form">
        <div>
          <h2 id="event-dialog-title" class="settings-title">New event</h2>
          <p class="dialog-subtitle" data-date></p>
        </div>
        <section class="settings-section">
          <input class="text-input wide" type="text" maxlength="100" autocomplete="off" placeholder="Event name" aria-label="Event name" required data-title />
          <label class="switch"><span>Repeat every year</span><input type="checkbox" role="switch" data-yearly /></label>
        </section>
        <div class="settings-actions">
          <button class="button glass" type="submit" value="cancel" formnovalidate>Cancel</button>
          <button class="button glass" type="submit" value="add">Add</button>
        </div>
      </form>`;
    // Clicking the dimmed area around the dialog cancels it.
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
    document.body.append(dialog);
  }
  const titleInput = dialog.querySelector("[data-title]");
  const yearly = dialog.querySelector("[data-yearly]");
  dialog.querySelector("[data-date]").textContent = date.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  titleInput.value = "";
  yearly.checked = false;
  dialog.returnValue = ""; // otherwise Escape would reuse the last button's value
  dialog.showModal();
  titleInput.focus();
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        const title = titleInput.value.trim();
        resolve(dialog.returnValue === "add" && title ? { title, yearly: yearly.checked } : null);
      },
      { once: true },
    );
  });
}
