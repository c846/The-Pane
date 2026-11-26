// Top-left quadrant: recently used apps and favorite apps.
//
// Recent: the last 3 apps launched from The Pane (6 when there are no favorites).
// Favorites: up to 3 tiles; with 4 or more, the first 2 then a "more" tile
// listing the rest. Hidden when there are none. While the pane is open, the
// "more" tile shows one of those other favorites, swapping to another
// every few seconds (just for show: clicking it opens the list).
// Right-click any app (here or in search results) for its options.
window.AppsPanel = (() => {
  const { invoke } = window.__TAURI__.core;
  const recentRow = document.getElementById("recent-apps");
  const favoritesRow = document.getElementById("favorite-apps");
  const favoritesGroup = favoritesRow.closest(".app-group");

  const RECENT_SHOWN = 3;
  const FAVORITE_SLOTS = 3;
  const ROTATE_MS = 4000;
  const SWAP_MS = 650;

  let recent = [];
  let favorites = [];

  async function refresh() {
    try {
      ({ recent, favorites } = await invoke("app_lists"));
    } catch (err) {
      console.error("Could not load recent and favorite apps", err);
    }
    render();
  }

  async function change(command, args) {
    try {
      await invoke(command, args);
    } catch (err) {
      console.error(command, err);
    }
    await refresh();
  }

  const setFavorite = (id, favorite) => change("set_favorite", { id, favorite });

  function launch(app) {
    invoke("launch_app", { id: app.id }).catch((err) => console.error("Could not launch", app.name, err));
  }

  // ---- Menus -------------------------------------------------------------------

  // Right-click options for any app (also used by search results).
  function menuFor(app) {
    const items = [{ label: "Open", action: () => launch(app) }, { separator: true }];
    const index = favorites.findIndex((a) => a.id === app.id);
    if (index === -1) {
      items.push({ label: "Add to favorites", action: () => setFavorite(app.id, true) });
    } else {
      if (index > 0) {
        items.push({ label: "Move to front", action: () => change("move_favorite", { id: app.id, index: 0 }) });
      }
      items.push({ label: "Remove from favorites", action: () => setFavorite(app.id, false) });
    }
    return items;
  }

  function recentMenu(app) {
    return [...menuFor(app), { label: "Remove from recent", action: () => change("forget_recent", { id: app.id }) }];
  }

  const openAt = (e, items) => {
    e.preventDefault();
    window.Menu.open({ x: e.clientX, y: e.clientY }, items);
  };

  // ---- Tiles -------------------------------------------------------------------

  function appTile(app, menu) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile glass app-tile";
    tile.title = app.name;

    const icon = document.createElement("img");
    icon.className = "tile-icon";
    icon.alt = "";
    window.Icons.show(icon, app.id, true);

    const label = document.createElement("span");
    label.className = "tile-label";
    label.textContent = app.name;

    tile.append(icon, label);
    tile.addEventListener("click", () => launch(app));
    tile.addEventListener("contextmenu", (e) => openAt(e, menu(app)));
    return tile;
  }

  // An unused slot: invisible, but keeps the grid in shape.
  function emptyTile() {
    const tile = document.createElement("div");
    tile.className = "tile tile-empty";
    tile.setAttribute("aria-hidden", "true");
    return tile;
  }

  // ---- The "more" tile -------------------------------------------------------------

  let carousel = null; // { box, apps, current } for the "more" tile on show
  let rotateTimer = null;

  function carouselIcon(app) {
    const img = document.createElement("img");
    img.className = "tile-icon more-icon";
    img.alt = "";
    window.Icons.show(img, app.id, true);
    return img;
  }

  // Slide a different favorite in; the current one slides out the opposite
  // way, in a random direction.
  function rotate() {
    if (!carousel?.box.isConnected || carousel.apps.length < 2) return;
    let next = Math.floor(Math.random() * (carousel.apps.length - 1));
    if (next >= carousel.current) next++;
    carousel.current = next;

    const [x, y] = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)];
    const away = `${x * 100}% ${y * 100}%`;
    const from = `${-x * 100}% ${-y * 100}%`;
    const timing = { duration: SWAP_MS, easing: "cubic-bezier(0.65, 0, 0.35, 1)" };

    const old = carousel.box.querySelectorAll(".more-icon");
    for (const icon of old) {
      icon.animate([{ translate: "0 0", opacity: 1 }, { translate: away, opacity: 0 }], { ...timing, fill: "forwards" })
        .finished.then(() => icon.remove(), () => icon.remove());
    }
    const icon = carouselIcon(carousel.apps[next]);
    carousel.box.append(icon);
    icon.animate([{ translate: from, opacity: 0 }, { translate: "0 0", opacity: 1 }], timing);
  }

  // Swap favorites only while the pane is open.
  function start() {
    stop();
    rotateTimer = setInterval(rotate, ROTATE_MS);
  }

  function stop() {
    clearInterval(rotateTimer);
    rotateTimer = null;
  }

  // The "more" tile: opens a menu with the favorites that don't fit.
  function moreTile(rest) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile glass more-tile";
    tile.title = `${rest.length} more favorite${rest.length === 1 ? "" : "s"}`;
    tile.setAttribute("aria-haspopup", "menu");
    tile.setAttribute("aria-expanded", "false");
    tile.innerHTML = `
      <span class="more-carousel" aria-hidden="true"></span>
      <span class="tile-label">${rest.length} more</span>`;

    const box = tile.querySelector(".more-carousel");
    const current = Math.floor(Math.random() * rest.length);
    box.append(carouselIcon(rest[current]));
    carousel = { box, apps: rest, current };

    tile.addEventListener("click", (e) => {
      const items = rest.map((app) => ({
        label: app.name,
        icon: app.id,
        action: () => launch(app),
        onContext: (ev) => openAt(ev, menuFor(app)),
      }));
      // e.detail is 0 when "clicked" with the keyboard.
      window.Menu.open({ anchor: tile, keyboard: e.detail === 0 }, items);
    });
    return tile;
  }

  function render() {
    // With no favorites, their section is hidden and recent apps take its row too.
    const noFavorites = favorites.length === 0;
    favoritesGroup.hidden = noFavorites;
    const recentShown = noFavorites ? RECENT_SHOWN * 2 : RECENT_SHOWN;

    const recentTiles = recent.slice(0, recentShown).map((app) => appTile(app, recentMenu));
    while (recentTiles.length < recentShown) recentTiles.push(emptyTile());
    recentRow.replaceChildren(...recentTiles);
    if (noFavorites) {
      favoritesRow.replaceChildren();
      return;
    }

    // Up to 3 favorites fit as tiles; with 4 or more, the third slot becomes "…".
    const overflow = favorites.length > FAVORITE_SLOTS;
    const shown = overflow ? FAVORITE_SLOTS - 1 : FAVORITE_SLOTS;
    const favoriteTiles = favorites.slice(0, shown).map((app) => appTile(app, menuFor));
    if (overflow) favoriteTiles.push(moreTile(favorites.slice(shown)));
    while (favoriteTiles.length < FAVORITE_SLOTS) favoriteTiles.push(emptyTile());
    favoritesRow.replaceChildren(...favoriteTiles);
  }

  refresh();

  return { refresh, menuFor, start, stop };
})();
