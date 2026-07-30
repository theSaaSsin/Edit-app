/* ============================================================
   Claude Photo Studio — in-chat photo editor
   Talks directly to Google's Gemini image model from the browser.
   No backend; the API key lives only in localStorage.
   ============================================================ */
"use strict";

/* ---------------------------------------------------------------
   State
--------------------------------------------------------------- */
const state = {
  /** Source photos the user uploaded: {id, name, dataUrl, on} */
  sources: [],
  /** Edit results over time: {id, dataUrl, prompt} — index 0..n */
  versions: [],
  currentVersionId: null,
  busy: false,
  masking: false,
};

const settings = {
  apiKey: localStorage.getItem("cps_apiKey") || "",
  model: localStorage.getItem("cps_model") || "gemini-2.5-flash-image",
};

let idSeq = 0;
const uid = (p) => `${p}_${Date.now().toString(36)}_${idSeq++}`;

/* ---------------------------------------------------------------
   Element refs
--------------------------------------------------------------- */
const el = (id) => document.getElementById(id);
const dom = {
  dropZone: el("dropZone"),
  emptyState: el("emptyState"),
  previewWrap: el("previewWrap"),
  previewImg: el("previewImg"),
  maskCanvas: el("maskCanvas"),
  loadingOverlay: el("loadingOverlay"),
  loadingText: el("loadingText"),
  stageToolbar: el("stageToolbar"),
  maskToggle: el("maskToggle"),
  maskClear: el("maskClear"),
  downloadBtn: el("downloadBtn"),
  addMoreBtn: el("addMoreBtn"),
  historyStrip: el("historyStrip"),
  historyItems: el("historyItems"),
  messages: el("messages"),
  tray: el("tray"),
  trayItems: el("trayItems"),
  composer: el("composer"),
  prompt: el("prompt"),
  sendBtn: el("sendBtn"),
  fileInput: el("fileInput"),
  uploadTrigger: el("uploadTrigger"),
  newSessionBtn: el("newSessionBtn"),
  settingsBtn: el("settingsBtn"),
  settingsModal: el("settingsModal"),
  settingsClose: el("settingsClose"),
  settingsSave: el("settingsSave"),
  apiKeyInput: el("apiKeyInput"),
  modelInput: el("modelInput"),
  toast: el("toast"),
  quickActions: el("quickActions"),
};

/* ---------------------------------------------------------------
   Helpers
--------------------------------------------------------------- */
function toast(msg, isErr = false) {
  dom.toast.textContent = msg;
  dom.toast.classList.toggle("err", isErr);
  dom.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (dom.toast.hidden = true), isErr ? 5200 : 3000);
}

/** Read a File into a data URL. */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/** Split a data URL into {mimeType, data(base64)}. */
function splitDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!m) throw new Error("Unsupported image encoding");
  return { mimeType: m[1], data: m[2] };
}

/** The image currently shown in the big preview (latest/selected result, else first active source). */
function currentImageDataUrl() {
  const v = state.versions.find((x) => x.id === state.currentVersionId);
  if (v) return v.dataUrl;
  const s = state.sources.find((x) => x.on) || state.sources[0];
  return s ? s.dataUrl : null;
}

/* ---------------------------------------------------------------
   Rendering
--------------------------------------------------------------- */
function render() {
  const hasImages = state.sources.length > 0 || state.versions.length > 0;

  dom.emptyState.hidden = hasImages;
  dom.previewWrap.hidden = !hasImages;
  dom.stageToolbar.hidden = !hasImages;

  const cur = currentImageDataUrl();
  if (cur) dom.previewImg.src = cur;

  renderTray();
  renderHistory();
  updateSendState();
}

function renderTray() {
  dom.tray.hidden = state.sources.length === 0;
  dom.trayItems.innerHTML = "";
  state.sources.forEach((s, i) => {
    const chip = document.createElement("div");
    chip.className = `tray-chip ${s.on ? "on" : "off"}`;
    chip.title = s.on ? "Included in the next edit — click to exclude" : "Excluded — click to include";
    chip.innerHTML = `
      <img src="${s.dataUrl}" alt="${s.name}" />
      <span class="tray-check">✓</span>
      <span class="tray-remove" data-remove="${s.id}" title="Remove photo">✕</span>`;
    chip.addEventListener("click", (e) => {
      if (e.target.dataset.remove) {
        state.sources = state.sources.filter((x) => x.id !== s.id);
        render();
        return;
      }
      s.on = !s.on;
      render();
    });
    dom.trayItems.appendChild(chip);
  });
}

