/* ============================================================
   Claude Photo Studio — cut-out & scene compositor
   Two workspaces sharing one free Gemini backend:
     • Cut Out — isolate an item onto a transparent cutout → Library
     • Scene   — drop cutouts onto a base image, arrange, then blend
   All calls go to Google Gemini from the browser with the user's own
   free key (localStorage). No backend, no cost.
   ============================================================ */
"use strict";

/* ---------------- Settings ---------------- */
const settings = {
  apiKey: localStorage.getItem("cps_apiKey") || "",
  model: localStorage.getItem("cps_model") || "gemini-2.5-flash-image",
};

/* ---------------- State ---------------- */
const state = {
  tab: "cut",
  library: [],                 // [{id, dataUrl}]
  cut: { src: null, result: null, busy: false },
  scene: {
    versions: [],              // [{id, dataUrl}] base-scene history
    currentId: null,
    layers: [],                // placed cutouts
    selectedId: null,
    busy: false,
    zTop: 1,
  },
};

let idSeq = 0;
const uid = (p) => `${p}_${Date.now().toString(36)}_${idSeq++}`;
let uploadTarget = "cut";

/* ---------------- DOM ---------------- */
const el = (id) => document.getElementById(id);
const dom = {};
[
  "cutStage","cutEmpty","cutWrap","cutImg","cutLoading","cutLoadingText",
  "sceneStage","sceneEmpty","sceneWrap","sceneImg","layerOverlay","sceneLoading","sceneLoadingText",
  "cutToolbar","cutAddBtn","cutSaveBtn","cutDownloadBtn",
  "sceneToolbar","sceneAddBtn","layerDeleteBtn","layerFlattenReset","sceneDownloadBtn",
  "historyStrip","historyItems",
  "libraryItems","libCount","libHint",
  "cutPanel","cutPrompt","cutRunBtn",
  "scenePanel","messages","blendBtn","composer","prompt","sendBtn",
  "fileInput","cutUploadTrigger","sceneUploadTrigger",
  "newSessionBtn","settingsBtn","settingsModal","settingsClose","settingsSave","apiKeyInput","modelInput",
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
function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });
}
function splitDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!m) throw new Error("Unsupported image encoding");
  return { mimeType: m[1], data: m[2] };
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ---------------- Gemini ---------------- */
async function callGemini(promptText, images) {
  if (!settings.apiKey) throw new Error("Add your free Google AI Studio key in Settings first.");
  const parts = [{ text: promptText }];
  for (const dataUrl of images) parts.push({ inlineData: splitDataUrl(dataUrl) });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    settings.model
  )}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `Request failed (${res.status})`);
  const cand = json?.candidates?.[0];
  if (!cand) {
    const fb = json?.promptFeedback?.blockReason;
    throw new Error(fb ? `Blocked by safety filter (${fb}).` : "No result returned.");
  }
  let imageOut = null, textOut = "";
  for (const p of cand.content?.parts || []) {
    if (p.inlineData?.data) imageOut = `data:${p.inlineData.mimeType || "image/png"};base64,${p.inlineData.data}`;
    else if (p.text) textOut += p.text;
  }
  return { imageOut, textOut };
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
  if (!isCut) requestAnimationFrame(positionOverlay);
}

/* ============================================================
   CUT-OUT WORKSPACE
   ============================================================ */
async function cutSetSource(file) {
  try {
    const dataUrl = await fileToDataUrl(file);
    state.cut.src = dataUrl;
    state.cut.result = null;
    dom.cutImg.src = dataUrl;
    dom.cutEmpty.hidden = true;
    dom.cutWrap.hidden = false;
    dom.cutRunBtn.disabled = false;
    dom.cutSaveBtn.disabled = true;
    dom.cutDownloadBtn.disabled = true;
  } catch {
    toast("Couldn't read that image.", true);
  }
}

async function runCut() {
  if (!state.cut.src || state.cut.busy) return;
  const want = dom.cutPrompt.value.trim();
  const subject = want || "the main subject";
  const prompt =
    `Cut out ${subject} from this image. Remove the background completely and return ONLY ${subject} ` +
    `as a PNG with a fully transparent background (real alpha channel). Do not add any new background, ` +
    `canvas, drop shadow, outline or border. Keep the subject's original detail, edges and colors.`;
  cutBusy(true);
  try {
    const { imageOut, textOut } = await callGemini(prompt, [state.cut.src]);
    if (!imageOut) {
      toast(textOut ? textOut.slice(0, 120) : "No cutout returned — try rephrasing.", true);
      return;
    }
    state.cut.result = imageOut;
    dom.cutImg.src = imageOut;
    dom.cutSaveBtn.disabled = false;
    dom.cutDownloadBtn.disabled = false;
    toast("Cutout ready — add it to your Library.");
  } catch (err) {
    toast(err.message || "Cut-out failed", true);
  } finally {
    cutBusy(false);
  }
}
function cutBusy(b) {
  state.cut.busy = b;
  dom.cutLoading.hidden = !b;
  dom.cutRunBtn.disabled = b || !state.cut.src;
}

