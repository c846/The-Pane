// Music: what's playing in any app, with controls.
//
// Album art and the track's details, a seek bar, previous / play-pause /
// next, and (when several apps have media) a row of chips to switch between
// them. One row tall it keeps to the art, the title and the controls.
// Updates once a second while in view, and not at all otherwise.
Widgets.define({
  kind: "music",
  name: "Music",
  description: "What's playing, with play, pause and skip.",
  sizes: [
    [4, 2],
    [3, 1],
    [4, 1],
    [3, 2],
    [5, 2],
    [6, 2],
  ],

  create(body, ctx) {
    const { invoke } = window.__TAURI__.core;
    const { el } = Widgets;
    const POLL_MS = 1000;
    const TICK_MS = 250;

    // ---- Building --------------------------------------------------------------------

    const media = el("div", "media");
    const art = el("div", "media-art");
    const artIcon = el("span", "icon icon-music");
    artIcon.setAttribute("aria-hidden", "true");
    const artImg = el("img");
    artImg.alt = "";
    artImg.hidden = true;
    art.append(artIcon, artImg);

    const main = el("div", "media-main");
    const sources = el("div", "media-sources");
    sources.setAttribute("role", "tablist");
    sources.setAttribute("aria-label", "Playing in");
    const info = el("div", "media-info");
    const titleEl = el("div", "media-title");
    const artistEl = el("div", "media-artist");
    const detailsEl = el("div", "media-details");
    info.append(titleEl, artistEl, detailsEl);

    const seekRow = el("div", "media-seek-row");
    const elapsedEl = el("span", "media-time", "0:00");
    const seek = el("input", "slider");
    Object.assign(seek, { type: "range", min: 0, max: 1, value: 0 });
    seek.setAttribute("aria-label", "Position in track");
    const lengthEl = el("span", "media-time", "0:00");
    seekRow.append(elapsedEl, seek, lengthEl);

    const button = (label, iconClass, extra = "") => {
      const b = el("button", `media-button glass ${extra}`.trim());
      b.type = "button";
      b.title = label;
      b.setAttribute("aria-label", label);
      const i = el("span", `icon ${iconClass}`);
      i.setAttribute("aria-hidden", "true");
      b.append(i);
      return b;
    };
    const prev = button("Previous", "icon-previous");
    const play = button("Play", "icon-play", "media-play");
    const next = button("Next", "icon-next");
    const controls = el("div", "media-controls");
    controls.append(prev, play, next);

    main.append(sources, info, seekRow, controls);
    media.append(art, main);

    const empty = el("div", "widget-message media-empty");
    const emptyIcon = el("span", "icon icon-music");
    emptyIcon.setAttribute("aria-hidden", "true");
    empty.append(emptyIcon, el("span", "", "Nothing playing"));
    body.append(media, empty);

    // ---- State -----------------------------------------------------------------------

    let sessions = [];
    let selectedId = null; // the session the user picked (if still around)
    let dragging = false;
    let holdPositionUntil = 0; // after seeking, briefly trust our own position

    const selected = () =>
      sessions.find((s) => s.id === selectedId) ??
      sessions.find((s) => s.isCurrent) ??
      sessions.find((s) => s.status === "playing") ??
      sessions[0];

    function clock(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = String(total % 60).padStart(2, "0");
      return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
    }

    // Where the track is now: apps report the position only now and then,
    // so keep counting from their last report while it's playing.
    function positionOf(s) {
      const since = s.status === "playing" && s.updatedAt ? Date.now() - s.updatedAt : 0;
      return Math.min(s.duration || Infinity, s.position + Math.max(0, since));
    }

    // ---- Album art -------------------------------------------------------------------

    let artKey = null;
    let artUrl = null;
    let artTries = 0;

    async function updateArt(s) {
      const k = `${s.id}|${s.title}|${s.artist}|${s.album}`;
      if (k === artKey && (artUrl || artTries >= 3)) return;
      if (k !== artKey) {
        artKey = k;
        artTries = 0;
        setArt(null);
      }
      if (!s.hasArt) return;
      artTries++;
      try {
        const bytes = await invoke("media_art", { id: s.id });
        if (artKey !== k || !bytes || bytes.byteLength === 0) return; // track changed meanwhile, or not ready yet
        setArt(URL.createObjectURL(new Blob([bytes])));
      } catch (err) {
        console.error("Could not load album art", err);
      }
    }

    function setArt(url) {
      if (artUrl) URL.revokeObjectURL(artUrl);
      artUrl = url;
      artImg.hidden = !url;
      if (url) artImg.src = url;
      else artImg.removeAttribute("src");
    }

    // ---- Rendering -----------------------------------------------------------------

    function renderSources(current) {
      // One chip per app; only worth showing when there's a choice.
      sources.hidden = sessions.length < 2;
      const chips = sessions.map((s) => {
        const chip = el("button", "media-source");
        chip.type = "button";
        chip.setAttribute("role", "tab");
        chip.setAttribute("aria-selected", String(s.id === current.id));
        chip.title = s.title ? `${s.app}: ${s.title}` : s.app;
        const icon = el("img", "media-source-icon");
        icon.alt = "";
        window.Icons.show(icon, s.appId);
        chip.append(icon, el("span", "", s.app));
        if (s.status === "playing") chip.classList.add("playing");
        chip.addEventListener("click", () => {
          selectedId = s.id;
          render();
        });
        return chip;
      });
      sources.replaceChildren(...chips);
    }

    function renderTime(s) {
      const pos = dragging ? Number(seek.value) : positionOf(s);
      elapsedEl.textContent = clock(pos);
      lengthEl.textContent = s.duration ? clock(s.duration) : "–:––";
      if (!dragging) {
        seek.max = Math.max(1, s.duration);
        seek.value = pos;
      }
      seek.style.setProperty("--fill", s.duration ? `${(pos / s.duration) * 100}%` : "0%");
    }

    function render() {
      const s = selected();
      media.hidden = !s;
      empty.hidden = !!s;
      if (!s) {
        setArt(null);
        artKey = null;
        return;
      }

      renderSources(s);
      titleEl.textContent = s.title || "Unknown title";
      titleEl.title = s.title;
      artistEl.textContent = s.artist || s.subtitle || s.app;

      // Everything else the app tells us about the track.
      const details = [];
      if (s.album) details.push(s.albumArtist && s.albumArtist !== s.artist ? `${s.album} — ${s.albumArtist}` : s.album);
      if (s.trackNumber > 0) details.push(s.trackCount > 0 ? `Track ${s.trackNumber} of ${s.trackCount}` : `Track ${s.trackNumber}`);
      if (s.genres.length) details.push(s.genres.join(", "));
      if (s.subtitle && s.artist) details.push(s.subtitle);
      if (sessions.length < 2) details.push(s.app); // otherwise the chips say it
      detailsEl.textContent = details.join("  ·  ");

      const playing = s.status === "playing";
      const icon = play.querySelector(".icon");
      const iconClass = `icon ${playing ? "icon-pause" : "icon-play"}`;
      if (icon.className !== iconClass) {
        icon.className = iconClass;
        // The new symbol pops in.
        icon.animate([{ transform: "scale(0.4)", opacity: 0 }, { transform: "scale(1.15)", opacity: 1, offset: 0.7 }, { transform: "scale(1)" }], {
          duration: 220,
          easing: "ease-out",
        });
      }
      play.title = playing ? "Pause" : "Play";
      play.setAttribute("aria-label", play.title);
      play.disabled = playing ? !s.canPause : !s.canPlay;
      prev.disabled = !s.canPrevious;
      next.disabled = !s.canNext;
      seek.disabled = !s.canSeek;

      renderTime(s);
      updateArt(s);
    }

    // ---- Updating ------------------------------------------------------------------

    async function poll() {
      try {
        const fresh = await invoke("media_sessions");
        // Just after seeking, the app may still report the old position.
        if (Date.now() < holdPositionUntil) {
          for (const f of fresh) {
            const old = sessions.find((s) => s.id === f.id);
            if (old) Object.assign(f, { position: old.position, updatedAt: old.updatedAt });
          }
        }
        sessions = fresh;
      } catch (err) {
        console.error("Could not read media sessions", err);
        sessions = [];
      }
      render();
    }

    ctx.every(POLL_MS, poll);
    ctx.every(TICK_MS, () => {
      const s = selected();
      if (s) renderTime(s);
    });
    poll();

    // ---- Controls ------------------------------------------------------------------

    async function control(action) {
      const s = selected();
      if (!s) return;
      try {
        await invoke("media_control", { id: s.id, action });
      } catch (err) {
        console.error("Media control failed", err);
      }
      poll();
      setTimeout(poll, 500); // apps can take a moment to report the change
    }

    // Play/pause pops; previous and next bump the way they go.
    const pop = [{ transform: "scale(1)" }, { transform: "scale(0.82)", offset: 0.3 }, { transform: "scale(1.12)", offset: 0.65 }, { transform: "scale(1)" }];
    const bump = (dx) => [{ transform: "translateX(0)" }, { transform: `translateX(${dx}px)`, offset: 0.35 }, { transform: "translateX(0)" }];

    play.addEventListener("click", () => {
      window.Motion.pulse(play, pop, 240);
      control("toggle");
    });
    prev.addEventListener("click", () => {
      window.Motion.pulse(prev.querySelector(".icon"), bump(-7), 260);
      window.Motion.pulse(prev, bump(-3), 260);
      control("previous");
    });
    next.addEventListener("click", () => {
      window.Motion.pulse(next.querySelector(".icon"), bump(7), 260);
      window.Motion.pulse(next, bump(3), 260);
      control("next");
    });

    // Seeking: follow the handle while dragging, jump when it's let go.
    seek.addEventListener("pointerdown", () => (dragging = true));
    seek.addEventListener("input", () => {
      dragging = true;
      const s = selected();
      if (s) renderTime(s);
    });
    seek.addEventListener("change", async () => {
      const s = selected();
      dragging = false;
      if (!s) return;
      const position = Number(seek.value);
      // Show the new position right away.
      s.position = position;
      s.updatedAt = Date.now();
      holdPositionUntil = Date.now() + 2000;
      renderTime(s);
      try {
        await invoke("media_seek", { id: s.id, position });
      } catch (err) {
        console.error("Seek failed", err);
      }
    });
    seek.addEventListener("pointerup", () => setTimeout(() => (dragging = false), 0));

    return {
      destroy: () => setArt(null),
    };
  },
});
