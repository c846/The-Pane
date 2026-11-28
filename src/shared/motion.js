// Small shared animations (see also motion.css).
//
// Motion.slideIn(el, dir) / Motion.slideOut(el, dir)
//   Slide a popup out of the edge it's attached to. dir is the way it
//   travels as it appears: "down" (opens below its button), "up", "left",
//   "right". slideOut runs it backwards and resolves when it's done.
// Motion.pulse(el, keyframes, ms)
//   A one-off bump that returns to normal (press, pop, nudge). Keyframes
//   use `transform`, which is added on top of the element's own.
//
// Buttons (anything matching PRESSABLE) grow a little more when
// pressed, then settle back.
window.Motion = (() => {
  const SLIDE_MS = 180;
  const SLIDE_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
  const DISTANCE = 10;
  // Room left around the popup while it's clipped, so its shadow shows.
  const SHADOW = "-48px";

  // Where the popup starts (offset) and which side the clip reveals it from.
  function slideFrames(dir) {
    const from = {
      down: { t: `0 ${-DISTANCE}px`, clip: `inset(0 ${SHADOW} 100% ${SHADOW})` },
      up: { t: `0 ${DISTANCE}px`, clip: `inset(100% ${SHADOW} 0 ${SHADOW})` },
      right: { t: `${-DISTANCE}px 0`, clip: `inset(${SHADOW} 100% ${SHADOW} 0)` },
      left: { t: `${DISTANCE}px 0`, clip: `inset(${SHADOW} 0 ${SHADOW} 100%)` },
    }[dir];
    return [
      { opacity: 0, translate: from.t, clipPath: from.clip },
      { opacity: 1, translate: "0 0", clipPath: `inset(${SHADOW} ${SHADOW} ${SHADOW} ${SHADOW})` },
    ];
  }

  function slideIn(el, dir = "down") {
    return el.animate(slideFrames(dir), { duration: SLIDE_MS, easing: SLIDE_EASE }).finished.catch(() => {});
  }

  function slideOut(el, dir = "down") {
    return el
      .animate(slideFrames(dir).reverse(), { duration: SLIDE_MS * 0.75, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" })
      .finished.catch(() => {});
  }

  function pulse(el, keyframes, duration = 260) {
    return el.animate(keyframes, { duration, easing: "ease-out", composite: "add" });
  }

  // ---- Pressing ------------------------------------------------------------------

  const PRESSABLE = ".tile:not(.tile-empty), .button, .top-button, .wx-alert, .media-source, .level-icon:is(button)";

  // Grow a little more than the hover size, then settle back. (Hover sizes
  // things with `scale`; pulses use `transform`, added on top.)
  function press(el) {
    pulse(el, [{ transform: "scale(1)" }, { transform: "scale(1.05)", offset: 0.35 }, { transform: "scale(1)" }], 300);
  }

  document.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest?.(PRESSABLE);
    if (el && !el.disabled) press(el);
  });
  // Keyboard "clicks" (Enter / Space) press too.
  document.addEventListener("click", (e) => {
    if (e.detail !== 0) return;
    const el = e.target.closest?.(PRESSABLE);
    if (el && !el.disabled) press(el);
  });

  return { slideIn, slideOut, pulse, press };
})();