function saveCutToLibrary() {
  const url = state.cut.result;
  if (!url) return;
  state.library.push({ id: uid("lib"), dataUrl: url });
  persistLibrary();
  renderLibrary();
  toast("Saved to Library ✓");
}

/* ============================================================
   LIBRARY
   ============================================================ */
function persistLibrary() {
  try {
    localStorage.setItem("cps_library", JSON.stringify(state.library));
  } catch {
    /* quota — keep in memory only for this session */
  }
}
function loadLibrary() {
  try {
    const raw = localStorage.getItem("cps_library");
    if (raw) state.library = JSON.parse(raw) || [];
  } catch {
    state.library = [];
  }
}
function renderLibrary() {
  dom.libCount.textContent = state.library.length;
  dom.libHint.hidden = state.library.length > 0;
  dom.libraryItems.innerHTML = "";
  if (!state.library.length) {
    const p = document.createElement("div");
    p.className = "lib-empty";
    p.textContent = "No cutouts yet. Make one in the Cut Out tab.";
    dom.libraryItems.appendChild(p);
    return;
  }
  state.library.forEach((item) => {
    const d = document.createElement("div");
    d.className = "lib-item";
    d.title = state.tab === "scene" ? "Tap to drop into the scene" : "Switch to Scene tab to use";
    d.innerHTML = `<img src="${item.dataUrl}" alt="cutout" /><span class="lib-del" data-del="${item.id}">✕</span>`;
    d.addEventListener("click", (e) => {
      if (e.target.dataset.del) {
        state.library = state.library.filter((x) => x.id !== item.id);
        persistLibrary();
        renderLibrary();
        return;
      }
      if (state.tab !== "scene") {
        setTab("scene");
        toast("Switched to Scene — tap the cutout again to place it.");
        return;
      }
      if (!state.scene.currentId) {
        toast("Add a scene photo first.", true);
        return;
      }
      addLayerFromAsset(item);
    });
    dom.libraryItems.appendChild(d);
  });
}

/* ============================================================
   SCENE WORKSPACE
   ============================================================ */
async function sceneSetBase(file) {
  try {
    const dataUrl = await fileToDataUrl(file);
    pushSceneVersion(dataUrl);
    state.scene.layers = [];
    state.scene.selectedId = null;
    dom.sceneEmpty.hidden = true;
    dom.sceneWrap.hidden = false;
    await showScene(dataUrl);
    renderLayers();
    updateSceneButtons();
  } catch {
    toast("Couldn't read that image.", true);
  }
}
function pushSceneVersion(dataUrl) {
  const v = { id: uid("sv"), dataUrl };
  state.scene.versions.push(v);
  state.scene.currentId = v.id;
  renderHistory();
}
async function showScene(dataUrl) {
  await new Promise((res) => {
    dom.sceneImg.onload = () => res();
    dom.sceneImg.src = dataUrl;
  });
  positionOverlay();
}

function currentSceneUrl() {
  const v = state.scene.versions.find((x) => x.id === state.scene.currentId);
  return v ? v.dataUrl : null;
}

/* ---- Layer overlay geometry ---- */
function positionOverlay() {
  if (dom.sceneWrap.hidden) return;
  const img = dom.sceneImg;
  if (!img.naturalWidth) return;
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
    const layer = {
      id: uid("ly"),
      dataUrl: asset.dataUrl,
      img: im,
      imgW: im.naturalWidth,
      imgH: im.naturalHeight,
      fx: 0.5, fy: 0.5,     // center as fraction of scene
      fw: 0.4,              // width as fraction of scene width
      rot: 0,
      z: ++state.scene.zTop,
    };
    state.scene.layers.push(layer);
    state.scene.selectedId = layer.id;
    renderLayers();
    updateSceneButtons();
  });
}

