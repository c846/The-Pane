// Slides the pane in and out of its window.
//
// The window always covers the whole screen and is see-through; the pane
// (#sheet) moves inside it. Its blurred wallpaper stays put while it moves,
// like a sheet of frosted glass sliding over the desktop.
//
// The backend says what to show (see pane.rs and edge.rs):
//   "pane-peek" px   cursor near the left edge: show px of the pane's edge
//                    (more as the mouse pushes into the edge; 0 = slide back).
//   "pane-pull" px   pane open, mouse pushing into the right edge: slide back px.
//   "pane-unglance"  a glance is over: slide away.
//   "pane-hidden"    the window was hidden: park the pane off screen.
// and pane.js calls Slide.open() / Slide.close() around opening and closing.
//
// Slide.glance(kind) opens the pane partway to show something brief in a
// strip along its edge (glance.js: the volume popup or window switcher),
// with the rest of the pane faded out. data-glance on the sheet says which.
window.Slide = (() => {
  const { listen } = window.__TAURI__.event;
  const sheet = document.getElementById("sheet");
  const backdrop = document.getElementById("backdrop");

  // Opening and closing are timed slides. pane.rs hides the window
  // HIDE_AFTER (360ms) after closing starts, so CLOSE_MS must stay shorter,
  // and FOLLOW_MS short enough for a peek to retract fully by then.
  const OPEN_MS = 380;
  const CLOSE_MS = 240;
  // Peek and pressure follow the mouse smoothly: each frame closes this
  // fraction of the gap per millisecond (an exponential glide, ~45ms).
  const FOLLOW_MS = 45;
  // How far a glance opens the pane (CSS px), and how long that takes.
  const GLANCE_WIDTH = { volume: 42, switcher: 380 };
  const GLANCE_MS = 300;

  const easeOut = (t) => 1 - Math.pow(1 - t, 4);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  let mode = "hidden"; // hidden | peek | glance | open | closing
  let glanceKind = null;
  let peekPx = 0;
  let pullPx = 0;
  let shown = 0; // how much of the pane is on screen (px from the left edge)
  let tween = null; // { from, start, duration, ease, done } while opening/closing
  let frame = 0;
  let last = 0;

  const width = () => window.innerWidth;

  function goal() {
    if (mode === "peek") return Math.min(peekPx, width());
    if (mode === "glance") return Math.min(GLANCE_WIDTH[glanceKind] ?? 0, width());
    if (mode === "open") return Math.max(0, width() - pullPx);
    return 0;
  }

  // Relative to the window's width (100vw) rather than a measured one, so it
  // stays right even in the frame where the window has just been resized.
  function apply() {
    sheet.style.transform = `translate3d(calc(${shown}px - 100vw), 0, 0)`;
    // The wallpaper doesn't move with the glass.
    backdrop.style.transform = `translate3d(calc(100vw - ${shown}px), 0, 0)`;
    sheet.classList.toggle("away", shown <= 0);
    sheet.classList.toggle("covering", shown >= width() - 0.5);
  }

  function step(now) {
    frame = 0;
    const target = goal();
    if (tween) {
      // (A frame's timestamp can be a little before the tween started.)
      const t = Math.min(1, Math.max(0, (now - tween.start) / tween.duration));
      shown = tween.from + (target - tween.from) * tween.ease(t);
      if (t >= 1) {
        const done = tween.done;
        tween = null;
        done?.();
      }
    } else {
      const dt = Math.min(50, Math.max(0, now - last));
      shown += (target - shown) * (1 - Math.exp(-dt / FOLLOW_MS));
      if (Math.abs(target - shown) < 0.4) shown = target;
    }
    last = now;
    apply();
    if (tween || shown !== target) frame = requestAnimationFrame(step);
  }

  function run() {
    if (frame) return;
    last = performance.now();
    frame = requestAnimationFrame(step);
  }

  function slideTo(nextMode, duration, ease) {
    return new Promise((resolve) => {
      tween?.done?.();
      mode = nextMode;
      tween = { from: shown, start: performance.now(), duration, ease, done: resolve };
      run();
    });
  }

  // Slide fully open, carrying on from wherever the pane is (e.g. a peek).
  // What the sheet shows: the whole pane, or a glance's strip.
  function setGlance(kind) {
    glanceKind = kind;
    if (kind) sheet.dataset.glance = kind;
    else delete sheet.dataset.glance;
  }

  function open() {
    pullPx = 0;
    setGlance(null); // the pane fades in over a glance as it opens
    return slideTo("open", OPEN_MS, easeOut);
  }

  function close() {
    return slideTo("closing", CLOSE_MS, easeInOut);
  }

  // Open partway to show `kind` (ignored while fully open).
  function glance(kind) {
    if (mode === "open") return Promise.resolve();
    if (mode === "glance" && glanceKind === kind) return Promise.resolve();
    setGlance(kind);
    return slideTo("glance", GLANCE_MS, easeOut);
  }

  listen("pane-unglance", () => {
    if (mode === "glance") close();
  });

  listen("pane-peek", ({ payload }) => {
    if (mode === "open") return;
    tween?.done?.();
    tween = null; // a peek takes over from a slide that's still going
    setGlance(null);
    mode = payload > 0 ? "peek" : "closing";
    peekPx = payload;
    run();
  });

  listen("pane-pull", ({ payload }) => {
    if (mode !== "open") return;
    pullPx = payload;
    run();
  });

  listen("pane-hidden", () => {
    tween?.done?.();
    tween = null;
    mode = "hidden";
    setGlance(null);
    shown = 0;
    apply();
  });

  // The window is resized to the screen when it's shown.
  window.addEventListener("resize", () => {
    if ((mode === "open" || mode === "glance") && !tween) shown = goal();
    apply();
  });

  apply();

  return {
    open,
    close,
    glance,
    isOpen: () => mode === "open",
  };
})();
