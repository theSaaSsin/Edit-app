/* ============================================================
   Claude Photo Studio — cut out, compose, harmonize
   100% client-side. No account, no API key, no quota.

     Cut Out  — background removal in-browser via
                @imgly/background-removal (open source, on-device).
     Compose  — a three-part layer stack rendered by one pipeline:

                  ✨ Finish   vignette / grain / faded blacks
                  🎞️ Overlay  texture photo + blend mode
                  🧍 Subject  cutouts: adjust, matte, shadows
                  🖼️ Scene    the main image

                The same renderComposite() draws the live preview
                (downscaled) and the exported PNG (full res), so what
                you see is exactly what you get.
   ============================================================ */
"use strict";

/* ---------------- Adjustment model ---------------- */
const newAdj = () => ({
  exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  saturation: 0, temperature: 0, tint: 0, blur: 0, grain: 0,
});
const newMatte = () => ({ choke: 0, feather: 0, edgeDark: 0, burn: 0, dodge: 0 });
const newShadow = () => ({ on: true, angle: 135, length: 26, soft: 40, opacity: 45, contact: 55 });

/* Slider specs — the panel UI is generated from these */
const ADJ_ROWS = [
  { k: "exposure",    label: "Exposure",    min: -100, max: 100 },
  { k: "contrast",    label: "Contrast",    min: -100, max: 100 },
  { k: "highlights",  label: "Highlights",  min: -100, max: 100 },
  { k: "shadows",     label: "Shadows",     min: -100, max: 100 },
  { k: "saturation",  label: "Saturation",  min: -100, max: 100 },
  { k: "temperature", label: "Temperature", min: -100, max: 100, hint: "cool ↔ warm" },
  { k: "tint",        label: "Tint",        min: -100, max: 100, hint: "green ↔ magenta" },
];
const MATTE_ROWS = [
  { k: "burn",     label: "Burn shadows",    min: 0, max: 100, hint: "near-transparent → transparent" },
  { k: "dodge",    label: "Dodge highlights", min: 0, max: 100, hint: "near-opaque → opaque" },
  { k: "choke",    label: "Shrink edge", min: 0, max: 100, hint: "eats a halo" },
  { k: "feather",  label: "Soften edge", min: 0, max: 100 },
  { k: "edgeDark", label: "Darken edge", min: 0, max: 100, hint: "kills bright fringing" },
];
const SHADOW_ROWS = [
  { k: "angle",   label: "Light from", min: 0, max: 359, unit: "°" },
  { k: "length",  label: "Cast length", min: 0, max: 100 },
  { k: "soft",    label: "Softness",    min: 0, max: 100 },
  { k: "opacity", label: "Strength",    min: 0, max: 100 },
  { k: "contact", label: "Contact shadow", min: 0, max: 100, hint: "grounds the subject" },
];
const FINISH_ROWS = [
  { k: "blacks",   label: "Black point", min: 0, max: 100, hint: "crush to true black" },
  { k: "shoulder", label: "Highlight roll-off", min: 0, max: 100, hint: "hold the highlights down" },
  { k: "contrast", label: "Filmic contrast", min: -100, max: 100 },
  { k: "vignette", label: "Vignette", min: 0, max: 100 },
  { k: "grain",    label: "Grain",    min: 0, max: 100 },
  { k: "fade",     label: "Faded blacks", min: 0, max: 100 },
];

const BLEND_MODES = [
  "soft-light", "overlay", "screen", "multiply", "hard-light",
  "color-dodge", "color-burn", "lighten", "darken", "difference",
  "hue", "color", "luminosity", "source-over",
];

/* ---------------- Auto edits ----------------
   Each look = a creative offset applied AFTER the subject has been
   auto-matched to the scene, so it stays scene-aware. */
const LOOKS = {
  natural: {
    name: "Auto blend", icon: "🎯", match: 0.85,
    base: {}, subject: {}, overlay: { opacity: 0, blend: "soft-light" },
    finish: { vignette: 12, grain: 6, fade: 0 },
  },
  rust: {
    name: "Rust & ruin", icon: "🧱", match: 0.8,
    base: { contrast: 16, saturation: -14, shadows: 8, temperature: 10 },
    subject: { contrast: 10, saturation: -8 },
    overlay: { opacity: 46, blend: "soft-light", exposure: 4, saturation: 10 },
    finish: { vignette: 34, grain: 22, fade: 10 },
  },
  golden: {
    name: "Golden hour", icon: "🌅", match: 0.6,
    base: { temperature: 30, exposure: 6, shadows: 12, saturation: 8 },
    subject: { temperature: 22, exposure: 4 },
    overlay: { opacity: 30, blend: "screen", exposure: -6, saturation: 14 },
    finish: { vignette: 22, grain: 10, fade: 8 },
  },
  cold: {
    name: "Cold concrete", icon: "🧊", match: 0.9,
    base: { temperature: -26, saturation: -22, contrast: 14, highlights: -8 },
    subject: { temperature: -18, saturation: -14 },
    overlay: { opacity: 24, blend: "overlay", saturation: -30 },
    finish: { vignette: 30, grain: 14, fade: 6 },
  },
  bleach: {
    name: "Bleach film", icon: "🎞️", match: 0.75,
    base: { saturation: -34, contrast: 22, highlights: 10 },
    subject: { saturation: -28, contrast: 14 },
    overlay: { opacity: 32, blend: "soft-light", saturation: -20 },
    finish: { vignette: 18, grain: 34, fade: 26 },
  },
  night: {
    name: "Night", icon: "🌙", match: 0.9,
    night: { visible: true, amount: 86, skyHue: 222, skySat: 20, skyDark: 78, horizonGlow: 40, stars: 40, lampWarmth: 78, ambient: 46, killDaylight: 84 },
    base: { contrast: 10, saturation: -18, highlights: -14 },
    subject: { exposure: -14, temperature: -12, saturation: -10 },
    overlay: { opacity: 18, blend: "soft-light", saturation: -40, exposure: -20 },
    finish: { vignette: 30, grain: 18, fade: 0, blacks: 10, shoulder: 44, contrast: 14 },
    glow: { visible: true, count: 34, size: 26, spread: 62, cy: 64, intensity: 70, hue: 68 },
  },
  fireflies: {
    name: "Fireflies", icon: "🪰", match: 0.9,
    night: { visible: true, amount: 76, skyHue: 230, skySat: 24, skyDark: 72, horizonGlow: 46, stars: 28, lampWarmth: 82, ambient: 48, killDaylight: 80 },
    base: { contrast: 8, saturation: -12, highlights: -10 },
    subject: { exposure: -10, temperature: -8 },
    overlay: { opacity: 14, blend: "soft-light", saturation: -30, exposure: -18 },
    finish: { vignette: 26, grain: 15, fade: 0, blacks: 8, shoulder: 40, contrast: 12 },
    glow: { visible: true, count: 90, size: 18, spread: 78, cy: 58, intensity: 85, hue: 62 },
  },
  noir: {
    name: "Ink noir", icon: "⚫", match: 0.85,
    base: { saturation: -100, contrast: 30, shadows: -14 },
    subject: { saturation: -100, contrast: 22 },
    overlay: { opacity: 20, blend: "multiply", saturation: -100 },
    finish: { vignette: 52, grain: 28, fade: 4 },
  },
};

/* ---------------- State ---------------- */
const state = {
  tab: "cut",
  library: [],
  cut: { file: null, src: null, result: null, busy: false, model: "fast" },
  scene: {
    versions: [], currentId: null,
    base: { img: null, adj: newAdj(), visible: true, token: 0 },
    layers: [],
    overlay: { dataUrl: null, img: null, visible: true, blend: "soft-light", opacity: 40, rot: 0, flipH: false, adj: newAdj() },
    finish: { visible: true, vignette: 0, grain: 0, fade: 0, blacks: 0, shoulder: 0, contrast: 0 },
    glow: { visible: false, count: 0, size: 30, spread: 60, cy: 62, intensity: 65, hue: 68, seed: 7 },
    lights: [],
    windows: { visible: false, list: [], warmth: 34, brightness: 62, spill: 45, variation: 35, seed: 5 },
    relight: { visible: true, dataUrl: null, img: null, strength: 100, scale: 10, colour: 100, protect: 20, keepDark: 45 },
    nightSolve: { visible: false, strength: 100, exposure: 70, canyon: 26, skyAmbient: 46, skyHue: 214, skySat: 30, windowGain: 62, lampGain: 70, floorLevel: 42, keepDark: 40 },
    night: { visible: false, amount: 0, skyHue: 220, skySat: 22, skyDark: 78, skyDetail: 70, shadowCool: 18, lightWarm: 55, horizonGlow: 35, glowSide: 70, stars: 0, lampWarmth: 72, skyDetect: 50, skyFeather: 30, skyEdge: 70, skyTighten: 0, skyBurn: 0, skyDodge: 0, ambient: 42, killDaylight: 78, seed: 3 },
    selectedId: null, zTop: 1, look: null,
    refine: { reach: 45, strength: 80, spill: 80 },
  },
  brush: { on: false, target: "subject", tool: "add", size: 12, soft: 60, strength: 70, showMask: true },
};
let idSeq = 0;
const uid = (p) => `${p}_${Date.now().toString(36)}_${idSeq++}`;
let uploadTarget = "cut";

/* ---------------- DOM ---------------- */
const el = (id) => document.getElementById(id);
const dom = {};
[
  "cutStage","cutEmpty","cutWrap","cutImg","cutLoading","cutLoadingText",
  "cutRotL","cutRotR","cutFlip",
  "sceneStage","sceneEmpty","sceneWrap","sceneCanvas","layerOverlay",
  "cutToolbar","cutAddBtn","cutSaveBtn","cutDownloadBtn",
  "sceneToolbar","sceneAddBtn","overlayAddBtn","lightAddBtn","brushToggle","brushBar","layerDeleteBtn","layerFlattenReset",
  "beforeAfterBtn","sceneDownloadBtn",
  "historyStrip","historyItems",
  "libraryItems","libCount","libHint",
  "cutPanel","cutRunBtn","cutModelChips",
  "scenePanel","lookChips","harmonizeBtn","layerStack","mergeBtn","copyPromptBtn","statusMsg",
  "fileInput","cutUploadTrigger","sceneUploadTrigger",
  "newSessionBtn","helpBtn","helpModal","helpClose","helpOk",
  "toast",
].forEach((id) => (dom[id] = el(id)));

/* ---------------- Helpers ---------------- */
function toast(msg, isErr = false) {
  dom.toast.textContent = msg;
  dom.toast.classList.toggle("err", isErr);
  dom.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (dom.toast.hidden = true), isErr ? 5200 : 3000);
}
function status(msg, kind = "") {
  dom.statusMsg.textContent = msg;
  dom.statusMsg.className = "status" + (kind ? " " + kind : "");
}
function fileToDataUrl(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
const blobToDataUrl = (blob) => fileToDataUrl(blob);
function loadImage(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
}
function cvOf(w, h) { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => Math.max(-0.1, Math.min(1.1, v));

/* Re-encode any browser-decodable image to a clean PNG Blob (and cap huge
   phone photos), so the background-removal decoder always gets a format it
   can read. */
async function toPngBlob(dataUrl, maxDim = 2048) {
  let img;
  try { img = await loadImage(dataUrl); }
  catch { throw new Error("This photo couldn't be read. Try a JPG or PNG — some phone photos (HEIC) aren't supported. A screenshot of the photo also works."); }
  let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error("This photo couldn't be read. Try a different image (JPG or PNG).");
  const scale = Math.min(1, maxDim / Math.max(w, h));
  w = Math.round(w * scale); h = Math.round(h * scale);
  const c = cvOf(w, h);
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return await new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error("Could not process this image."))), "image/png")
  );
}

/* Rotate / flip a data URL (used to straighten sideways phone photos). */
async function transformDataUrl(dataUrl, { rot = 0, flipH = false }) {
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth, h = img.naturalHeight;
  const swap = rot === 90 || rot === 270;
  const c = cvOf(swap ? h : w, swap ? w : h);
  const ctx = c.getContext("2d");
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  if (flipH) ctx.scale(-1, 1);
  ctx.drawImage(img, -w / 2, -h / 2);
  return c.toDataURL("image/png");
}

/* ============================================================
   CUTOUT STORAGE — source photo + separate mask

   A cutout is deliberately NOT one flattened RGBA png. Background removal
   throws the background pixels away (they come back as RGB 0,0,0 under
   alpha 0), so a flattened cutout can never be un-erased — a restore brush
   would have nothing to paint back, and hair the model cut off would be
   gone for good. Keeping the untouched photo alongside a greyscale mask
   makes every mask edit reversible and makes hair recoverable.
   ============================================================ */
const IDB_NAME = "cps", IDB_STORE = "library";
function idb() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(IDB_NAME, 1);
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(IDB_STORE)) rq.result.createObjectStore(IDB_STORE, { keyPath: "id" }); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbAll() {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const rq = db.transaction(IDB_STORE).objectStore(IDB_STORE).getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error);
    });
  } catch { return null; }
}
async function idbPut(item) {
  try { const db = await idb(); db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put(item); return true; }
  catch { return false; }
}
async function idbDel(id) {
  try { const db = await idb(); db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).delete(id); } catch {}
}

/* Pull a greyscale mask out of an RGBA cutout's alpha channel. */
function maskFromAlpha(img) {
  const c = cvOf(img.naturalWidth || img.width, img.naturalHeight || img.height);
  const x = c.getContext("2d");
  x.drawImage(img, 0, 0);
  const id = x.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    d[i] = d[i + 1] = d[i + 2] = a; d[i + 3] = 255;
  }
  x.putImageData(id, 0, 0);
  return c;
}
/* src + mask -> a normal RGBA cutout (thumbnails, downloads). */
function applyMask(srcImg, maskSrc, w, h) {
  const W = w || srcImg.naturalWidth || srcImg.width, H = h || srcImg.naturalHeight || srcImg.height;
  const c = cvOf(W, H);
  const x = c.getContext("2d");
  x.drawImage(srcImg, 0, 0, W, H);
  const m = cvOf(W, H);
  m.getContext("2d").drawImage(maskSrc, 0, 0, W, H);
  const id = x.getImageData(0, 0, W, H), md = m.getContext("2d").getImageData(0, 0, W, H).data;
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) d[i + 3] = md[i];
  x.putImageData(id, 0, 0);
  return c;
}
/* Downscale a photo for storage — full phone resolution in the library is
   what pushes it past any browser quota. */
