/* ============================================================
   Claude Photo Studio — FREE cut-out & scene compositor
   100% client-side. No account, no API key, no quota.
     • Cut Out — background removal runs in-browser via
       @imgly/background-removal (open source, on-device).
     • Scene   — place cutouts, move/resize/rotate, cast shadows,
       color-grade, and merge — all with the Canvas API locally.
   Your photos never leave your device.
   ============================================================ */
"use strict";

/* ---------------- State ---------------- */
const state = {
  tab: "cut",
  library: [],
  cut: { file: null, src: null, result: null, busy: false },
  scene: {
    versions: [], currentId: null,
    layers: [], selectedId: null,
    zTop: 1, grade: "none", lightDir: "tl",
  },
};
let idSeq = 0;
const uid = (p) => `${p}_${Date.now().toString(36)}_${idSeq++}`;
let uploadTarget = "cut";

/* Color grades — same string works as CSS filter AND canvas ctx.filter */
const GRADES = {
  none: "",
  warm: "saturate(1.12) sepia(0.18) brightness(1.03)",
  cinematic: "contrast(1.15) saturate(0.9) brightness(0.98) sepia(0.08)",
  cool: "saturate(1.06) hue-rotate(-12deg) brightness(1.02)",
  bw: "grayscale(1) contrast(1.08)",
  vivid: "saturate(1.4) contrast(1.06)",
};

/* ---------------- DOM ---------------- */
const el = (id) => document.getElementById(id);
const dom = {};
[
  "cutStage","cutEmpty","cutWrap","cutImg","cutLoading","cutLoadingText",
  "sceneStage","sceneEmpty","sceneWrap","sceneImg","layerOverlay",
  "cutToolbar","cutAddBtn","cutSaveBtn","cutDownloadBtn",
  "sceneToolbar","sceneAddBtn","layerDeleteBtn","layerFlattenReset","sceneDownloadBtn",
  "historyStrip","historyItems",
  "libraryItems","libCount","libHint",
  "cutPanel","cutRunBtn",
  "scenePanel","shadowToggle","lightDir","gradeChips","mergeBtn","copyPromptBtn","statusMsg",
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
function blobToDataUrl(blob) { return fileToDataUrl(blob); }
function loadImage(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
}
function cvOf(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }

/* ============================================================
   Background removal engine (lazy-loaded, cached)
   ============================================================ */
let _imgly = null;
/* Browser-bundled builds only — the raw dist/index.mjs has bare imports
   (zod, ndarray, lodash-es) that don't resolve in a browser. jsDelivr's
   "/+esm" and esm.sh bundle those dependencies for us. */
const IMGLY_SOURCES = [
  "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm",
  "https://esm.sh/@imgly/background-removal@1.7.0",
  "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1/+esm",
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
  if (!isCut) requestAnimationFrame(positionOverlay);
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
    dom.cutImg.style.filter = "";
    dom.cutEmpty.hidden = true;
    dom.cutWrap.hidden = false;
    dom.cutRunBtn.disabled = false;
    dom.cutSaveBtn.disabled = true;
    dom.cutDownloadBtn.disabled = true;
  } catch { toast("Couldn't read that image.", true); }
}

