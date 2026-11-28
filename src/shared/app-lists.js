// Recently used and favorite apps, shared by the Recent and Favorites
// widgets (on either surface) and the pane's search results.
//
//   AppLists.get()         { recent, favorites } (apps, newest/first first)
//   AppLists.onChange(fn)  fn({ recent, favorites }) on every change, and
//                          right away if they've loaded; returns an unsubscribe
//   AppLists.launch(app)
//   AppLists.menuFor(app)  right-click options for any app
//   AppLists.recentMenu(app)  …plus "Remove from recent"
//
// The backend says when the lists change ("apps-changed"), from any window.
window.AppLists = (() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  let lists = null;
  const listeners = new Set();

  async function refresh() {
    try {
      lists = await invoke("app_lists");
    } catch (err) {
      console.error("Could not load recent and favorite apps", err);
      lists = lists ?? { recent: [], favorites: [] };
    }
    for (const fn of listeners) fn(lists);
  }

  function onChange(fn) {
    listeners.add(fn);
    if (lists) fn(lists);
    return () => listeners.delete(fn);
  }

  const change = (command, args) => invoke(command, args).catch((err) => console.error(command, err));

  function launch(app) {
    invoke("launch_app", { id: app.id }).catch((err) => console.error("Could not launch", app.name, err));
  }

  function menuFor(app) {
    const favorites = lists?.favorites ?? [];
    const items = [{ label: "Open", action: () => launch(app) }, { separator: true }];
    const index = favorites.findIndex((a) => a.id === app.id);
    if (index === -1) {
      items.push({ label: "Add to favorites", action: () => change("set_favorite", { id: app.id, favorite: true }) });
    } else {
      if (index > 0) {
        items.push({ label: "Move to front", action: () => change("move_favorite", { id: app.id, index: 0 }) });
      }
      items.push({ label: "Remove from favorites", action: () => change("set_favorite", { id: app.id, favorite: false }) });
    }
    return items;
  }

  function recentMenu(app) {
    return [...menuFor(app), { label: "Remove from recent", action: () => change("forget_recent", { id: app.id }) }];
  }

  listen("apps-changed", refresh);
  refresh();

  return { get: () => lists, onChange, refresh, launch, menuFor, recentMenu };
})();

// An app's tile: its icon over its name. Click to launch; right-click for
// `menu(app)`'s options.
window.AppLists.tile = (app, menu) => {
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
  tile.addEventListener("click", () => window.AppLists.launch(app));
  tile.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    window.Menu.open({ x: e.clientX, y: e.clientY }, menu(app));
  });
  return tile;
};
