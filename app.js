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
const newMatte = () => ({ choke: 0, feather: 0, edgeDark: 0 });
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
    base: { exposure: -46, contrast: 18, saturation: -34, temperature: -40, highlights: -26, shadows: -10 },
    subject: { exposure: -14, temperature: -12, saturation: -10 },
    overlay: { opacity: 18, blend: "soft-light", saturation: -40, exposure: -20 },
    finish: { vignette: 52, grain: 20, fade: 4 },
    glow: { visible: true, count: 34, size: 26, spread: 62, cy: 64, intensity: 70, hue: 68 },
  },
  fireflies: {
    name: "Fireflies", icon: "🪰", match: 0.9,
    base: { exposure: -38, contrast: 14, saturation: -20, temperature: -28, highlights: -20 },
    subject: { exposure: -10, temperature: -8 },
    overlay: { opacity: 14, blend: "soft-light", saturation: -30, exposure: -18 },
    finish: { vignette: 46, grain: 16, fade: 6 },
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
    finish: { visible: true, vignette: 0, grain: 0, fade: 0 },
    glow: { visible: false, count: 0, size: 30, spread: 60, cy: 62, intensity: 65, hue: 68, seed: 7 },
    selectedId: null, zTop: 1, look: null,
    refine: { reach: 45, strength: 80, spill: 80 },
  },
  brush: { on: false, tool: "erase", size: 12, soft: 60, strength: 70 },
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
  "sceneToolbar","sceneAddBtn","overlayAddBtn","brushToggle","brushBar","layerDeleteBtn","layerFlattenReset",
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
  const md = mc.getContext("2d").getImageData(0, 0, W, H).data;
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
    ctx.putImageData(id, 0, 0);
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

  /* 3 — glow specks (fireflies, embers, dust catching the light).
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

  /* 4 — texture overlay */
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

  /* 5 — finish */
  const F = S.finish;
  if (F.visible) {
    if (F.vignette > 0) {
      const k = F.vignette / 100;
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.28, W / 2, H / 2, Math.max(W, H) * 0.78);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, `rgba(0,0,0,${(k * 0.82).toFixed(3)})`);
      ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore();
    }
    if (F.grain > 0 || F.fade > 0) {
      const id = ctx.getImageData(0, 0, W, H);
      const d = id.data;
      const grain = F.grain / 100, fade = F.fade / 100;
      const lift = fade * 0.20, mul = 1 - fade * 0.16;
      for (let i = 0; i < d.length; i += 4) {
        let r = d[i] / 255, g2 = d[i + 1] / 255, b = d[i + 2] / 255;
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
  const sig = S.base.token + "|" + JSON.stringify(S.base.adj);
  if (S._an && S._an.sig === sig) return S._an;
  const W = 640, H = Math.max(1, Math.round(W * (S.base.img.naturalHeight / S.base.img.naturalWidth)));
  const c = cvOf(W, H);
  const x = c.getContext("2d");
  x.drawImage(S.base.img, 0, 0, W, H);
  const id = x.getImageData(0, 0, W, H);
  applyAdjust(id, S.base.adj);
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
const BRUSH_TOOLS = {
  erase:   { icon: "🩹", name: "Erase",    hint: "cut leftover background away" },
  restore: { icon: "🖌", name: "Restore",  hint: "paint the subject back in" },
  fix:     { icon: "💡", name: "Fix light", hint: "kill a glow / match the scene's light" },
};

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

function paintAt(L, from, to) {
  const B = state.brush;
  const target = B.tool === "fix" ? L.fix : L.mask;
  const ctx = target.getContext("2d");
  // Brush size is a share of the subject's own width, so it stays consistent
  // whatever the subject is scaled to on screen.
  const radius = Math.max(1, (B.size / 200) * L.mask.width);
  const alpha = (B.strength / 100) * (B.tool === "fix" ? 0.35 : 0.5);
  const color = B.tool === "erase" ? "rgba(0,0,0,ALPHA)" : "rgba(255,255,255,ALPHA)";

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
  // Fall back to the top layer rather than refusing to paint — if there is
  // only one subject there is no ambiguity about what the user meant.
  const S = state.scene;
  const L = S.layers.find((x) => x.id === S.selectedId) || (S.layers.length === 1 ? S.layers[0] : null);
  if (!L) { toast("Tap a subject in the Layers panel first, then brush.", true); return; }
  S.selectedId = L.id;
  e.preventDefault();
  e.stopPropagation();
  const p = pointToMask(L, e.clientX, e.clientY);
  painting = { L, last: p };
  paintAt(L, p, p);
  scheduleRender();
  dom.layerOverlay.setPointerCapture?.(e.pointerId);
  window.addEventListener("pointermove", movePaint);
  window.addEventListener("pointerup", endPaint);
}
function movePaint(e) {
  if (!painting) return;
  e.preventDefault();
  const p = pointToMask(painting.L, e.clientX, e.clientY);
  paintAt(painting.L, painting.last, p);
  painting.last = p;
  scheduleRender();
}
function endPaint() {
  painting = null;
  window.removeEventListener("pointermove", movePaint);
  window.removeEventListener("pointerup", endPaint);
}

function setBrush(on, tool) {
  state.brush.on = on;
  if (tool) state.brush.tool = tool;
  dom.layerOverlay.classList.toggle("painting", on);
  dom.sceneStage.classList.toggle("brush-mode", on);
  renderHandles();
  buildBrushBar();
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
  if (drag && (drag.role === "move" || drag.role === "resize") && autoMatchLayer(drag.L)) {
    buildLayerStack(); scheduleRender();
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
  dom.brushToggle.disabled = !hasLayers;
  if (!hasLayers && state.brush.on) setBrush(false);
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

  const tools = document.createElement("div");
  tools.className = "brush-tools";
  Object.entries(BRUSH_TOOLS).forEach(([k, t]) => {
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
  rows.appendChild(mini("Size", "size", 1, 60));
  rows.appendChild(mini("Soft", "soft", 0, 100));
  rows.appendChild(mini("Strength", "strength", 5, 100));
  bar.appendChild(rows);

  const acts = document.createElement("div");
  acts.className = "brush-tools";
  const add = (label, fn, title) => {
    const b = document.createElement("button");
    b.className = "tool-btn tiny"; b.textContent = label; if (title) b.title = title;
    b.addEventListener("click", fn); acts.appendChild(b);
  };
  if (L) {
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
  hint.textContent = L
    ? `Painting on “${L.name}”. ${BRUSH_TOOLS[B.tool].hint}.`
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
    finish: { visible: true, vignette: 0, grain: 0, fade: 0 },
    glow: { visible: false, count: 0, size: 30, spread: 60, cy: 62, intensity: 65, hue: 68, seed: 7 },
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
      ({ cut: cutSetSource, scene: sceneSetBase, overlay: setOverlay })[uploadTarget](f);
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