async function runCut() {
  if (!state.cut.file || state.cut.busy) return;
  cutBusy(true, "Loading model…");
  try {
    const removeBackground = await ensureImgly();
    const blob = await removeBackground(state.cut.file, {
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
function cutBusy(b, text = "Removing background…") {
  state.cut.busy = b;
  dom.cutLoading.hidden = !b;
  dom.cutLoadingText.textContent = text;
  dom.cutRunBtn.disabled = b || !state.cut.file;
}
function saveCutToLibrary() {
  if (!state.cut.result) return;
  state.library.push({ id: uid("lib"), dataUrl: state.cut.result });
  persistLibrary(); renderLibrary();
  toast("Saved to Library ✓");
}

/* ============================================================
   LIBRARY
   ============================================================ */
function persistLibrary() { try { localStorage.setItem("cps_library", JSON.stringify(state.library)); } catch {} }
function loadLibrary() { try { const r = localStorage.getItem("cps_library"); if (r) state.library = JSON.parse(r) || []; } catch { state.library = []; } }
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
    d.title = state.tab === "scene" ? "Tap to place · drag to reorder" : "Drag to reorder · Scene tab to use";
    d.innerHTML = `<img src="${item.dataUrl}" alt="cutout" draggable="false" /><span class="lib-del" data-del="${item.id}">✕</span>`;
    d.addEventListener("pointerdown", (e) => startLibPointer(e, item, d));
    dom.libraryItems.appendChild(d);
  });
}

/* ---- Library: tap-to-place + drag-to-reorder (mouse & touch) ---- */
let libDrag = null;
function handleLibTap(item) {
  if (state.tab !== "scene") { setTab("scene"); toast("Switched to Scene — tap the cutout again to place it."); return; }
  if (!state.scene.currentId) { toast("Add a scene photo first.", true); return; }
  addLayerFromAsset(item);
}
function startLibPointer(e, item, elem) {
  if (e.target.dataset.del) {
    state.library = state.library.filter((x) => x.id !== item.id);
    persistLibrary(); renderLibrary();
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
    renderLayers(); updateSceneButtons();
    status("Scene loaded. Tap a Library cutout to place it.");
  } catch { toast("Couldn't read that image.", true); }
}
function pushSceneVersion(dataUrl) {
  const v = { id: uid("sv"), dataUrl }; state.scene.versions.push(v); state.scene.currentId = v.id; renderHistory();
}
async function showScene(dataUrl) {
  await new Promise((res) => { dom.sceneImg.onload = () => res(); dom.sceneImg.src = dataUrl; });
  applyGradePreview(); positionOverlay();
}
function currentSceneUrl() { const v = state.scene.versions.find((x) => x.id === state.scene.currentId); return v ? v.dataUrl : null; }

/* ---- Overlay geometry ---- */
function positionOverlay() {
  if (dom.sceneWrap.hidden) return;
  const img = dom.sceneImg; if (!img.naturalWidth) return;
  const wrap = dom.sceneWrap.getBoundingClientRect();
  const r = img.getBoundingClientRect();
  const ov = dom.layerOverlay;
  ov.style.left = r.left - wrap.left + "px";
  ov.style.top = r.top - wrap.top + "px";
  ov.style.width = r.width + "px";
  ov.style.height = r.height + "px";
  renderLayers();
}
function addLayerFromAsset(asset) {
  loadImage(asset.dataUrl).then((im) => {
    state.scene.layers.push({
      id: uid("ly"), dataUrl: asset.dataUrl, img: im,
      imgW: im.naturalWidth, imgH: im.naturalHeight,
      fx: 0.5, fy: 0.5, fw: 0.4, rot: 0, z: ++state.scene.zTop,
    });
    state.scene.selectedId = state.scene.layers[state.scene.layers.length - 1].id;
    renderLayers(); updateSceneButtons();
    status("Placed. Drag to move · corner = resize · top handle = rotate.");
  });
}
const sortedLayers = () => [...state.scene.layers].sort((a, b) => a.z - b.z);

/* ---- Shadow direction ---- */
function shadowVec() {
  const map = { tl: [1, 1], tr: [-1, 1], t: [0, 1], bl: [1, -1], br: [-1, -1] };
  return map[state.scene.lightDir] || [1, 1];
}

function renderLayers() {
  const ov = dom.layerOverlay;
  const ow = ov.clientWidth, oh = ov.clientHeight;
  ov.classList.toggle("with-shadow", dom.shadowToggle.checked);
  // preview shadow offset in px
  const [vx, vy] = shadowVec();
  const mag = Math.max(3, Math.round(Math.min(ow, oh) * 0.018)) || 5;
  ov.style.setProperty("--sx", vx * mag + "px");
  ov.style.setProperty("--sy", vy * mag + "px");
  const gradeF = GRADES[state.scene.grade] || "";
  ov.innerHTML = "";
  for (const L of sortedLayers()) {
    const div = document.createElement("div");
    div.className = "layer" + (L.id === state.scene.selectedId ? " selected" : "");
    div.style.left = L.fx * ow + "px";
    div.style.top = L.fy * oh + "px";
    div.style.width = L.fw * ow + "px";
    div.style.setProperty("--rot", L.rot + "deg");
    div.dataset.id = L.id;
    div.innerHTML =
      `<img src="${L.dataUrl}" alt="item" style="filter:${gradeF}" />` +
      `<span class="handle h-del" data-role="del" title="Delete">✕</span>` +
      `<span class="handle h-rotate" data-role="rotate" title="Rotate">⟳</span>` +
      `<span class="handle h-resize" data-role="resize" title="Resize">⤡</span>`;
    div.addEventListener("pointerdown", (e) => startLayerPointer(e, L));
    ov.appendChild(div);
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
  renderLayers(); updateSceneButtons();
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
    L.rot = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90;
  }
  renderLayers();
}
function endLayerPointer() { drag = null; window.removeEventListener("pointermove", moveLayerPointer); window.removeEventListener("pointerup", endLayerPointer); }
const clamp01 = (v) => Math.max(-0.1, Math.min(1.1, v));
function deleteLayer(id) {
  state.scene.layers = state.scene.layers.filter((x) => x.id !== id);
  if (state.scene.selectedId === id) state.scene.selectedId = null;
  renderLayers(); updateSceneButtons();
}

function updateSceneButtons() {
  const hasScene = !!state.scene.currentId;
  const hasLayers = state.scene.layers.length > 0;
  dom.mergeBtn.disabled = !hasScene;
  dom.sceneDownloadBtn.disabled = !hasScene;
  dom.layerDeleteBtn.disabled = !state.scene.selectedId;
  dom.layerFlattenReset.disabled = !hasLayers;
  dom.mergeBtn.textContent = hasLayers ? "🧩 Merge items & bake grade" : "🎨 Bake grade into scene";
}

/* ---- Grade preview ---- */
function applyGradePreview() {
  const f = GRADES[state.scene.grade] || "";
  dom.sceneImg.style.filter = f;
  renderLayers();
}

/* ---- Sprite with rotation baked in ---- */
function makeSprite(img, w, h, rotDeg) {
  const rad = (rotDeg * Math.PI) / 180;
  const bw = Math.ceil(Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad)));
  const bh = Math.ceil(Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad)));
  const c = cvOf(Math.max(1, bw), Math.max(1, bh));
  const ctx = c.getContext("2d");
  ctx.translate(bw / 2, bh / 2); ctx.rotate(rad);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return { canvas: c, bw, bh };
}

