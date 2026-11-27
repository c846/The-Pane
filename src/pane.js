const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// The pane's widgets: everything below the top bar (shared/widget-host.js).
// They're in view only while the pane is open; out of view, they stop
// whatever they do on a timer.
const paneWidgets = window.Widgets.host({
  surface: "pane",
  layer: document.getElementById("pane-widgets"),
  fillFrom: "top-left",
  visible: false,
  canType: true,
  openSettings: () => window.PaneSettings.open(),
});

// An empty pane offers to add widgets.
document.getElementById("pane-empty-add").addEventListener("click", () => window.PaneSettings.openPicker("pane"));

// Close anything floating over the pane (menus, tooltips, dialogs).
function closePopups() {
  window.Menu.close();
  window.Tooltip.hide();
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
}

listen("pane-opening", async () => {
  try {
    await window.Backdrop.refresh();
  } finally {
    closePopups();
    window.AppLists.refresh(); // apps may have been installed or removed
    // Every open starts with an empty, focused search bar.
    window.Search.reset();
    window.Search.focus();
    window.Search.refresh();
    // Wait for the new background to be painted, then focus the window and
    // slide the pane the rest of the way in (from wherever a peek left it).
    requestAnimationFrame(async () => {
      await invoke("reveal_pane");
      window.Search.focus();
      paneWidgets.setVisible(true);
      await window.Slide.open();
    });
  }
});

listen("pane-closing", () => {
  closePopups();
  window.Slide.close();
  // Stop work that only matters while the pane is visible.
  paneWidgets.setVisible(false);
});

document.addEventListener("keydown", (e) => {
  // Escape closes the pane, unless it's closing a dialog.
  if (e.key === "Escape" && !document.querySelector("dialog[open]")) invoke("hide_pane");
  // Fully quit The Pane.
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "q") invoke("quit_app");
});

// No browser context menu in a shell UI.
document.addEventListener("contextmenu", (e) => e.preventDefault());