async function fitDataUrl(dataUrl, maxDim, type = "image/jpeg", q = 0.86) {
  const img = await loadImage(dataUrl);
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  const s = Math.min(1, maxDim / Math.max(w0, h0));
  const c = cvOf(w0 * s, h0 * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL(type, q);
}

/* ============================================================
   Background removal engine (lazy-loaded, cached)
   ============================================================ */
let _imgly = null;
/* Load a browser-bundled build. Two hard requirements:
   1) Use a "/+esm" (jsDelivr) or esm.sh URL so the library's own bare
      imports (zod, ndarray, lodash-es) get bundled for the browser.
   2) Pin to 1.5.7 — the last release where onnxruntime-web is a REGULAR
      dependency (so the bundler includes it). From 1.5.8 on it became a
      *peer* dependency, which the bundler externalises → the runtime
      error "failed to resolve onnxruntime". */
const IMGLY_SOURCES = [
  "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.5.7/+esm",
  "https://esm.sh/@imgly/background-removal@1.5.7",
];
async function ensureImgly() {
  if (_imgly) return _imgly;
  let lastErr;
  for (const url of IMGLY_SOURCES) {
    try {
      const mod = await import(url);
      const fn = mod.removeBackground || mod.default?.removeBackground || mod.default;
      if (typeof fn === "function") { _imgly = fn; return _imgly; }
      lastErr = new Error("Module loaded but removeBackground was not found.");
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Could not load the background-removal module.");
}

/* ------------------------------------------------------------------
   Cut-out models

   Side-by-side on a backlit portrait, the default model welds a bright
   rim of blown sky onto the hair; BiRefNet does not. It's a much bigger
   quality jump than any amount of edge post-processing, so it's worth
   the larger download — but it IS larger, so it stays opt-in and the
   fast model remains the default.
   ------------------------------------------------------------------ */
const CUT_MODELS = {
  fast:  { name: "Fast", note: "quick, small download", engine: "imgly", model: "isnet_fp16" },
  sharp: { name: "Sharper", note: "full-precision, better edges", engine: "imgly", model: "isnet" },
  hair:  { name: "Best for hair", note: "BiRefNet · big first download", engine: "birefnet" },
};

const TRANSFORMERS_SOURCES = [
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1",
  "https://esm.sh/@huggingface/transformers@3.5.1",
];
let _birefnet = null;
async function ensureBiRefNet(onProgress) {
  if (_birefnet) return _birefnet;
  let lastErr;
  for (const url of TRANSFORMERS_SOURCES) {
    try {
      const tf = await import(url);
      const opts = { progress_callback: onProgress };
      const model = await tf.AutoModel.from_pretrained("onnx-community/BiRefNet_lite", { dtype: "fp32", ...opts });
      const processor = await tf.AutoProcessor.from_pretrained("onnx-community/BiRefNet_lite", opts);
      _birefnet = { tf, model, processor };
      return _birefnet;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Could not load BiRefNet.");
}

/* Returns an RGBA cutout Blob, same contract as imgly's removeBackground. */
async function removeBackgroundBiRefNet(pngBlob, onProgress) {
  const { tf, model, processor } = await ensureBiRefNet(onProgress);
  const url = URL.createObjectURL(pngBlob);
  try {
    const image = await tf.RawImage.fromURL(url);
    const { pixel_values } = await processor(image);
    const out = await model({ input_image: pixel_values });
    // Output tensor naming varies between exports — take the first tensor.
    let t = out.output_image ?? out.output ?? out.logits ?? Object.values(out)[0];
    if (Array.isArray(t)) t = t[0];
    if (t.dims && t.dims.length === 4) t = t[0];
    const maskImg = await tf.RawImage.fromTensor(t.sigmoid().mul(255).to("uint8")).resize(image.width, image.height);

    const c = cvOf(image.width, image.height);
    const x = c.getContext("2d");
    const src = await loadImage(url);
    x.drawImage(src, 0, 0);
    const id = x.getImageData(0, 0, c.width, c.height);
    const md = maskImg.data;
    const step = md.length / (c.width * c.height);   // 1 for greyscale, 3/4 if not
    for (let i = 0, p = 0; i < id.data.length; i += 4, p += step) id.data[i + 3] = md[p | 0];
    x.putImageData(id, 0, 0);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/png"));
  } finally { URL.revokeObjectURL(url); }
}

/* ============================================================
   PIXEL ENGINE
   ============================================================ */

/* Tone + colour, alpha-preserving. Operates in place. */
function applyAdjust(id, a) {
  if (!a) return id;
  const exposure = Math.pow(2, (a.exposure || 0) / 100);
  const contrast = 1 + (a.contrast || 0) / 100;
  const sat = 1 + (a.saturation || 0) / 100;
  const temp = (a.temperature || 0) / 100;
  const tint = (a.tint || 0) / 100;
  const hi = (a.highlights || 0) / 100;
  const sh = (a.shadows || 0) / 100;
  const grain = (a.grain || 0) / 100;
  const noop = exposure === 1 && contrast === 1 && sat === 1 && !temp && !tint && !hi && !sh && !grain;
  if (noop) return id;

  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;

    r *= exposure; g *= exposure; b *= exposure;

    if (temp) { r += temp * 0.18; b -= temp * 0.18; }
    if (tint) { g -= tint * 0.15; r += tint * 0.05; b += tint * 0.05; }

    if (contrast !== 1) {
      r = (r - 0.5) * contrast + 0.5;
      g = (g - 0.5) * contrast + 0.5;
      b = (b - 0.5) * contrast + 0.5;
    }

    let L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (hi || sh) {
      const Lc = clamp(L, 0, 1);
      const add = hi * 0.42 * (Lc * Lc) + sh * 0.42 * ((1 - Lc) * (1 - Lc));
      r += add; g += add; b += add;
      L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    if (sat !== 1) { r = L + (r - L) * sat; g = L + (g - L) * sat; b = L + (b - L) * sat; }

    if (grain) {
      // Strongest in the midtones, like real film.
      const n = (Math.random() - 0.5) * grain * 0.36 * (1 - Math.abs(clamp(L, 0, 1) * 2 - 1));
      r += n; g += n; b += n;
    }

    d[i]     = r <= 0 ? 0 : r >= 1 ? 255 : r * 255;
    d[i + 1] = g <= 0 ? 0 : g >= 1 ? 255 : g * 255;
    d[i + 2] = b <= 0 ? 0 : b >= 1 ? 255 : b * 255;
  }
  return id;
}

/* ============================================================
   DODGE & BURN ON A MATTE

   The darkroom technique photographers use on a hair channel, which works
   because it is range-limited: burning only touches what is already dark,
   dodging only what is already light.

   On a matte that is exactly the right tool. Background removal leaves the
   background at 0.05 instead of 0 and solid hair at 0.9 instead of 1 — both
   read as haze. Burning the shadows drives the near-transparent to properly
   transparent and dodging the highlights drives the near-opaque to properly
   opaque, while the genuine mid-range, which is where individual strands
   live, is left alone. A plain contrast curve cannot do this: it pivots
   about the middle and eats exactly the strands worth keeping.

   burn  — shadows only, small exposure, applied repeatedly
   dodge — highlights only, larger exposure
   ============================================================ */
function dodgeBurnValue(v, burn, dodge) {
  if (burn > 0) {
    const w = Math.pow(clamp(1 - v / 0.55, 0, 1), 1.6);   // shadows range
    v *= 1 - burn * w;
  }
  if (dodge > 0) {
    const w = Math.pow(clamp((v - 0.45) / 0.55, 0, 1), 1.6); // highlights range
    v += (1 - v) * dodge * w;
  }
  return clamp(v, 0, 1);
}
/* Applied globally the same idea is a range-limited levels move, and that is
   the better formulation: a multiplicative push only ever approaches zero,
   where a black point actually reaches it. Burn sets the black point, dodge
   the white point, and everything between is rescaled — so haze is removed
   outright while the strand ramp is stretched rather than clipped. The
   multiplicative form above stays for the brush, where repeated local
   application is the whole point. */
function dodgeBurnLevels(burnPct, dodgePct) {
  const bp = ((burnPct || 0) / 100) * 0.46;
  const wp = 1 - ((dodgePct || 0) / 100) * 0.46;
  return { bp, span: Math.max(0.04, wp - bp) };
}
function dodgeBurnMask8(data, burnPct, dodgePct) {
  if (!burnPct && !dodgePct) return;
  const { bp, span } = dodgeBurnLevels(burnPct, dodgePct);
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(clamp((i / 255 - bp) / span, 0, 1) * 255);
  for (let i = 0; i < data.length; i += 4) {
    const v = lut[data[i]];
    data[i] = data[i + 1] = data[i + 2] = v;
  }
}

/* Matte refinement — shrink / soften / darken the cut edge.
   The blurred alpha is remapped so `choke` erodes inward instead of just
   fogging the edge; `edgeDark` multiplies RGB down where alpha is partial,
   which is what actually kills a bright halo from the old background. */
function refineMatte(src, m) {
  const choke = (m.choke || 0) / 100, feather = (m.feather || 0) / 100, edgeDark = (m.edgeDark || 0) / 100;
  if (!choke && !feather && !edgeDark) return src;

  const w = src.width, h = src.height;
  const unit = Math.max(1, Math.min(w, h) / 100);
  const blurPx = (choke * 2.2 + feather * 3.0) * unit;

  let alpha;
  if (blurPx > 0.4) {
    const mask = cvOf(w, h);
    const mx = mask.getContext("2d");
    mx.filter = `blur(${blurPx.toFixed(2)}px)`;
    mx.drawImage(src, 0, 0);
    mx.filter = "none";
    alpha = mx.getImageData(0, 0, w, h);
  }

  const out = cvOf(w, h);
  const ox = out.getContext("2d");
  ox.drawImage(src, 0, 0);
  const id = ox.getImageData(0, 0, w, h);
  const d = id.data;
  const A = alpha ? alpha.data : null;
  // Erode: everything below the threshold goes transparent, the rest is
  // rescaled so the surviving edge keeps a smooth ramp.
  const t = choke * 0.62;
  const inv = 1 / Math.max(0.001, 1 - t);

  for (let i = 0; i < d.length; i += 4) {
    let a = (A ? A[i + 3] : d[i + 3]) / 255;
    if (t) a = clamp((a - t) * inv, 0, 1);
    if (edgeDark && a > 0 && a < 0.999) {
      const k = 1 - edgeDark * (1 - a);
      d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
    }
    d[i + 3] = a * 255;
  }
  ox.putImageData(id, 0, 0);
  return out;
}

/* ============================================================
   HAIR / EDGE REFINEMENT

   Background removal returns a hard silhouette: on the sample photo the
   matte was 688k fully-transparent and 615k fully-opaque pixels with
   literally nothing in between, so every hair strand was either chopped
   off or left welded to a chunk of bright sky.

   This recovers the in-between. Around the matte edge it estimates the
   local foreground colour F and background colour B by push-pull blurring
   the pixels that are confidently inside and confidently outside, then
   solves each band pixel for where it sits on the F→B colour line:

       alpha = clamp( (C-B)·(F-B) / |F-B|² )

   Hair against a bright sky separates strongly on that line, so strands
   come back as genuine partial alpha. The same F and B then let us
   un-mix the colour — F = (C-(1-a)B)/a — which removes the background
   spill that reads as a glowing rim. That's a real fix, as opposed to
   just darkening the edge and hoping.
   ============================================================ */
function boxBlur(buf, w, h, r, ch) {
  const tmp = new Float32Array(buf.length);
  const win = r * 2 + 1;
  for (let y = 0; y < h; y++) {           // horizontal
    for (let c = 0; c < ch; c++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += buf[(y * w + clamp(x, 0, w - 1)) * ch + c];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * ch + c] = acc / win;
        acc += buf[(y * w + clamp(x + r + 1, 0, w - 1)) * ch + c] - buf[(y * w + clamp(x - r, 0, w - 1)) * ch + c];
      }
    }
  }
  for (let x = 0; x < w; x++) {           // vertical
    for (let c = 0; c < ch; c++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[(clamp(y, 0, h - 1) * w + x) * ch + c];
      for (let y = 0; y < h; y++) {
        buf[(y * w + x) * ch + c] = acc / win;
        acc += tmp[(clamp(y + r + 1, 0, h - 1) * w + x) * ch + c] - tmp[(clamp(y - r, 0, h - 1) * w + x) * ch + c];
      }
    }
  }
}

/* Returns { mask, decon } canvases at working resolution. */
function refineHair(srcImg, maskSrc, { reach = 45, strength = 80, spill = 80 } = {}) {
  const maxDim = 1100;
  const w0 = srcImg.naturalWidth || srcImg.width, h0 = srcImg.naturalHeight || srcImg.height;
  const s = Math.min(1, maxDim / Math.max(w0, h0));
  const W = Math.max(2, Math.round(w0 * s)), H = Math.max(2, Math.round(h0 * s));

  const sc = cvOf(W, H); sc.getContext("2d").drawImage(srcImg, 0, 0, W, H);
  const S = sc.getContext("2d").getImageData(0, 0, W, H).data;
  const mc = cvOf(W, H); mc.getContext("2d").drawImage(maskSrc, 0, 0, W, H);
  const M = mc.getContext("2d").getImageData(0, 0, W, H).data;

  const N = W * H;
  const a0 = new Float32Array(N);
  for (let i = 0; i < N; i++) a0[i] = M[i * 4] / 255;

  const R = Math.max(2, Math.round((reach / 100) * Math.min(W, H) / 26));

  // Push-pull: colour sums weighted by confident-inside / confident-outside.
  const inB = new Float32Array(N * 4), outB = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const j = i * 4, a = a0[i];
    const wi = a > 0.92 ? 1 : 0, wo = a < 0.08 ? 1 : 0;
    inB[j] = S[j] * wi; inB[j + 1] = S[j + 1] * wi; inB[j + 2] = S[j + 2] * wi; inB[j + 3] = wi;
    outB[j] = S[j] * wo; outB[j + 1] = S[j + 1] * wo; outB[j + 2] = S[j + 2] * wo; outB[j + 3] = wo;
  }
  boxBlur(inB, W, H, R, 4);
  boxBlur(outB, W, H, R, 4);

  const band = new Float32Array(a0);
  boxBlur(band, W, H, R, 1);

  const k = strength / 100, kS = spill / 100;
  const outMask = cvOf(W, H), dec = cvOf(W, H);
  const mo = outMask.getContext("2d").createImageData(W, H);
  const dd = dec.getContext("2d").createImageData(W, H);

  for (let i = 0; i < N; i++) {
    const j = i * 4;
    let a = a0[i];
    const inW = inB[j + 3], outW = outB[j + 3];
    if (band[i] > 0.015 && band[i] < 0.985 && inW > 1e-3 && outW > 1e-3) {
      const Fr = inB[j] / inW, Fg = inB[j + 1] / inW, Fb = inB[j + 2] / inW;
      const Br = outB[j] / outW, Bg = outB[j + 1] / outW, Bb = outB[j + 2] / outW;
      const dr = Fr - Br, dg = Fg - Bg, db = Fb - Bb;
      const den = dr * dr + dg * dg + db * db;
      if (den > 260) {                       // enough colour separation to trust
        const am = clamp(((S[j] - Br) * dr + (S[j + 1] - Bg) * dg + (S[j + 2] - Bb) * db) / den, 0, 1);
        a = a0[i] * (1 - k) + am * k;
        if (kS && a > 0.03 && a < 0.985) {   // un-mix the background spill
          const ia = 1 / a;
          dd.data[j]     = clamp((S[j]     - (1 - a) * Br) * ia, 0, 255) * kS + S[j]     * (1 - kS);
          dd.data[j + 1] = clamp((S[j + 1] - (1 - a) * Bg) * ia, 0, 255) * kS + S[j + 1] * (1 - kS);
          dd.data[j + 2] = clamp((S[j + 2] - (1 - a) * Bb) * ia, 0, 255) * kS + S[j + 2] * (1 - kS);
          dd.data[j + 3] = 255;
        }
      }
    }
    mo.data[j] = mo.data[j + 1] = mo.data[j + 2] = a * 255;
    mo.data[j + 3] = 255;
  }
  outMask.getContext("2d").putImageData(mo, 0, 0);
  dec.getContext("2d").putImageData(dd, 0, 0);
  return { mask: outMask, decon: dec };
}

/* ============================================================
   SKY DETECTION + REAL NIGHT

   Grading a daytime frame darker does not make night — a blown-out sky
   carries no detail, so darkening it only ever yields grey. Night needs
   the sky found and *replaced*, and needs artificial light left behind
   rather than dragged down with everything else.

   Detection is a flood fill from the top edge that stops at strong
   gradients. Sky is the region that is connected to the top of the
   frame, close in colour to what's already up there, and not across a
   hard edge — which is exactly what a roofline is.
   ============================================================ */
function detectSky(img, { threshold = 50, feather = 30 } = {}) {
  const maxDim = 760;
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const s = Math.min(1, maxDim / Math.max(w0, h0));
  const W = Math.max(4, Math.round(w0 * s)), H = Math.max(4, Math.round(h0 * s));
  const c = cvOf(W, H);
  c.getContext("2d").drawImage(img, 0, 0, W, H);
  const D = c.getContext("2d").getImageData(0, 0, W, H).data;
  const N = W * H;

  const lum = new Float32Array(N), sat = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const j = i * 4, r = D[j] / 255, g = D[j + 1] / 255, b = D[j + 2] / 255;
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sat[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  // Sobel-ish gradient magnitude: the stop condition.
  const grad = new Float32Array(N);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = lum[i + 1] - lum[i - 1], gy = lum[i + W] - lum[i - W];
      grad[i] = Math.hypot(gx, gy);
    }
  }

  // Seed from the top strip, and take its colour as the sky reference.
  const seedRows = Math.max(1, Math.round(H * 0.03));
  let sl = 0, ss = 0, n = 0;
  for (let y = 0; y < seedRows; y++) for (let x = 0; x < W; x++) { const i = y * W + x; sl += lum[i]; ss += sat[i]; n++; }
  const refL = sl / n, refS = ss / n;

  /* Two fills, not one. A single tolerance has to be either strict — which
     stops short of rooflines and leaves sky misclassified — or loose, which
     leaks through gaps into the buildings. Running both gives the bounds
     directly from the image instead of guessing them with a fixed
     morphological radius: what the strict fill reaches is certainly sky,
     what the loose fill cannot reach is certainly not, and the guided filter
     resolves the band between against the photograph. */
  const fill = (tol, gStop) => {
    const hit = new Uint8Array(N);
    const q = [];
    for (let y = 0; y < seedRows; y++) for (let x = 0; x < W; x++) { const i = y * W + x; hit[i] = 1; q.push(i); }
    while (q.length) {
      const i = q.pop();
      const x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (hit[ni]) continue;
        if (grad[ni] > gStop) continue;                     // don't cross a roofline
        if (Math.abs(lum[ni] - refL) > tol) continue;
        if (sat[ni] - refS > tol * 0.9) continue;
        hit[ni] = 1; q.push(ni);
      }
    }
    return hit;
  };

  const tol = 0.10 + (threshold / 100) * 0.42;
  const gStop = 0.055 + (1 - threshold / 100) * 0.05;
  let tight = fill(tol * 0.80, gStop * 0.80);               // certainly sky
  let loose = fill(tol * 1.30, gStop * 1.45);               // certainly not, beyond this
  let inSky = fill(tol, gStop);                             // the working estimate

  /* Sky that clips to white loses its colour, so a fill measuring distance
     from a coloured seed stops dead at the clip point. On a backlit facade
     that left a wedge of blown sky (luma 234-250, texture 0-2 out of 255)
     unclaimed directly beside sky the fill had already taken, and the night
     pass then re-exposed one half of the sky and not the other, leaving a hard
     seam across open air.

     So continue each fill through connected near-white, texture-free pixels.
     The threshold is the found sky's own median luminance, not a constant, so
     it tracks the exposure of the photograph rather than assuming one. And
     connectivity does the semantic work that brightness alone cannot: bright
     balcony glazing in the same frame measures much the same, but it is
     separated from the sky by dark brick, so the fill never reaches it. */
  {
    const ls = [];
    for (let i = 0; i < N; i++) if (inSky[i]) ls.push(lum[i]);
    if (ls.length > 32) {
      ls.sort((a, b) => a - b);
      const med = ls[ls.length >> 1];
      const blowL = Math.max(0.80, med - 0.02);
      // Only worth doing when the sky actually reaches the top of the range;
      // an overcast grey sky has no clipped region to recover.
      if (ls[ls.length - 1] > 0.88) {
        const spread = (hit, gs) => {
          const out = Uint8Array.from(hit);
          const q = [];
          for (let i = 0; i < N; i++) if (out[i]) q.push(i);
          while (q.length) {
            const i = q.pop();
            const x = i % W, y = (i / W) | 0;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const ni = ny * W + nx;
              if (out[ni] || lum[ni] < blowL || grad[ni] > gs) continue;
              out[ni] = 1; q.push(ni);
            }
          }
          return out;
        };
        tight = spread(tight, gStop * 0.80);
        inSky = spread(inSky, gStop);
        loose = spread(loose, gStop * 1.45);
      }
    }
  }

  /* Power lines, aerials and bare branches are strong gradients, so the fill
     stops dead at every one of them and leaves the sky sliced into strips —
     which shows up as hard bands once the sky is re-lit. A morphological
     close (dilate, then erode by the same amount) bridges anything thinner
     than the radius while leaving the roofline where it is. The wires stay
     visible either way: they're dark, and the sky remap preserves their own
     luminance. */
  const closeR = Math.max(2, Math.round(Math.min(W, H) / 90));
  const dil = new Uint8Array(N), cls = new Uint8Array(N), tmpA = new Uint8Array(N);
  const morph = (src, dst, r, want) => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let hit = 0;
        for (let dy = -r; dy <= r && !hit; dy++) {
          const yy = clamp(y + dy, 0, H - 1);
          for (let dx = -r; dx <= r; dx++) {
            if (src[yy * W + clamp(x + dx, 0, W - 1)] === want) { hit = 1; break; }
          }
        }
        dst[y * W + x] = hit ? want : 1 - want;
      }
    }
  };
  morph(inSky, dil, closeR, 1);   // dilate
  morph(dil, cls, closeR, 0);     // erode

  /* The fill's boundary is not trustworthy in either direction: it halts on
     the gradient BEFORE a roofline (leaving sky on the ground side, which
     survives as a bright fringe), and a blanket dilation to compensate
     overshoots into thin foreground detail on other scenes.

     So don't trust it. Build a trimap instead — eroded region is confidently
     sky, dilated region is confidently not, and the band between is unknown.
     The guided filter resolves the unknown band against the photograph, the
     way the hair matte does. Nothing here is tuned to one image. */
  /* Bounds come from the two fills. Morphology is still applied, but only to
     close thin structures (wires, aerials) inside each bound — it no longer
     has to invent where the edge might be, which is what made a fixed radius
     right on one photograph and wrong on the next. */
  const sure = new Uint8Array(N), maybe = new Uint8Array(N);
  const tclose = new Uint8Array(N), lclose = new Uint8Array(N);
  morph(tight, tmpA, closeR, 1); morph(tmpA, tclose, closeR, 0);
  morph(loose, tmpA, closeR, 1); morph(tmpA, lclose, closeR, 0);
  /* The loose fill can still run away on a scene with a soft horizon, and an
     unknown band covering half the frame lets the guided filter invent sky
     wherever it likes — measured at roughly double the working estimate on
     every test scene. Bound the band spatially as well: it may only extend a
     short distance from what the working fill actually reached. */
  const over = new Uint8Array(N);
  morph(cls, tmpA, Math.max(2, Math.round(closeR * 1.6)), 1);
  for (let i = 0; i < N; i++) over[i] = tmpA[i];

  const reach = new Uint8Array(N);
  morph(cls, tmpA, Math.max(3, closeR * 3), 1);
  for (let i = 0; i < N; i++) reach[i] = tmpA[i];
  /* A strict fill cannot traverse a highly varied sky — on a sunset it barely
     moves, which left "sure" tiny and let the guided filter shrink an
     86%-sky frame to half that. The working fill's own interior is the
     dependable floor; the strict fill only adds to it. */
  const interior = new Uint8Array(N);
  morph(cls, tmpA, Math.max(2, Math.round(closeR * 1.8)), 0);
  for (let i = 0; i < N; i++) interior[i] = tmpA[i];
  for (let i = 0; i < N; i++) {
    sure[i] = (interior[i] || (tclose[i] && cls[i])) ? 1 : 0; // sure ⊆ working
    // The loose fill halts on the same roofline gradient the strict one does,
    // just later — so on its own it never covers the pixels between the
    // fill's edge and the real edge, and they get pinned to not-sky and
    // survive as the bright fringe. The dilation has to be part of the bound.
    maybe[i] = ((lclose[i] || cls[i] || over[i]) && reach[i]) ? 1 : 0;
  }

  /* 255 sure sky · 0 sure not · 170/90 unknown, leaning sky / leaning ground.
     The lean is what matters: the fill stops before the roofline, so the
     pixels between are unknown but almost certainly sky, and saying so lets
     the guided filter snap the edge back onto the building instead of
     resolving them to ground. */
  const m = cvOf(W, H);
  const mx = m.getContext("2d");
  const id = mx.createImageData(W, H);
  let skyN = 0;
  for (let i = 0; i < N; i++) {
    const v = sure[i] ? 255 : (maybe[i] ? (over[i] ? 170 : 90) : 0);
    if (cls[i]) skyN++;
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = 255;
  }
  mx.putImageData(id, 0, 0);

  /* Universality guard. Not every photo has sky in it, and a fill seeded from
     the top of an interior or a close-up will happily flood the whole frame.
     Score what was found: sky should be a sensible share of the image, and
     brighter and less saturated than the scene as a whole. A low score scales
     the sky treatment down instead of wrecking the picture. */
  const frac = skyN / N;
  /* Scoring sky by "bright and desaturated" fails the moment a scene has a
     sunset in it — that is saturated, and it is still sky. And penalising a
     large detected fraction punishes photographs that genuinely are mostly
     sky. Both were false negatives on real images.

     Smoothness, height in frame, and brightness relative to the REST of the
     picture hold up regardless of colour: sky has little texture, sits above
     the horizon, and is lighter than what it silhouettes. */
  let skyL = 0, skyG = 0, skyY = 0, sn = 0;
  let othL = 0, othG = 0, on = 0;
  for (let i = 0; i < N; i++) {
    const y = (i / W) | 0;
    if (cls[i]) { skyL += lum[i]; skyG += grad[i]; skyY += y / H; sn++; }
    else { othL += lum[i]; othG += grad[i]; on++; }
  }
  /* Deliberately biased towards precision over recall.

     Benchmarked on twelve labelled photographs, the previous scoring got
     every sky scene right and every NO-sky scene wrong — it never once
     said "no sky". An indoor ceiling is smoother and brighter than the
     cluttered room beneath it, exactly like sky over a street; a tabletop
     backdrop and a bright sky are not separable on local statistics, which
     the same measurement showed earlier for a sunset against rusted metal.

     So this no longer tries to be clever. It demands strong evidence —
     the region must be markedly brighter AND markedly smoother than the
     rest of the picture — and otherwise reports nothing. That trades away
     detections on hard-but-real skies, which cost one tap to add by hand,
     to avoid confidently wrecking a photograph that has no sky in it,
     which is silent and much worse. */
  let conf = 0;
  if (frac >= 0.004 && frac <= 0.985 && sn && on) {
    const brightGap = (skyL / sn) - (othL / on);
    const smoothRatio = ((othG / on) || 1e-6) / ((skyG / sn) || 1e-6);
    const higher = clamp((0.62 - (skyY / sn)) / 0.30, 0, 1);
    const bScore = clamp((brightGap - 0.16) / 0.22, 0, 1);
    const sScore = clamp((smoothRatio - 1.35) / 1.1, 0, 1);
    conf = Math.min(bScore, sScore) * (0.55 + 0.45 * higher);   // both, not either
    if (frac > 0.80) conf *= clamp((0.985 - frac) / 0.18, 0, 1); // a runaway fill
  }
  m._skyConfidence = conf;
  m._skyFraction = frac;

  return m;   // the trimap goes out raw; softening happens after matting
}

/* Replace the sky, sink the ground into night, and leave artificial light
   burning. One pass, so a lamp is only evaluated once. */
function applyNight(id, W, H, skyData, N) {
  const k = (N.amount || 0) / 100;
  if (!k) return id;
  const d = id.data;
  const keep = (N.lampWarmth || 0) / 100;
  const dark = (N.skyDark || 0) / 100;
  const glow = (N.horizonGlow || 0) / 100;

  // Find where the sky ends, so the gradient spans the sky rather than the frame.
  let skyBottom = 0;
  if (skyData) {
    for (let y = H - 1; y >= 0; y--) {
      let hit = 0;
      for (let x = 0; x < W; x += Math.max(1, W >> 6)) if (skyData[(y * W + x) * 4] > 128) { hit++; break; }
      if (hit) { skyBottom = y; break; }
    }
  }
  skyBottom = Math.max(skyBottom, H * 0.12);

  const hue = ((N.skyHue || 220) % 360) / 360;
  const tint = hsl2rgb(hue, clamp((N.skySat ?? 22) / 100, 0, 1), 0.5);
  const keepCloud = (N.skyDetail ?? 70) / 100;

  /* Crucially the sky is re-exposed, not painted over. An overcast sky has
     real cloud structure in it; replacing it with a flat gradient throws
     that away and looks like a sticker. So we take the sky's OWN luminance,
     normalise it against its own range, and remap that into a night range —
     the clouds survive, they just live in the dark now. */
  let sLo = 0, sHi = 1;
  if (skyData) {
    const samp = [];
    const stride = Math.max(4, ((W * H) / 12000) | 0) * 4;
    for (let i = 0; i < d.length; i += stride) {
      if (skyData[i] > 140) samp.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    }
    if (samp.length > 32) {
      samp.sort((a, b) => a - b);
      sLo = samp[(samp.length * 0.04) | 0] / 255;
      sHi = samp[(samp.length * 0.97) | 0] / 255;
      if (sHi - sLo < 0.02) { sLo = Math.max(0, sLo - 0.05); sHi = sLo + 0.1; }
    }
  }
  const lo = 0.012 + (1 - dark) * 0.055;
  const hi = 0.085 + (1 - dark) * 0.30;

  for (let y = 0; y < H; y++) {
    const t = clamp(y / skyBottom, 0, 1);
    const vert = 0.62 + t * 0.62;               // zenith darker than horizon
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const sky = skyData ? skyData[i] / 255 : 0;
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;

      let sr = 0, sg = 0, sb = 0;
      if (sky > 0) {
        const norm = clamp((L - sLo) / Math.max(0.02, sHi - sLo), 0, 1);
        const shaped = 1 - Math.pow(1 - norm, 1 + keepCloud * 1.6);   // keep cloud separation
        const nl = (lo + shaped * (hi - lo)) * vert;
        sr = tint[0] * nl * 2.0; sg = tint[1] * nl * 2.0; sb = tint[2] * nl * 2.0;
      }

      // Ground: how lamp-like is this pixel? Warm AND bright AND saturated.
      // Chroma is what separates a real lamp from blown sky: sky is close to
      // neutral, sodium light is not. Without this test, sky slivers that
      // fall on the ground side of the matte get "protected" as if they were
      // lamps and survive as a pale fringe around aerials and rooflines.
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const chroma = mx > 0.02 ? (mx - mn) / mx : 0;
      const warm = clamp((r - b) * 2.4, 0, 1)
                 * clamp((L - 0.34) / 0.66, 0, 1)
                 * clamp((chroma - 0.10) / 0.30, 0, 1);
      const protect = warm * keep;
      const kk = k * (1 - sky) * (1 - protect * 0.88);

      if (kk > 0) {
        // Real night has skylight fill: shadows go dark, not to zero. Without
        // a floor the foreground of every scene blocks up solid black.
        const amb = (N.ambient ?? 22) / 100;
        /* A uniform multiplier keeps bright things proportionally bright: white
           aerial hardware at 240 halves to 120 while the sky lands near 46, so
           it reads as if something is shining on it. But it is bright because
           of DAYLIGHT, and at night there is no daylight to reflect. Compress
           the highlights of unlit ground hard — anything genuinely lit is
           already excluded by the lamp protection above, and the placeable
           lights are applied after this, so real light still lands. */
        const dayHi = clamp((L - 0.25) / 0.75, 0, 1);
        const noSun = 1 - kk * dayHi * ((N.killDaylight ?? 78) / 100) * (1 - protect);
        const mul = (1 - kk * 0.74 * (1 - amb * 0.42)) * noSun;
        r *= mul; g *= mul; b *= mul;
        const L2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r += (L2 - r) * kk * 0.5;            // night vision desaturates…
        g += (L2 - g) * kk * 0.5;
        b += (L2 - b) * kk * 0.5;
        // …and shifts blue, hardest in the deepest shadow. Warm highlights
        // against cool shadow is what gives a night frame its depth; a flat
        // sepia wash over everything is what kills it.
        const deep = 1 - clamp(L2 / 0.42, 0, 1);
        const cool = kk * deep * ((N.shadowCool ?? 18) / 100) * 0.30;
        b += cool; r -= cool * 0.7; g -= cool * 0.2;
        const fill = amb * kk * 0.16;                // cool skylight in the shade
        r += fill * 0.72; g += fill * 0.85; b += fill;
        const lit = clamp((L2 - 0.30) / 0.70, 0, 1);
        const warm = kk * lit * ((N.lightWarm ?? 55) / 100) * 0.16;
        r += warm; g += warm * 0.42; b -= warm * 0.28;
      }
      if (sky > 0) {
        const ks = k * sky;
        r += (sr - r) * ks; g += (sg - g) * ks; b += (sb - b) * ks;
        if (glow) {
          // Light pollution comes from somewhere, not from everywhere: bias it
          // to one side and let it fall off, the way sodium glow really sits.
          const side = (N.glowSide ?? 50) / 100;
          const lateral = 1 - Math.abs(x / W - side) * 1.5;
          const prof = Math.pow(t, 2.0) * (1 - Math.pow(clamp(t, 0, 1), 7));
          const gl = glow * ks * prof * 1.9 * clamp(lateral, 0, 1);
          r += gl * 0.42; g += gl * 0.25; b += gl * 0.10;
        }
      }
      d[i]     = r <= 0 ? 0 : r >= 1 ? 255 : r * 255;
      d[i + 1] = g <= 0 ? 0 : g >= 1 ? 255 : g * 255;
      d[i + 2] = b <= 0 ? 0 : b >= 1 ? 255 : b * 255;
    }
  }
  return id;
}

function hsl2rgb(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/* ============================================================
   PLACEABLE LIGHTS

   A light is not a bright blob pasted on top. Adding colour uniformly
   washes a scene flat, because it lifts black brick exactly as much as
   white render. Real light *scales* what a surface already reflects, so
   the dominant term here is multiplicative: gain rides on the surface's
   own albedo, and a dark bin stays dark while pale brick lights up.

   A smaller additive term rides along for the air near the source — the
   haze around a lamp that genuinely does add light regardless of what's
   behind it.
   ============================================================ */
const LIGHT_TYPES = {
  lamp:      { name: "Lamp",      icon: "💡", hue: 34,  sat: 78, spread: 360 },
  sodium:    { name: "Streetlamp", icon: "🏮", hue: 26, sat: 92, spread: 360 },
  window:    { name: "Window",    icon: "🪟", hue: 40,  sat: 62, spread: 360 },
  headlight: { name: "Headlight", icon: "🚗", hue: 48,  sat: 22, spread: 46 },
  neon:      { name: "Neon",      icon: "🩵", hue: 190, sat: 88, spread: 360 },
  moon:      { name: "Moonlight", icon: "🌙", hue: 218, sat: 45, spread: 360 },
};
const newLight = (type = "sodium") => {
  const t = LIGHT_TYPES[type];
  return {
    id: uid("lt"), type, visible: true,
    x: 0.72, y: 0.3, radius: 42, intensity: 70,
    hue: t.hue, sat: t.sat, falloff: 55,
    beamAngle: 200, beamSpread: t.spread, airlight: 30,
    shadows: 100, shadowSoft: 45, depthGap: 22,
  };
};

/* ============================================================
   OCCLUSION — what stands between a surface and the lamp

   Until now a light reached every pixel within its radius, so a lamp
   behind a wall lit the far side of it and a subject standing under one
   cast nothing onto the ground. That flatness is what stops placed light
   reading as light rather than as a gradient.

   A photograph carries no depth, so this does not try to infer any. It
   ray-marches a 2D occluder buffer instead: subject cut-outs block by
   default, since an object standing in the scene plainly does, and
   anything else — a wall, a fence, a parked car — is painted with the
   same brush used for every other mask.

   The march runs at low resolution and is blurred afterwards. Shadows
   from an area source are soft, so nothing is lost, and it keeps a cost
   that would otherwise be prohibitive down to a few milliseconds.
   ============================================================ */
function occluderBuffer(w, h) {
  const S = state.scene;
  const c = cvOf(w, h);
  const x = c.getContext("2d");
  if (S.occluder) x.drawImage(S.occluder, 0, 0, w, h);   // hand-painted blockers

  // Subjects occlude on their own account.
  for (const L of S.layers) {
    if (!L.visible || L.blocksLight === false) continue;
    const sw = L.fw * w, sh = sw * (L.imgH / L.imgW);
    x.save();
    x.translate(L.fx * w, L.fy * h);
    x.rotate((L.rot * Math.PI) / 180);
    if (L.flipH) x.scale(-1, 1);
    x.drawImage(L.mask, -sw / 2, -sh / 2, sw, sh);
    x.restore();
  }
  const id = x.getImageData(0, 0, w, h);
  const occ = new Float32Array(w * h);
  for (let i = 0; i < occ.length; i++) occ[i] = id.data[i * 4] / 255;
  return occ;
}

/* ============================================================
   WINDOW DETECTION

   A night frame lives or dies on its lit windows — they are the thing the
   eye reads as "someone is in there". Finding them is a much narrower
   problem than finding sky, and one local statistics can actually do,
   because a window is not merely bright: it is bright *relative to the
   wall immediately around it*, compact, and roughly rectangular. A wall
   is none of those, and the sky is excluded outright.

   Detection returns regions rather than a mask, so each one can be lit,
   tinted and switched off individually.
   ============================================================ */
function detectWindows(opts = {}) {
  const S = state.scene;
  if (!S.base.img) return [];
  const maxDim = 700;
  const w0 = S.base.img.naturalWidth, h0 = S.base.img.naturalHeight;
  const s = Math.min(1, maxDim / Math.max(w0, h0));
  const W = Math.max(8, Math.round(w0 * s)), H = Math.max(8, Math.round(h0 * s));

  const c = cvOf(W, H);
  c.getContext("2d").drawImage(S.base.img, 0, 0, W, H);
  const D = c.getContext("2d").getImageData(0, 0, W, H).data;
  const sky = skyDataAt(W, H);

  const N = W * H;
  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const j = i * 4;
    L[i] = (0.2126 * D[j] + 0.7152 * D[j + 1] + 0.0722 * D[j + 2]) / 255;
  }
  // Local background = the wall around it, at a scale bigger than a window.
  const bg = Float32Array.from(L);
  boxBlur(bg, W, H, Math.max(4, Math.round(Math.min(W, H) / 16)), 1);

  const lift = (opts.sensitivity ?? 50) / 100;
  const thresh = 0.055 + (1 - lift) * 0.14;
  /* Windows are not bright. In a daytime photograph you are looking into an
     unlit interior, so a window is usually DARKER than the wall around it —
     searching for bright regions found mortar patches and a football while
     missing every curtained window on the terrace. What matters is that a
     window DIFFERS from its wall and is rectangular, in either direction. */
  const hit = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (sky[i * 4] > 110) continue;                 // never the sky
    if (Math.abs(L[i] - bg[i]) > thresh) hit[i] = 1;
  }

  // Connected components, then keep only what looks like a window.
  const lab = new Int32Array(N).fill(-1);
  const out = [];
  const minA = Math.max(18, N * (opts.minArea ?? 0.00022)), maxA = N * 0.03;
  const stack = [];
  for (let seed = 0; seed < N; seed++) {
    if (!hit[seed] || lab[seed] !== -1) continue;
    stack.length = 0; stack.push(seed);
    lab[seed] = out.length;
    let n = 0, minX = W, maxX = 0, minY = H, maxY = 0, sum = 0;
    const px = [];
    while (stack.length) {
      const i = stack.pop();
      const x = i % W, y = (i / W) | 0;
      n++; sum += L[i]; px.push(i);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && hit[i - 1] && lab[i - 1] === -1) { lab[i - 1] = out.length; stack.push(i - 1); }
      if (x < W - 1 && hit[i + 1] && lab[i + 1] === -1) { lab[i + 1] = out.length; stack.push(i + 1); }
      if (y > 0 && hit[i - W] && lab[i - W] === -1) { lab[i - W] = out.length; stack.push(i - W); }
      if (y < H - 1 && hit[i + W] && lab[i + W] === -1) { lab[i + W] = out.length; stack.push(i + W); }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = n / (bw * bh);
    const aspect = bw / bh;
    if (n < minA || n > maxA) continue;
    if (bw < 5 || bh < 5) continue;
    if (fill < (opts.fill ?? 0.55)) continue;                       // a window fills its box
    if (aspect < 0.22 || aspect > 4.5) continue;     // not a long thin smear

    /* Rectangularity. Bright mortar, litter and a football all pass a
       fill-ratio test — they are blobs that happen to fill their bounding
       box. A window is a RECTANGLE, so its rows are all the same width and
       its columns all the same height. Measuring how much those vary
       separates the two, and it is what stopped this detector boxing half
       the brickwork in the yard. */
    const rows = new Int32Array(bh), cols = new Int32Array(bw);
    for (const i of px) { rows[((i / W) | 0) - minY]++; cols[(i % W) - minX]++; }
    const cv = (arr) => {
      let m = 0; for (const v of arr) m += v; m /= arr.length;
      if (m <= 0) return 9;
      let s2 = 0; for (const v of arr) s2 += (v - m) * (v - m);
      return Math.sqrt(s2 / arr.length) / m;
    };
    if (cv(rows) > (opts.rect ?? 0.42) || cv(cols) > (opts.rect ?? 0.42)) continue;

    // And it must differ meaningfully from the wall it sits in, either way.
    let bgSum = 0; for (const i of px) bgSum += bg[i];
    const delta = sum / n - bgSum / n;
    if (Math.abs(delta) < thresh * 1.15) continue;
    out.push({
      id: uid("win"),
      x: (minX + bw / 2) / W, y: (minY + bh / 2) / H,
      w: bw / W, h: bh / H,
      bright: sum / n, on: true,
    });
  }
  return out.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 80);
}

