// App icons, shared by search results and app tiles.
// Icons.load(id, large) -> Promise of an image URL ("" if the app has none).
//   small: 48px, for lists.   large: up to 96px, for tiles (sharp on high-DPI screens).
window.Icons = (() => {
  const { invoke } = window.__TAURI__.core;
  const LARGE_SIDE = 96;
  const cache = new Map(); // "id|size" -> Promise<url>

  // The backend sends raw RGBA pixels; turn them into an image URL,
  // scaled down to at most `maxSide`.
  function pixelsToUrl(buffer, maxSide) {
    const bytes = new Uint8ClampedArray(buffer);
    const side = Math.round(Math.sqrt(bytes.length / 4));
    if (!side || side * side * 4 !== bytes.length) return "";
    const full = document.createElement("canvas");
    full.width = full.height = side;
    full.getContext("2d").putImageData(new ImageData(bytes, side, side), 0, 0);
    if (side <= maxSide) return full.toDataURL();

    const small = document.createElement("canvas");
    small.width = small.height = maxSide;
    const ctx = small.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(full, 0, 0, maxSide, maxSide);
    return small.toDataURL();
  }

  function load(id, large = false) {
    const key = `${id}|${large ? "L" : "S"}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        invoke("app_icon", { id, large })
          .then((buf) => pixelsToUrl(buf, large ? LARGE_SIDE : 48))
          .catch(() => ""),
      );
    }
    return cache.get(key);
  }

  // Fill an <img> with an app's icon; it keeps the "placeholder" class until loaded.
  function show(img, id, large = false) {
    img.classList.add("placeholder");
    load(id, large).then((url) => {
      if (!url) return;
      img.src = url;
      img.classList.remove("placeholder");
    });
  }

  return { load, show, pixelsToUrl };
})();
