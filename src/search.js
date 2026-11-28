// Search bar: type to find installed apps, Enter or click to launch.
window.Search = (() => {
  const { invoke } = window.__TAURI__.core;
  const input = document.getElementById("search-input");
  const list = document.getElementById("search-results");

  const MAX_RESULTS = 8;

  let apps = null; // [{ name, id, lower }] once loaded
  let results = []; // [{ app, positions }]
  let selected = 0;

  async function loadApps() {
    try {
      const list = await invoke("list_apps");
      apps = list.map((a) => ({ ...a, lower: a.name.toLowerCase() }));
    } catch (err) {
      console.error("Could not load apps", err);
      apps = apps ?? [];
    }
    update();
  }

  // ---- Matching -------------------------------------------------------------

  const isWordStart = (s, i) => i === 0 || !/[a-z0-9]/i.test(s[i - 1]);

  // Score how well `app` matches the lower-case query `q`, and which characters
  // of its name matched (for highlighting). Returns null if it doesn't match.
  function match(app, q) {
    const name = app.lower;

    // Whole query appears in the name: best at the start, then at a word start.
    const idx = name.indexOf(q);
    if (idx !== -1) {
      const positions = Array.from({ length: q.length }, (_, k) => idx + k);
      let score;
      if (idx === 0) score = 1000;
      else if (isWordStart(name, idx)) score = 800 - idx;
      else score = 500 - idx;
      return { score: score - name.length * 0.1, positions };
    }

    // Otherwise every query character in order, e.g. "vsc" -> Visual Studio Code.
    // Matches at word starts count more, gaps count against.
    const chars = q.replace(/\s+/g, "");
    if (chars.length < 2) return null;
    const positions = [];
    let score = 300;
    let from = 0;
    for (const ch of chars) {
      // Prefer the next word start that has this character.
      let at = -1;
      for (let i = from; i < name.length; i++) {
        if (name[i] === ch && isWordStart(name, i)) {
          at = i;
          break;
        }
      }
      if (at === -1) at = name.indexOf(ch, from);
      if (at === -1) return null;
      if (!isWordStart(name, at)) score -= 10;
      score -= (at - from) * 2;
      positions.push(at);
      from = at + 1;
    }
    return { score: score - name.length * 0.1, positions };
  }

  function search(query) {
    const q = query.trim().toLowerCase();
    if (!q || !apps) return [];
    const found = [];
    for (const app of apps) {
      const m = match(app, q);
      if (m) found.push({ app, ...m });
    }
    found.sort((a, b) => b.score - a.score || a.app.lower.localeCompare(b.app.lower));
    return found.slice(0, MAX_RESULTS);
  }

  // ---- Rendering ---------------------------------------------------------------

  // The name with matched characters wrapped in <mark>.
  function highlighted(name, positions) {
    const frag = document.createDocumentFragment();
    const set = new Set(positions);
    let run = "";
    let runMarked = false;
    const flush = () => {
      if (!run) return;
      if (runMarked) {
        const m = document.createElement("mark");
        m.textContent = run;
        frag.append(m);
      } else {
        frag.append(run);
      }
      run = "";
    };
    for (let i = 0; i < name.length; i++) {
      const marked = set.has(i);
      if (marked !== runMarked) {
        flush();
        runMarked = marked;
      }
      run += name[i];
    }
    flush();
    return frag;
  }

  function message(text) {
    const li = document.createElement("li");
    li.className = "search-message";
    li.textContent = text;
    return li;
  }

  function render() {
    const query = input.value.trim();
    list.replaceChildren();
    if (!query) {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      return;
    }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");

    if (!apps) {
      list.append(message("Loading apps…"));
      return;
    }
    if (results.length === 0) {
      list.append(message(`No apps match “${query}”`));
      input.removeAttribute("aria-activedescendant");
      return;
    }

    results.forEach((r, i) => {
      const li = document.createElement("li");
      li.className = "result";
      li.id = `result-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === selected));

      const icon = document.createElement("img");
      icon.className = "result-icon";
      icon.alt = "";
      window.Icons.show(icon, r.app.id);

      const name = document.createElement("span");
      name.className = "result-name";
      name.append(highlighted(r.app.name, r.positions));

      li.append(icon, name);
      li.addEventListener("mousemove", () => select(i));
      li.addEventListener("click", () => launch(i));
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        select(i);
        window.Menu.open({ x: e.clientX, y: e.clientY }, window.AppLists.menuFor(r.app));
      });
      list.append(li);
    });
    input.setAttribute("aria-activedescendant", `result-${selected}`);
  }

  function select(i) {
    if (i === selected || i < 0 || i >= results.length) return;
    list.children[selected]?.setAttribute("aria-selected", "false");
    selected = i;
    list.children[selected]?.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", `result-${selected}`);
  }

  function update() {
    results = search(input.value);
    selected = 0;
    render();
  }

  async function launch(i) {
    const r = results[i];
    if (!r) return;
    try {
      await invoke("launch_app", { id: r.app.id });
    } catch (err) {
      console.error("Could not launch", r.app.name, err);
    }
  }

  // ---- Input ---------------------------------------------------------------------

  input.addEventListener("input", update);

  // Move the selection one result down (or up), wrapping around at the ends.
  const step = (by) => select((selected + by + results.length) % Math.max(results.length, 1));

  input.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        step(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        step(-1);
        break;
      case "Tab":
        // While there are results, Tab cycles through them (Shift+Tab goes
        // back) instead of moving focus out of the search bar.
        if (results.length === 0) break;
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
        break;
      case "Enter":
        e.preventDefault();
        launch(selected);
        break;
      case "Escape":
        // First Escape clears the search; a second one closes the pane.
        if (input.value) {
          e.preventDefault();
          e.stopPropagation();
          reset();
        }
        break;
    }
  });

  // Start typing anywhere in the pane to search.
  // (Not while typing in another text box or using the settings dialog.)
  document.addEventListener("keydown", (e) => {
    if (document.activeElement === input) return;
    if (e.target.closest?.("input[type=text], textarea, dialog")) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1) return;
    input.focus();
  });

  // When the pane window gets focus, put it in the search bar.
  window.addEventListener("focus", () => {
    if (document.activeElement === document.body) input.focus();
  });

  function reset() {
    input.value = "";
    update();
  }

  function focus() {
    input.focus();
  }

  loadApps();

  return {
    reset,
    focus,
    // Pick up apps installed since the last open.
    refresh: loadApps,
  };
})();
