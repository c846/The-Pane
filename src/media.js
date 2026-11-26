// Music (bottom-right quadrant): what's playing in any app, with controls.
//
// Shows album art and all the track info the app provides, a seek bar,
// previous / play-pause / next, and — when several apps have media — a row
// of chips to switch between them. Updates once a second while the pane is
// open, and not at all while it's closed.
window.MediaPanel = (() => {
  const { invoke } = window.__TAURI__.core;
  const $ = (id) => document.getElementById(id);

  const POLL_MS = 1000;
  const TICK_MS = 250;

  const quadrant = document.querySelector(".q-media");
  const media = $("media");
  const empty = $("media-empty");
  const artImg = $("media-art-img");
  const sources = $("media-sources");
  const titleEl = $("media-title");
  const artistEl = $("media-artist");
  const detailsEl = $("media-details");
  const seek = $("media-seek");
  const elapsedEl = $("media-elapsed");
  const lengthEl = $("media-length");
  const prev = $("media-prev");
  const play = $("media-play");
  const next = $("media-next");

  let sessions = [];
  let selectedId = null; // the session the user picked (if still around)
  let pollTimer = null;
  let tickTimer = null;
  let dragging = false;
  let holdPositionUntil = 0; // after seeking, briefly trust our own position

  // ---- Helpers -------------------------------------------------------------------

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
    const key = `${s.id}|${s.title}|${s.artist}|${s.album}`;
    if (key === artKey && (artUrl || artTries >= 3)) return;
    if (key !== artKey) {
      artKey = key;
      artTries = 0;
      setArt(null);
    }
    if (!s.hasArt) return;
    artTries++;
    try {
      const bytes = await invoke("media_art", { id: s.id });
      if (artKey !== key || !bytes || bytes.byteLength === 0) return; // track changed meanwhile, or not ready yet
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
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "media-source";
      chip.setAttribute("role", "tab");
      chip.setAttribute("aria-selected", String(s.id === current.id));
      chip.title = s.title ? `${s.app}: ${s.title}` : s.app;
      const icon = document.createElement("img");
      icon.className = "media-source-icon";
      icon.alt = "";
      window.Icons.show(icon, s.appId);
      const name = document.createElement("span");
      name.textContent = s.app;
      chip.append(icon, name);
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

  function start() {
    stop();
    if (quadrant.hidden) return;
    poll();
    pollTimer = setInterval(poll, POLL_MS);
    tickTimer = setInterval(() => {
      const s = selected();
      if (s) renderTime(s);
    }, TICK_MS);
  }

  function stop() {
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    pollTimer = tickTimer = null;
  }

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

  // Start/stop with the Music switch in Pane settings.
  window.PaneSettings.onChange((s) => {
    if (!s.panels.music) stop();
  });

  return { start, stop };
})();