function renderLayers() {
  const ov = dom.layerOverlay;
  const ow = ov.clientWidth, oh = ov.clientHeight;
  ov.innerHTML = "";
  const sorted = [...state.scene.layers].sort((a, b) => a.z - b.z);
  for (const L of sorted) {
    const wpx = L.fw * ow;
    const div = document.createElement("div");
    div.className = "layer" + (L.id === state.scene.selectedId ? " selected" : "");
    div.style.left = L.fx * ow + "px";
    div.style.top = L.fy * oh + "px";
    div.style.width = wpx + "px";
    div.style.setProperty("--rot", L.rot + "deg");
    div.dataset.id = L.id;
    div.innerHTML =
      `<img src="${L.dataUrl}" alt="item" />` +
      `<span class="handle h-del" data-role="del" title="Delete">✕</span>` +
      `<span class="handle h-rotate" data-role="rotate" title="Rotate">⟳</span>` +
      `<span class="handle h-resize" data-role="resize" title="Resize">⤡</span>`;
    div.addEventListener("pointerdown", (e) => startLayerPointer(e, L));
    ov.appendChild(div);
  }
}

/* ---- Pointer interaction (move / resize / rotate) ---- */
let drag = null;
function startLayerPointer(e, L) {
  e.preventDefault();
  e.stopPropagation();
  state.scene.selectedId = L.id;
  L.z = ++state.scene.zTop;
  const role = e.target.dataset.role || "move";
  const ov = dom.layerOverlay.getBoundingClientRect();
  drag = {
    L, role, ovRect: ov,
    startX: e.clientX, startY: e.clientY,
    startFx: L.fx, startFy: L.fy, startFw: L.fw, startRot: L.rot,
  };
  if (role === "del") {
    deleteLayer(L.id);
    drag = null;
    return;
  }
  e.target.setPointerCapture?.(e.pointerId);
  window.addEventListener("pointermove", moveLayerPointer);
  window.addEventListener("pointerup", endLayerPointer);
  renderLayers();
  updateSceneButtons();
}
function moveLayerPointer(e) {
  if (!drag) return;
  const { L, role, ovRect } = drag;
  const ow = ovRect.width, oh = ovRect.height;
  if (role === "move") {
    L.fx = clamp01(drag.startFx + (e.clientX - drag.startX) / ow);
    L.fy = clamp01(drag.startFy + (e.clientY - drag.startY) / oh);
  } else if (role === "resize") {
    const cx = ovRect.left + L.fx * ow;
    const cy = ovRect.top + L.fy * oh;
    const dist = Math.hypot(e.clientX - cx, e.clientY - cy); // to corner = half diagonal
    const aspect = L.imgH / L.imgW;
    const widthPx = (2 * dist) / Math.sqrt(1 + aspect * aspect);
    L.fw = Math.max(0.04, Math.min(2.5, widthPx / ow));
  } else if (role === "rotate") {
    const cx = ovRect.left + L.fx * ow;
    const cy = ovRect.top + L.fy * oh;
    const ang = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
    L.rot = ang + 90; // handle sits above center
  }
  renderLayers();
}
function endLayerPointer() {
  drag = null;
  window.removeEventListener("pointermove", moveLayerPointer);
  window.removeEventListener("pointerup", endLayerPointer);
}
const clamp01 = (v) => Math.max(-0.1, Math.min(1.1, v));

function deleteLayer(id) {
  state.scene.layers = state.scene.layers.filter((x) => x.id !== id);
  if (state.scene.selectedId === id) state.scene.selectedId = null;
  renderLayers();
  updateSceneButtons();
}

function updateSceneButtons() {
  const hasScene = !!state.scene.currentId;
  const hasLayers = state.scene.layers.length > 0;
  const hasSel = !!state.scene.selectedId;
  dom.blendBtn.disabled = !hasScene || state.scene.busy;
  dom.sendBtn.disabled = !hasScene || state.scene.busy || dom.prompt.value.trim().length === 0;
  dom.sceneDownloadBtn.disabled = !hasScene;
  dom.layerDeleteBtn.disabled = !hasSel;
  dom.layerFlattenReset.disabled = !hasLayers;
  dom.blendBtn.textContent = hasLayers ? "✨ Blend items into scene" : "✨ Enhance scene";
}

