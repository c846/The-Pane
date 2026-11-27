// Every desktop widget there is, shared by the pane's widget picker
// (pane-settings.js) and the desktop (widgets/desktop.js).
//
// Sizes are in desktop grid cells, [columns, rows]; a cell is the size of an
// app tile in the pane's apps panel. A widget can only be resized to one of
// its sizes. The first size is its default: the one it's added at.
//
// To add a widget: an entry here, plus a folder in src/widgets with a script
// that calls Desktop.register (see desktop.js) and its styles.
window.WidgetCatalog = [
  {
    kind: "weather",
    name: "Weather",
    description: "Conditions now, today's high and low, and the next few hours.",
    sizes: [
      [3, 2],
      [3, 1],
      [2, 1],
    ],
  },
];
