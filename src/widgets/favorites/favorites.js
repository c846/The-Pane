// Favorites: your favorite apps as tiles, one per cell of the widget. With
// more favorites than fit, the last tile becomes "N more", listing the rest;
// while in view it shows one of those others at a time, swapping every few
// seconds (just for show: clicking it opens the list).
// Right-click any app for its options (add to / remove from favorites, …).
Widgets.define({
  kind: "favorites",
  name: "Favorites",
  description: "Your favorite apps. Right-click any app to add it.",
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
    const ROTATE_MS = 4000;
    const SWAP_MS = 650;

    const tiles = el("div", "app-tiles");
    body.append(el("h3", "group-label", "Favorites"), tiles);

    let favorites = [];
    let carousel = null; // { box, apps, current } for the "more" tile

    function carouselIcon(app) {
      const img = el("img", "tile-icon more-icon");
      img.alt = "";
      window.Icons.show(img, app.id, true);
      return img;
    }

    // Slide a different favorite in; the current one slides out the
    // opposite way, in a random direction.
    function rotate() {
      if (!carousel?.box.isConnected || carousel.apps.length < 2) return;
      let next = Math.floor(Math.random() * (carousel.apps.length - 1));
      if (next >= carousel.current) next++;
      carousel.current = next;

      const [x, y] = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)];
      const away = `${x * 100}% ${y * 100}%`;
      const from = `${-x * 100}% ${-y * 100}%`;
      const timing = { duration: SWAP_MS, easing: "cubic-bezier(0.65, 0, 0.35, 1)" };

      for (const icon of carousel.box.querySelectorAll(".more-icon")) {
        icon
          .animate([{ translate: "0 0", opacity: 1 }, { translate: away, opacity: 0 }], { ...timing, fill: "forwards" })
          .finished.then(() => icon.remove(), () => icon.remove());
      }
      const icon = carouselIcon(carousel.apps[next]);
      carousel.box.append(icon);
      icon.animate([{ translate: from, opacity: 0 }, { translate: "0 0", opacity: 1 }], timing);
    }

    // The "more" tile: opens a menu with the favorites that don't fit.
    function moreTile(rest) {
      const tile = el("button", "tile glass more-tile");
      tile.type = "button";
      tile.title = `${rest.length} more favorite${rest.length === 1 ? "" : "s"}`;
      tile.setAttribute("aria-haspopup", "menu");
      tile.setAttribute("aria-expanded", "false");
      const box = el("span", "more-carousel");
      box.setAttribute("aria-hidden", "true");
      const current = Math.floor(Math.random() * rest.length);
      box.append(carouselIcon(rest[current]));
      tile.append(box, el("span", "tile-label", `${rest.length} more`));
      carousel = { box, apps: rest, current };

      tile.addEventListener("click", (e) => {
        const items = rest.map((app) => ({
          label: app.name,
          icon: app.id,
          action: () => AppLists.launch(app),
          onContext: (ev) => window.Menu.open({ x: ev.clientX, y: ev.clientY }, AppLists.menuFor(app)),
        }));
        // e.detail is 0 when "clicked" with the keyboard.
        window.Menu.open({ anchor: tile, keyboard: e.detail === 0 }, items);
      });
      return tile;
    }

    function render() {
      const { w, h } = ctx.size;
      const slots = w * h;
      tiles.style.gridTemplateColumns = `repeat(${w}, minmax(0, 1fr))`;
      tiles.style.gridTemplateRows = `repeat(${h}, minmax(0, 1fr))`;
      carousel = null;
      if (!favorites.length) {
        tiles.replaceChildren(el("p", "widget-message app-tiles-message", "Right-click an app to add it to your favorites."));
        return;
      }
      // With more than fit, the last slot becomes "N more".
      const overflow = favorites.length > slots;
      const shown = overflow ? slots - 1 : slots;
      const list = favorites.slice(0, shown).map((app) => AppLists.tile(app, AppLists.menuFor));
      if (overflow) list.push(moreTile(favorites.slice(shown)));
      while (list.length < slots) {
        const empty = el("div", "tile tile-empty");
        empty.setAttribute("aria-hidden", "true");
        list.push(empty);
      }
      tiles.replaceChildren(...list);
    }

    ctx.onDestroy(
      AppLists.onChange((lists) => {
        favorites = lists.favorites;
        render();
      }),
    );
    ctx.every(ROTATE_MS, rotate);
    render();

    return { resized: render };
  },
});
