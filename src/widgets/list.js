// Every widget there is, in the order the widget picker lists them. Each is
// a folder here holding <kind>.js (which calls Widgets.define; see
// shared/widget-host.js) and <kind>.css. Both the pane and the desktop load
// them all, so a widget written once works on either.
//
// To add a widget: make its folder, and add its name here.
window.WidgetList = [
  "weather",
  "calendar",
  "date",
  "music",
  "favorites",
  "recent",
  "volume",
  "brightness",
  "battery",
];