function renderHistory() {
  dom.historyStrip.hidden = state.versions.length === 0;
  dom.historyItems.innerHTML = "";
  state.versions.forEach((v, i) => {
    const t = document.createElement("div");
    t.className = `thumb ${v.id === state.currentVersionId ? "active" : ""}`;
    t.title = v.prompt || `Version ${i + 1}`;
    t.innerHTML = `<img src="${v.dataUrl}" alt="v${i + 1}" /><span class="thumb-badge">v${i + 1}</span>`;
    t.addEventListener("click", () => {
      state.currentVersionId = v.id;
      render();
    });
    dom.historyItems.appendChild(t);
  });
}

function updateSendState() {
  const ready =
    !state.busy &&
    !!settings.apiKey &&
    (state.sources.length > 0 || state.versions.length > 0) &&
    dom.prompt.value.trim().length > 0;
  dom.sendBtn.disabled = !ready;
}

/* ---------------------------------------------------------------
   Chat log
--------------------------------------------------------------- */
function addMessage(role, html, { thumbUrl = null, isError = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `msg msg-${role}` + (isError ? " msg-error" : "");
  const avatar = role === "user" ? "🧑" : "🎨";
  wrap.innerHTML = `
    <div class="msg-avatar">${avatar}</div>
    <div class="msg-bubble">${html}${thumbUrl ? `<img class="msg-thumb" src="${thumbUrl}" alt="attached" />` : ""}</div>`;
  dom.messages.appendChild(wrap);
  dom.messages.scrollTop = dom.messages.scrollHeight;
  return wrap;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ---------------------------------------------------------------
   Adding images
--------------------------------------------------------------- */
async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  for (const f of files) {
    try {
      const dataUrl = await fileToDataUrl(f);
      state.sources.push({ id: uid("src"), name: f.name || "photo", dataUrl, on: true });
    } catch {
      toast(`Couldn't read ${f.name}`, true);
    }
  }
  // Before any edit, preview the newest source.
  if (!state.currentVersionId) state.currentVersionId = null;
  render();
}

/* ---------------------------------------------------------------
   Mask / brush (inpaint helper)
--------------------------------------------------------------- */
const mask = {
  ctx: null,
  drawing: false,
  hasStrokes: false,
  brush: 34,
};

function setupMaskCanvas() {
  const c = dom.maskCanvas;
  // Match canvas pixel size to the *displayed* image size.
  const rect = dom.previewImg.getBoundingClientRect();
  const wrapRect = dom.previewWrap.getBoundingClientRect();
  c.width = rect.width;
  c.height = rect.height;
  c.style.width = rect.width + "px";
  c.style.height = rect.height + "px";
  c.style.left = rect.left - wrapRect.left + "px";
  c.style.top = rect.top - wrapRect.top + "px";
  c.style.position = "absolute";
  mask.ctx = c.getContext("2d");
  mask.ctx.strokeStyle = "rgba(255, 0, 200, 0.55)";
  mask.ctx.lineWidth = mask.brush;
  mask.ctx.lineCap = "round";
  mask.ctx.lineJoin = "round";
  mask.hasStrokes = false;
}

function maskPos(e) {
  const r = dom.maskCanvas.getBoundingClientRect();
  const p = e.touches ? e.touches[0] : e;
  return { x: p.clientX - r.left, y: p.clientY - r.top };
}
function maskDown(e) {
  if (!state.masking) return;
  e.preventDefault();
  mask.drawing = true;
  const { x, y } = maskPos(e);
  mask.ctx.beginPath();
  mask.ctx.moveTo(x, y);
}
function maskMove(e) {
  if (!mask.drawing) return;
  e.preventDefault();
  const { x, y } = maskPos(e);
  mask.ctx.lineTo(x, y);
  mask.ctx.stroke();
  mask.hasStrokes = true;
}
function maskUp() {
  mask.drawing = false;
  dom.maskClear.hidden = !mask.hasStrokes;
}

function toggleMask() {
  if (!currentImageDataUrl()) return;
  state.masking = !state.masking;
  dom.maskToggle.classList.toggle("active", state.masking);
  dom.maskCanvas.hidden = !state.masking;
  if (state.masking) {
    setupMaskCanvas();
    toast("Brush over the area you want to change, then describe the edit.");
  }
}
function clearMask() {
  if (mask.ctx) mask.ctx.clearRect(0, 0, dom.maskCanvas.width, dom.maskCanvas.height);
  mask.hasStrokes = false;
  dom.maskClear.hidden = true;
}

/**
 * Produce a version of the current image with the brushed area burned in,
 * so the model knows exactly where to work. Returns a data URL, or null.
 */
function buildMaskedImage() {
  if (!state.masking || !mask.hasStrokes) return null;
  const img = dom.previewImg;
  const out = document.createElement("canvas");
  out.width = img.naturalWidth;
  out.height = img.naturalHeight;
  const ctx = out.getContext("2d");
  ctx.drawImage(img, 0, 0, out.width, out.height);
  // Scale the (displayed-size) mask strokes up to natural size.
  ctx.drawImage(dom.maskCanvas, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

/* ---------------------------------------------------------------
   Gemini call
--------------------------------------------------------------- */
async function callGemini(promptText, images) {
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

  if (!res.ok) {
    const msg = json?.error?.message || `Request failed (${res.status})`;
    throw new Error(msg);
  }

  const candidate = json?.candidates?.[0];
  if (!candidate) {
    const fb = json?.promptFeedback?.blockReason;
    throw new Error(fb ? `Blocked by safety filter (${fb}).` : "No result returned.");
  }

  let imageOut = null;
  let textOut = "";
  for (const p of candidate.content?.parts || []) {
    if (p.inlineData?.data) {
      imageOut = `data:${p.inlineData.mimeType || "image/png"};base64,${p.inlineData.data}`;
    } else if (p.text) {
      textOut += p.text;
    }
  }
  return { imageOut, textOut };
}

/* ---------------------------------------------------------------
   Submit an edit
--------------------------------------------------------------- */
async function submitEdit(rawPrompt) {
  const promptText = rawPrompt.trim();
  if (!promptText) return;

  if (!settings.apiKey) {
    openSettings();
    toast("Add your free Google AI Studio key to start.", true);
    return;
  }
  if (state.sources.length === 0 && state.versions.length === 0) {
    toast("Add at least one photo first.", true);
    return;
  }

  // Gather images to send.
  const images = [];
  const maskedUrl = buildMaskedImage();
  let effectivePrompt = promptText;

  if (maskedUrl) {
    // Inpaint mode: send the marked-up image and tell the model where to work.
    images.push(maskedUrl);
    effectivePrompt =
      `The magenta highlighted region marks where to apply this change: "${promptText}". ` +
      `Blend the edit seamlessly with matching lighting, shadow and color. ` +
      `Do NOT alter anything outside the highlighted region, and do NOT include the magenta overlay in the output.`;
  } else {
    // Normal mode: current result (if any) + every "on" source.
    const cur = state.versions.find((x) => x.id === state.currentVersionId);
    if (cur) images.push(cur.dataUrl);
    for (const s of state.sources) if (s.on) images.push(s.dataUrl);
    // De-dup while preserving order.
    const seen = new Set();
    for (let i = images.length - 1; i >= 0; i--) {
      if (seen.has(images[i])) images.splice(i, 1);
      else seen.add(images[i]);
    }
  }

  if (images.length === 0) {
    toast("No photos selected for this edit.", true);
    return;
  }

  // UI: user message + busy state.
  addMessage("user", `<p>${escapeHtml(promptText)}</p>`);
  dom.prompt.value = "";
  autoGrow();
  setBusy(true, images.length > 1 ? "Blending scene…" : "Editing…");

  try {
    const { imageOut, textOut } = await callGemini(effectivePrompt, images);

    if (!imageOut) {
      addMessage(
        "assistant",
        `<p>${textOut ? escapeHtml(textOut) : "The model didn't return an image. Try rephrasing, or check the model name in Settings."}</p>`,
        { isError: !textOut }
      );
      return;
    }

    // New version.
    const v = { id: uid("v"), dataUrl: imageOut, prompt: promptText };
    state.versions.push(v);
    state.currentVersionId = v.id;

    // After the first successful edit, keep iterating on the result:
    // turn sources off so follow-ups operate on the latest version.
    if (state.versions.length === 1) state.sources.forEach((s) => (s.on = false));

    // Clear any mask.
    if (state.masking) toggleMask();
    clearMask();

    addMessage(
      "assistant",
      `<p>${textOut ? escapeHtml(textOut) : "Done — here's the edit."}</p>`,
      { thumbUrl: imageOut }
    );
  } catch (err) {
    addMessage("assistant", `<p>⚠️ ${escapeHtml(err.message || "Something went wrong.")}</p>`, {
      isError: true,
    });
    toast(err.message || "Edit failed", true);
  } finally {
    setBusy(false);
    render();
  }
}

function setBusy(b, text = "Editing…") {
  state.busy = b;
  dom.loadingOverlay.hidden = !b;
  dom.loadingText.textContent = text;
  updateSendState();
}

/* ---------------------------------------------------------------
   Download
--------------------------------------------------------------- */
function downloadCurrent() {
  const url = currentImageDataUrl();
  if (!url) return;
  const a = document.createElement("a");
  a.href = url;
  const n = state.versions.findIndex((v) => v.id === state.currentVersionId);
  a.download = `photo-studio-${n >= 0 ? "v" + (n + 1) : "source"}.png`;
  a.click();
}

/* ---------------------------------------------------------------
   Settings modal
--------------------------------------------------------------- */
function openSettings() {
  dom.apiKeyInput.value = settings.apiKey;
  dom.modelInput.value = settings.model;
  dom.settingsModal.hidden = false;
}
function closeSettings() {
  dom.settingsModal.hidden = true;
}
function saveSettings() {
  settings.apiKey = dom.apiKeyInput.value.trim();
  settings.model = dom.modelInput.value.trim() || "gemini-2.5-flash-image";
  localStorage.setItem("cps_apiKey", settings.apiKey);
  localStorage.setItem("cps_model", settings.model);
  closeSettings();
  updateSendState();
  toast(settings.apiKey ? "Settings saved." : "Key cleared.");
}

/* ---------------------------------------------------------------
   New session
--------------------------------------------------------------- */
function newSession() {
  if (state.versions.length && !confirm("Start over? This clears the current photos and history.")) return;
  state.sources = [];
  state.versions = [];
  state.currentVersionId = null;
  if (state.masking) toggleMask();
  clearMask();
  // Keep the intro message; drop the rest.
  [...dom.messages.children].slice(1).forEach((n) => n.remove());
  render();
}

/* ---------------------------------------------------------------
   Composer sizing
--------------------------------------------------------------- */
function autoGrow() {
  dom.prompt.style.height = "auto";
  dom.prompt.style.height = Math.min(dom.prompt.scrollHeight, 160) + "px";
}

/* ---------------------------------------------------------------
   Wiring
--------------------------------------------------------------- */
function init() {
  // Uploads
  dom.uploadTrigger.addEventListener("click", () => dom.fileInput.click());
  dom.addMoreBtn.addEventListener("click", () => dom.fileInput.click());
  dom.fileInput.addEventListener("change", (e) => {
    addFiles(e.target.files);
    dom.fileInput.value = "";
  });

  // Drag & drop
  ["dragenter", "dragover"].forEach((ev) =>
    dom.dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dom.dropZone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dom.dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === "dragleave" && dom.dropZone.contains(e.relatedTarget)) return;
      dom.dropZone.classList.remove("dragover");
    })
  );
  dom.dropZone.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

  // Paste
  window.addEventListener("paste", (e) => {
    const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith("image/"));
    if (items.length) addFiles(items.map((i) => i.getAsFile()).filter(Boolean));
  });

  // Composer
  dom.prompt.addEventListener("input", () => {
    autoGrow();
    updateSendState();
  });
  dom.prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!dom.sendBtn.disabled) submitEdit(dom.prompt.value);
    }
  });
  dom.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    submitEdit(dom.prompt.value);
  });

  // Quick actions
  dom.quickActions.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const p = chip.dataset.prompt;
    if (state.sources.length === 0 && state.versions.length === 0) {
      toast("Add a photo first, then tap a quick action.", true);
      return;
    }
    submitEdit(p);
  });

  // Toolbar
  dom.maskToggle.addEventListener("click", toggleMask);
  dom.maskClear.addEventListener("click", clearMask);
  dom.downloadBtn.addEventListener("click", downloadCurrent);

  // Mask drawing
  const c = dom.maskCanvas;
  c.addEventListener("mousedown", maskDown);
  c.addEventListener("mousemove", maskMove);
  window.addEventListener("mouseup", maskUp);
  c.addEventListener("touchstart", maskDown, { passive: false });
  c.addEventListener("touchmove", maskMove, { passive: false });
  c.addEventListener("touchend", maskUp);

  // Keep mask aligned if the window resizes while masking.
  window.addEventListener("resize", () => {
    if (state.masking) setupMaskCanvas();
  });

  // Settings
  dom.settingsBtn.addEventListener("click", openSettings);
  dom.settingsClose.addEventListener("click", closeSettings);
  dom.settingsSave.addEventListener("click", saveSettings);
  dom.settingsModal.addEventListener("click", (e) => {
    if (e.target === dom.settingsModal) closeSettings();
  });

  // New session
  dom.newSessionBtn.addEventListener("click", newSession);

  // First run: nudge for a key.
  render();
  if (!settings.apiKey) {
    setTimeout(() => {
      addMessage(
        "assistant",
        `<p>⚙️ First, add your <strong>free</strong> Google AI Studio API key in <strong>Settings</strong> (top right) so I can edit your photos.</p>`
      );
    }, 400);
  }
}

document.addEventListener("DOMContentLoaded", init);