/* Depth. Without it the occluder march treats the whole photograph as one
   flat plane, so a shadow slides across the ground, up the far wall and over
   a mid wall as though they were coplanar — which is exactly what a yard
   with walls at three different distances makes obvious.

   No depth is inferred from the image. The default is a ground-plane prior
   (lower in frame is nearer), which is right for most outdoor scenes, and
   anything it gets wrong is painted: tap a wall, set how far away it is.
   Shadows then refuse to cross a large depth gap, so a subject standing in
   the foreground stops casting onto a building behind it. */
function depthBuffer(w, h) {
  const S = state.scene;
  const d = new Float32Array(w * h);
  if (S.depthMap) {
    const c = cvOf(w, h);
    c.getContext("2d").drawImage(S.depthMap, 0, 0, w, h);
    const id = c.getContext("2d").getImageData(0, 0, w, h).data;
    for (let i = 0; i < d.length; i++) d[i] = id[i * 4] / 255;
  } else {
    for (let y = 0; y < h; y++) {
      const near = Math.pow(y / Math.max(1, h - 1), 0.85);   // bottom of frame = nearest
      for (let x = 0; x < w; x++) d[y * w + x] = near;
    }
  }
  return d;
}

function shadowMapFor(occ, w, h, lxf, lyf, softness, depth, depthGap) {
  const vis = new Float32Array(w * h);
  const lx = lxf * w, ly = lyf * h;
  const maxSteps = 54;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dx = lx - x, dy = ly - y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1.5) { vis[i] = 1; continue; }
      const n = Math.min(maxSteps, Math.max(4, Math.ceil(dist / 1.5)));
      const stepLen = dist / (n + 1);
      let block = 0;
      /* A wall must not shadow itself. If this pixel is part of an occluder,
         walk out of that occluder first and only start accumulating beyond
         it — the face of a wall towards the lamp is lit, and only what lies
         past the wall is in shade. Without this the blocker shades its own
         surface and a painted building goes darker than the open ground. */
      let inside = occ[i] > 0.02;
      const dHere = depth ? depth[i] : 0;
      for (let s = 1; s <= n; s++) {
        const t = s / (n + 1);
        const sx = (x + dx * t) | 0, sy = (y + dy * t) | 0;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) break;
        const si = sy * w + sx;
        const o = occ[si];
        if (inside) { if (o <= 0.02) inside = false; continue; }
        if (o > 0.02 && depth) {
          /* An occluder only shadows a surface at a comparable distance. A
             person standing in the foreground does not darken a building
             several gardens behind them, and without this test the shadow
             smears across every wall in the frame regardless of depth. */
          const gap = Math.abs(depth[si] - dHere);
          if (gap > depthGap) continue;
        }
        if (o > 0.02) {
          /* Weight by the distance each step covers, not per step: otherwise a
             thin wall blocks fully up close and barely at all far away, purely
             because the ray is sampled the same number of times either way. */
          block += o * (1 - t * 0.55) * stepLen * 0.24;
          if (block >= 1) { block = 1; break; }
        }
      }
      vis[i] = 1 - clamp(block, 0, 1);
    }
  }
  boxBlur(vis, w, h, Math.max(1, Math.round((softness / 100) * Math.min(w, h) / 26)), 1);
  return vis;
}

function applyLights(id, W, H, lights, unit, skyData) {
  const live = lights.filter((l) => l.visible && l.intensity > 0);
  if (!live.length) return id;
  const d = id.data;

  /* One shadow map per light, at low resolution. Soft shadows do not need
     detail, and a full-resolution march would cost seconds. */
  const anyOcc = state.scene.occluder || state.scene.layers.some((L) => L.visible && L.blocksLight !== false);
  const sw2 = anyOcc ? Math.max(64, Math.min(240, Math.round(W / 8))) : 0;
  const sh2 = anyOcc ? Math.max(64, Math.round(sw2 * (H / W))) : 0;
  const occ = anyOcc ? occluderBuffer(sw2, sh2) : null;
  const dep = anyOcc ? depthBuffer(sw2, sh2) : null;

  // Precompute per-light constants so the inner loop stays cheap.
  const P = live.map((l) => {
    const rgb = hsl2rgb(((l.hue % 360) + 360) % 360 / 360, clamp(l.sat / 100, 0, 1), 0.5);
    const peak = Math.max(rgb[0], rgb[1], rgb[2]) || 1;
    return {
      cx: l.x * W, cy: l.y * H,
      R: Math.max(4, (l.radius / 100) * Math.max(W, H) * 0.9),
      k: l.intensity / 100,
      air: (l.airlight || 0) / 100,
      pow: 1 + (l.falloff / 100) * 3.2,
      r: rgb[0] / peak, g: rgb[1] / peak, b: rgb[2] / peak,
      cone: l.beamSpread < 359,
      dir: ((l.beamAngle || 0) * Math.PI) / 180,
      half: ((l.beamSpread || 360) / 2) * (Math.PI / 180),
      shadow: (occ && (l.shadows ?? 100) > 0)
        ? shadowMapFor(occ, sw2, sh2, l.x, l.y, l.shadowSoft ?? 45, dep, ((l.depthGap ?? 22) / 100))
        : null,
      shAmt: (l.shadows ?? 100) / 100,
    };
  });

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let gr = 0, gg = 0, gb = 0, ar = 0, ag = 0, ab = 0;
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        const dx = x - p.cx, dy = y - p.cy;
        const dist = Math.sqrt(dx * dx + dy * dy) / p.R;
        if (dist > 3.2) continue;
        let f = 1 / (1 + Math.pow(dist, p.pow) * 4);
        if (p.cone) {
          // A headlight is a cone: fall off toward the edge of the beam
          // rather than cutting a hard-edged wedge out of the frame.
          let a = Math.atan2(dy, dx) - p.dir;
          while (a > Math.PI) a -= Math.PI * 2;
          while (a < -Math.PI) a += Math.PI * 2;
          const t = clamp(1 - Math.abs(a) / p.half, 0, 1);
          f *= t * t * (3 - 2 * t);
        }
        if (f <= 0.002) continue;
        if (p.shadow) {
          const sx2 = ((x / W) * sw2) | 0, sy2 = ((y / H) * sh2) | 0;
          const v = p.shadow[clamp(sy2, 0, sh2 - 1) * sw2 + clamp(sx2, 0, sw2 - 1)];
          f *= 1 - (1 - v) * p.shAmt;
        }
        if (f <= 0.002) continue;
        const s = f * p.k;
        gr += p.r * s; gg += p.g * s; gb += p.b * s;
        if (p.air) {
          const h = f * f * p.k * p.air;
          ar += p.r * h; ag += p.g * h; ab += p.b * h;
        }
      }
      if (gr + gg + gb + ar + ag + ab < 0.0015) continue;
      const i4 = (y * W + x) * 4;
      // A lamp lights surfaces, not the clouds. Without this the sky picks
      // up the full falloff and the whole frame reads as a sunset instead of
      // a lit street. A little haze still reaches it, so it isn't cut to zero.
      if (skyData) {
        const sky = skyData[i4] / 255;
        if (sky > 0.004) {
          const keepS = 1 - sky * 0.93, keepA = 1 - sky * 0.72;
          gr *= keepS; gg *= keepS; gb *= keepS;
          ar *= keepA; ag *= keepA; ab *= keepA;
        }
      }
      let r = d[i4] / 255, g = d[i4 + 1] / 255, b = d[i4 + 2] / 255;
      /* Gain alone drives anything bright near a lamp straight past 1 and it
         clips flat white — a subject standing under a light lost its whole
         upper body. Roll the result off instead, so extra light keeps adding
         detail into the highlights instead of welding them shut. */
      r = r * (1 + gr * 2.6) + ar * 0.5;   // multiplicative on albedo…
      g = g * (1 + gg * 2.6) + ag * 0.5;   // …plus a little air
      b = b * (1 + gb * 2.6) + ab * 0.5;
      const peak2 = Math.max(r, g, b);
      if (peak2 > 0.72) {
        const rolled = 0.72 + (peak2 - 0.72) / (1 + (peak2 - 0.72) * 2.2);
        const k2 = rolled / peak2;
        r *= k2; g *= k2; b *= k2;
      }
      d[i4]     = r <= 0 ? 0 : r >= 1 ? 255 : r * 255;
      d[i4 + 1] = g <= 0 ? 0 : g >= 1 ? 255 : g * 255;
      d[i4 + 2] = b <= 0 ? 0 : b >= 1 ? 255 : b * 255;
    }
  }
  return id;
}

/* The scene rearranges itself around the light: every subject that is
   following it turns its shadow away from the source and lengthens it
   with distance, and the sky's glow slides to the light's side. */
function lightsDriveScene() {
  const S = state.scene;
  const key = S.lights
    .filter((l) => l.visible && l.intensity > 0)
    .sort((a, b) => b.intensity * b.radius - a.intensity * a.radius)[0];
  if (!key) return false;
  let touched = false;
  for (const L of S.layers) {
    if (L.shadowFollow === false) continue;
    const vx = L.fx - key.x, vy = L.fy - key.y;
    const len = Math.hypot(vx, vy) || 1e-4;
    // shadow offset direction is (-sin a, cos a), so solve for a
    L.shadow.angle = Math.round((((Math.atan2(-vx / len, vy / len) * 180) / Math.PI) % 360 + 360) % 360);
    L.shadow.length = Math.round(clamp(12 + len * 110, 5, 100));
    touched = true;
  }
  if (S.night.visible) S.night.glowSide = Math.round(clamp(key.x * 100, 0, 100));
  return touched;
}

/* Local "fix light" paint — desaturate, cool and pull down the highlights
   only where the user has brushed. This is what kills a warm rim glow that
   belongs to the photo the subject came from. */
function applyLocalFix(id, fixData, amount) {
  if (!amount) return id;
  const d = id.data, k = amount / 100;
  for (let i = 0; i < d.length; i += 4) {
    const t = (fixData[i] / 255) * k;
    if (t <= 0.002 || d[i + 3] === 0) continue;
    let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const hi = clamp((L - 0.28) / 0.72, 0, 1);       // bias to the lit rim
    const w = t * (0.5 + 0.5 * hi);
    r = r + (L - r) * w;                             // all the way to neutral if pushed
    g = g + (L - g) * w;
    b = b + (L - b) * w;
    const dark = 1 - w * (0.22 + 0.55 * hi);         // pull the glow down
    r *= dark; g *= dark; b *= dark;
    b += w * 0.055;                                  // and a touch cooler
    d[i] = clamp(r, 0, 1) * 255;
    d[i + 1] = clamp(g, 0, 1) * 255;
    d[i + 2] = clamp(b, 0, 1) * 255;
  }
  return id;
}

/* Guided filter — snap a coarse mask onto the real edges of an image.

   The sky matte is solved at low resolution and then blurred, which is
   exactly what puts a soft bright rim along every roofline: the blur
   carries sky over the top of the dark roof edge, and re-lighting turns
   that into a glow tracing the building. Blurring harder makes it worse.

   The fix is the same idea as the hair matting — let the photograph
   decide where the edge is. For each window this solves the linear model
   q = a·I + b that best explains the mask from the guide image, so the
   output follows the roofline to the pixel while staying smooth across
   flat sky. */
function guidedFilter(guide, mask, W, H, r, eps) {
  const N = W * H;
  const I = guide, p = mask;
  const Ip = new Float32Array(N), II = new Float32Array(N);
  for (let i = 0; i < N; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }

  const mI = Float32Array.from(I), mP = Float32Array.from(p);
  const mIp = Ip, mII = II;
  boxBlur(mI, W, H, r, 1); boxBlur(mP, W, H, r, 1);
  boxBlur(mIp, W, H, r, 1); boxBlur(mII, W, H, r, 1);

  const a = new Float32Array(N), b = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const varI = mII[i] - mI[i] * mI[i];
    const covIp = mIp[i] - mI[i] * mP[i];
    a[i] = covIp / (varI + eps);
    b[i] = mP[i] - a[i] * mI[i];
  }
  boxBlur(a, W, H, r, 1); boxBlur(b, W, H, r, 1);

  const q = new Float32Array(N);
  for (let i = 0; i < N; i++) q[i] = clamp(a[i] * I[i] + b[i], 0, 1);
  return q;
}

/* Sky detection is expensive, so it's cached against the image and the
   detection settings — not against the grade, which doesn't move the sky. */
function skyMask() {
  const S = state.scene;
  const sig = S.base.token + "|" + S.night.skyDetect + "|" + S.night.skyFeather;
  if (S._sky && S._sky.sig === sig) return S._sky.canvas;
  const canvas = detectSky(S.base.img, { threshold: S.night.skyDetect, feather: S.night.skyFeather });
  S._sky = { sig, canvas };
  return canvas;
}
function skyDataAt(W, H) {
  const S = state.scene;
  const sig = `${S.base.token}|${S.night.skyDetect}|${S.night.skyFeather}|${S.night.skyEdge}|${S.night.skyTighten}|${S.night.skyBurn}|${S.night.skyDodge}|${S.skyEditRev || 0}|${W}x${H}`;
  if (S._skyData && S._skyData.sig === sig) return S._skyData.data;

  // Refine at a working resolution: the guide only has to resolve the
  // roofline, and a full-resolution solve on an 8MP export is wasted work.
  const cap = 1500;
  const sc = Math.min(1, cap / Math.max(W, H));
  const w = Math.max(8, Math.round(W * sc)), h = Math.max(8, Math.round(H * sc));

  const mc = cvOf(w, h);
  mc.getContext("2d").drawImage(skyMask(), 0, 0, w, h);
  const md = mc.getContext("2d").getImageData(0, 0, w, h).data;

  const gc = cvOf(w, h);
  gc.getContext("2d").drawImage(S.base.img, 0, 0, w, h);
  const gd = gc.getContext("2d").getImageData(0, 0, w, h).data;

  const n = w * h;
  const guide = new Float32Array(n), mask = new Float32Array(n);
  const sure = new Uint8Array(n);            // 1 = sky, 2 = not sky, 0 = unknown
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    guide[i] = (0.2126 * gd[j] + 0.7152 * gd[j + 1] + 0.0722 * gd[j + 2]) / 255;
    const v = md[j];
    sure[i] = v > 200 ? 1 : (v < 55 ? 2 : 0);
    mask[i] = v > 200 ? 1 : (v < 55 ? 0 : (v > 128 ? 0.80 : 0.28));
  }
  const edge = (S.night.skyEdge ?? 70) / 100;
  const r = Math.max(2, Math.round((1.6 + (1 - edge) * 9) * Math.min(w, h) / 380));
  const eps = 0.0004 + Math.pow(1 - edge, 2) * 0.02;
  const q = guidedFilter(guide, mask, w, h, r, eps);
  // The filter leaves a soft ramp the width of its window. Partial sky gets
  // partially treated as ground, which reads as a dark halo hugging every
  // building. Steepening the ramp about its midpoint keeps the sub-pixel
  // edge the guide found while collapsing the transition to a few pixels.
  /* Appearance gate. Pushing the unknown band past the roofline is what
     stops sky being left on the ground side, but it also hands the solver a
     strip of building to decide about — and it was claiming some of it
     outright, measured at 4.7% of the brickwork with individual pixels fully
     opaque. Geometry alone cannot settle this: a pixel adjacent to sky is
     not sky if it looks nothing like it.

     So gate the solve on how far each pixel sits from the colour of the sky
     that was confidently found. Brickwork is many deviations away and gets
     rejected regardless of where the band reached. */
  let mr = 0, mg = 0, mb = 0, sn2 = 0;
  for (let i = 0; i < n; i++) {
    if (sure[i] !== 1) continue;
    const j = i * 4;
    mr += gd[j]; mg += gd[j + 1]; mb += gd[j + 2]; sn2++;
  }
  let gate = null;
  if (sn2 > 40) {
    mr /= sn2; mg /= sn2; mb /= sn2;
    let vv = 0;
    for (let i = 0; i < n; i++) {
      if (sure[i] !== 1) continue;
      const j = i * 4;
      const dr = gd[j] - mr, dg2 = gd[j + 1] - mg, db = gd[j + 2] - mb;
      vv += dr * dr + dg2 * dg2 + db * db;
    }
    const sd2 = Math.max(9, Math.sqrt(vv / sn2));
    gate = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      const dr = gd[j] - mr, dg2 = gd[j + 1] - mg, db = gd[j + 2] - mb;
      const dist = Math.sqrt(dr * dr + dg2 * dg2 + db * db) / sd2;
      gate[i] = clamp((3.2 - dist) / 1.6, 0, 1);      // within ~1.6σ keep, past ~3.2σ drop
    }
  }

  // Known regions are known: pin them, and let the solve stand only in the
  // unknown band. This is what stops the matte drifting off real edges.
  const bw = 0.07 + (1 - edge) * 0.33;
  const lo = 0.5 - bw, span = Math.max(1e-4, bw * 2);
  for (let i = 0; i < q.length; i++) {
    if (sure[i] === 1) { q[i] = 1; continue; }
    if (sure[i] === 2) { q[i] = 0; continue; }
    const t = clamp((q[i] - lo) / span, 0, 1);
    q[i] = t * t * (3 - 2 * t);
    if (gate) q[i] *= gate[i];          // geometry proposes, appearance disposes
  }

  /* Tighten pulls the matte in off the edge, feather softens it. Separate
     from "edge snap", which decides where the edge IS — this decides how
     hard it lands once found. */
  const tighten = (S.night.skyTighten ?? 0) / 100;
  if (tighten > 0) {
    const t0 = tighten * 0.55;
    for (let i = 0; i < n; i++) q[i] = clamp((q[i] - t0) / Math.max(0.05, 1 - t0), 0, 1);
  } else if (tighten < 0) {
    const g0 = -tighten * 0.5;
    for (let i = 0; i < n; i++) q[i] = clamp(q[i] * (1 + g0) , 0, 1);
  }

  if (S.night.skyBurn || S.night.skyDodge) {
    const { bp, span } = dodgeBurnLevels(S.night.skyBurn, S.night.skyDodge);
    for (let i = 0; i < n; i++) q[i] = clamp((q[i] - bp) / span, 0, 1);
  }

  const out = cvOf(w, h);
  const oid = out.getContext("2d").createImageData(w, h);
  for (let i = 0; i < n; i++) {
    const v = q[i] * 255;
    oid.data[i * 4] = oid.data[i * 4 + 1] = oid.data[i * 4 + 2] = v;
    oid.data[i * 4 + 3] = 255;
  }
  out.getContext("2d").putImageData(oid, 0, 0);

  const soften = (S.night.skyFeather ?? 30) / 100;
  let src2 = out;
  if (soften > 0.02) {
    const f = cvOf(w, h);
    const fx2 = f.getContext("2d");
    fx2.filter = `blur(${(soften * Math.min(w, h) / 150 + 0.3).toFixed(2)}px)`;
    fx2.drawImage(out, 0, 0);
    src2 = f;
  }

  const c = cvOf(W, H);
  c.getContext("2d").drawImage(src2, 0, 0, W, H);
  const data = c.getContext("2d").getImageData(0, 0, W, H).data;
  const conf = skyMask()._skyConfidence ?? 1;
  if (conf < 0.999) for (let i = 0; i < data.length; i += 4) data[i] *= conf;

  // Hand corrections sit ON TOP of the detection rather than inside it, so
  // re-detecting or moving the detection sliders never discards them.
  if (S.skyEdit) {
    const ec = cvOf(W, H);
    ec.getContext("2d").drawImage(S.skyEdit, 0, 0, W, H);
    const ed = ec.getContext("2d").getImageData(0, 0, W, H).data;
    for (let i = 0; i < data.length; i += 4) {
      const e = (ed[i] - 128) / 127;          // -1 remove, 0 neutral, +1 add
      if (e > 0.004) data[i] = data[i] + (255 - data[i]) * e;
      else if (e < -0.004) data[i] = data[i] * (1 + e);
    }
  }
  S._skyData = { sig, data };
  return data;
}
function drawStars(ctx, W, H, N) {
  const count = Math.round((N.stars / 100) * 1100);
  if (!count) return;
  const tmp = cvOf(W, H), tx = tmp.getContext("2d");
  const rnd = mulberry32((N.seed | 0) * 40503 + 991);
  for (let i = 0; i < count; i++) {
    const x = rnd() * W, y = rnd() * H;
    const b = 0.25 + rnd() * 0.75;
    const r = Math.max(0.4, (Math.min(W, H) / 1400) * (0.5 + rnd() * 1.6));
    tx.fillStyle = `rgba(255,255,${Math.round(232 + rnd() * 23)},${(b * 0.9).toFixed(3)})`;
    tx.beginPath(); tx.arc(x, y, r, 0, Math.PI * 2); tx.fill();
  }
  /* The sky mask stores its value in RGB with alpha opaque everywhere, so
     using it directly as a destination-in clip keeps everything — stars were
     landing on brickwork and wheelie bins. Convert it to alpha first. */
  const sd = skyDataAt(W, H);
  const clip = cvOf(W, H);
  const cx2 = clip.getContext("2d");
  const cid = cx2.createImageData(W, H);
  for (let i = 0; i < cid.data.length; i += 4) {
    cid.data[i] = cid.data[i + 1] = cid.data[i + 2] = 255;
    cid.data[i + 3] = sd[i];
  }
  cx2.putImageData(cid, 0, 0);
  tx.globalCompositeOperation = "destination-in";
  tx.drawImage(clip, 0, 0);
  ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.drawImage(tmp, 0, 0); ctx.restore();
}

/* Black silhouette of a sprite's alpha — the basis for both shadows. */
function silhouetteOf(sprite) {
  const c = cvOf(sprite.width, sprite.height);
  const x = c.getContext("2d");
  x.drawImage(sprite, 0, 0);
  x.globalCompositeOperation = "source-in";
  x.fillStyle = "#000";
  x.fillRect(0, 0, c.width, c.height);
  return c;
}

/* Opaque bounding box, used to ground the contact shadow at the subject's
   real feet rather than at the bottom of a mostly-empty PNG. */
function opaqueBounds(sprite) {
  const w = sprite.width, h = sprite.height;
  const step = Math.max(1, Math.floor(Math.max(w, h) / 220));
  const d = sprite.getContext("2d").getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (d[(y * w + x) * 4 + 3] > 24) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w, h, cx: w / 2, bottom: h };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, bottom: maxY };
}

/* Build (and cache) a layer's adjusted, matte-refined sprite at width `w`.
   Rotation/flip stay out of the cache so dragging never re-renders pixels. */
