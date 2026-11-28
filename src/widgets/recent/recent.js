// Recently used apps: the apps you last launched from The Pane, newest
// first, one per cell of the widget. Right-click one for its options
// (including "Remove from recent").
Widgets.define({
  kind: "recent",
  name: "Recently used apps",
  description: "The apps you launched last.",
  sizes: [
    [3, 1],
    [2, 1],
    [1, 1],
    [4, 1],
    [6, 1],
    [3, 2],
  ],

  create(body, ctx) {
    const { el } = Widgets;
    const tiles = el("div", "app-tiles");
    body.append(el("h3", "group-label", "Recently used apps"), tiles);

    let recent = [];

    function render() {
      const { w, h } = ctx.size;
      const slots = w * h;
      tiles.style.gridTemplateColumns = `repeat(${w}, minmax(0, 1fr))`;
      tiles.style.gridTemplateRows = `repeat(${h}, minmax(0, 1fr))`;
      if (!recent.length) {
        tiles.replaceChildren(el("p", "widget-message app-tiles-message", "Apps you open from The Pane show up here."));
        return;
      }
      const list = recent.slice(0, slots).map((app) => AppLists.tile(app, AppLists.recentMenu));
      while (list.length < slots) {
        const empty = el("div", "tile tile-empty");
        empty.setAttribute("aria-hidden", "true");
        list.push(empty);
      }
      tiles.replaceChildren(...list);
    }

    ctx.onDestroy(
      AppLists.onChange((lists) => {
        recent = lists.recent;
        render();
      }),
    );
    render();

    return { resized: render };
  },
});