/* ---- Flatten base + layers (+ shadows + grade) ---- */
function flattenScene() {
  const base = dom.sceneImg;
  const W = base.naturalWidth, H = base.naturalHeight;
  const cv = cvOf(W, H); const ctx = cv.getContext("2d");
  ctx.drawImage(base, 0, 0, W, H);
  const shadows = dom.shadowToggle.checked;
  const [vx, vy] = shadowVec();
  const mag = Math.round(Math.min(W, H) * 0.02);
  const blur = Math.max(4, Math.round(Math.min(W, H) * 0.02));
  for (const L of sortedLayers()) {
    const w = L.fw * W, h = w * (L.imgH / L.imgW);
    const sp = makeSprite(L.img, w, h, L.rot);
    ctx.save();
    if (shadows) { ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = blur; ctx.shadowOffsetX = vx * mag; ctx.shadowOffsetY = vy * mag; }
    ctx.drawImage(sp.canvas, L.fx * W - sp.bw / 2, L.fy * H - sp.bh / 2);
    ctx.restore();
  }
  const gf = GRADES[state.scene.grade];
  if (!gf) return cv.toDataURL("image/png");
  const g = cvOf(W, H); const gx = g.getContext("2d");
  gx.filter = gf; gx.drawImage(cv, 0, 0);
  return g.toDataURL("image/png");
}

/* ---- Merge ---- */
async function mergeScene() {
  if (!state.scene.currentId) return;
  const out = flattenScene();
  pushSceneVersion(out);
  state.scene.layers = []; state.scene.selectedId = null;
  state.scene.grade = "none"; syncGradeChips();
  await showScene(out);
  renderLayers(); updateSceneButtons();
  status("Merged into a new scene version ✓", "ok");
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
      await showScene(v.dataUrl); renderLayers(); renderHistory(); updateSceneButtons();
    });
    dom.historyItems.appendChild(t);
  });
}