function spriteFor(L, w) {
  const sig = JSON.stringify([L.adj, L.matte, L.fixAmount, L.maskRev, Math.round(w)]);
  if (L._cache && L._cache.sig === sig) return L._cache;

  const W = Math.max(2, Math.round(w));
  const H = Math.max(2, Math.round(w * (L.imgH / L.imgW)));
  const base = cvOf(W, H);
  const bx = base.getContext("2d");
  bx.drawImage(L.src, 0, 0, W, H);
  if (L.decon) bx.drawImage(L.decon, 0, 0, W, H);   // spill-corrected edge over the original

  // The mask is the alpha — kept separate from the photo so it stays editable.
  const mc = cvOf(W, H);
  mc.getContext("2d").drawImage(L.mask, 0, 0, W, H);
  const mdRaw = mc.getContext("2d").getImageData(0, 0, W, H);
  dodgeBurnMask8(mdRaw.data, L.matte.burn, L.matte.dodge);
  const md = mdRaw.data;
  const id = bx.getImageData(0, 0, W, H);
  for (let i = 0; i < id.data.length; i += 4) id.data[i + 3] = md[i];

  applyAdjust(id, L.adj);
  if (L.fixAmount > 0 && L.fix) {
    const fc = cvOf(W, H);
    fc.getContext("2d").drawImage(L.fix, 0, 0, W, H);
    applyLocalFix(id, fc.getContext("2d").getImageData(0, 0, W, H).data, L.fixAmount);
  }
  bx.putImageData(id, 0, 0);

  let sprite = refineMatte(base, L.matte);

  if (L.adj.blur > 0) {
    const b = cvOf(sprite.width, sprite.height);
    const bc = b.getContext("2d");
    bc.filter = `blur(${(L.adj.blur / 100) * 12}px)`;
    bc.drawImage(sprite, 0, 0);
    sprite = b;
  }

  L._cache = { sig, sprite, silhouette: silhouetteOf(sprite), bounds: opaqueBounds(sprite) };
  return L._cache;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sortedLayers = () => [...state.scene.layers].sort((a, b) => a.z - b.z);

/* ---- The one renderer: preview and export both call this ---- */
/* ---------------------------------------------------------------------------
   Lighting transfer.

   Generative relighting is very good at deciding where light comes from and
   what colour it is, and very bad at leaving a photograph's own pixels alone —
   which is the whole complaint about it. Those two facts live at different
   spatial frequencies, so they can be separated: illumination varies slowly
   across a frame, while invented brick, smeared window frames and mangled
   text are all high-frequency.

   So take the relit version's ILLUMINATION and none of its detail. Blur both
   the composite and the relit reference until nothing is left but the light
   field, divide one by the other, and multiply that ratio back onto the real
   photograph. Every pixel of texture in the result is still the photograph's;
   only the light on it comes from elsewhere.

   Working in ratio rather than difference is what makes it behave like light:
   multiplying is what a light source does to a surface, so a dark surface
   stays dark and a bright one carries the change, instead of everything being
   shifted by the same amount and the blacks going milky.
--------------------------------------------------------------------------- */
function applyRelight(ctx, W, H, R) {
  // A medium working resolution is plenty: the output is a blurred field, and
  // solving it at export resolution is wasted work for an identical answer.
  const cap = 480;
  const sc = Math.min(1, cap / Math.max(W, H));
  const w = Math.max(8, Math.round(W * sc)), h = Math.max(8, Math.round(H * sc));

  const curC = cvOf(w, h), refC = cvOf(w, h);
  curC.getContext("2d").drawImage(ctx.canvas, 0, 0, w, h);
  /* The reference is stretched to the composite's frame rather than letter-
     boxed. Relighting apps commonly hand back a slightly different aspect
     ratio, and for a field this soft a small stretch is invisible, whereas a
     letterbox would put a hard band of "no change" down the edges. */
  refC.getContext("2d").drawImage(R.img, 0, 0, w, h);

  const cd = curC.getContext("2d").getImageData(0, 0, w, h).data;
  const rd = refC.getContext("2d").getImageData(0, 0, w, h).data;

  const n = w * h;
  const cur = new Float32Array(n * 3), ref = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) { cur[i * 3 + c] = cd[i * 4 + c]; ref[i * 3 + c] = rd[i * 4 + c]; }
  }

  /* Blur the LOGARITHM, not the value. Illumination is multiplicative, so the
     right average for it is geometric; an arithmetic blur lets one bright lamp
     pool drag up the whole neighbourhood it sits in, which shows up as a
     systematic lift of the surrounding shadow. Averaging in log space is the
     geometric mean, and it leaves the dark surround dark. */
  const lfloor = 3 + (R.protect / 100) * 22;
  for (let i = 0; i < n * 3; i++) {
    cur[i] = Math.log2(cur[i] + lfloor);
    ref[i] = Math.log2(ref[i] + lfloor);
  }
  const r = Math.max(2, Math.round((Math.min(w, h) * R.scale) / 100));
  boxBlur(cur, w, h, r, 3);
  boxBlur(ref, w, h, r, 3);
  boxBlur(cur, w, h, Math.max(1, r >> 1), 3);   // second pass ≈ gaussian, so the
  boxBlur(ref, w, h, Math.max(1, r >> 1), 3);   // field has no box artefacts in it
  for (let i = 0; i < n * 3; i++) {
    cur[i] = Math.pow(2, cur[i]) - lfloor;
    ref[i] = Math.pow(2, ref[i]) - lfloor;
  }

  /* The ratio blows up where the composite is near black — a pixel at 1 going
     to 40 is a ratio of 40. The guard belongs on the DENOMINATOR only. Adding
     the same floor to both, which is the obvious thing to write, drags every
     ratio toward 1 whenever either side is small, and that is a systematic
     lift of exactly the tones a night image most needs to keep: measured on a
     day-to-night field it put the 10th-percentile luminance at 20.9 where the
     target was 8.9, which is the milky-blacks look. */
  const floor = 3 + (R.protect / 100) * 22;
  const ratio = new Float32Array(n * 3);
  const colour = R.colour / 100;
  for (let i = 0; i < n; i++) {
    let lr = 0;
    for (let c = 0; c < 3; c++) {
      const q = clamp(ref[i * 3 + c] / Math.max(cur[i * 3 + c], floor), 0.02, 8);
      ratio[i * 3 + c] = q; lr += q;
    }
    lr /= 3;
    // colour < 100 keeps the reference's brightness but discards its cast,
    // for when the relight is well judged in light and wrong in white balance.
    if (colour < 1) for (let c = 0; c < 3; c++) ratio[i * 3 + c] = lr + (ratio[i * 3 + c] - lr) * colour;
  }

  applyLightField(ctx, W, H, ratio, w, h, R);
}

/* Take a low-frequency illumination ratio and put it on the picture. Shared by
   the imported relight and the locally solved one, so a field is applied the
   same way however it was arrived at. */
function applyLightField(ctx, W, H, ratio, w, h, R) {
  const n = w * h;
  /* Encode log2(ratio) so the canvas can do the smooth upscale to full size —
     a ratio field interpolates correctly in log space, not linear.

     What gets encoded is the ratio's deviation from its own geometric mean,
     with the mean carried alongside as an exact number. A day-to-night field
     spans about nine stops end to end, and 8 bits stretched across that is
     3.5% per level, coarse enough to band a smooth sky. Taking the overall
     exposure out first leaves only the spatial variation to quantise, so the
     scale can stay fine (1.7% per level) and the big exposure change is not
     quantised at all. */
  const gm = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.log2(ratio[i * 3 + c]);
    gm[c] = Math.pow(2, s / n);
  }
  const enc = cvOf(w, h);
  const ex = enc.getContext("2d");
  const eid = ex.createImageData(w, h);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      eid.data[i * 4 + c] = clamp(Math.round(128 + 42 * Math.log2(ratio[i * 3 + c] / gm[c])), 0, 255);
    }
    eid.data[i * 4 + 3] = 255;
  }
  ex.putImageData(eid, 0, 0);

  const up = cvOf(W, H);
  const ux = up.getContext("2d");
  ux.imageSmoothingEnabled = true; ux.imageSmoothingQuality = "high";
  ux.drawImage(enc, 0, 0, W, H);
  const ud = ux.getImageData(0, 0, W, H).data;

  const out = ctx.getImageData(0, 0, W, H);
  const od = out.data;
  const gmOut = gm;
  const amt = R.strength / 100;
  /* Deep shadow is where a relight most often goes wrong: it lifts blacks into
     grey haze and the frame loses its night. The obvious guard — roll the
     whole effect off in dark tones — is the wrong one, because in a
     day-to-night transfer the effect IS the darkening, so backing it off in
     the shadows keeps them daylight-bright. That was measured as the second
     half of the milky-blacks problem.

     So suppress the direction rather than the effect. Darkening always applies
     in full; brightening is what gets held back, and only where the plate is
     already dark. */
  const keep = R.keepDark / 100;
  for (let i = 0; i < od.length; i += 4) {
    const L = (0.2126 * od[i] + 0.7152 * od[i + 1] + 0.0722 * od[i + 2]) / 255;
    const dark = keep > 0 ? keep * clamp((0.30 - L) / 0.30, 0, 1) : 0;
    for (let c = 0; c < 3; c++) {
      let q = gmOut[c] * Math.pow(2, (ud[i + c] - 128) / 42);
      if (dark > 0 && q > 1) q = 1 + (q - 1) * (1 - dark);
      od[i + c] = clamp(od[i + c] * (1 + (q - 1) * amt), 0, 255);
    }
  }
  ctx.putImageData(out, 0, 0);
}

/* ---------------------------------------------------------------------------
   Solving the night locally.

   The imported relight proved the useful half of the idea: a low-frequency
   illumination field, multiplied onto real pixels, produces a believable
   relight with none of the invented texture. The generator was only ever
   supplying the FIELD. Everything else — the detail, the edges, the whole
   photograph — was already here.

   So build the field instead of borrowing it. This is a small renderer, and
   it can be, because the app already knows the scene: where the sky is, where
   the windows are, where the lights were placed, what occludes what.

   Two ideas carry it, and both are why a per-pixel grade could never work:

   · Take the daylight OUT before putting the night IN. The photograph's own
     low-frequency luminance is, to a good approximation, the daylight field
     that lit it. Dividing by it removes the sun's fingerprint — the reason a
     graded night keeps looking like a dim day is that this term is never
     removed, so every sunlit face stays proportionally bright.

   · Sky light falls off with depth into the scene. A surface high on a
     facade sees most of the sky; one under a balcony or down an alley sees
     almost none. Marching up each column to the nearest open sky gives that
     for free, and it is most of what makes a night street read as a street
     rather than a flat dark wall.
--------------------------------------------------------------------------- */
function solveNightField(ctx, W, H, NS) {
  const S = state.scene;
  const cap = 480;
  const sc = Math.min(1, cap / Math.max(W, H));
  const w = Math.max(8, Math.round(W * sc)), h = Math.max(8, Math.round(H * sc));
  const n = w * h;

  const pc = cvOf(w, h);
  pc.getContext("2d").drawImage(ctx.canvas, 0, 0, w, h);
  const pd = pc.getContext("2d").getImageData(0, 0, w, h).data;

  /* 1 — the daylight field currently in the picture. Low-frequency luminance
     conflates illumination with albedo, but albedo is broadband and roughly
     uncorrelated with position, so over a large blur it averages out and what
     is left is dominated by the light. Blurred in log space, because this is
     a multiplicative quantity. */
  const day = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    day[i] = Math.log2(0.2126 * pd[i * 4] + 0.7152 * pd[i * 4 + 1] + 0.0722 * pd[i * 4 + 2] + 8);
  }
  const rD = Math.max(3, Math.round(Math.min(w, h) * 0.13));
  boxBlur(day, w, h, rD, 1); boxBlur(day, w, h, rD >> 1, 1);
  let dmean = 0;
  for (let i = 0; i < n; i++) { day[i] = Math.pow(2, day[i]) - 8; dmean += day[i]; }
  dmean = Math.max(1, dmean / n);
  for (let i = 0; i < n; i++) day[i] = Math.max(0.06, day[i] / dmean);   // mean 1

  /* 2 — how much open sky each pixel can see. Marching up the column to the
     nearest sky pixel is a crude horizon, but it is the right crude one: it
     makes the top of a facade brighter than its base and puts genuine darkness
     under an archway, which is exactly the structure a flat grade lacks. */
  const skyA = new Float32Array(n);
  {
    const sd = skyDataAt(w, h);
    for (let i = 0; i < n; i++) skyA[i] = sd[i * 4] / 255;
  }
  const openness = new Float32Array(n);
  const canyon = Math.max(0.02, (NS.canyon / 100) * 0.9) * h;
  for (let x = 0; x < w; x++) {
    let dist = 0;
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      dist = skyA[i] > 0.5 ? 0 : dist + 1;
      openness[i] = Math.exp(-dist / canyon);
    }
  }
  /* Painted correction to how much sky a surface sees. The column march is a
     crude horizon and it has no idea about a recess, a soffit or a wall facing
     away, so this is where you say so. */
  const readPaint = (cv) => {
    if (!cv) return null;
    const c = cvOf(w, h);
    c.getContext("2d").drawImage(cv, 0, 0, w, h);
    return c.getContext("2d").getImageData(0, 0, w, h).data;
  };
  const openPd = readPaint(S.openPaint);
  if (openPd) {
    for (let i = 0; i < n; i++) {
      const e = (openPd[i * 4] - 128) / 127;
      if (e > 0.004) openness[i] = openness[i] + (1 - openness[i]) * e;
      else if (e < -0.004) openness[i] = openness[i] * (1 + e);
    }
  }

  /* 3 — the emitters. Windows and placed lights are the only things actually
     making light at night, and inverse-square is what makes the falloff read
     as light rather than as an airbrushed blob. */
  const em = new Float32Array(n * 3);
  /* Occlusion belongs in the field, not just in the drawn glow. A lamp behind
     a wall must not bounce light onto what is in front of the wall, and a
     subject standing in front of a window must leave its own dark side. The
     ray-march and the depth map are already built for the drawn lights, so
     the solve borrows them rather than inventing a second answer. */
  const anyOcc = !!(S.occluder || S.layers.some((L) => L.visible && L.blocksLight !== false));
  const ow = anyOcc ? Math.max(48, Math.min(200, Math.round(w / 2))) : 0;
  const oh = anyOcc ? Math.max(48, Math.round(ow * (h / w))) : 0;
  const occ = anyOcc ? occluderBuffer(ow, oh) : null;
  const dep = anyOcc ? depthBuffer(ow, oh) : null;

  const addEmitter = (fx, fy, rad, gain, hue, sat, shade) => {
    if (gain <= 0) return;
    const [er, eg, eb] = hsl2rgb((((hue % 360) + 360) % 360) / 360, clamp(sat / 100, 0, 1), 0.58);
    const cx = fx * w, cy = fy * h;
    const rr = Math.max(2, rad * Math.max(w, h));
    const reach = rr * 5;
    const vis = (shade && occ) ? shadowMapFor(occ, ow, oh, fx, fy, 45, dep, 0.22) : null;
    const x0 = Math.max(0, Math.floor(cx - reach)), x1 = Math.min(w - 1, Math.ceil(cx + reach));
    const y0 = Math.max(0, Math.floor(cy - reach)), y1 = Math.min(h - 1, Math.ceil(cy + reach));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        const d2 = (dx * dx + dy * dy) / (rr * rr);
        let f = gain / (1 + d2 * 5.5);
        if (f < 0.002) continue;
        const p = y * w + x;
        if (vis) {
          const vx = Math.min(ow - 1, (x * ow / w) | 0), vy = Math.min(oh - 1, (y * oh / h) | 0);
          f *= vis[vy * ow + vx];
        }
        const i = p * 3;
        em[i] += f * er; em[i + 1] += f * eg; em[i + 2] += f * eb;
      }
    }
  };

  const WN = S.windows;
  if (WN.visible && WN.list.length) {
    const rnd = mulberry32((WN.seed | 0) * 7919 + 41);
    const g = (NS.windowGain / 100) * 0.42;
    for (const win of WN.list) {
      if (!win.on) continue;
      const jit = 1 - (WN.variation / 100) * rnd();
      addEmitter(win.x, win.y, Math.max(win.w, win.h) * 0.9, g * jit, 34 + WN.warmth * 0.12, 55 + WN.warmth * 0.25, false);
    }
  }
  for (const lt of S.lights) {
    if (!lt.visible) continue;
    const t = LIGHT_TYPES[lt.type] || LIGHT_TYPES.sodium;
    addEmitter(lt.x, lt.y, (lt.radius / 100) * 0.32, (lt.intensity / 100) * (NS.lampGain / 100) * 1.15, t.hue, t.sat, (lt.shadows ?? 100) > 0);
  }

  /* 4 — assemble, and divide the daylight out. */
  const [sr, sg, sb] = hsl2rgb((((NS.skyHue % 360) + 360) % 360) / 360, clamp(NS.skySat / 100, 0, 1), 0.52);
  const skyAmb = (NS.skyAmbient / 100) * 0.30;
  const base = 0.010 + (NS.floorLevel / 100) * 0.055;
  const exposure = 1;   // set by the auto-exposure below, not by hand
  const ratio = new Float32Array(n * 3);
  const skyCol = [sr, sg, sb];
  for (let i = 0; i < n; i++) {
    const o = openness[i], d = day[i], s = skyA[i];
    for (let c = 0; c < 3; c++) {
      // ambient floor + sky light scaled by how much sky this pixel sees
      let lit = base + skyAmb * o * skyCol[c] + em[i * 3 + c];
      /* The sky itself is not a surface being lit — it IS the light. Give it
         the night sky's own value rather than dividing it by a daylight
         estimate it never had. */
      const surf = (lit / d) * exposure;
      const skyV = (base * 1.4 + skyAmb * 1.25 * skyCol[c]) * exposure / Math.max(0.25, d);
      ratio[i * 3 + c] = clamp(surf * (1 - s) + skyV * s, 0.008, 8);
    }
  }

  /* 5 — auto-expose. Without this the result lands wherever the scene's own
     brightness happens to put it: across six test photographs the same
     settings produced medians from 16 to 23 and crushed anywhere between
     0.03% and 5.8% of the frame, because a scene with more light in it to
     begin with ends up with more light in it at night, which is not how a
     camera works. Aim the solved base at a median instead, and the exposure
     slider becomes a statement about the picture rather than about the file. */
  {
    const pred = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const pl = 0.2126 * pd[i * 4] + 0.7152 * pd[i * 4 + 1] + 0.0722 * pd[i * 4 + 2];
      const rl = 0.2126 * ratio[i * 3] + 0.7152 * ratio[i * 3 + 1] + 0.0722 * ratio[i * 3 + 2];
      pred[i] = pl * rl;
    }
    /* Painted light goes on before the auto-exposure reads the frame, so
       brushing a wall brighter moves that wall rather than quietly stopping
       the rest of the picture down to compensate. */
    const lightPd = readPaint(S.lightPaint);
    if (lightPd) {
      for (let i = 0; i < n; i++) {
        const e = (lightPd[i * 4] - 128) / 127;
        if (Math.abs(e) < 0.004) continue;
        const g2 = Math.pow(2, e * 2.6);       // +/- 2.6 stops at full brush
        for (let c = 0; c < 3; c++) ratio[i * 3 + c] = clamp(ratio[i * 3 + c] * g2, 0.006, 10);
        pred[i] *= g2;
      }
    }
    const srt = Array.from(pred).sort((a, b) => a - b);
    const med = Math.max(0.5, srt[srt.length >> 1]);
    const target = 5 + (NS.exposure / 100) * 40;
    const k = clamp(target / med, 0.02, 40);
    for (let i = 0; i < n * 3; i++) ratio[i] = clamp(ratio[i] * k, 0.006, 10);
  }
  return { ratio, w, h };
}

