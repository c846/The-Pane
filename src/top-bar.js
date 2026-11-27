// The Settings and Power buttons, left of the search bar. Like the search
// bar, they belong to the pane itself (they aren't widgets).
(() => {
  const { invoke } = window.__TAURI__.core;

  // One Settings button for both The Pane's settings and Windows Settings.
  const settings = document.getElementById("settings-button");
  settings.addEventListener("click", (e) => {
    // e.detail is 0 when "clicked" with the keyboard.
    window.Menu.open({ anchor: settings, keyboard: e.detail === 0 }, [
      { label: "Pane settings", action: () => window.PaneSettings.open() },
      {
        label: "Windows Settings",
        action: () => invoke("open_windows_settings").catch((err) => console.error(err)),
      },
    ]);
  });

  const power = document.getElementById("power-button");
  const powerAction = (action) => () => invoke("power", { action }).catch((err) => console.error(err));
  power.addEventListener("click", (e) => {
    window.Menu.open({ anchor: power, keyboard: e.detail === 0 }, [
      { label: "Lock", action: powerAction("lock") },
      { label: "Sleep", action: powerAction("sleep") },
      { separator: true },
      { label: "Sign out", action: powerAction("signout") },
      { label: "Restart", action: powerAction("restart") },
      { label: "Shut down", action: powerAction("shutdown") },
    ]);
  });
})();
