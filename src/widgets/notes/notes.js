// Notes: a text box to type in, kept between restarts (notes.rs, by widget
// id). Saved shortly after typing stops, and when the box loses focus.
//
// The desktop never takes the keyboard, so there, clicking into the note
// lets it take the keyboard (`desktop_keyboard`) until the note loses focus
// (e.g. another app is clicked), then gives it back up.
Widgets.define({
  kind: "notes",
  name: "Notes",
  description: "A place to jot things down.",
  sizes: [
    [1, 2],
    [2, 2],
    [1, 3],
    [2, 3],
    [1, 4],
    [2, 4],
  ],

  create(body, ctx) {
    const { invoke } = window.__TAURI__.core;
    const { el } = Widgets;
    const SAVE_AFTER_MS = 600;

    const box = el("textarea", "notes-text");
    box.placeholder = "Type a note…";
    box.spellcheck = true;
    box.setAttribute("aria-label", "Note");
    body.append(box);

    let saved = "";
    let timer = 0;
    let loaded = false;

    function save() {
      clearTimeout(timer);
      timer = 0;
      if (!loaded || box.value === saved) return;
      const text = box.value;
      invoke("save_note", { id: ctx.id, text })
        .then(() => {
          saved = text;
        })
        .catch((err) => console.error("Couldn't save the note", err));
    }

    invoke("get_note", { id: ctx.id })
      .then((text) => {
        // Don't overwrite anything typed while it loaded.
        if (!box.value) box.value = text;
        saved = text;
      })
      .catch((err) => console.error("Couldn't load the note", err))
      .finally(() => {
        loaded = true;
        if (box.value !== saved) save();
      });

    box.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(save, SAVE_AFTER_MS);
    });

    // Esc leaves the note (on the desktop, handing the keyboard back).
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") box.blur();
    });

    let hasKeyboard = false;
    box.addEventListener("blur", () => {
      save();
      if (hasKeyboard) {
        hasKeyboard = false;
        invoke("desktop_keyboard", { on: false }).catch(() => {});
      }
    });

    if (!ctx.canType) {
      box.addEventListener("pointerdown", () => {
        if (hasKeyboard) return;
        hasKeyboard = true;
        invoke("desktop_keyboard", { on: true })
          .then(() => box.focus())
          .catch(() => {
            hasKeyboard = false;
          });
      });
    }

    return {
      destroy() {
        save();
        if (hasKeyboard) invoke("desktop_keyboard", { on: false }).catch(() => {});
      },
    };
  },
});