function renderComposite(targetW, opts = {}) {
  const S = state.scene;
  const base = S.base.img;
  if (!base) return null;
  const aspect = base.naturalHeight / base.naturalWidth;
  const W = Math.max(1, Math.round(targetW));
  const H = Math.max(1, Math.round(W * aspect));
  const cv = cvOf(W, H);
  const ctx = cv.getContext("2d");
  const unit = Math.min(W, H) / 100;

  /* 1 — main image */
  ctx.drawImage(base, 0, 0, W, H);
  if (opts.baseOnly) return cv;
  if (!S.base.visible) { ctx.clearRect(0, 0, W, H); ctx.fillStyle = "#101216"; ctx.fillRect(0, 0, W, H); }
  else {
    const id = ctx.getImageData(0, 0, W, H);
    applyAdjust(id, S.base.adj);
    const NG = S.night;
    const nightOn = NG.visible && NG.amount > 0;
    if (nightOn) applyNight(id, W, H, skyDataAt(W, H), NG);
    ctx.putImageData(id, 0, 0);
    if (nightOn && NG.stars > 0) drawStars(ctx, W, H, NG);
  }

  /* 2 — subject cutouts */
  for (const L of sortedLayers()) {
    if (!L.visible) continue;
    const w = Math.max(2, L.fw * W);
    const { sprite, silhouette, bounds } = spriteFor(L, Math.min(w, 2600));
    const sw = w, sh = w * (sprite.height / sprite.width);
    const cx = L.fx * W, cy = L.fy * H;
    const rad = (L.rot * Math.PI) / 180;
    const sc = sw / sprite.width;
    const sd = L.shadow;

    const place = (drawFn) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rad);
      if (L.flipH) ctx.scale(-1, 1);
      drawFn(-sw / 2, -sh / 2);
      ctx.restore();
    };

    /* contact shadow — an ellipse at the subject's feet, in scene space so
       it stays glued to the ground when the sprite is rotated */
    if (sd.on && sd.contact > 0) {
      const footY = cy + (bounds.bottom * sc - sh / 2) * Math.cos(rad);
      const footX = cx + (bounds.cx * sc - sw / 2) * (L.flipH ? -1 : 1);
      const rx = Math.max(2, bounds.w * sc * 0.52);
      const ry = Math.max(1.5, rx * 0.17);
      const g = ctx.createRadialGradient(footX, footY, 0, footX, footY, Math.max(rx, ry));
      const alpha = (sd.contact / 100) * 0.72;
      g.addColorStop(0, `rgba(0,0,0,${alpha.toFixed(3)})`);
      g.addColorStop(0.55, `rgba(0,0,0,${(alpha * 0.42).toFixed(3)})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.save();
      ctx.translate(footX, footY);
      ctx.scale(1, ry / Math.max(rx, ry));
      ctx.translate(-footX, -footY);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(footX, footY, Math.max(rx, ry), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    /* cast shadow — silhouette pushed away from the light */
    if (sd.on && sd.length > 0 && sd.opacity > 0) {
      const a = (sd.angle * Math.PI) / 180;
      const dist = (sd.length / 100) * unit * 12;
      const dx = -Math.sin(a) * dist, dy = Math.cos(a) * dist;
      ctx.save();
      ctx.globalAlpha = sd.opacity / 100;
      ctx.filter = `blur(${((sd.soft / 100) * unit * 3 + 0.4).toFixed(2)}px)`;
      ctx.translate(dx, dy);
      place((x, y) => ctx.drawImage(silhouette, x, y, sw, sh));
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = L.opacity / 100;
    place((x, y) => ctx.drawImage(sprite, x, y, sw, sh));
    ctx.restore();
  }

  /* 2.5 — solve the night, BEFORE any source is drawn.

     Order is not a detail here. The lit windows and the placed lamps are
     night sources; running the solve after them would treat their glow as
     part of the daylight the solve is trying to remove, divide it away, and
     then spill what survived across the whole frame. So the scene is taken to
     night first, and the sources are lit on top of it — which is also the
     honest reading of what they are: the solve supplies the bounce those
     sources throw onto the surfaces around them, and the draws below supply
     the sources you can actually see. */
  const NS = S.nightSolve;
  if (NS.visible && NS.strength > 0) {
    const f = solveNightField(ctx, W, H, NS);
    applyLightField(ctx, W, H, f.ratio, f.w, f.h, { strength: NS.strength, keepDark: NS.keepDark });
  }

  /* Lit windows. Drawn before the placeable lights so a lamp still washes
     over them, and additively, because a window at night is a source rather
     than a bright surface. */
  const WIN = S.windows;
  if (WIN && WIN.visible && WIN.list.length) {
    const rnd = mulberry32((WIN.seed | 0) * 7919 + 13);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const win of WIN.list) {
      const jitter = 1 - (WIN.variation / 100) * rnd();   // not every room is equally lit
      if (!win.on) continue;
      const cx = win.x * W, cy = win.y * H;
      const ww = Math.max(2, win.w * W), wh = Math.max(2, win.h * H);
      const b2 = (WIN.brightness / 100) * jitter;
      const hue = 20 + (WIN.warmth / 100) * 40;
      // the pane itself
      const g = ctx.createLinearGradient(cx, cy - wh / 2, cx, cy + wh / 2);
      g.addColorStop(0, `hsla(${hue},85%,72%,${(0.95 * b2).toFixed(3)})`);
      g.addColorStop(1, `hsla(${hue},90%,58%,${(0.72 * b2).toFixed(3)})`);
      ctx.fillStyle = g;
      ctx.fillRect(cx - ww / 2, cy - wh / 2, ww, wh);
      // light thrown onto the wall around it
      if (WIN.spill > 0) {
        const r2 = Math.max(ww, wh) * (0.7 + (WIN.spill / 100) * 2.4);
        const sg = ctx.createRadialGradient(cx, cy, Math.min(ww, wh) * 0.4, cx, cy, r2);
        sg.addColorStop(0, `hsla(${hue},88%,62%,${(0.42 * b2 * (WIN.spill / 100)).toFixed(3)})`);
        sg.addColorStop(1, `hsla(${hue},88%,55%,0)`);
        ctx.fillStyle = sg;
        ctx.beginPath(); ctx.arc(cx, cy, r2, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  /* 3 — placeable lights, after the subjects so they light them too */
  if (S.lights.length) {
    const lid = ctx.getImageData(0, 0, W, H);
    applyLights(lid, W, H, S.lights, unit, S.night.visible && S.night.amount > 0 ? skyDataAt(W, H) : null);
    ctx.putImageData(lid, 0, 0);
  }

  /* 4 — glow specks (fireflies, embers, dust catching the light).
     Additive, so they read as emitted light rather than pasted dots. */
  const G = S.glow;
  if (G.visible && G.count > 0) {
    const rnd = mulberry32((G.seed | 0) * 2654435761 + 12345);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < G.count; i++) {
      const sx = (rnd() - 0.5) * (G.spread / 100) * 1.15;
      const sy = (rnd() - 0.5) * (G.spread / 100) * 0.85;
      const x = W * (0.5 + sx);
      const y = H * (G.cy / 100 + sy);
      if (x < -50 || x > W + 50 || y < -50 || y > H + 50) continue;
      const depth = rnd();                                  // near specks are bigger and brighter
      const r = Math.max(1.5, unit * (G.size / 100) * (0.35 + depth * 1.5));
      const b = (G.intensity / 100) * (0.3 + depth * 0.7);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0,    `hsla(${G.hue},72%,94%,${(0.95 * b).toFixed(3)})`);
      g.addColorStop(0.18, `hsla(${G.hue},95%,66%,${(0.62 * b).toFixed(3)})`);
      g.addColorStop(0.45, `hsla(${G.hue},95%,54%,${(0.20 * b).toFixed(3)})`);
      g.addColorStop(1,    `hsla(${G.hue},95%,50%,0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      if (depth > 0.72) {                                    // hot core on the near ones
        ctx.fillStyle = `hsla(${G.hue},60%,97%,${(0.9 * b).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(x, y, Math.max(0.6, r * 0.11), 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  /* 5 — texture overlay */
  const ov = S.overlay;
  if (ov.img && ov.visible && ov.opacity > 0) {
    const ow = ov.img.naturalWidth, oh = ov.img.naturalHeight;
    const swap = ov.rot === 90 || ov.rot === 270;
    const natW = swap ? oh : ow, natH = swap ? ow : oh;
    const scale = Math.max(W / natW, H / natH); // cover
    const dw = natW * scale, dh = natH * scale;

    let tex = cvOf(dw, dh);
    const tx = tex.getContext("2d");
    tx.translate(dw / 2, dh / 2);
    tx.rotate((ov.rot * Math.PI) / 180);
    if (ov.flipH) tx.scale(-1, 1);
    tx.drawImage(ov.img, (-ow * scale) / 2, (-oh * scale) / 2, ow * scale, oh * scale);

    const tid = tx.getImageData(0, 0, tex.width, tex.height);
    applyAdjust(tid, ov.adj);
    tx.putImageData(tid, 0, 0);

    ctx.save();
    ctx.globalCompositeOperation = ov.blend;
    ctx.globalAlpha = ov.opacity / 100;
    ctx.drawImage(tex, (W - dw) / 2, (H - dh) / 2);
    ctx.restore();
  }

  /* Mask overlay — the mask has to be visible to be edited with any
     confidence, so it paints over the composite in red while brushing. */
  if (state.brush.on && state.brush.showMask && S.base.img) {
    let md = null;
    if (state.brush.target === "sky") md = skyDataAt(W, H);
    else if (state.brush.target === "blocker" || state.brush.target === "depth") {
      const srcC = state.brush.target === "depth" ? ensureDepth() : ensureOccluder();
      const oc = cvOf(W, H); oc.getContext("2d").drawImage(srcC, 0, 0, W, H);
      md = oc.getContext("2d").getImageData(0, 0, W, H).data;
    }
    else {
      const L = S.layers.find((x) => x.id === S.selectedId) || (S.layers.length === 1 ? S.layers[0] : null);
      if (L) {
        const mc = cvOf(W, H);
        const w2 = Math.max(2, L.fw * W), h2 = w2 * (L.imgH / L.imgW);
        const cx2 = L.fx * W, cy2 = L.fy * H;
        const mx3 = mc.getContext("2d");
        mx3.save(); mx3.translate(cx2, cy2); mx3.rotate((L.rot * Math.PI) / 180);
        if (L.flipH) mx3.scale(-1, 1);
        mx3.drawImage(L.mask, -w2 / 2, -h2 / 2, w2, h2); mx3.restore();
        md = mx3.getImageData(0, 0, W, H).data;
      }
    }
    if (md) {
      const om = cvOf(W, H);
      const oid = om.getContext("2d").createImageData(W, H);
      for (let i = 0; i < oid.data.length; i += 4) {
        oid.data[i] = 255; oid.data[i + 1] = 40; oid.data[i + 2] = 90;
        oid.data[i + 3] = md[i] * 0.42;
      }
      om.getContext("2d").putImageData(oid, 0, 0);
      ctx.drawImage(om, 0, 0);
    }
  }

  /* Sky mask inspector — draw it over everything so it can be judged */
  if (S.showSky && S.base.img) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.globalCompositeOperation = "screen";
    // The mask carries sky in its RGB with alpha opaque everywhere, so it has
    // to be converted to alpha before it can tint anything.
    const m = cvOf(W, H); const mx2 = m.getContext("2d");
    const sd = skyDataAt(W, H);
    const mid = mx2.createImageData(W, H);
    for (let i = 0; i < mid.data.length; i += 4) {
      mid.data[i + 3] = sd[i];
      mid.data[i] = 255; mid.data[i + 1] = 59; mid.data[i + 2] = 127;
    }
    mx2.putImageData(mid, 0, 0);
    ctx.drawImage(m, 0, 0);
    ctx.restore();
  }

  /* 5.5 — lighting transfer from an imported relight */
  const RL = S.relight;
  if (RL.visible && RL.img && RL.strength > 0) applyRelight(ctx, W, H, RL);

  /* 6 — finish */
  const F = S.finish;
  if (F.visible) {
    if (F.vignette > 0) {
      const k = F.vignette / 100;
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.28, W / 2, H / 2, Math.max(W, H) * 0.78);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, `rgba(0,0,0,${(k * 0.82).toFixed(3)})`);
      ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore();
    }
    const blacks = (F.blacks || 0) / 100, shoulder = (F.shoulder || 0) / 100, fcon = (F.contrast || 0) / 100;
    if (F.grain > 0 || F.fade > 0 || blacks || shoulder || fcon) {
      const id = ctx.getImageData(0, 0, W, H);
      const d = id.data;
      const grain = F.grain / 100, fade = F.fade / 100;
      const lift = fade * 0.20, mul = 1 - fade * 0.16;
      const bp = blacks * 0.16;
      const sh = shoulder * 3.4;
      const knee = 0.42;
      const tone = (v) => {
        if (bp) v = (v - bp) / (1 - bp);              // set the black point
        if (v < 0) v = 0;
        if (sh && v > knee) v = knee + (v - knee) / (1 + sh * (v - knee));   // bend only the top
        if (fcon) {                                   // S-curve about the midtone
          const t = clamp(v, 0, 1);
          const s2 = t * t * (3 - 2 * t);
          v = v + (s2 - t) * fcon;
        }
        return v;
      };
      for (let i = 0; i < d.length; i += 4) {
        let r = d[i] / 255, g2 = d[i + 1] / 255, b = d[i + 2] / 255;
        if (bp || sh || fcon) { r = tone(r); g2 = tone(g2); b = tone(b); }
        if (fade) { r = r * mul + lift; g2 = g2 * mul + lift; b = b * mul + lift; }
        if (grain) {
          const L = 0.2126 * r + 0.7152 * g2 + 0.0722 * b;
          const n = (Math.random() - 0.5) * grain * 0.30 * (1 - Math.abs(clamp(L, 0, 1) * 2 - 1));
          r += n; g2 += n; b += n;
        }
        d[i]     = r <= 0 ? 0 : r >= 1 ? 255 : r * 255;
        d[i + 1] = g2 <= 0 ? 0 : g2 >= 1 ? 255 : g2 * 255;
        d[i + 2] = b <= 0 ? 0 : b >= 1 ? 255 : b * 255;
      }
      ctx.putImageData(id, 0, 0);
    }
  }
  return cv;
}

/* ============================================================
   HARMONIZE — read the scene, dial the subject to match
   ============================================================ */
/* Two deliberate choices here, both learned from real photos:

   Exposure/contrast come from the MEDIAN and the 16–84 percentile spread,
   not the mean and standard deviation. A blown-out sky or a subject in
   near-black clothing drags a mean around badly; the median doesn't care.

   The colour cast comes from NEAR-NEUTRAL pixels only, weighted by how grey
   they are. Saturated surfaces carry their own pigment, not the light in the
   room — averaging a scene's foliage and mossy concrete tells you the moss
   is green, and matching a person to it turns their skin green. Weighting
   toward greys estimates the illuminant instead, which is the thing the
   subject actually needs to agree with. */
function statsFrom(data, w, h, rect, alphaOnly) {
  const lum = [];
  let n = 0, sC = 0, wsum = 0, sRB = 0, sGM = 0;
  const x0 = clamp(Math.floor(rect.x), 0, w - 1), x1 = clamp(Math.ceil(rect.x + rect.w), 1, w);
  const y0 = clamp(Math.floor(rect.y), 0, h - 1), y1 = clamp(Math.ceil(rect.y + rect.h), 1, h);
  const step = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 160));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * w + x) * 4;
      if (alphaOnly && data[i + 3] < 200) continue;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      lum.push(L);
      n++; sC += chroma;
      // Greyer pixels vote harder on the illuminant; near-clipped ones abstain.
      const nw = Math.max(0, 1 - chroma / 0.40) * (L > 0.03 && L < 0.97 ? 1 : 0.15);
      wsum += nw; sRB += (r - b) * nw; sGM += (g - (r + b) / 2) * nw;
    }
  }
  if (!n) return null;
  lum.sort((a, b) => a - b);
  const at = (p) => lum[clamp(Math.round(p * (lum.length - 1)), 0, lum.length - 1)];
  const spread = Math.max(0.02, (at(0.84) - at(0.16)) / 2);
  const W_ = Math.max(1e-4, wsum);
  // Lhi is the exposure anchor: the brightest surfaces are the ones sitting
  // closest to white under the prevailing light, so they track illumination.
  // The median tracks albedo instead — anchoring on it forces a subject in
  // navy clothing up to the brightness of the concrete wall behind them.
  return { n, L: at(0.5), Lhi: at(0.88), std: spread, rb: sRB / W_, gm: sGM / W_, chroma: sC / n };
}

/* Where the subject sits, in the base image's own pixel space. */
function sceneRectFor(L, W, H) {
  const w = L.fw * W, h = w * (L.imgH / L.imgW);
  return { x: L.fx * W - w / 2, y: L.fy * H - h / 2, w, h };
}

/* The scene as it currently looks — the main image WITH its own grade baked
   in. Matching against the raw upload is wrong: the moment you grade the
   scene (or an auto edit does), the subject would be matching a scene that
   no longer exists.

   Overlay and Finish are deliberately excluded. They composite on top of the
   subject too, so they move both sides equally; folding them in here would
   double-count them. base.adj is the only thing that shifts the scene out
   from under the subject. */
function baseAnalysis() {
  const S = state.scene;
  const sig = S.base.token + "|" + JSON.stringify(S.base.adj) + "|" + JSON.stringify(S.night);
  if (S._an && S._an.sig === sig) return S._an;
  const W = 640, H = Math.max(1, Math.round(W * (S.base.img.naturalHeight / S.base.img.naturalWidth)));
  const c = cvOf(W, H);
  const x = c.getContext("2d");
  x.drawImage(S.base.img, 0, 0, W, H);
  const id = x.getImageData(0, 0, W, H);
  applyAdjust(id, S.base.adj);
  // Night moves the scene as surely as the grade does, so a subject that
  // follows the scene has to be matched against the night version of it.
  if (S.night.visible && S.night.amount > 0) applyNight(id, W, H, skyDataAt(W, H), S.night);
  S._an = { sig, W, H, data: id.data };
  return S._an;
}

function harmonizeLayer(L, strength = 0.85) {
  const S = state.scene;
  if (!S.base.img || !L) return false;
  const { W, H, data: bd } = baseAnalysis();

  // Sample the scene around the subject, not the whole frame — a subject
  // standing in shade should match the shade.
  const r = sceneRectFor(L, W, H);
  const pad = Math.max(r.w, r.h) * 0.45;
  const region = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
  const sceneStats = statsFrom(bd, W, H, region, false) || statsFrom(bd, W, H, { x: 0, y: 0, w: W, h: H }, false);

  const sw = 320, sh = Math.max(1, Math.round(sw * (L.imgH / L.imgW)));
  const sc = applyMask(L.src, L.mask, sw, sh);
  const sd = sc.getContext("2d").getImageData(0, 0, sw, sh).data;
  const subjStats = statsFrom(sd, sw, sh, { x: 0, y: 0, w: sw, h: sh }, true);

  if (!sceneStats || !subjStats) return false;

  const k = clamp(strength, 0, 1);
  const a = L.adj;
  // Invert each adjustment's own model so the numbers land where they should.
  // Each channel is damped by how trustworthy its signal is. Exposure and
  // temperature are solid. Tint is the dangerous one — a green cast on skin
  // reads as illness long before it reads as "matched" — and chroma between a
  // person and a landscape is barely comparable at all, so both are held back.
  a.exposure    = Math.round(clamp(Math.log2(Math.max(0.05, sceneStats.Lhi) / Math.max(0.05, subjStats.Lhi)) * 100 * k, -35, 35));
  a.contrast    = Math.round(clamp((sceneStats.std / Math.max(0.02, subjStats.std) - 1) * 100 * k * 0.7, -45, 45));
  a.temperature = Math.round(clamp(((sceneStats.rb - subjStats.rb) / 0.36) * 100 * k, -80, 80));
  a.tint        = Math.round(clamp((-(sceneStats.gm - subjStats.gm) / 0.15) * 100 * k * 0.55, -30, 30));
  a.saturation  = Math.round(clamp((sceneStats.chroma / Math.max(0.02, subjStats.chroma) - 1) * 100 * k * 0.45, -35, 35));
  L._cache = null;
  return true;
}

/* Re-match a layer that is still following the scene, then re-apply the
   current look's creative offset on top — so re-matching never wipes the
   look, and the look never freezes a stale match. */
function autoMatchLayer(L, force = false) {
  if (!L || (!L.autoMatch && !force)) return false;
  if (!harmonizeLayer(L, (L.matchStrength ?? 85) / 100)) return false;
  const look = LOOKS[state.scene.look];
  if (look) {
    Object.entries(look.subject).forEach(([k, v]) => {
      L.adj[k] = clamp((L.adj[k] || 0) + v, -100, 100);
    });
  }
  L._cache = null;
  return true;
}
function autoMatchAll() {
  let any = false;
  state.scene.layers.forEach((L) => { if (autoMatchLayer(L)) any = true; });
  return any;
}
/* A manual move on a subject's light/colour slider means the user has taken
   over — stop overwriting them from the scene. */
function breakFollow(L, card) {
  if (!L.autoMatch) return;
  L.autoMatch = false;
  const box = card && card.querySelector('input[data-follow="1"]');
  if (box) box.checked = false;
  const meta = card && card.querySelector(".lcard-meta");
  if (meta) meta.textContent = `${Math.round(L.fw * 100)}% · manual`;
  toast("Following the scene turned off for this subject — your values stick now.");
}

/* ============================================================
   TABS
   ============================================================ */
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  const isCut = tab === "cut";
  dom.cutStage.hidden = !isCut;
  dom.sceneStage.hidden = isCut;
  dom.cutToolbar.hidden = !isCut;
  dom.sceneToolbar.hidden = isCut;
  dom.cutPanel.hidden = !isCut;
  dom.scenePanel.hidden = isCut;
  dom.historyStrip.hidden = isCut || state.scene.versions.length === 0;
  renderLibrary();
  if (!isCut) requestAnimationFrame(() => { scheduleRender(); positionOverlay(); });
}

/* ============================================================
   CUT-OUT WORKSPACE
   ============================================================ */
async function cutSetSource(file) {
  try {
    const dataUrl = await fileToDataUrl(file);
    state.cut.file = file;
    state.cut.src = dataUrl;
    state.cut.result = null;
    dom.cutImg.src = dataUrl;
    dom.cutEmpty.hidden = true;
    dom.cutWrap.hidden = false;
    dom.cutRunBtn.disabled = false;
    dom.cutSaveBtn.disabled = true;
    dom.cutDownloadBtn.disabled = true;
    setCutTransformEnabled(true);
  } catch { toast("Couldn't read that image.", true); }
}
function setCutTransformEnabled(on) {
  dom.cutRotL.disabled = !on; dom.cutRotR.disabled = !on; dom.cutFlip.disabled = !on;
}
async function cutTransform(t) {
  const cur = state.cut.result || state.cut.src;
  if (!cur) return;
  const out = await transformDataUrl(cur, t);
  if (state.cut.result) { state.cut.result = out; } else { state.cut.src = out; }
  dom.cutImg.src = out;
}

async function runCut() {
  if (!state.cut.file || state.cut.busy) return;
  cutBusy(true, "Reading photo…");
  try {
    const pngBlob = await toPngBlob(state.cut.src);
    cutBusy(true, "Loading model…");
    const choice = CUT_MODELS[state.cut.model] || CUT_MODELS.fast;
    const note = (p) => {
      if (p && typeof p.progress === "number") dom.cutLoadingText.textContent = `Downloading ${choice.name} model… ${Math.round(p.progress)}%`;
    };

    let blob;
    if (window.__cpsRemoveBg) {
      blob = await window.__cpsRemoveBg(pngBlob, { output: { format: "image/png" } });
    } else if (choice.engine === "birefnet") {
      try {
        blob = await removeBackgroundBiRefNet(pngBlob, note);
      } catch (e) {
        console.warn("[cutout] BiRefNet unavailable, falling back:", e);
        toast("BiRefNet couldn't load — using the fast model instead.", true);
        blob = await runImgly(pngBlob, CUT_MODELS.fast);
      }
    } else {
      blob = await runImgly(pngBlob, choice);
    }
    const dataUrl = await blobToDataUrl(blob);
    state.cut.result = dataUrl;
    dom.cutImg.src = dataUrl;
    dom.cutSaveBtn.disabled = false;
    dom.cutDownloadBtn.disabled = false;
    toast("Background removed ✓ — add it to your Library.");
  } catch (err) {
    console.error("[cutout] failed:", err);
    const m = (err && err.message) ? err.message : String(err);
    toast("Background removal couldn't run: " + m.slice(0, 100), true);
  } finally {
    cutBusy(false);
  }
}
async function runImgly(pngBlob, choice) {
  const removeBackground = await ensureImgly();
  return await removeBackground(pngBlob, {
    model: choice.model,
    output: { format: "image/png" },
    progress: (key, current, total) => {
      if (key && key.startsWith("fetch")) {
        const pct = total ? Math.round((current / total) * 100) : 0;
        dom.cutLoadingText.textContent = `Downloading model… ${pct}%`;
      } else {
        dom.cutLoadingText.textContent = "Removing background…";
      }
    },
  });
}

function cutBusy(b, text = "Removing background…") {
  state.cut.busy = b;
  dom.cutLoading.hidden = !b;
  dom.cutLoadingText.textContent = text;
  dom.cutRunBtn.disabled = b || !state.cut.file;
}
async function saveCutToLibrary() {
  if (!state.cut.result) return;
  try {
    const cutImg = await loadImage(state.cut.result);
    const srcImg = await loadImage(state.cut.src);
    const fullMask = maskFromAlpha(cutImg);

    // Trim to what's actually in the cutout. A subject that fills a quarter
    // of its own frame makes scaling, positioning and brushing all behave
    // as if the empty margin were part of the subject.
    const b = opaqueBounds(applyMask(cutImg, fullMask));
    const pad = Math.round(Math.max(b.w, b.h) * 0.02);
    const X = clamp(b.x - pad, 0, cutImg.naturalWidth - 1);
    const Y = clamp(b.y - pad, 0, cutImg.naturalHeight - 1);
    const W = clamp(b.w + pad * 2, 1, cutImg.naturalWidth - X);
    const H = clamp(b.h + pad * 2, 1, cutImg.naturalHeight - Y);

    const crop = (img) => {
      const c = cvOf(W, H);
      c.getContext("2d").drawImage(img, X, Y, W, H, 0, 0, W, H);
      return c;
    };
    // The untouched photo travels with the mask. Without it a restore brush
    // has nothing to paint back — removal zeroes the RGB it erases.
    const src = await fitDataUrl(crop(srcImg).toDataURL("image/png"), 1600, "image/jpeg", 0.9);
    const maskC = crop(fullMask);
    const mask = maskC.toDataURL("image/png");
    const th = 220 / Math.max(W, H);
    const thumbC = applyMask(await loadImage(src), maskC, Math.max(1, W * th), Math.max(1, H * th));
    const item = { id: uid("lib"), src, mask, thumb: thumbC.toDataURL("image/png"), w: W, h: H };
    state.library.push(item);
    await idbPut(item);
    renderLibrary();
    toast("Saved to Library ✓ — open Compose and tap it to place.");
  } catch (e) {
    console.error(e);
    toast("Couldn't save that cutout.", true);
  }
}

/* ============================================================
   LIBRARY
   ============================================================ */
async function persistLibrary() {
  for (const it of state.library) await idbPut(it);
}
async function loadLibrary() {
  const rows = await idbAll();
  if (rows && rows.length) { state.library = rows; return; }
  // Migrate anything saved by the old flattened-PNG version.
  try {
    const raw = localStorage.getItem("cps_library");
    if (!raw) return;
    const old = JSON.parse(raw) || [];
    for (const o of old) {
      if (!o.dataUrl) continue;
      const img = await loadImage(o.dataUrl);
      const item = {
        id: o.id, src: o.dataUrl, mask: maskFromAlpha(img).toDataURL("image/png"),
        thumb: o.dataUrl, w: img.naturalWidth, h: img.naturalHeight, legacy: true,
      };
      state.library.push(item); await idbPut(item);
    }
    localStorage.removeItem("cps_library");
  } catch {}
}
function renderLibrary() {
  dom.libCount.textContent = state.library.length;
  dom.libHint.hidden = state.library.length > 0;
  dom.libraryItems.innerHTML = "";
  if (!state.library.length) {
    const p = document.createElement("div"); p.className = "lib-empty";
    p.textContent = "No cutouts yet. Make one in the Cut Out tab.";
    dom.libraryItems.appendChild(p); return;
  }
  state.library.forEach((item) => {
    const d = document.createElement("div");
    d.className = "lib-item";
    d.dataset.id = item.id;
    d.title = state.tab === "scene" ? "Tap to place · drag to reorder" : "Drag to reorder · Compose tab to use";
    d.innerHTML = `<img src="${item.thumb || item.src}" alt="cutout" draggable="false" /><span class="lib-del" data-del="${item.id}">✕</span>`;
    d.addEventListener("pointerdown", (e) => startLibPointer(e, item, d));
    dom.libraryItems.appendChild(d);
  });
}

let libDrag = null;
function handleLibTap(item) {
  if (state.tab !== "scene") { setTab("scene"); toast("Switched to Compose — tap the cutout again to place it."); return; }
  if (!state.scene.base.img) { toast("Add the main image first.", true); return; }
  addLayerFromAsset(item);
}
function startLibPointer(e, item, elem) {
  if (e.target.dataset.del) {
    state.library = state.library.filter((x) => x.id !== item.id);
    idbDel(item.id); renderLibrary();
    return;
  }
  libDrag = { item, elem, startX: e.clientX, startY: e.clientY, moved: false };
  elem.setPointerCapture?.(e.pointerId);
  window.addEventListener("pointermove", onLibMove);
  window.addEventListener("pointerup", onLibUp);
}
function onLibMove(e) {
  if (!libDrag) return;
  if (!libDrag.moved) {
    if (Math.hypot(e.clientX - libDrag.startX, e.clientY - libDrag.startY) < 6) return;
    libDrag.moved = true;
    libDrag.elem.classList.add("dragging");
  }
  e.preventDefault();
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const target = under && under.closest(".lib-item");
  if (target && target !== libDrag.elem && target.parentElement === dom.libraryItems) {
    const rect = target.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    dom.libraryItems.insertBefore(libDrag.elem, before ? target : target.nextSibling);
  }
}
function onLibUp() {
  window.removeEventListener("pointermove", onLibMove);
  window.removeEventListener("pointerup", onLibUp);
  const d = libDrag; libDrag = null;
  if (!d) return;
  if (!d.moved) { handleLibTap(d.item); return; }
  d.elem.classList.remove("dragging");
  const order = [...dom.libraryItems.querySelectorAll(".lib-item")].map((elm) => elm.dataset.id);
  state.library.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  persistLibrary(); renderLibrary();
}

/* ============================================================
   SCENE WORKSPACE
   ============================================================ */
async function sceneSetBase(file) {
  try {
    const dataUrl = await fileToDataUrl(file);
    pushSceneVersion(dataUrl);
    state.scene.layers = []; state.scene.selectedId = null;
    dom.sceneEmpty.hidden = true; dom.sceneWrap.hidden = false;
    await showScene(dataUrl);
    status("Main image loaded. Tap a Library cutout to place your subject.");
  } catch { toast("Couldn't read that image.", true); }
}
function pushSceneVersion(dataUrl) {
  const v = { id: uid("sv"), dataUrl }; state.scene.versions.push(v); state.scene.currentId = v.id; renderHistory();
}
async function showScene(dataUrl) {
  state.scene.base.img = await loadImage(dataUrl);
  state.scene.base.token++;
  state.scene._an = null;
  state.scene._sky = null; state.scene._skyData = null;
  buildLayerStack(); scheduleRender(); positionOverlay(); updateSceneButtons();
}
async function setOverlay(file) {
  try {
    const dataUrl = await fileToDataUrl(file);
    const img = await loadImage(dataUrl);
    state.scene.overlay.dataUrl = dataUrl;
    state.scene.overlay.img = img;
    state.scene.overlay.visible = true;
    if (state.scene.overlay.opacity === 0) state.scene.overlay.opacity = 40;
    buildLayerStack(); scheduleRender();
    toast("Overlay added ✓ — set the blend mode and opacity in the Layers panel.");
  } catch { toast("Couldn't read that image.", true); }
}

/* ---- Preview rendering ---- */
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; drawPreview(); });
}
function drawPreview() {
  const S = state.scene;
  if (!S.base.img || dom.sceneWrap.hidden) return;
  const stage = dom.sceneStage.getBoundingClientRect();
  const aspect = S.base.img.naturalHeight / S.base.img.naturalWidth;
  const avail = { w: Math.max(80, stage.width - 32), h: Math.max(80, stage.height - 32) };
  let dispW = avail.w, dispH = dispW * aspect;
  if (dispH > avail.h) { dispH = avail.h; dispW = dispH / aspect; }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const renderW = Math.min(Math.round(dispW * dpr), 1800);

  const out = previewBase
    ? renderComposite(renderW, { baseOnly: true })
    : renderComposite(renderW);
  if (!out) return;
  const cv = dom.sceneCanvas;
  cv.width = out.width; cv.height = out.height;
  cv.style.width = Math.round(dispW) + "px";
  cv.style.height = Math.round(dispH) + "px";
  cv.getContext("2d").drawImage(out, 0, 0);
  positionOverlay();
}
let previewBase = false;

/* ---- Overlay geometry (interaction handles) ---- */
function positionOverlay() {
  if (dom.sceneWrap.hidden || !state.scene.base.img) return;
  const wrap = dom.sceneWrap.getBoundingClientRect();
  const r = dom.sceneCanvas.getBoundingClientRect();
  const ov = dom.layerOverlay;
  ov.style.left = r.left - wrap.left + "px";
  ov.style.top = r.top - wrap.top + "px";
  ov.style.width = r.width + "px";
  ov.style.height = r.height + "px";
  renderHandles();
}
async function addLayerFromAsset(asset) {
  const src = await loadImage(asset.src);
  const maskImg = await loadImage(asset.mask);
  const W = src.naturalWidth, H = src.naturalHeight;
  const mask = cvOf(W, H);
  mask.getContext("2d").drawImage(maskImg, 0, 0, W, H);
  const fix = cvOf(W, H);   // starts black = no local correction anywhere

  const L = {
    id: uid("ly"), assetId: asset.id, src, mask, fix, decon: null,
    imgW: W, imgH: H, maskRev: 0, fixAmount: 70,
    fx: 0.5, fy: 0.58, fw: 0.42, rot: 0, flipH: false,
    opacity: 100, visible: true, z: ++state.scene.zTop,
    autoMatch: true, matchStrength: 85,
    adj: newAdj(), matte: newMatte(), shadow: newShadow(),
    name: `Subject ${state.scene.layers.length + 1}`, _cache: null,
  };
  state.scene.layers.push(L);
  state.scene.selectedId = L.id;
  autoMatchLayer(L, true);
  buildLayerStack(); scheduleRender(); updateSceneButtons();
  status("Placed and auto-matched. Drag to move · corner = resize · ✂️ Edge to brush the mask.");
}

function renderHandles() {
  const ov = dom.layerOverlay;
  const ow = ov.clientWidth, oh = ov.clientHeight;
  ov.innerHTML = "";
  if (previewBase) return;
  if (state.brush.on) return;   // the overlay itself becomes the paint surface
  for (const lt of state.scene.lights) {
    if (!lt.visible) continue;
    const h = document.createElement("div");
    h.className = "light-handle" + (state.scene.selectedLight === lt.id ? " selected" : "");
    h.style.left = lt.x * ow + "px";
    h.style.top = lt.y * oh + "px";
    h.textContent = LIGHT_TYPES[lt.type]?.icon || "💡";
    h.title = "Drag to move the light — shadows follow it";
    h.addEventListener("pointerdown", (e) => startLightDrag(e, lt));
    ov.appendChild(h);
  }
  for (const L of sortedLayers()) {
    if (!L.visible) continue;
    const div = document.createElement("div");
    div.className = "layer" + (L.id === state.scene.selectedId ? " selected" : "");
    const w = L.fw * ow, h = w * (L.imgH / L.imgW);
    div.style.left = L.fx * ow + "px";
    div.style.top = L.fy * oh + "px";
    div.style.width = w + "px";
    div.style.height = h + "px";
    div.style.setProperty("--rot", L.rot + "deg");
    div.dataset.id = L.id;
    div.innerHTML =
      `<span class="handle h-del" data-role="del" title="Delete">✕</span>` +
      `<span class="handle h-rotate" data-role="rotate" title="Rotate">⟳</span>` +
      `<span class="handle h-resize" data-role="resize" title="Resize">⤡</span>`;
    div.addEventListener("pointerdown", (e) => startLayerPointer(e, L));
    ov.appendChild(div);
  }
}

/* ============================================================
   MASK BRUSH — paint directly on the selected subject's matte
   ============================================================ */
/* One tool set, whichever mask is being edited. "Add" means more of the
   thing the mask selects — more subject, or more sky — so the same two
   buttons read correctly in both places. */
const BRUSH_TOOLS = {
  add:     { icon: "➕", name: "Add",     hint: "paint the mask in" },
  sub:     { icon: "➖", name: "Remove",  hint: "paint the mask out" },
  wandAdd: { icon: "✨", name: "Tap +",   hint: "tap a spot — grows through everything that colour" },
  wandSub: { icon: "🪄", name: "Tap −",   hint: "tap a spot — removes everything that colour" },
  burn:    { icon: "🔥", name: "Burn",    hint: "darken only what's already dark — cleans haze" },
  dodge:   { icon: "🔆", name: "Dodge",   hint: "brighten only what's already bright — solidifies" },
  fix:     { icon: "💡", name: "Fix light", hint: "subject only — kill a glow" },
};
const isDodgeBurn = (t) => t === "burn" || t === "dodge";
const MASK_TARGETS = {
  subject: { icon: "🧍", name: "Subject" },
  sky:     { icon: "🌌", name: "Sky" },
  blocker: { icon: "🧱", name: "Blockers" },
  depth:   { icon: "🪜", name: "Depth" },
  window:  { icon: "🪟", name: "Windows" },
  light:   { icon: "🔦", name: "Light" },
  open:    { icon: "🕳", name: "Sky reach" },
};
const isWand = (t) => t === "wandAdd" || t === "wandSub";

/* ============================================================
   MASK EDITING — no detector is right on every photograph

   Automatic sky detection gets most scenes most of the way. It will
   never get all of them, and a scene where it misses one roof is not a
   scene worth abandoning. So every mask is directly editable: paint it
   in or out, or tap a spot and let the region grow through everything
   that colour — the tap being the useful one, since a missed roof is
   usually one flat-toned area rather than something worth brushing.

   Edits are stored as a signed layer over the detection, not baked into
   it, so re-detecting or moving the detection sliders never throws away
   hand corrections.
   ============================================================ */
function ensureDepth() {
  const S = state.scene;
  if (!S.base.img) return null;
  const w = 320, h = Math.max(8, Math.round(w * (S.base.img.naturalHeight / S.base.img.naturalWidth)));
  if (!S.depthMap || S.depthMap.width !== w) {
    const c = cvOf(w, h);
    const x = c.getContext("2d");
    // Seed with the ground-plane prior so painting only has to correct it.
    const g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#000"); g.addColorStop(1, "#fff");
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    S.depthMap = c;
  }
  return S.depthMap;
}
function pointToDepth(clientX, clientY) {
  const r = dom.layerOverlay.getBoundingClientRect();
  const m = ensureDepth();
  return { x: ((clientX - r.left) / r.width) * m.width, y: ((clientY - r.top) / r.height) * m.height };
}

/* Painting the solve. The renderer's job is to get a scene most of the way;
   the last stretch is judgement, and judgement is faster to paint than to
   parameterise. Each of these is a separate stage of the light rather than
   one catch-all brush, because "this wall should catch more of the lamp" and
   "this alcove sees no sky" are different statements and collapsing them into
   a single slider is how you end up unable to say either.

   Both store 128 as neutral, so an untouched map changes nothing and the
   painting is a signed correction rather than a replacement. */
function ensureLightPaint() {
  const S = state.scene;
  if (!S.base.img) return null;
  const w = 320, h = Math.max(8, Math.round(w * (S.base.img.naturalHeight / S.base.img.naturalWidth)));
  if (!S.lightPaint || S.lightPaint.width !== w) {
    const c = cvOf(w, h), x = c.getContext("2d");
    x.fillStyle = "#808080"; x.fillRect(0, 0, w, h);
    S.lightPaint = c;
  }
  return S.lightPaint;
}
function pointToLightPaint(clientX, clientY) {
  const r = dom.layerOverlay.getBoundingClientRect();
  const m = ensureLightPaint();
  return { x: ((clientX - r.left) / r.width) * m.width, y: ((clientY - r.top) / r.height) * m.height };
}
function ensureOpenPaint() {
  const S = state.scene;
  if (!S.base.img) return null;
  const w = 320, h = Math.max(8, Math.round(w * (S.base.img.naturalHeight / S.base.img.naturalWidth)));
  if (!S.openPaint || S.openPaint.width !== w) {
    const c = cvOf(w, h), x = c.getContext("2d");
    x.fillStyle = "#808080"; x.fillRect(0, 0, w, h);
    S.openPaint = c;
  }
  return S.openPaint;
}
function pointToOpenPaint(clientX, clientY) {
  const r = dom.layerOverlay.getBoundingClientRect();
  const m = ensureOpenPaint();
  return { x: ((clientX - r.left) / r.width) * m.width, y: ((clientY - r.top) / r.height) * m.height };
}

function ensureOccluder() {
  const S = state.scene;
  if (!S.base.img) return null;
  const w = 320, h = Math.max(8, Math.round(w * (S.base.img.naturalHeight / S.base.img.naturalWidth)));
  if (!S.occluder || S.occluder.width !== w) {
    const c = cvOf(w, h);
    const x = c.getContext("2d");
    x.fillStyle = "#000"; x.fillRect(0, 0, w, h);   // nothing blocks by default
    S.occluder = c;
  }
  return S.occluder;
}
function pointToOccluder(clientX, clientY) {
  const r = dom.layerOverlay.getBoundingClientRect();
  const m = ensureOccluder();
  return { x: ((clientX - r.left) / r.width) * m.width, y: ((clientY - r.top) / r.height) * m.height };
}

function ensureSkyEdit() {
  const S = state.scene;
  const m = skyMask();
  if (!S.skyEdit || S.skyEdit.width !== m.width || S.skyEdit.height !== m.height) {
    const c = cvOf(m.width, m.height);
    const x = c.getContext("2d");
    x.fillStyle = "rgb(128,128,128)";       // 128 = leave the detection alone
    x.fillRect(0, 0, c.width, c.height);
    S.skyEdit = c;
    S.skyEditRev = (S.skyEditRev || 0) + 1;
  }
  return S.skyEdit;
}
function skyEditDirty() {
  const S = state.scene;
  S.skyEditRev = (S.skyEditRev || 0) + 1;
  S._skyData = null;
  scheduleRender();
}
/* Scene point (fractions of the frame) -> sky-mask pixel. */
function pointToSky(clientX, clientY) {
  const r = dom.layerOverlay.getBoundingClientRect();
  const m = ensureSkyEdit();
  return {
    x: ((clientX - r.left) / r.width) * m.width,
    y: ((clientY - r.top) / r.height) * m.height,
    w: m.width, h: m.height,
  };
}
function paintSky(from, to) {
  const B = state.brush;
  const c = ensureSkyEdit();
  if (isDodgeBurn(B.tool)) { dodgeBurnStroke(c, from, to); skyEditDirty(); return; }
  const ctx = c.getContext("2d");
  const radius = Math.max(1, (B.size / 100) * Math.min(c.width, c.height) * 0.35);
  const alpha = (B.strength / 100) * 0.55;
  const color = B.tool === "sub" ? "rgba(0,0,0,ALPHA)" : "rgba(255,255,255,ALPHA)";
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(dist / (radius * 0.3)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    stamp(ctx, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, radius, B.soft, alpha, color);
  }
  skyEditDirty();
}
/* Region grow shared by every mask: from the tapped pixel, through anything
   close to it in colour, bounded so one tap cannot run away with the frame. */
function growRegion(srcImg, W, H, pt, tolPct, sizePct) {
  const g = cvOf(W, H);
  g.getContext("2d").drawImage(srcImg, 0, 0, W, H);
  const D = g.getContext("2d").getImageData(0, 0, W, H).data;
  const sx = clamp(Math.round(pt.x), 0, W - 1), sy = clamp(Math.round(pt.y), 0, H - 1);
  const si = (sy * W + sx) * 4;
  const r0 = D[si], g0 = D[si + 1], b0 = D[si + 2];
  const tol = (18 + (tolPct / 100) * 90) * 3;
  const maxR = (sizePct / 100) * Math.max(W, H) * 2.2;
  const seen = new Uint8Array(W * H), out = new Uint8Array(W * H);
  const q = [sy * W + sx];
  seen[sy * W + sx] = 1;
  let n = 0;
  while (q.length) {
    const i = q.pop(); n++;
    out[i] = 1;
    const x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (seen[ni]) continue;
      if (Math.hypot(nx - sx, ny - sy) > maxR) continue;
      const j = ni * 4;
      if (Math.abs(D[j] - r0) + Math.abs(D[j + 1] - g0) + Math.abs(D[j + 2] - b0) > tol) continue;
      seen[ni] = 1; q.push(ni);
    }
  }
  return { out, n };
}

/* Tap a window to light it. Auto-detection proposes candidates; this is how
   they are actually chosen, because one tap per window is quick and certain
   whereas a detector confident enough to decide for you does not exist. */
function tapWindow(pt, add) {
  const S = state.scene;
  const W2 = 700, H2 = Math.max(8, Math.round(W2 * (S.base.img.naturalHeight / S.base.img.naturalWidth)));
  const px = { x: pt.x * W2, y: pt.y * H2 };
  if (!add) {
    const before = S.windows.list.length;
    S.windows.list = S.windows.list.filter((w) =>
      Math.abs(w.x - pt.x) > w.w * 0.75 || Math.abs(w.y - pt.y) > w.h * 0.75);
    scheduleRender(); refreshStack();
    toast(before === S.windows.list.length ? "No lit window there." : "Window switched off.");
    return;
  }
  /* A window is a solid rectangle. That is a claim about *shape*, not about
     what the thing is, which is why it survives where brightness heuristics
     don't: measured over 16 taps on a tower block, the 11 real windows filled
     0.63–0.89 of their bounding box while the 5 grabs that escaped along the
     facade filled 0.30–0.43. Nothing overlapped. So when a grab fails the
     shape test, tighten the tolerance and try again rather than giving up —
     the escape is almost always the fill leaking through one soft edge. */
  const shapeOf = (out, n) => {
    let minX = W2, maxX = 0, minY = H2, maxY = 0;
    for (let i = 0; i < out.length; i++) {
      if (!out[i]) continue;
      const x = i % W2, y = (i / W2) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const wpx = maxX - minX + 1, hpx = maxY - minY + 1;
    return { minX, maxX, minY, maxY, bw: wpx / W2, bh: hpx / H2, fill: n / (wpx * hpx), area: (wpx * hpx) / (W2 * H2) };
  };
  // Solid, and big enough to be a window rather than a mortar line or a sliver
  // of window frame — a thin edge passes the fill test easily but is never one.
  const ok = (s, n) => n >= 6 && s.fill >= 0.55 && s.area <= 0.12
    && s.bw >= 0.014 && s.bh >= 0.007 && s.bw <= 0.5 && s.bh <= 0.5;

  let best = null;
  for (const scale of [1, 0.6, 0.35, 0.2]) {
    const tol = Math.max(2, state.brush.strength * scale);
    const g = growRegion(S.base.img, W2, H2, px, tol, state.brush.size);
    const s = shapeOf(g.out, g.n);
    if (ok(s, g.n)) { best = s; break; }
  }
  if (!best) {
    // Every tolerance leaked. Rather than do nothing, drop a window the size of
    // the ones already placed — a tap should always land something you can see
    // and tap again to remove.
    const prior = S.windows.list;
    const mw = prior.length ? prior.reduce((a, w) => a + w.w, 0) / prior.length : 0.05;
    const mh = prior.length ? prior.reduce((a, w) => a + w.h, 0) / prior.length : 0.032;
    best = { minX: (pt.x - mw / 2) * W2, maxX: (pt.x + mw / 2) * W2, minY: (pt.y - mh / 2) * H2, maxY: (pt.y + mh / 2) * H2, bw: mw, bh: mh };
  }
  const { minX, maxX, minY, maxY, bw, bh } = best;
  S.windows.list.push({ id: uid("win"), x: (minX + maxX) / 2 / W2, y: (minY + maxY) / 2 / H2, w: bw, h: bh, on: true });
  S.windows.visible = true;
  scheduleRender(); refreshStack();
  toast(`🪟 Window lit (${S.windows.list.length} total)`);
}

function wandFlat(t, pt, add) {
  const c = t.canvas;
  const W = c.width, H = c.height;
  const { out, n } = growRegion(state.scene.base.img, W, H, pt, state.brush.strength, state.brush.size);
  const ctx = c.getContext("2d");
  const id = ctx.getImageData(0, 0, W, H);
  const v = add ? 255 : 0;
  for (let i = 0; i < out.length; i++) { if (!out[i]) continue; const j = i * 4; id.data[j] = id.data[j + 1] = id.data[j + 2] = v; }
  ctx.putImageData(id, 0, 0);
  scheduleRender();
  toast(t.kind === "depth"
    ? `🪜 Moved ${Math.round((n / (W * H)) * 100)}% of the frame ${add ? "nearer" : "further away"}`
    : `🧱 ${add ? "Marked" : "Cleared"} ${Math.round((n / (W * H)) * 100)}% as a light blocker`);
}

function wandSubject(L, pt, add) {
  const W = L.mask.width, H = L.mask.height;
  const { out, n } = growRegion(L.src, W, H, pt, state.brush.strength, state.brush.size);
  const ctx = L.mask.getContext("2d");
  const id = ctx.getImageData(0, 0, W, H);
  const v = add ? 255 : 0;
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) continue;
    const j = i * 4;
    id.data[j] = id.data[j + 1] = id.data[j + 2] = v;
  }
  ctx.putImageData(id, 0, 0);
  const soft = cvOf(W, H), sx2 = soft.getContext("2d");
  sx2.filter = `blur(${Math.max(0.8, Math.min(W, H) / 500).toFixed(2)}px)`;
  sx2.drawImage(L.mask, 0, 0);
  ctx.clearRect(0, 0, W, H); ctx.drawImage(soft, 0, 0);
  L.maskRev++; L._cache = null;
  scheduleRender();
  toast(`✨ ${add ? "Added" : "Removed"} ${Math.round((n / (W * H)) * 100)}% of the cut-out`);
}

/* Snapseed-style tap: grow from the tapped pixel through anything close to
   it in colour, bounded so one tap can't run away with the whole frame. */
function wandSky(pt, add) {
  const S = state.scene;
  const c = ensureSkyEdit();
  const W = c.width, H = c.height;

  const { out, n } = growRegion(S.base.img, W, H, pt, state.brush.strength, state.brush.size);

  const ctx = c.getContext("2d");
  const id = ctx.getImageData(0, 0, W, H);
  const v = add ? 255 : 0;
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) continue;
    const j = i * 4;
    id.data[j] = id.data[j + 1] = id.data[j + 2] = v;
  }
  ctx.putImageData(id, 0, 0);
  // Soften what the wand grabbed so its edge isn't a hard cut-out.
  const soft = cvOf(W, H), sc2 = soft.getContext("2d");
  sc2.filter = "blur(1.2px)";
  sc2.drawImage(c, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(soft, 0, 0);
  skyEditDirty();
  toast(add ? `✨ Grew ${Math.round((n / (W * H)) * 100)}% of the frame into the sky` : "✨ Removed that region from the sky");
}

/* Screen point -> the layer's own mask pixels, undoing position, scale,
   rotation and flip so the brush lands where the cursor is. */
function pointToMask(L, clientX, clientY) {
  const r = dom.layerOverlay.getBoundingClientRect();
  const ow = r.width, oh = r.height;
  const dx = clientX - r.left - L.fx * ow;
  const dy = clientY - r.top - L.fy * oh;
  const rad = (-L.rot * Math.PI) / 180;
  let rx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
  if (L.flipH) rx = -rx;
  const sw = L.fw * ow, sh = sw * (L.imgH / L.imgW);
  const u = rx / sw + 0.5, v = ry / sh + 0.5;
  return { x: u * L.mask.width, y: v * L.mask.height, sw };
}

function stamp(ctx, x, y, radius, soft, alpha, color) {
  const inner = radius * clamp(1 - soft / 100, 0.02, 1);
  const g = ctx.createRadialGradient(x, y, inner, x, y, Math.max(radius, inner + 0.5));
  g.addColorStop(0, color.replace("ALPHA", alpha.toFixed(3)));
  g.addColorStop(1, color.replace("ALPHA", "0"));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(radius, inner + 0.5), 0, Math.PI * 2);
  ctx.fill();
}

/* What is being painted on right now: the selected subject's matte, or the
   scene's sky matte. */
function maskTarget() {
  const S = state.scene;
  if (state.brush.target === "sky") {
    if (!S.base.img) return null;
    return { kind: "sky", canvas: ensureSkyEdit(), src: S.base.img };
  }
  if (state.brush.target === "blocker") {
    if (!S.base.img) return null;
    return { kind: "blocker", canvas: ensureOccluder(), src: S.base.img };
  }
  if (state.brush.target === "depth") {
    if (!S.base.img) return null;
    return { kind: "depth", canvas: ensureDepth(), src: S.base.img };
  }
  if (state.brush.target === "window") {
    if (!S.base.img) return null;
    return { kind: "window", src: S.base.img };
  }
  if (state.brush.target === "light") {
    if (!S.base.img) return null;
    return { kind: "light", canvas: ensureLightPaint(), src: S.base.img };
  }
  if (state.brush.target === "open") {
    if (!S.base.img) return null;
    return { kind: "open", canvas: ensureOpenPaint(), src: S.base.img };
  }
  const L = S.layers.find((x) => x.id === S.selectedId) || (S.layers.length === 1 ? S.layers[0] : null);
  if (!L) return null;
  return { kind: "subject", layer: L, canvas: L.mask, src: L.src };
}
function targetPoint(t, cx, cy) {
  if (t.kind === "sky") return pointToSky(cx, cy);
  if (t.kind === "blocker") return pointToOccluder(cx, cy);
  if (t.kind === "depth") return pointToDepth(cx, cy);
  if (t.kind === "light") return pointToLightPaint(cx, cy);
  if (t.kind === "open") return pointToOpenPaint(cx, cy);
  if (t.kind === "window") {
    const r = dom.layerOverlay.getBoundingClientRect();
    return { x: (cx - r.left) / r.width, y: (cy - r.top) / r.height, frac: true };
  }
  return pointToMask(t.layer, cx, cy);
}
/* Blockers and depth paint like any other mask, straight into their buffer.
   For depth, white is near and black is far, so "add" brings a surface
   forward and "remove" pushes it back. */
function paintFlat(t, from, to) {
  const B = state.brush;
  const c = t.canvas;
  if (isDodgeBurn(B.tool)) { dodgeBurnStroke(c, from, to); scheduleRender(); return; }
  const ctx = c.getContext("2d");
  const radius = Math.max(1, (B.size / 100) * Math.min(c.width, c.height) * 0.35);
  const alpha = (B.strength / 100) * 0.6;
  const color = B.tool === "sub" ? "rgba(0,0,0,ALPHA)" : "rgba(255,255,255,ALPHA)";
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(dist / (radius * 0.3)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    stamp(ctx, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, radius, B.soft, alpha, color);
  }
  scheduleRender();
}

/* Local dodge/burn. Unlike the other tools this is read-modify-write: the
   result depends on what the mask already says at each pixel, which is the
   whole point of a range-limited tool. */
function dodgeBurnStroke(canvas, from, to) {
  const B = state.brush;
  const ctx = canvas.getContext("2d");
  const radius = Math.max(2, (B.size / 200) * canvas.width);
  const expo = (B.strength / 100) * (B.tool === "burn" ? 0.06 : 0.55);  // burn wants a light touch
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(dist / (radius * 0.5)));
  const pad = Math.ceil(radius) + 2;
  const x0 = clamp(Math.floor(Math.min(from.x, to.x) - pad), 0, canvas.width - 1);
  const y0 = clamp(Math.floor(Math.min(from.y, to.y) - pad), 0, canvas.height - 1);
  const x1 = clamp(Math.ceil(Math.max(from.x, to.x) + pad), 1, canvas.width);
  const y1 = clamp(Math.ceil(Math.max(from.y, to.y) + pad), 1, canvas.height);
  const w = x1 - x0, h = y1 - y0;
  if (w < 1 || h < 1) return;
  const id = ctx.getImageData(x0, y0, w, h);
  const d = id.data;
  const inner = radius * clamp(1 - B.soft / 100, 0.02, 1);
  for (let s2 = 0; s2 <= steps; s2++) {
    const t = steps ? s2 / steps : 0;
    const cx = from.x + (to.x - from.x) * t, cy = from.y + (to.y - from.y) * t;
    for (let y = 0; y < h; y++) {
      const dy = (y0 + y) - cy;
      if (Math.abs(dy) > radius) continue;
      for (let x = 0; x < w; x++) {
        const dx = (x0 + x) - cx;
        const r2 = Math.hypot(dx, dy);
        if (r2 > radius) continue;
        const fall = r2 <= inner ? 1 : 1 - (r2 - inner) / Math.max(1e-3, radius - inner);
        const e = expo * fall * fall;
        if (e <= 0.0005) continue;
        const i = (y * w + x) * 4;
        const v = dodgeBurnValue(d[i] / 255, B.tool === "burn" ? e : 0, B.tool === "dodge" ? e : 0);
        d[i] = d[i + 1] = d[i + 2] = v * 255;
      }
    }
  }
  ctx.putImageData(id, x0, y0);
}

function paintAt(L, from, to) {
  const B = state.brush;
  if (isDodgeBurn(B.tool)) {
    dodgeBurnStroke(L.mask, from, to);
    L.maskRev++; L._cache = null;
    return;
  }
  const target = B.tool === "fix" ? L.fix : L.mask;
  const ctx = target.getContext("2d");
  // Brush size is a share of the subject's own width, so it stays consistent
  // whatever the subject is scaled to on screen.
  const radius = Math.max(1, (B.size / 200) * L.mask.width);
  const alpha = (B.strength / 100) * (B.tool === "fix" ? 0.35 : 0.5);
  const color = B.tool === "sub" ? "rgba(0,0,0,ALPHA)" : "rgba(255,255,255,ALPHA)";

  ctx.save();
  if (B.tool === "fix") ctx.globalCompositeOperation = "lighter";
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(dist / (radius * 0.28)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    stamp(ctx, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, radius, B.soft, alpha, color);
  }
  ctx.restore();
  L.maskRev++;
  L._cache = null;
}

let painting = null;
function startPaint(e) {
  const t = maskTarget();
  if (!t) {
    toast(state.brush.target === "sky" ? "Add a main image first." : "Tap a subject in the Layers panel first.", true);
    return;
  }
  if (t.kind === "subject") state.scene.selectedId = t.layer.id;
  e.preventDefault();
  e.stopPropagation();
  const p = targetPoint(t, e.clientX, e.clientY);
  painting = { t, last: p, startX: e.clientX, startY: e.clientY, moved: false, tool: state.brush.tool };
  if (!isWand(painting.tool)) {
    if (t.kind === "window") { /* windows are placed on release, not dragged */ }
    else if (t.kind === "sky") paintSky(p, p);
    else if (t.kind === "blocker" || t.kind === "depth" || t.kind === "light" || t.kind === "open") paintFlat(t, p, p);
    else paintAt(t.layer, p, p);
    scheduleRender();
  }
  dom.layerOverlay.setPointerCapture?.(e.pointerId);
  window.addEventListener("pointermove", movePaint);
  window.addEventListener("pointerup", endPaint);
}
function movePaint(e) {
  if (!painting) return;
  e.preventDefault();
  if (Math.hypot(e.clientX - painting.startX, e.clientY - painting.startY) > 4) painting.moved = true;
  if (isWand(painting.tool)) return;          // a wand acts on release, not on drag
  const p = targetPoint(painting.t, e.clientX, e.clientY);
  if (painting.t.kind === "window") { painting.last = p; return; }
  if (painting.t.kind === "sky") paintSky(painting.last, p);
  else if (painting.t.kind === "blocker" || painting.t.kind === "depth" || painting.t.kind === "light" || painting.t.kind === "open") paintFlat(painting.t, painting.last, p);
  else paintAt(painting.t.layer, painting.last, p);
  painting.last = p;
  scheduleRender();
}
function endPaint(e) {
  const p = painting;
  painting = null;
  window.removeEventListener("pointermove", movePaint);
  window.removeEventListener("pointerup", endPaint);
  if (p && isWand(p.tool) && !p.moved) {
    const add = p.tool === "wandAdd";
    if (p.t.kind === "window") tapWindow(p.last, add);
    else if (p.t.kind === "sky") wandSky(p.last, add);
    else if (p.t.kind === "blocker" || p.t.kind === "depth") wandFlat(p.t, p.last, add);
    else wandSubject(p.t.layer, p.last, add);
    buildBrushBar();
  }
}

function setBrush(on, tool) {
  state.brush.on = on;
  if (tool) state.brush.tool = tool;
  dom.layerOverlay.classList.toggle("painting", on);
  dom.sceneStage.classList.toggle("brush-mode", on);
  renderHandles();
  buildBrushBar();
  if (!on && state.brush._stackDirty) { state.brush._stackDirty = false; buildLayerStack(); }
}

/* Rebuilding the panel mid-brush reflows the page, which moves the stage out
   from under a finger that is part-way through tapping a row of windows. So
   while the brush is live the rebuild is deferred to when it's put down. */
function refreshStack() {
  if (state.brush.on) { state.brush._stackDirty = true; return; }
  buildLayerStack();
}

async function runRefineHair(L) {
  const R = state.scene.refine;
  status("Refining the edge…");
  await new Promise((r) => setTimeout(r, 16));
  try {
    // Refines from the CURRENT mask, so a rough hand-brushed fix is a valid
    // input to it: block the edge in loosely, then let this solve the strands.
    const out = refineHair(L.src, L.mask, R);
    const m = cvOf(L.mask.width, L.mask.height);
    m.getContext("2d").drawImage(out.mask, 0, 0, m.width, m.height);
    L.mask = m;
    L.decon = R.spill > 0 ? out.decon : null;
    L.maskRev++;
    L._cache = null;
    scheduleRender();
    status("Edge refined ✓ — brush over anything it missed.", "ok");
    toast("✨ Hair & edges refined");
  } catch (err) {
    console.error(err);
    status("Couldn't refine that edge.", "err");
  }
}

let lightDrag = null;
function startLightDrag(e, lt) {
  e.preventDefault(); e.stopPropagation();
  state.scene.selectedLight = lt.id;
  const r = dom.layerOverlay.getBoundingClientRect();
  lightDrag = { lt, r };
  e.target.setPointerCapture?.(e.pointerId);
  window.addEventListener("pointermove", moveLightDrag);
  window.addEventListener("pointerup", endLightDrag);
  buildLayerStack();
}
function moveLightDrag(e) {
  if (!lightDrag) return;
  const { lt, r } = lightDrag;
  lt.x = clamp((e.clientX - r.left) / r.width, -0.3, 1.3);
  lt.y = clamp((e.clientY - r.top) / r.height, -0.3, 1.3);
  lightsDriveScene();
  scheduleRender();
}
function endLightDrag() {
  lightDrag = null;
  window.removeEventListener("pointermove", moveLightDrag);
  window.removeEventListener("pointerup", endLightDrag);
  syncSliders(); buildLayerStack(); scheduleRender();
}

/* ---- Pointer interaction ---- */
let drag = null;
function startLayerPointer(e, L) {
  e.preventDefault(); e.stopPropagation();
  state.scene.selectedId = L.id; L.z = ++state.scene.zTop;
  const role = e.target.dataset.role || "move";
  if (role === "del") { deleteLayer(L.id); return; }
  const ov = dom.layerOverlay.getBoundingClientRect();
  drag = { L, role, ovRect: ov, startX: e.clientX, startY: e.clientY, startFx: L.fx, startFy: L.fy };
  e.target.setPointerCapture?.(e.pointerId);
  window.addEventListener("pointermove", moveLayerPointer);
  window.addEventListener("pointerup", endLayerPointer);
  buildLayerStack(); scheduleRender(); updateSceneButtons();
}
function moveLayerPointer(e) {
  if (!drag) return;
  const { L, role, ovRect } = drag;
  const ow = ovRect.width, oh = ovRect.height;
  if (role === "move") {
    L.fx = clamp01(drag.startFx + (e.clientX - drag.startX) / ow);
    L.fy = clamp01(drag.startFy + (e.clientY - drag.startY) / oh);
  } else if (role === "resize") {
    const cx = ovRect.left + L.fx * ow, cy = ovRect.top + L.fy * oh;
    const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
    const aspect = L.imgH / L.imgW;
    const widthPx = (2 * dist) / Math.sqrt(1 + aspect * aspect);
    L.fw = Math.max(0.04, Math.min(2.5, widthPx / ow));
  } else if (role === "rotate") {
    const cx = ovRect.left + L.fx * ow, cy = ovRect.top + L.fy * oh;
    L.rot = Math.round((Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90);
  }
  scheduleRender();
}
function endLayerPointer() {
  // A subject dragged into shade should match the shade it landed in.
  if (drag && (drag.role === "move" || drag.role === "resize")) {
    const m = autoMatchLayer(drag.L);
    const s2 = lightsDriveScene();
    if (m || s2) { syncSliders(); buildLayerStack(); scheduleRender(); }
  }
  drag = null;
  window.removeEventListener("pointermove", moveLayerPointer);
  window.removeEventListener("pointerup", endLayerPointer);
}
function deleteLayer(id) {
  state.scene.layers = state.scene.layers.filter((x) => x.id !== id);
  if (state.scene.selectedId === id) state.scene.selectedId = null;
  buildLayerStack(); scheduleRender(); updateSceneButtons();
}

function updateSceneButtons() {
  const hasScene = !!state.scene.base.img;
  const hasLayers = state.scene.layers.length > 0;
  dom.mergeBtn.disabled = !hasScene;
  dom.sceneDownloadBtn.disabled = !hasScene;
  dom.beforeAfterBtn.disabled = !hasScene;
  dom.layerDeleteBtn.disabled = !state.scene.selectedId;
  dom.brushToggle.disabled = !hasScene;
  if (!hasScene && state.brush.on) setBrush(false);
  if (!hasLayers && state.brush.target === "subject" && state.brush.on) {
    state.brush.target = "sky";          // nothing to paint on but the sky
  }
  dom.layerFlattenReset.disabled = !hasLayers;
  dom.harmonizeBtn.disabled = !hasScene || !hasLayers;
  dom.mergeBtn.textContent = hasLayers || state.scene.overlay.img
    ? "🧩 Merge & bake into a new version"
    : "🎨 Bake adjustments into the scene";
}

/* ============================================================
   LAYER PANEL UI
   ============================================================ */
/* Every slider registers itself, so an auto-match can push new numbers into
   the visible controls without rebuilding the panel — rebuilding mid-drag
   would destroy the input the user is holding. */
let sliderRegistry = [];
function syncSliders() {
  for (const s of sliderRegistry) {
    if (s.input === document.activeElement) continue;   // don't fight a live drag
    const v = s.obj[s.k] ?? 0;
    if (Number(s.input.value) !== v) s.input.value = v;
    s.out.textContent = v + s.unit;
  }
}

function sliderRow(spec, obj, onChange) {
  const row = document.createElement("div");
  row.className = "srow";
  const val = obj[spec.k] ?? 0;
  row.innerHTML =
    `<div class="srow-head"><span class="srow-label">${spec.label}${spec.hint ? ` <em>${spec.hint}</em>` : ""}</span>` +
    `<span class="srow-val">${val}${spec.unit || ""}</span></div>`;
  const input = document.createElement("input");
  input.type = "range";
  input.min = spec.min; input.max = spec.max; input.step = spec.step || 1;
  input.value = val;
  input.className = "srange";
  input.dataset.key = spec.k;
  const out = row.querySelector(".srow-val");
  const commit = () => {
    obj[spec.k] = Number(input.value);
    out.textContent = input.value + (spec.unit || "");
    onChange();
  };
  input.addEventListener("input", commit);
  row.addEventListener("dblclick", () => { input.value = spec.def ?? 0; commit(); });
  row.appendChild(input);
  sliderRegistry.push({ input, out, obj, k: spec.k, unit: spec.unit || "" });
  return row;
}

function sectionCard({ key, icon, title, meta, visible, onToggle, onSelect, selected, body, actions }) {
  const card = document.createElement("div");
  card.className = "lcard" + (selected ? " selected" : "") + (visible === false ? " off" : "");
  card.dataset.key = key;

  const head = document.createElement("div");
  head.className = "lcard-head";
  head.innerHTML =
    `<button class="lcard-eye" title="Show / hide this layer">${visible === false ? "🚫" : "👁"}</button>` +
    `<span class="lcard-title">${icon} ${title}</span>` +
    `<span class="lcard-meta">${meta || ""}</span>` +
    `<span class="lcard-caret">▾</span>`;
  head.querySelector(".lcard-eye").addEventListener("click", (e) => { e.stopPropagation(); onToggle && onToggle(); });
  head.addEventListener("click", () => {
    const open = card.classList.toggle("open");
    openCards[key] = open;
    onSelect && onSelect();
  });
  card.appendChild(head);

  const bodyEl = document.createElement("div");
  bodyEl.className = "lcard-body";
  if (actions) bodyEl.appendChild(actions);
  body(bodyEl);
  card.appendChild(bodyEl);
  if (openCards[key]) card.classList.add("open");
  return card;
}

const openCards = {};

function groupLabel(text) {
  const s = document.createElement("div");
  s.className = "sgroup";
  s.textContent = text;
  return s;
}
function btnRow(buttons) {
  const r = document.createElement("div");
  r.className = "btn-row";
  buttons.forEach(([label, fn, title]) => {
    const b = document.createElement("button");
    b.className = "tool-btn tiny";
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener("click", fn);
    r.appendChild(b);
  });
  return r;
}

function buildLayerStack() {
  const S = state.scene;
  const host = dom.layerStack;
  host.innerHTML = "";
  sliderRegistry = [];
  if (!S.base.img) return;
  const rerender = () => scheduleRender();

  /* ✨ Finish */
  host.appendChild(sectionCard({
    key: "finish", icon: "✨", title: "Finish", meta: "whole image",
    visible: S.finish.visible,
    onToggle: () => { S.finish.visible = !S.finish.visible; buildLayerStack(); rerender(); },
    body: (b) => { FINISH_ROWS.forEach((sp) => b.appendChild(sliderRow(sp, S.finish, rerender))); },
  }));

  /* 🌙 Night */
  host.appendChild(sectionCard({
    key: "night", icon: "🌙", title: "Night",
    meta: (() => {
      if (!S.night.visible || S.night.amount <= 0) return "off";
      const c = S.base.img ? (skyMask()._skyConfidence ?? 1) : 1;
      const f = S.base.img ? (skyMask()._skyFraction ?? 0) : 0;
      if (c < 0.15) return `${S.night.amount}% · no sky found — tap to add`;
      return `${S.night.amount}% · sky ${Math.round(f * 100)}%${c < 0.7 ? " (unsure)" : ""}`;
    })(),
    visible: S.night.visible,
    onToggle: () => { S.night.visible = !S.night.visible; S._an = null; autoMatchAll(); buildLayerStack(); rerender(); },
    actions: btnRow([
      ["✏️ Edit sky mask", () => {
        state.brush.target = "sky";
        state.brush.tool = "wandAdd";
        state.brush.showMask = true;
        setBrush(true);
        status("Tap a roof it missed to add it · ➕/➖ to brush · the mask shows in red.", "ok");
      }, "Add or remove sky by hand — tap or brush"],
      ["🌙 Full night", () => { Object.assign(S.night, { visible: true, amount: 88, stars: 45 }); S._an = null; autoMatchAll(); buildLayerStack(); rerender(); }],
      ["🌆 Dusk", () => { Object.assign(S.night, { visible: true, amount: 52, stars: 12 }); S._an = null; autoMatchAll(); buildLayerStack(); rerender(); }],
      ["👁 Show sky mask", () => { S.showSky = !S.showSky; rerender(); }, "Check what was detected as sky"],
      ["✕ Off", () => { S.night.visible = false; S.night.amount = 0; S._an = null; autoMatchAll(); buildLayerStack(); rerender(); }],
    ]),
    body: (b) => {
      const p = document.createElement("p");
      p.className = "panel-hint"; p.style.margin = "2px 0 6px";
      p.textContent = "Darkening a daytime frame only makes it grey — a blown sky has no detail to recover. This finds the sky and replaces it, sinks the ground into night, and leaves warm artificial light burning.";
      b.appendChild(p);
      const conf = S.base.img ? (skyMask()._skyConfidence ?? 1) : 1;
      if (conf < 0.5) {
        const warn = document.createElement("p");
        warn.className = "panel-hint";
        warn.style.cssText = "margin:2px 0 8px;color:var(--accent-strong)";
        warn.textContent = conf < 0.15
          ? "No sky found here. Detection only claims a sky when it is clearly brighter and smoother than the rest of the picture — it would rather miss one than wreck a photo that has none. If there IS sky, hit Edit sky mask and tap it."
          : "Unsure about the sky in this one. Check it with Edit sky mask before leaning on the sky controls.";
        b.appendChild(warn);
      }
      const nightChange = () => { S._an = null; if (autoMatchAll()) syncSliders(); buildBrushBar(); rerender(); };
      [
        { k: "amount",      label: "Night",        min: 0, max: 100 },
        { k: "skyDark",     label: "Sky darkness", min: 0, max: 100 },
        { k: "skyHue",      label: "Sky colour",   min: 0, max: 359, unit: "°" },
        { k: "skySat",      label: "Sky saturation", min: 0, max: 100, hint: "keep it near-neutral" },
        { k: "skyDetail",   label: "Cloud detail", min: 0, max: 100, hint: "keeps the sky's own structure" },
        { k: "horizonGlow", label: "City glow",    min: 0, max: 100, hint: "sodium light pollution" },
        { k: "glowSide",    label: "Glow from",    min: 0, max: 100, hint: "left ↔ right" },
        { k: "stars",       label: "Stars",        min: 0, max: 100 },
        { k: "lampWarmth",  label: "Keep lamps lit", min: 0, max: 100, hint: "protects warm light" },
        { k: "ambient",     label: "Ambient fill", min: 0, max: 100, hint: "keeps shadows off pure black" },
        { k: "killDaylight", label: "Kill daylight", min: 0, max: 100, hint: "unlit bright things go dark" },
        { k: "shadowCool",  label: "Shadow coolness", min: 0, max: 100 },
        { k: "lightWarm",   label: "Highlight warmth", min: 0, max: 100, hint: "where the depth comes from" },
      ].forEach((sp) => b.appendChild(sliderRow(sp, S.night, nightChange)));
      b.appendChild(groupLabel("Sky detection"));
      [
        { k: "skyDetect",  label: "Spread",  min: 0, max: 100, hint: "how far the fill runs" },
        { k: "skyFeather", label: "Softness", min: 0, max: 100 },
        { k: "skyEdge",    label: "Edge snap", min: 0, max: 100, hint: "follow the roofline" },
        { k: "skyTighten", label: "Tighten", min: -100, max: 100, hint: "pull the matte in ↔ let it out" },
        { k: "skyBurn",    label: "Burn shadows",     min: 0, max: 100, hint: "near-out → fully out" },
        { k: "skyDodge",   label: "Dodge highlights", min: 0, max: 100, hint: "near-in → fully in" },
      ].forEach((sp) => b.appendChild(sliderRow(sp, S.night, () => { S._sky = null; S._skyData = null; nightChange(); })));
    },
  }));

  /* 🪟 Lit windows */
  host.appendChild(sectionCard({
    key: "windows", icon: "🪟", title: "Lit windows",
    meta: S.windows.list.length ? `${S.windows.list.filter((w) => w.on).length} lit` : "none",
    visible: S.windows.visible,
    onToggle: () => { S.windows.visible = !S.windows.visible; buildLayerStack(); rerender(); },
    actions: btnRow([
      ["🪟 Tap windows", () => {
        state.brush.target = "window"; state.brush.tool = "wandAdd"; state.brush.showMask = false;
        setBrush(true);
        status("Tap a window to light it · Tap − to switch one off.", "ok");
      }, "Tap each window you want lit"],
      ["✨ Suggest", () => {
        const found = detectWindows({ sensitivity: 50 });
        S.windows.list = found.map((f) => ({ ...f, on: true }));
        S.windows.visible = true;
        buildLayerStack(); rerender();
        toast(`Found ${found.length} candidate${found.length === 1 ? "" : "s"} — check them and tap to fix.`);
      }, "Guess at the windows — expect to correct it"],
      ["✕ None", () => { S.windows.list = []; buildLayerStack(); rerender(); }],
    ]),
    body: (b) => {
      const p = document.createElement("p");
      p.className = "panel-hint"; p.style.margin = "2px 0 8px";
      p.textContent = "Lit windows are what make a night frame read as inhabited. Tapping each one is the reliable route — automatic suggestion finds some of them and also finds mortar patches and, on one test photo, a football.";
      b.appendChild(p);
      [
        { k: "brightness", label: "Brightness", min: 0, max: 100 },
        { k: "warmth",     label: "Warmth",     min: 0, max: 100 },
        { k: "spill",      label: "Spill onto the wall", min: 0, max: 100 },
        { k: "variation",  label: "Variation",  min: 0, max: 100, hint: "not every room matches" },
      ].forEach((sp) => b.appendChild(sliderRow(sp, S.windows, rerender)));
    },
  }));

  /* 🌃 Solved night */
  host.appendChild(sectionCard({
    key: "nightSolve", icon: "🌃", title: "Solve the night",
    meta: S.nightSolve.visible ? "on" : "off",
    visible: S.nightSolve.visible,
    onToggle: () => { S.nightSolve.visible = !S.nightSolve.visible; buildLayerStack(); rerender(); },
    actions: btnRow([
      ["🌃 Solve", () => {
        S.nightSolve.visible = true; S.night.visible = false;
        buildLayerStack(); rerender();
        status("Night solved from the scene — light the windows to give it sources.", "ok");
      }, "Relight the scene as night, from its own geometry"],
      ["🔦 Paint light", () => {
        state.brush.target = "light"; state.brush.tool = "add"; state.brush.showMask = false;
        S.nightSolve.visible = true; setBrush(true);
        status("Brush to add light · − to take it away. Up to ±2.6 stops.", "ok");
      }, "Push light onto a surface by hand"],
      ["🕳 Paint sky reach", () => {
        state.brush.target = "open"; state.brush.tool = "sub"; state.brush.showMask = false;
        S.nightSolve.visible = true; setBrush(true);
        status("Brush − over recesses and soffits that see no sky · + for open faces.", "ok");
      }, "Correct how much sky a surface sees"],
      ["✕ Off", () => { S.nightSolve.visible = false; buildLayerStack(); rerender(); }],
      ["↺ Clear paint", () => { S.lightPaint = null; S.openPaint = null; rerender(); toast("Painted light cleared"); }],
    ]),
    body: (b) => {
      const p = document.createElement("p");
      p.className = "panel-hint"; p.style.margin = "2px 0 8px";
      p.textContent = "Builds an actual night light field — ambient sky falling off with depth into the scene, plus every lit window and placed light as a real emitter — then divides the daylight out and multiplies it on. Same maths as the imported relight, no second app. Give it sources: tap windows and drop lights, and it solves around them.";
      b.appendChild(p);
      [
        { k: "strength",   label: "Strength",       min: 0, max: 100 },
        { k: "exposure",   label: "Exposure",       min: 0, max: 100, hint: "how dark the night is" },
        { k: "canyon",     label: "Depth falloff",  min: 2, max: 100, hint: "how fast sky light dies going down" },
        { k: "skyAmbient", label: "Sky light",      min: 0, max: 100 },
        { k: "skyHue",     label: "Sky hue",        min: 0, max: 360 },
        { k: "skySat",     label: "Sky saturation", min: 0, max: 100 },
        { k: "windowGain", label: "Window output",  min: 0, max: 100 },
        { k: "lampGain",   label: "Lamp output",    min: 0, max: 100 },
        { k: "floorLevel", label: "Ambient floor",  min: 0, max: 100, hint: "raise if shadows go pure black" },
        { k: "keepDark",   label: "Protect shadows", min: 0, max: 100 },
      ].forEach((sp) => b.appendChild(sliderRow(sp, S.nightSolve, rerender)));
    },
  }));

  /* 🌗 Lighting transfer */
  host.appendChild(sectionCard({
    key: "relight", icon: "🌗", title: "Lighting transfer",
    meta: S.relight.img ? "loaded" : "none",
    visible: S.relight.visible,
    onToggle: () => { S.relight.visible = !S.relight.visible; buildLayerStack(); rerender(); },
    actions: btnRow([
      ["1 · ⬇ Plate", () => exportRelightPlate(), "Export a clean plate to relight elsewhere"],
      ["2 · 📋 Prompt", async () => {
        const ok = await copyText(RELIGHT_PROMPT);
        toast(ok ? "Prompt copied — paste it with the plate" : "Couldn't copy — select it by hand");
      }, "Copy the relight prompt"],
      ["3 · ⬆ Relit", () => pickRelight(), "Load the relit version back in"],
      ["✕", () => { S.relight.img = null; S.relight.dataUrl = null; buildLayerStack(); rerender(); }, "Clear"],
    ]),
    body: (b) => {
      const p = document.createElement("p");
      p.className = "panel-hint"; p.style.margin = "2px 0 8px";
      p.textContent = S.relight.img
        ? "Only the light is being taken from that image — every pixel of texture here is still your photograph. Coarseness decides how much of its light shaping comes across; raise it if any of its invented detail starts showing through."
        : "Sliders can darken a photo but they can't know where light comes from, so a graded night stays flat. This borrows the lighting judgement instead: export the plate, relight it in the free Gemini app, load it back, and only the low-frequency light field is kept. The invented brick and smeared frames are all high-frequency, and they get thrown away.";
      b.appendChild(p);
      if (!S.relight.img) return;
      [
        { k: "strength", label: "Strength",   min: 0, max: 100 },
        { k: "scale",    label: "Coarseness", min: 4, max: 60, hint: "raise it if its invented detail shows through" },
        { k: "colour",   label: "Take colour", min: 0, max: 100, hint: "0 = its brightness only" },
        { k: "keepDark", label: "Protect shadows", min: 0, max: 100, hint: "stops blacks going milky" },
        { k: "protect",  label: "Shadow floor", min: 0, max: 100, hint: "tames the ratio in near-black" },
      ].forEach((sp) => b.appendChild(sliderRow(sp, S.relight, rerender)));
    },
  }));

  /* 💡 Lights */
  host.appendChild(sectionCard({
    key: "lights", icon: "💡", title: "Lights",
    meta: S.lights.length ? `${S.lights.length} placed` : "none",
    visible: true,
    onToggle: () => { const any = S.lights.some((l) => l.visible); S.lights.forEach((l) => (l.visible = !any)); buildLayerStack(); rerender(); },
    actions: btnRow(Object.entries(LIGHT_TYPES).map(([k, t]) => [
      `${t.icon} ${t.name}`,
      () => {
        const lt = newLight(k);
        S.lights.push(lt); S.selectedLight = lt.id;
        lightsDriveScene(); buildLayerStack(); rerender();
        status("Light placed — drag it on the image, shadows follow it.", "ok");
      },
      `Add a ${t.name.toLowerCase()}`,
    ])),
    body: (b) => {
      const p = document.createElement("p");
      p.className = "panel-hint"; p.style.margin = "2px 0 8px";
      p.textContent = S.lights.length
        ? "Drag a light on the image. Subjects turn their shadows away from it and lengthen them with distance, and the sky's glow slides to its side."
        : "Add a light, then drag it on the image. The scene re-solves around it — shadow direction, shadow length and the sky's glow all follow.";
      b.appendChild(p);
      S.lights.forEach((lt, i) => {
        const t = LIGHT_TYPES[lt.type] || LIGHT_TYPES.lamp;
        b.appendChild(groupLabel(`${t.icon} ${t.name} ${i + 1}${S.selectedLight === lt.id ? " · selected" : ""}`));
        b.appendChild(btnRow([
          ["◎ Select", () => { S.selectedLight = lt.id; buildLayerStack(); renderHandles(); }],
          [lt.visible ? "👁 On" : "🚫 Off", () => { lt.visible = !lt.visible; buildLayerStack(); rerender(); }],
          ["🗑", () => { S.lights = S.lights.filter((z) => z.id !== lt.id); buildLayerStack(); rerender(); }, "Remove"],
        ]));
        const rows = [
          { k: "intensity", label: "Brightness", min: 0, max: 100 },
          { k: "radius",    label: "Reach",      min: 2, max: 100 },
          { k: "falloff",   label: "Falloff",    min: 0, max: 100, hint: "tight ↔ soft" },
          { k: "hue",       label: "Colour",     min: 0, max: 359, unit: "°" },
          { k: "sat",       label: "Saturation", min: 0, max: 100 },
          { k: "airlight",  label: "Haze",       min: 0, max: 100, hint: "glow in the air" },
          { k: "shadows",   label: "Casts shadows", min: 0, max: 100, hint: "blocked by subjects & blockers" },
          { k: "shadowSoft", label: "Shadow softness", min: 0, max: 100 },
          { k: "depthGap",  label: "Shadow depth reach", min: 2, max: 100, hint: "how far in depth a shadow carries" },
        ];
        if (lt.beamSpread < 359) {
          rows.push({ k: "beamAngle",  label: "Beam aim",   min: 0, max: 359, unit: "°" });
          rows.push({ k: "beamSpread", label: "Beam width", min: 5, max: 359, unit: "°" });
        }
        rows.forEach((sp) => b.appendChild(sliderRow(sp, lt, () => { lightsDriveScene(); rerender(); })));
      });
    },
  }));

  /* ✨ Glow specks */
  host.appendChild(sectionCard({
    key: "glow", icon: "🪰", title: "Glow specks",
    meta: S.glow.count > 0 ? `${S.glow.count} lights` : "off",
    visible: S.glow.visible,
    onToggle: () => { S.glow.visible = !S.glow.visible; buildLayerStack(); rerender(); },
    actions: btnRow([
      ["🎲 Reshuffle", () => { S.glow.seed = Math.floor(Math.random() * 9999); rerender(); }],
      ["🪰 30 fireflies", () => { Object.assign(S.glow, { visible: true, count: 30 }); buildLayerStack(); rerender(); }],
      ["✕ None", () => { S.glow.count = 0; buildLayerStack(); rerender(); }],
    ]),
    body: (b) => {
      const p = document.createElement("p");
      p.className = "panel-hint"; p.style.margin = "2px 0 6px";
      p.textContent = "Additive points of light — fireflies, embers, dust catching a lamp. Drawn, not pasted, so they glow into the scene instead of sitting on it.";
      b.appendChild(p);
      [
        { k: "count",     label: "Count",      min: 0, max: 300 },
        { k: "size",      label: "Size",       min: 2, max: 100 },
        { k: "intensity", label: "Brightness", min: 0, max: 100 },
        { k: "spread",    label: "Spread",     min: 5, max: 140 },
        { k: "cy",        label: "Height",     min: 0, max: 100, hint: "where the swarm sits" },
        { k: "hue",       label: "Colour",     min: 0, max: 359, unit: "°" },
      ].forEach((sp) => b.appendChild(sliderRow(sp, S.glow, () => { buildBrushBar(); rerender(); })));
    },
  }));

  /* 🎞️ Overlay */
  host.appendChild(sectionCard({
    key: "overlay", icon: "🎞️", title: "Overlay", meta: S.overlay.img ? `${S.overlay.blend} · ${S.overlay.opacity}%` : "none",
    visible: S.overlay.visible,
    onToggle: () => { S.overlay.visible = !S.overlay.visible; buildLayerStack(); rerender(); },
    body: (b) => {
      if (!S.overlay.img) {
        const p = document.createElement("p");
        p.className = "panel-hint";
        p.style.margin = "2px 0 8px";
        p.textContent = "Add a texture photo — rust, grain, a light leak, a painted wall — to carry the whole composite into one feel.";
        b.appendChild(p);
        b.appendChild(btnRow([["🎞️ Choose overlay image", () => openPicker("overlay")]]));
        return;
      }
      const blendRow = document.createElement("div");
      blendRow.className = "row";
      blendRow.innerHTML = `<span class="mini-label">Blend</span>`;
      const sel = document.createElement("select");
      sel.className = "mini-select";
      BLEND_MODES.forEach((m) => {
        const o = document.createElement("option");
        o.value = m; o.textContent = m === "source-over" ? "normal" : m;
        if (m === S.overlay.blend) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", () => { S.overlay.blend = sel.value; buildLayerStack(); rerender(); });
      blendRow.appendChild(sel);
      b.appendChild(blendRow);

      b.appendChild(sliderRow({ k: "opacity", label: "Opacity", min: 0, max: 100, unit: "%" }, S.overlay, () => { buildLayerStack(); rerender(); }));
      b.appendChild(btnRow([
        ["⟲", () => { S.overlay.rot = (S.overlay.rot + 270) % 360; rerender(); }, "Rotate left"],
        ["⟳", () => { S.overlay.rot = (S.overlay.rot + 90) % 360; rerender(); }, "Rotate right"],
        ["⇋", () => { S.overlay.flipH = !S.overlay.flipH; rerender(); }, "Flip"],
        ["🎞️ Replace", () => openPicker("overlay")],
        ["✕ Remove", () => { S.overlay.img = null; S.overlay.dataUrl = null; buildLayerStack(); rerender(); }],
      ]));
      b.appendChild(groupLabel("Overlay colour"));
      ADJ_ROWS.forEach((sp) => b.appendChild(sliderRow(sp, S.overlay.adj, rerender)));
    },
  }));

  /* 🧍 Subjects — top of the stack first */
  [...S.layers].sort((a, b) => b.z - a.z).forEach((L) => {
    host.appendChild(sectionCard({
      key: "ly_" + L.id, icon: "🧍", title: L.name,
      meta: `${Math.round(L.fw * 100)}% · ${L.autoMatch ? "following scene" : "manual"}`,
      visible: L.visible, selected: L.id === S.selectedId,
      onToggle: () => { L.visible = !L.visible; buildLayerStack(); rerender(); },
      onSelect: () => { S.selectedId = L.id; renderHandles(); updateSceneButtons(); },
      actions: btnRow([
        ["🎯 Match to scene", () => { if (harmonizeLayer(L, 0.85)) { buildLayerStack(); rerender(); toast("Matched to the scene ✓ — tweak from here."); } }, "Re-read the scene and dial this subject to it"],
        ["⟲", () => { L.rot = (L.rot - 90 + 360) % 360; rerender(); }, "Rotate left"],
        ["⟳", () => { L.rot = (L.rot + 90) % 360; rerender(); }, "Rotate right"],
        ["⇋", () => { L.flipH = !L.flipH; rerender(); }, "Flip"],
        ["↺ Reset", () => { L.adj = newAdj(); L.matte = newMatte(); L._cache = null; buildLayerStack(); rerender(); }],
      ]),
      body: (b) => {
        b.appendChild(sliderRow({ k: "opacity", label: "Opacity", min: 0, max: 100, unit: "%" }, L, rerender));

        b.appendChild(groupLabel("Match to the scene"));
        const follow = document.createElement("label");
        follow.className = "switch";
        follow.innerHTML =
          `<input type="checkbox" data-follow="1" ${L.autoMatch ? "checked" : ""} />` +
          `<span>Follow the scene</span>`;
        follow.querySelector("input").addEventListener("change", (e) => {
          L.autoMatch = e.target.checked;
          if (L.autoMatch) autoMatchLayer(L);
          buildLayerStack(); rerender();
        });
        b.appendChild(follow);
        const fh = document.createElement("p");
        fh.className = "panel-hint dim";
        fh.style.margin = "5px 0 0";
        fh.textContent = "Re-reads the scene — as you grade it, and as you move this subject around it — and keeps the light and colour below matched. Moving any of them yourself turns this off.";
        b.appendChild(fh);
        b.appendChild(sliderRow(
          { k: "matchStrength", label: "Match strength", min: 0, max: 100, unit: "%" },
          L,
          () => { autoMatchLayer(L); syncSliders(); rerender(); }
        ));

        b.appendChild(groupLabel("Light & colour"));
        ADJ_ROWS.forEach((sp) => b.appendChild(sliderRow(sp, L.adj, () => {
          L._cache = null;
          breakFollow(L, b.closest(".lcard"));
          rerender();
        })));
        b.appendChild(sliderRow({ k: "blur", label: "Blur", min: 0, max: 100, hint: "match scene focus" }, L.adj, () => { L._cache = null; rerender(); }));
        b.appendChild(sliderRow({ k: "grain", label: "Grain", min: 0, max: 100, hint: "match scene noise" }, L.adj, () => { L._cache = null; rerender(); }));
        b.appendChild(groupLabel("Cut edge & hair"));
        b.appendChild(btnRow([
          ["✨ Refine hair", () => runRefineHair(L), "Re-solve the edge against the photo's own background"],
          ["✂️ Brush the mask", () => { S.selectedId = L.id; setBrush(true, "erase"); }],
        ]));
        const rf = document.createElement("p");
        rf.className = "panel-hint dim"; rf.style.margin = "5px 0 0";
        rf.textContent = "Refine estimates the local foreground and background colours around the edge and solves each pixel for how much of each it is — so strands come back as real partial alpha and the background spill causing a glowing rim gets un-mixed.";
        b.appendChild(rf);
        [
          { k: "reach",    label: "Reach",     min: 5,  max: 100, hint: "how far out to look for strands" },
          { k: "strength", label: "Strength",  min: 0,  max: 100 },
          { k: "spill",    label: "De-spill",  min: 0,  max: 100, hint: "un-mix the old background colour" },
        ].forEach((sp) => b.appendChild(sliderRow(sp, S.refine, () => {})));
        b.appendChild(sliderRow({ k: "fixAmount", label: "Fix-light strength", min: 0, max: 100, hint: "for what you brush" }, L, () => { L._cache = null; rerender(); }));
        MATTE_ROWS.forEach((sp) => b.appendChild(sliderRow(sp, L.matte, () => { L._cache = null; rerender(); })));
        b.appendChild(groupLabel("Shadow"));
        const sw = document.createElement("label");
        sw.className = "switch";
        sw.innerHTML = `<input type="checkbox" ${L.shadow.on ? "checked" : ""} /><span>Cast &amp; contact shadow</span>`;
        sw.querySelector("input").addEventListener("change", (e) => { L.shadow.on = e.target.checked; rerender(); });
        b.appendChild(sw);
        const bw = document.createElement("label");
        bw.className = "switch";
        bw.innerHTML = `<input type="checkbox" ${L.blocksLight !== false ? "checked" : ""} /><span>Blocks light (casts into the scene)</span>`;
        bw.querySelector("input").addEventListener("change", (e) => { L.blocksLight = e.target.checked; rerender(); });
        b.appendChild(bw);
        const fw = document.createElement("label");
        fw.className = "switch";
        fw.innerHTML = `<input type="checkbox" ${L.shadowFollow !== false ? "checked" : ""} /><span>Aim shadow at the light</span>`;
        fw.querySelector("input").addEventListener("change", (e) => {
          L.shadowFollow = e.target.checked;
          if (L.shadowFollow) { lightsDriveScene(); syncSliders(); }
          rerender();
        });
        b.appendChild(fw);
        SHADOW_ROWS.forEach((sp) => b.appendChild(sliderRow(sp, L.shadow, rerender)));
      },
    }));
  });

  /* 🖼️ Main image */
  host.appendChild(sectionCard({
    key: "base", icon: "🖼️", title: "Main image", meta: `${S.base.img.naturalWidth}×${S.base.img.naturalHeight}`,
    visible: S.base.visible,
    onToggle: () => { S.base.visible = !S.base.visible; buildLayerStack(); rerender(); },
    actions: btnRow([
      ["＋ Replace", () => openPicker("scene")],
      ["↺ Reset", () => { S.base.adj = newAdj(); S._an = null; autoMatchAll(); buildLayerStack(); rerender(); }],
    ]),
    body: (b) => {
      // Grading the scene moves the target the subjects were matched to, so
      // any subject still following it gets re-matched as the slider moves.
      const onBase = () => { S._an = null; if (autoMatchAll()) syncSliders(); rerender(); };
      ADJ_ROWS.forEach((sp) => b.appendChild(sliderRow(sp, S.base.adj, onBase)));
    },
  }));
}

/* ============================================================
   AUTO EDITS
   ============================================================ */
function buildLookChips() {
  dom.lookChips.innerHTML = "";
  Object.entries(LOOKS).forEach(([key, look]) => {
    const b = document.createElement("button");
    b.className = "chip" + (state.scene.look === key ? " active" : "");
    b.dataset.look = key;
    b.textContent = `${look.icon} ${look.name}`;
    b.addEventListener("click", () => applyLook(key));
    dom.lookChips.appendChild(b);
  });
}
function applyLook(key) {
  const look = LOOKS[key];
  const S = state.scene;
  if (!look || !S.base.img) return;

  // Order matters: grade the scene FIRST, then match subjects to the graded
  // scene. Doing it the other way round matches them to the ungraded upload
  // and then moves the scene out from under them.
  S.base.adj = Object.assign(newAdj(), look.base);
  S._an = null;
  S.look = key;
  S.layers.forEach((L) => {
    L.matchStrength = Math.round(look.match * 100);
    L.autoMatch = true;
    autoMatchLayer(L, true);   // matches the graded scene, then adds look.subject
  });
  const ovAdj = newAdj();
  Object.entries(look.overlay).forEach(([k, v]) => { if (k !== "opacity" && k !== "blend") ovAdj[k] = v; });
  S.overlay.adj = ovAdj;
  if (look.overlay.blend) S.overlay.blend = look.overlay.blend;
  if (typeof look.overlay.opacity === "number") S.overlay.opacity = S.overlay.img ? look.overlay.opacity : 0;
  Object.assign(S.finish, look.finish);
  if (look.glow) Object.assign(S.glow, look.glow);
  else { S.glow.visible = false; S.glow.count = 0; }
  if (look.night) Object.assign(S.night, look.night);
  else { S.night.visible = false; S.night.amount = 0; }
  S._an = null;

  buildLookChips(); buildLayerStack(); scheduleRender();
  status(`“${look.name}” applied — every slider below is now yours to tune.`, "ok");
  toast(`${look.icon} ${look.name} applied ✓`);
}

function buildModelChips() {
  if (!dom.cutModelChips) return;
  dom.cutModelChips.innerHTML = "";
  Object.entries(CUT_MODELS).forEach(([k, m]) => {
    const b = document.createElement("button");
    b.className = "chip" + (state.cut.model === k ? " active" : "");
    b.innerHTML = `${m.name}<em> · ${m.note}</em>`;
    b.title = m.note;
    b.addEventListener("click", () => { state.cut.model = k; buildModelChips(); });
    dom.cutModelChips.appendChild(b);
  });
}

/* ---- Brush bar (sits under the stage while painting) ---- */
function buildBrushBar() {
  const bar = dom.brushBar;
  bar.hidden = !state.brush.on;
  dom.brushToggle.classList.toggle("active", state.brush.on);
  if (!state.brush.on) return;
  const B = state.brush;
  const L = state.scene.layers.find((x) => x.id === state.scene.selectedId);
  bar.innerHTML = "";

  // What am I masking?
  const tgt = document.createElement("div");
  tgt.className = "brush-tools";
  Object.entries(MASK_TARGETS).forEach(([k, t]) => {
    const b = document.createElement("button");
    b.className = "tool-btn" + (B.target === k ? " active" : "");
    b.textContent = `${t.icon} ${t.name}`;
    b.addEventListener("click", () => {
      B.target = k;
      if (k !== "subject" && B.tool === "fix") B.tool = "add";
      buildBrushBar(); scheduleRender();
    });
    tgt.appendChild(b);
  });
  const showMask = document.createElement("button");
  showMask.className = "tool-btn" + (B.showMask ? " active" : "");
  showMask.textContent = "👁 Show mask";
  showMask.title = "See the mask in red while you work";
  showMask.addEventListener("click", () => { B.showMask = !B.showMask; buildBrushBar(); scheduleRender(); });
  tgt.appendChild(showMask);
  bar.appendChild(tgt);

  const tools = document.createElement("div");
  tools.className = "brush-tools";
  Object.entries(BRUSH_TOOLS).forEach(([k, t]) => {
    if (k === "fix" && B.target === "sky") return;      // subject-only
    const b = document.createElement("button");
    b.className = "tool-btn" + (B.tool === k ? " active" : "");
    b.textContent = `${t.icon} ${t.name}`;
    b.title = t.hint;
    b.addEventListener("click", () => { B.tool = k; buildBrushBar(); });
    tools.appendChild(b);
  });
  bar.appendChild(tools);

  const mini = (label, key, min, max) => {
    const w = document.createElement("label");
    w.className = "brush-slider";
    w.innerHTML = `<span>${label} <b>${B[key]}</b></span>`;
    const i = document.createElement("input");
    i.type = "range"; i.min = min; i.max = max; i.value = B[key]; i.className = "srange";
    i.addEventListener("input", () => { B[key] = Number(i.value); w.querySelector("b").textContent = i.value; });
    w.appendChild(i);
    return w;
  };
  const rows = document.createElement("div");
  rows.className = "brush-rows";
  rows.appendChild(mini(isWand(B.tool) ? "Reach" : "Size", "size", 1, 60));
  rows.appendChild(mini("Soft", "soft", 0, 100));
  rows.appendChild(mini(isWand(B.tool) ? "Tolerance" : (isDodgeBurn(B.tool) ? "Exposure" : "Strength"), "strength", 5, 100));
  bar.appendChild(rows);

  const acts = document.createElement("div");
  acts.className = "brush-tools";
  const add = (label, fn, title) => {
    const b = document.createElement("button");
    b.className = "tool-btn tiny"; b.textContent = label; if (title) b.title = title;
    b.addEventListener("click", fn); acts.appendChild(b);
  };
  if (B.target === "blocker") {
    add("↺ Clear blockers", () => { state.scene.occluder = null; ensureOccluder(); scheduleRender(); toast("Blockers cleared."); });
  }
  if (B.target === "depth") {
    add("↺ Reset to ground plane", () => { state.scene.depthMap = null; ensureDepth(); scheduleRender(); toast("Depth reset — near at the bottom of frame."); });
  }
  if (B.target === "sky") {
    add("↺ Reset sky edits", () => {
      state.scene.skyEdit = null; ensureSkyEdit(); skyEditDirty();
      toast("Hand edits to the sky mask cleared — detection only.");
    });
  }
  if (L && B.target === "subject") {
    add("✨ Refine hair", () => runRefineHair(L), "Re-solve the edge from the photo");
    add("↺ Reset mask", async () => {
      const asset = state.library.find((a) => a.id === L.assetId);
      if (!asset) { toast("Original mask not in the Library any more.", true); return; }
      const mi = await loadImage(asset.mask);
      const m = cvOf(L.imgW, L.imgH);
      m.getContext("2d").drawImage(mi, 0, 0, L.imgW, L.imgH);
      L.mask = m; L.decon = null; L.maskRev++; L._cache = null;
      scheduleRender(); toast("Mask reset to the original cut-out.");
    });
    add("○ Clear fix light", () => {
      L.fix = cvOf(L.imgW, L.imgH); L.maskRev++; L._cache = null; scheduleRender();
    });
  }
  add("✓ Done", () => setBrush(false));
  bar.appendChild(acts);

  const hint = document.createElement("p");
  hint.className = "brush-hint";
  const what = B.target === "sky" ? "the sky mask"
             : B.target === "blocker" ? "what blocks light — walls, fences, cars"
             : B.target === "depth" ? "how far away things are — add = nearer, remove = further"
             : (L ? `“${L.name}”` : null);
  hint.textContent = what
    ? `${isWand(B.tool) ? "Tap" : "Drag"} on the image — ${BRUSH_TOOLS[B.tool].hint}. Editing ${what}.`
    : "Select a subject in the Layers panel to paint on it.";
  bar.appendChild(hint);
}

/* ---- Merge ---- */
async function mergeScene() {
  const S = state.scene;
  if (!S.base.img) return;
  const out = renderComposite(S.base.img.naturalWidth);
  if (!out) return;
  const url = out.toDataURL("image/png");
  pushSceneVersion(url);
  S.layers = []; S.selectedId = null;
  S.base.adj = newAdj();
  S.overlay.img = null; S.overlay.dataUrl = null; S.overlay.adj = newAdj();
  S.finish = { visible: true, vignette: 0, grain: 0, fade: 0 };
  S.look = null;
  await showScene(url);
  buildLookChips();
  status("Merged into a new scene version ✓ — keep composing on top.", "ok");
  toast("Merged ✓");
}

/* ---- History ---- */
function renderHistory() {
  dom.historyStrip.hidden = state.tab === "cut" || state.scene.versions.length === 0;
  dom.historyItems.innerHTML = "";
  state.scene.versions.forEach((v, i) => {
    const t = document.createElement("div");
    t.className = "thumb" + (v.id === state.scene.currentId ? " active" : "");
    t.innerHTML = `<img src="${v.dataUrl}" alt="v${i + 1}" /><span class="thumb-badge">${i === 0 ? "base" : "v" + i}</span>`;
    t.addEventListener("click", async () => {
      state.scene.currentId = v.id; state.scene.layers = []; state.scene.selectedId = null;
      await showScene(v.dataUrl); renderHistory();
    });
    dom.historyItems.appendChild(t);
  });
}

/* ---------------- Download ---------------- */
function downloadUrl(url, name) { const a = document.createElement("a"); a.href = url; a.download = name; a.click(); }
function downloadScene() {
  const S = state.scene;
  if (!S.base.img) return;
  const out = renderComposite(S.base.img.naturalWidth);
  if (out) downloadUrl(out.toDataURL("image/png"), "composite.png");
}

/* The plate goes out WITHOUT the relight already applied, and without the
   finish. Exporting the relit look back into the relighter would compound it
   a second time, and vignette and grain are a lie about the light that the
   ratio would faithfully reproduce. */
function exportRelightPlate() {
  const S = state.scene;
  if (!S.base.img) return;
  const wasRelight = S.relight.visible, wasFinish = S.finish.visible;
  S.relight.visible = false; S.finish.visible = false;
  const out = renderComposite(S.base.img.naturalWidth);
  S.relight.visible = wasRelight; S.finish.visible = wasFinish;
  if (out) downloadUrl(out.toDataURL("image/png"), "relight-plate.png");
  status("Plate saved. Relight it, then load it back with ⬆ Relit.", "ok");
}

function pickRelight() { openPicker("relight"); }

async function setRelightRef(file) {
  const S = state.scene;
  if (!S.base.img) { status("Add a main image first.", "err"); return; }
  try {
    const dataUrl = await fileToDataUrl(file);
    const img = await loadImage(dataUrl);
    const ar = (img.naturalWidth / img.naturalHeight);
    const base = (S.base.img.naturalWidth / S.base.img.naturalHeight);
    S.relight.dataUrl = dataUrl; S.relight.img = img; S.relight.visible = true;
    buildLayerStack(); rerender();
    // Worth saying out loud: a heavy crop moves the light field off the frame
    // it is supposed to describe, and the result is subtly wrong everywhere.
    if (Math.abs(ar - base) / base > 0.06) {
      status("Loaded — but that came back a different shape, so the light is stretched to fit. Re-export uncropped for a clean match.", "err");
    } else {
      status("Lighting transferred ✓ — texture is still your photograph.", "ok");
    }
  } catch (err) {
    console.error(err);
    status("Couldn't read that image.", "err");
  }
}

/* ---------------- Relight handoff ---------------- */
const RELIGHT_PROMPT =
  "Turn this composite into a single, believable photograph. The scene has elements that were pasted in — " +
  "relight everything with one consistent light source, add natural contact and cast shadows, match color " +
  "temperature and grain across all elements, fix any edge halos, and color-grade it cohesively. " +
  "Keep the composition and every item exactly where it is — only make it look real.";
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy"); ta.remove(); return ok;
    } catch { return false; }
  }
}

/* ---------------- New session ---------------- */
function newSession() {
  if (!confirm("Start over? This clears the current scene and cut-out (your saved Library is kept).")) return;
  state.cut = { file: null, src: null, result: null, busy: false };
  state.scene = {
    versions: [], currentId: null,
    base: { img: null, adj: newAdj(), visible: true, token: 0 },
    layers: [],
    overlay: { dataUrl: null, img: null, visible: true, blend: "soft-light", opacity: 40, rot: 0, flipH: false, adj: newAdj() },
    finish: { visible: true, vignette: 0, grain: 0, fade: 0, blacks: 0, shoulder: 0, contrast: 0 },
    glow: { visible: false, count: 0, size: 30, spread: 60, cy: 62, intensity: 65, hue: 68, seed: 7 },
    lights: [],
    windows: { visible: false, list: [], warmth: 34, brightness: 62, spill: 45, variation: 35, seed: 5 },
    relight: { visible: true, dataUrl: null, img: null, strength: 100, scale: 10, colour: 100, protect: 20, keepDark: 45 },
    nightSolve: { visible: false, strength: 100, exposure: 70, canyon: 26, skyAmbient: 46, skyHue: 214, skySat: 30, windowGain: 62, lampGain: 70, floorLevel: 42, keepDark: 40 },
    night: { visible: false, amount: 0, skyHue: 220, skySat: 22, skyDark: 78, skyDetail: 70, shadowCool: 18, lightWarm: 55, horizonGlow: 35, glowSide: 70, stars: 0, lampWarmth: 72, skyDetect: 50, skyFeather: 30, skyEdge: 70, skyTighten: 0, skyBurn: 0, skyDodge: 0, ambient: 42, killDaylight: 78, seed: 3 },
    refine: { reach: 45, strength: 80, spill: 80 },
    selectedId: null, zTop: 1, look: null,
  };
  state.brush.on = false;
  dom.cutEmpty.hidden = false; dom.cutWrap.hidden = true;
  dom.cutSaveBtn.disabled = true; dom.cutDownloadBtn.disabled = true; dom.cutRunBtn.disabled = true;
  setCutTransformEnabled(false);
  dom.sceneEmpty.hidden = false; dom.sceneWrap.hidden = true;
  dom.layerOverlay.innerHTML = "";
  dom.layerStack.innerHTML = "";
  buildLookChips(); renderHistory(); updateSceneButtons(); status("");
}

/* ============================================================
   WIRING
   ============================================================ */
const openPicker = (target) => { uploadTarget = target; dom.fileInput.click(); };

async function init() {
  await loadLibrary(); renderLibrary(); buildModelChips(); buildLookChips(); updateSceneButtons();

  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));

  dom.cutUploadTrigger.addEventListener("click", () => openPicker("cut"));
  dom.cutAddBtn.addEventListener("click", () => openPicker("cut"));
  dom.sceneUploadTrigger.addEventListener("click", () => openPicker("scene"));
  dom.sceneAddBtn.addEventListener("click", () => openPicker("scene"));
  dom.overlayAddBtn.addEventListener("click", () => openPicker("overlay"));
  dom.fileInput.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f && f.type.startsWith("image/")) {
      ({ cut: cutSetSource, scene: sceneSetBase, overlay: setOverlay, relight: setRelightRef })[uploadTarget](f);
    }
    dom.fileInput.value = "";
  });

  const wireDrop = (zone, handler) => {
    ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("dragover"); }));
    ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "dragleave" && zone.contains(e.relatedTarget)) return; zone.classList.remove("dragover"); }));
    zone.addEventListener("drop", (e) => { const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("image/")); if (f) handler(f); });
  };
  wireDrop(dom.cutStage, cutSetSource);
  wireDrop(dom.sceneStage, sceneSetBase);

  // Cut
  dom.cutRunBtn.addEventListener("click", runCut);
  dom.cutSaveBtn.addEventListener("click", saveCutToLibrary);
  dom.cutDownloadBtn.addEventListener("click", () => state.cut.result && downloadUrl(state.cut.result, "cutout.png"));
  dom.cutRotL.addEventListener("click", () => cutTransform({ rot: 270 }));
  dom.cutRotR.addEventListener("click", () => cutTransform({ rot: 90 }));
  dom.cutFlip.addEventListener("click", () => cutTransform({ flipH: true }));

  // Scene
  dom.mergeBtn.addEventListener("click", mergeScene);
  dom.layerDeleteBtn.addEventListener("click", () => state.scene.selectedId && deleteLayer(state.scene.selectedId));
  dom.layerFlattenReset.addEventListener("click", () => {
    state.scene.layers = []; state.scene.selectedId = null;
    buildLayerStack(); scheduleRender(); updateSceneButtons();
  });
  dom.sceneDownloadBtn.addEventListener("click", downloadScene);
  dom.brushToggle.addEventListener("click", () => setBrush(!state.brush.on));
  dom.lightAddBtn.addEventListener("click", () => {
    const lt = newLight("sodium");
    state.scene.lights.push(lt); state.scene.selectedLight = lt.id;
    lightsDriveScene(); buildLayerStack(); scheduleRender();
    toast("Light placed — drag it on the image.");
  });
  dom.layerOverlay.addEventListener("pointerdown", (e) => { if (state.brush.on) startPaint(e); });
  dom.copyPromptBtn.addEventListener("click", async () => {
    const ok = await copyText(RELIGHT_PROMPT);
    toast(ok ? "Relight prompt copied — paste it in the Gemini app with your image." : "Couldn't copy automatically.");
  });
  dom.harmonizeBtn.addEventListener("click", () => {
    const S = state.scene;
    const L = S.layers.find((x) => x.id === S.selectedId) || S.layers[S.layers.length - 1];
    if (!L) return;
    if (autoMatchLayer(L, true)) {
      L.autoMatch = true;
      buildLayerStack(); scheduleRender();
      status("Subject matched to the scene's light and colour ✓", "ok");
      toast("🎯 Matched to the scene ✓");
    }
  });

  // Hold to compare against the untouched main image
  const setBase = (v) => { previewBase = v; dom.beforeAfterBtn.classList.toggle("active", v); scheduleRender(); };
  ["pointerdown"].forEach((ev) => dom.beforeAfterBtn.addEventListener(ev, () => setBase(true)));
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => dom.beforeAfterBtn.addEventListener(ev, () => setBase(false)));

  dom.sceneWrap.addEventListener("pointerdown", (e) => {
    // While brushing, a stroke starts on the overlay and bubbles to here.
    // Deselecting on it would clear the very layer being painted, so the
    // brush would work exactly once and then go dead.
    if (state.brush.on) return;
    if (e.target === dom.sceneWrap || e.target === dom.sceneCanvas || e.target === dom.layerOverlay) {
      state.scene.selectedId = null; renderHandles(); updateSceneButtons();
    }
  });
  window.addEventListener("resize", () => { if (state.tab === "scene") scheduleRender(); });

  // Help
  const showHelp = (v) => (dom.helpModal.hidden = !v);
  dom.helpBtn.addEventListener("click", () => showHelp(true));
  dom.helpClose.addEventListener("click", () => showHelp(false));
  dom.helpOk.addEventListener("click", () => showHelp(false));
  dom.helpModal.addEventListener("click", (e) => { if (e.target === dom.helpModal) showHelp(false); });

  dom.newSessionBtn.addEventListener("click", newSession);
}

document.addEventListener("DOMContentLoaded", init);