/* ---- Grade chips ---- */
function syncGradeChips() {
  dom.gradeChips.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.grade === state.scene.grade));
}

/* ---------------- Download ---------------- */
function downloadUrl(url, name) { const a = document.createElement("a"); a.href = url; a.download = name; a.click(); }

/* ---------------- Relight handoff ---------------- */
const RELIGHT_PROMPT =
  "Turn this composite into a single, believable photograph. The scene has elements that were pasted in — " +
  "relight everything with one consistent light source, add natural contact and cast shadows, match color " +
  "temperature and grain across all elements, fix any edge halos, and color-grade it cohesively. " +
  "Keep the composition and every item exactly where it is — only make it look real.";
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try { const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove(); return ok; }
    catch { return false; }
  }
}

/* ---------------- New session ---------------- */
function newSession() {
  if (!confirm("Start over? This clears the current scene and cut-out (your saved Library is kept).")) return;
  state.cut = { file: null, src: null, result: null, busy: false };
  state.scene = { versions: [], currentId: null, layers: [], selectedId: null, zTop: 1, grade: "none", lightDir: state.scene.lightDir };
  dom.cutEmpty.hidden = false; dom.cutWrap.hidden = true;
  dom.cutSaveBtn.disabled = true; dom.cutDownloadBtn.disabled = true; dom.cutRunBtn.disabled = true;
  dom.sceneEmpty.hidden = false; dom.sceneWrap.hidden = true;
  dom.layerOverlay.innerHTML = "";
  syncGradeChips(); renderHistory(); updateSceneButtons(); status("");
}

/* ============================================================
   WIRING
   ============================================================ */
function init() {
  loadLibrary(); renderLibrary(); updateSceneButtons();

  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));

  const openPicker = (target) => { uploadTarget = target; dom.fileInput.click(); };
  dom.cutUploadTrigger.addEventListener("click", () => openPicker("cut"));
  dom.cutAddBtn.addEventListener("click", () => openPicker("cut"));
  dom.sceneUploadTrigger.addEventListener("click", () => openPicker("scene"));
  dom.sceneAddBtn.addEventListener("click", () => openPicker("scene"));
  dom.fileInput.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f && f.type.startsWith("image/")) (uploadTarget === "cut" ? cutSetSource : sceneSetBase)(f);
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

  // Scene
  dom.mergeBtn.addEventListener("click", mergeScene);
  dom.layerDeleteBtn.addEventListener("click", () => state.scene.selectedId && deleteLayer(state.scene.selectedId));
  dom.layerFlattenReset.addEventListener("click", () => { state.scene.layers = []; state.scene.selectedId = null; renderLayers(); updateSceneButtons(); });
  dom.sceneDownloadBtn.addEventListener("click", () => { const url = flattenScene(); if (url) downloadUrl(url, "scene.png"); });
  dom.copyPromptBtn.addEventListener("click", async () => { const ok = await copyText(RELIGHT_PROMPT); toast(ok ? "Relight prompt copied — paste it in the Gemini app with your image." : "Couldn't copy automatically."); });
  dom.shadowToggle.addEventListener("change", renderLayers);
  dom.lightDir.addEventListener("change", () => { state.scene.lightDir = dom.lightDir.value; renderLayers(); });
  dom.gradeChips.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip"); if (!chip) return;
    state.scene.grade = chip.dataset.grade; syncGradeChips(); applyGradePreview();
  });

  dom.sceneWrap.addEventListener("pointerdown", (e) => {
    if (e.target === dom.sceneWrap || e.target === dom.sceneImg || e.target === dom.layerOverlay) { state.scene.selectedId = null; renderLayers(); updateSceneButtons(); }
  });
  window.addEventListener("resize", () => { if (state.tab === "scene") positionOverlay(); });

  // Help
  const showHelp = (v) => (dom.helpModal.hidden = !v);
  dom.helpBtn.addEventListener("click", () => showHelp(true));
  dom.helpClose.addEventListener("click", () => showHelp(false));
  dom.helpOk.addEventListener("click", () => showHelp(false));
  dom.helpModal.addEventListener("click", (e) => { if (e.target === dom.helpModal) showHelp(false); });

  dom.newSessionBtn.addEventListener("click", newSession);
}

document.addEventListener("DOMContentLoaded", init);
