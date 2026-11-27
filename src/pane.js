const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

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
    window.AppsPanel.refresh();
    window.PcPanel.refresh();
    window.CalendarPanel.refresh();
    window.WeatherPanel.refresh(); // only downloads if the forecast is 30+ minutes old
    window.MediaPanel.start(); // updates while the pane is open
    window.ClockPanel.start();
    // Every open starts with an empty, focused search bar.
    window.Search.reset();
    window.Search.focus();
    window.Search.refresh();
    // Wait for the new background to be painted, then focus the window and
    // slide the pane the rest of the way in (from wherever a peek left it).
    requestAnimationFrame(async () => {
      await invoke("reveal_pane");
      window.Search.focus();
      window.WeatherPanel.intro();
      window.AppsPanel.start();
      await window.Slide.open();
    });
  }
});

listen("pane-closing", () => {
  closePopups();
  window.Slide.close();
  // Stop work that only matters while the pane is visible.
  window.MediaPanel.stop();
  window.ClockPanel.stop();
  window.AppsPanel.stop();
});

document.addEventListener("keydown", (e) => {
  // Escape closes the pane, unless it's closing a dialog.
  if (e.key === "Escape" && !document.querySelector("dialog[open]")) invoke("hide_pane");
  // Fully quit The Pane.
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "q") invoke("quit_app");
});

// No browser context menu in a shell UI.
document.addEventListener("contextmenu", (e) => e.preventDefault());
