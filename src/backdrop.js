// Shows the desktop wallpaper, blurred, in the element with id="backdrop"
// (styled in backdrop.css).
window.Backdrop = (() => {
  const { invoke } = window.__TAURI__.core;
  const el = document.getElementById("backdrop");

  // Size the backdrop to the whole screen (plus the blur overhang), even
  // before the window itself has been sized to the screen.
  el.style.width = `${screen.width + 80}px`;
  el.style.height = `${screen.height + 80}px`;

  // Average wallpaper brightness (0-1) above which it counts as light.
  const LIGHT_THRESHOLD = 0.5;

  let key = null;
  let url = null;

  // Reload the wallpaper, but only if it changed since last time.
  async function refresh() {
    const next = await invoke("wallpaper_key");
    if (next === key) return;
    key = next;

    const bytes = next ? await invoke("get_wallpaper") : null;
    if (url) URL.revokeObjectURL(url);
    url = null;
    if (!bytes || bytes.byteLength === 0) {
      el.style.backgroundImage = "none";
      setTheme(false); // plain dark background
      return;
    }
    url = URL.createObjectURL(new Blob([bytes]));
    // Decode first, so the window never appears half-painted.
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {});
    // Switch theme and image together, so they change in the same frame.
    setTheme(isLight(img));
    el.style.backgroundImage = `url("${url}")`;
  }

  // Light wallpaper -> black text and darker glass; dark wallpaper -> white text.
  function setTheme(light) {
    document.documentElement.dataset.wallpaper = light ? "light" : "dark";
  }

  // Average brightness of the part of the wallpaper that's on screen
  // (it's shown with background-size: cover, so the edges may be cropped).
  function isLight(img) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return false;
    const screenRatio = screen.width / screen.height;
    let sw = w;
    let sh = h;
    if (w / h > screenRatio) sw = h * screenRatio;
    else sh = w / screenRatio;

    // A small sample is plenty for an average.
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 36;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, (w - sw) / 2, (h - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) {
      sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    }
    return sum / (px.length / 4) / 255 > LIGHT_THRESHOLD;
  }

  refresh();
  return {
    refresh,
    // The wallpaper as an object URL (null if none), and its file path.
    get url() {
      return url;
    },
    get path() {
      return key ? key.slice(0, key.lastIndexOf("|")) : "";
    },
  };
})();
