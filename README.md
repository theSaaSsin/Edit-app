# 🎨 Claude Photo Studio — Cut-Out & Scene Compositor

Build scenes by cutting out items and blending them together. Two workspaces, one **free** image engine:

- **✂️ Cut Out** — add a photo of an outfit piece, furniture, graffiti — anything — and isolate it onto a **transparent cutout**. Save cutouts to your **Library**.
- **🎬 Scene** — set a base image (a character, a room, a wall), **tap Library cutouts to drop them in**, then **move / resize / rotate** each one. Hit **Blend** and the model integrates them photorealistically — matching perspective, lighting direction, shadows, and color grade.

Also does whole-image edits from plain language (relight, color grade, enhance) and keeps a **scene history** so you can step back to any version.

It runs as a plain static web page — no server, nothing to install. It talks **directly** to Google's Gemini image model from your browser using **your own free API key**, stored only in your browser (`localStorage`).

> **Cost:** completely free. The only thing it uses is a free **Google AI Studio** API key (no credit card). Both the cut-outs and the scene blending run through that same free key. The free tier has daily rate limits, but it never costs money.

> **A note on "Claude":** Claude (the language model) can *see* and *reason about* images, but it can't render or edit pixels. Generative editing needs a dedicated image model, so this app uses Google **Gemini 2.5 Flash Image** ("nano banana"), which is free and excellent at cut-outs, harmonizing, and relighting.

---

## Quick start

1. **Get a free API key** (no credit card):
   - Go to **https://aistudio.google.com/apikey** → sign in with Google → **Create API key** → copy it (`AIza…`).
2. **Open the app** — either the hosted link (see below) or locally:
   ```bash
   python3 -m http.server 8000   # then visit http://localhost:8000
   ```
3. Click **⚙ Settings**, paste your key, **Save**.

### Use it on your phone (hosted, no setup)
The app is public and served straight from GitHub:
**https://raw.githack.com/theSaaSsin/Edit-app/main/index.html**

---

## Workflow

**Make cutouts (Cut Out tab)**
1. Tap **Choose a photo** and pick an item.
2. Optionally type what to keep (e.g. *"just the red jacket"*) — leave empty for the main subject.
3. Tap **✂️ Remove background** → **💾 Add to Library**. Repeat to build up outfit pieces, furniture, graffiti, etc.

**Compose a scene (Scene tab)**
1. Tap **Choose scene photo** (your character / room / wall).
2. **Tap a Library cutout** to drop it onto the scene.
3. **Drag** to move, use the **corner handle** to resize, the **top handle** to rotate, the **✕** to delete.
4. Add more cutouts and arrange them.
5. Tap **✨ Blend items into scene** — the model fuses everything with realistic shadows, lighting, and color. The result becomes a new scene version (baked in), so you can keep compositing on top of it.
6. **⬇ Download** saves a PNG.

**Tips**
- *Build an outfit on a character:* cut out each garment, drop them on the person, then use **🧥 Fit outfit to person**.
- *Add furniture/graffiti:* place them, then **💡 Add shadows** and **✨ Blend naturally**.
- Your **Library persists** in the browser between sessions; **New** clears the current scene/cutout but keeps the Library.

---

## Files

```
index.html   — layout: tabs, cut-out & scene stages, library, panels
styles.css   — dark responsive UI, transparency checkerboard, layer handles
app.js       — tabs, cut-out, library, scene layers (drag/resize/rotate),
               flatten + blend, scene history, Gemini calls
```

No build step, no dependencies.

---

## Configuration & privacy

- **Model** is configurable in Settings. Default `gemini-2.5-flash-image`; fallback `gemini-2.0-flash-preview-image-generation`.
- Your API key never leaves your browser except in requests **to Google's API**. Images are sent to Gemini to perform the edits — that's where the work happens. There is no backend of our own.
