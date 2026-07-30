# 🎨 Claude Photo Studio — Free Cut-Out & Scene Compositor

Build scenes from cut-out items — **100% free, runs entirely in your browser.** No account, no API key, no quota. Your photos never leave your device.

- **✂️ Cut Out** — add a photo of an outfit piece, furniture, graffiti — anything with a clear subject — and an on-device model erases the background, leaving a transparent cutout. Save cutouts to your **Library**.
- **🎬 Scene** — set a base image (a character, a room, a wall), **tap Library cutouts to drop them in**, then **move / resize / rotate** each one. Turn on **cast shadows** (with adjustable light direction), pick a **color grade**, and **Merge** to flatten it into a finished image with a full undo history.

## The workflow (free end-to-end)

This app is deliberately the **front half** of a free pipeline:

1. **Cut out & compose here** — precise placement, scaling, rotation, shadows, and grading. (This is exactly what AI image apps are *bad* at.)
2. **Download** the composite PNG.
3. Open the **free Gemini app** on your phone (or gemini.google.com), add the image, and paste the built-in **relight prompt** (there's a *Copy relight prompt* button). Nano-banana relights it into one photorealistic scene.

> **Why this is free:** the daily quota you can hit is on the *developer API key*. The **Gemini app** has its own separate free image editing — so relighting there doesn't touch that quota. And the cut-out + compositing in this app use **no API at all**; they run locally with the Canvas API and an on-device background-removal model.

## Use it on your phone

Hosted straight from GitHub, nothing to install:

**https://raw.githack.com/theSaaSsin/Edit-app/main/index.html**

## Workflow details

**Make cutouts (Cut Out tab)**
1. **Choose a photo** with a clear main subject.
2. Tap **✂️ Remove background** (first run downloads a small model once, then it's cached/offline).
3. **💾 Add to Library.** Repeat to stock up on garments, furniture, graffiti, etc.
   *To isolate one thing like a jacket, photograph or crop it on its own — free removal keeps the whole foreground subject and can't pick one object out of a busy photo.*

**Compose a scene (Scene tab)**
1. **Choose scene photo** (character / room / wall).
2. **Tap a Library cutout** to drop it in.
3. **Drag** to move · **corner handle** to resize · **top handle** to rotate · **✕** to delete. Add more and arrange.
4. Toggle **Cast shadows** and set **Light from**; pick a **Color grade**.
5. **🧩 Merge** to bake shadows + grade into a new scene version (keep compositing on top), or **⬇ Download** any time.
6. For photorealism, hand the download to the **Gemini app** with the copied relight prompt.

Your **Library persists** in the browser between visits. **New** clears the current scene/cut-out but keeps the Library.

## Files

```
index.html   — tabs, cut-out & scene stages, library, panels, help
styles.css   — dark responsive UI, transparency checkerboard, layer handles, shadow preview
app.js       — on-device background removal (@imgly/background-removal),
               library, scene layers (drag/resize/rotate), canvas shadows,
               color grades, flatten/merge, history, relight-prompt handoff
```

No build step. The only runtime dependency is the background-removal model, loaded on demand from a public CDN and cached.

## Privacy

Everything is processed locally in your browser. No server, no uploads. The background-removal model is downloaded once (then cached); after that the app works offline.
