// Date: the time, and today's date. Bigger sizes spell more of it out.
// Ticks once a minute (on the minute) while in view.
Widgets.define({
  kind: "date",
  name: "Date",
  description: "The time and today's date.",
  sizes: [
    [2, 1],
    [1, 1],
    [3, 1],
    [3, 2],
  ],

  create(body, ctx) {
    const { el } = Widgets;
    const time = el("div", "date-time");
    const day = el("div", "date-day");
    body.append(time, day);

    let timer = null;

    function render() {
      const now = new Date();
      time.textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const { w, h } = ctx.size;
      // 1x1: "Wed 27"; wider: "Wednesday, November 27"; 3x2 adds the year.
      const format =
        w === 1
          ? { weekday: "short", day: "numeric" }
          : h > 1
            ? { weekday: "long", month: "long", day: "numeric", year: "numeric" }
            : { weekday: w > 2 ? "long" : "short", month: w > 2 ? "long" : "short", day: "numeric" };
      day.textContent = now.toLocaleDateString([], format);
      body.title = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    }

    // On the next whole minute, then every minute.
    function start() {
      stop();
      render();
      const tick = () => {
        render();
        timer = setTimeout(tick, 60000 - (Date.now() % 60000));
      };
      timer = setTimeout(tick, 60000 - (Date.now() % 60000));
    }

    function stop() {
      clearTimeout(timer);
      timer = null;
    }

    if (ctx.visible) start();
    else render();

    return { resized: render, shown: start, hidden: stop, destroy: stop };
  },
});