/* ---- Flatten base + layers to one PNG ---- */
function flattenScene() {
  const base = dom.sceneImg;
  const W = base.naturalWidth, H = base.naturalHeight;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.drawImage(base, 0, 0, W, H);
  const sorted = [...state.scene.layers].sort((a, b) => a.z - b.z);
  for (const L of sorted) {
    const w = L.fw * W;
    const h = w * (L.imgH / L.imgW);
    ctx.save();
    ctx.translate(L.fx * W, L.fy * H);
    ctx.rotate((L.rot * Math.PI) / 180);
    ctx.drawImage(L.img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
  return cv.toDataURL("image/png");
}

/* ---- Run a scene edit / blend ---- */
async function runSceneEdit(promptText) {
  if (!state.scene.currentId || state.scene.busy) return;
  const hasLayers = state.scene.layers.length > 0;
  const composite = hasLayers ? flattenScene() : currentSceneUrl();

  const instruction = hasLayers
    ? `${promptText}\n\nContext: this image is a rough composite — some elements were pasted on top of a base scene. ` +
      `Integrate every pasted element seamlessly and photorealistically: match perspective, scale and lighting ` +
      `direction, add realistic contact and cast shadows, match color temperature and grain, and blend all edges. ` +
      `Keep each element roughly where it is placed. Output a single natural photograph.`
    : promptText;

  addMessage("user", `<p>${escapeHtml(promptText)}</p>`);
  sceneBusy(true, hasLayers ? "Blending…" : "Editing…");
  try {
    const { imageOut, textOut } = await callGemini(instruction, [composite]);
    if (!imageOut) {
      addMessage("assistant", `<p>${textOut ? escapeHtml(textOut) : "No image returned — try rephrasing."}</p>`, { isError: !textOut });
      return;
    }
    pushSceneVersion(imageOut);
    state.scene.layers = [];          // items are now baked into the scene
    state.scene.selectedId = null;
    await showScene(imageOut);
    renderLayers();
    addMessage("assistant", `<p>${textOut ? escapeHtml(textOut) : "Done — items blended in."}</p>`, { thumbUrl: imageOut });
  } catch (err) {
    addMessage("assistant", `<p>⚠️ ${escapeHtml(err.message || "Something went wrong.")}</p>`, { isError: true });
    toast(err.message || "Edit failed", true);
  } finally {
    sceneBusy(false);
    updateSceneButtons();
  }
}
function sceneBusy(b, text = "Working…") {
  state.scene.busy = b;
  dom.sceneLoading.hidden = !b;
  dom.sceneLoadingText.textContent = text;
  updateSceneButtons();
}

/* ---- Scene history ---- */
function renderHistory() {
  dom.historyStrip.hidden = state.tab === "cut" || state.scene.versions.length === 0;
  dom.historyItems.innerHTML = "";
  state.scene.versions.forEach((v, i) => {
    const t = document.createElement("div");
    t.className = "thumb" + (v.id === state.scene.currentId ? " active" : "");
    t.innerHTML = `<img src="${v.dataUrl}" alt="v${i + 1}" /><span class="thumb-badge">${i === 0 ? "base" : "v" + i}</span>`;
    t.addEventListener("click", async () => {
      state.scene.currentId = v.id;
      state.scene.layers = [];
      state.scene.selectedId = null;
      await showScene(v.dataUrl);
      renderLayers();
      renderHistory();
      updateSceneButtons();
    });
    dom.historyItems.appendChild(t);
  });
}

/* ---------------- Chat ---------------- */
function addMessage(role, html, { thumbUrl = null, isError = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `msg msg-${role}` + (isError ? " msg-error" : "");
  wrap.innerHTML =
    `<div class="msg-avatar">${role === "user" ? "🧑" : "🎨"}</div>` +
    `<div class="msg-bubble">${html}${thumbUrl ? `<img class="msg-thumb" src="${thumbUrl}" alt="result" />` : ""}</div>`;
  dom.messages.appendChild(wrap);
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

/* ---------------- Download ---------------- */
function downloadUrl(url, name) {
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
}

/* ---------------- Settings ---------------- */
function openSettings() {
  dom.apiKeyInput.value = settings.apiKey;
  dom.modelInput.value = settings.model;
  dom.settingsModal.hidden = false;
}
function saveSettings() {
  settings.apiKey = dom.apiKeyInput.value.trim();
  settings.model = dom.modelInput.value.trim() || "gemini-2.5-flash-image";
  localStorage.setItem("cps_apiKey", settings.apiKey);
  localStorage.setItem("cps_model", settings.model);
  dom.settingsModal.hidden = true;
  updateSceneButtons();
  toast(settings.apiKey ? "Settings saved." : "Key cleared.");
}

/* ---------------- New session ---------------- */
function newSession() {
  if (!confirm("Start over? This clears the current scene and cut-out (your saved Library is kept).")) return;
  state.cut = { src: null, result: null, busy: false };
  state.scene = { versions: [], currentId: null, layers: [], selectedId: null, busy: false, zTop: 1 };
  dom.cutEmpty.hidden = false; dom.cutWrap.hidden = true;
  dom.cutSaveBtn.disabled = true; dom.cutDownloadBtn.disabled = true; dom.cutRunBtn.disabled = true;
  dom.cutPrompt.value = "";
  dom.sceneEmpty.hidden = false; dom.sceneWrap.hidden = true;
  dom.layerOverlay.innerHTML = "";
  [...dom.messages.children].slice(1).forEach((n) => n.remove());
  renderHistory(); updateSceneButtons();
}

/* ---------------- Composer sizing ---------------- */
function autoGrow() {
  dom.prompt.style.height = "auto";
  dom.prompt.style.height = Math.min(dom.prompt.scrollHeight, 140) + "px";
}

/* ============================================================
   WIRING
   ============================================================ */
function init() {
  loadLibrary();
  renderLibrary();
  updateSceneButtons();

  // Tabs
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));

  // Uploads (shared input, target set per trigger)
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

  // Drag & drop per stage
  const wireDrop = (zone, handler) => {
    ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("dragover"); }));
    ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === "dragleave" && zone.contains(e.relatedTarget)) return;
      zone.classList.remove("dragover");
    }));
    zone.addEventListener("drop", (e) => {
      const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("image/"));
      if (f) handler(f);
    });
  };
  wireDrop(dom.cutStage, cutSetSource);
  wireDrop(dom.sceneStage, sceneSetBase);

  // Cut actions
  dom.cutRunBtn.addEventListener("click", runCut);
  dom.cutSaveBtn.addEventListener("click", saveCutToLibrary);
  dom.cutDownloadBtn.addEventListener("click", () => state.cut.result && downloadUrl(state.cut.result, "cutout.png"));
  dom.cutPrompt.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runCut(); } });
  document.querySelectorAll("[data-cut]").forEach((c) =>
    c.addEventListener("click", () => { dom.cutPrompt.value = c.dataset.cut; runCut(); })
  );

  // Scene actions
  dom.blendBtn.addEventListener("click", () => {
    const preset = "Integrate the placed items into the scene photorealistically: match perspective and scale, add realistic contact shadows and cast shadows, match the light direction and color temperature, and color-grade everything to look like one photograph.";
    runSceneEdit(state.scene.layers.length ? preset : "Enhance this image: balance the lighting, refine the color grade, and make it look like a polished natural photograph.");
  });
  dom.layerDeleteBtn.addEventListener("click", () => state.scene.selectedId && deleteLayer(state.scene.selectedId));
  dom.layerFlattenReset.addEventListener("click", () => { state.scene.layers = []; state.scene.selectedId = null; renderLayers(); updateSceneButtons(); });
  dom.sceneDownloadBtn.addEventListener("click", () => {
    const url = state.scene.layers.length ? flattenScene() : currentSceneUrl();
    if (url) downloadUrl(url, "scene.png");
  });
  document.querySelectorAll("[data-scene]").forEach((c) =>
    c.addEventListener("click", () => runSceneEdit(c.dataset.scene))
  );
  dom.prompt.addEventListener("input", () => { autoGrow(); updateSceneButtons(); });
  dom.prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!dom.sendBtn.disabled) { runSceneEdit(dom.prompt.value.trim()); dom.prompt.value = ""; autoGrow(); } }
  });
  dom.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = dom.prompt.value.trim();
    if (v) { runSceneEdit(v); dom.prompt.value = ""; autoGrow(); }
  });

  // Deselect layer when clicking empty scene area
  dom.sceneWrap.addEventListener("pointerdown", (e) => {
    if (e.target === dom.sceneWrap || e.target === dom.sceneImg || e.target === dom.layerOverlay) {
      state.scene.selectedId = null; renderLayers(); updateSceneButtons();
    }
  });

  window.addEventListener("resize", () => { if (state.tab === "scene") positionOverlay(); });

  // Settings
  dom.settingsBtn.addEventListener("click", openSettings);
  dom.settingsClose.addEventListener("click", () => (dom.settingsModal.hidden = true));
  dom.settingsSave.addEventListener("click", saveSettings);
  dom.settingsModal.addEventListener("click", (e) => { if (e.target === dom.settingsModal) dom.settingsModal.hidden = true; });

  dom.newSessionBtn.addEventListener("click", newSession);

  if (!settings.apiKey) setTimeout(openSettings, 350);
}

document.addEventListener("DOMContentLoaded", init);
