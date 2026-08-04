# 🎨 Claude Photo Studio — Cut Out, Compose &amp; Harmonize

Drop a person into a scene and make them **belong** there — **100% free, runs entirely in your browser.** No account, no API key, no quota. Your photos never leave your device.

The whole app is a three-part layer stack rendered by one pipeline:

```
✨ Finish    vignette · grain · faded blacks
🎞️ Overlay   texture photo + blend mode        ← the "feel"
🧍 Subject   cutouts: light, colour, matte, shadows
🖼️ Scene     the main image
```

Every layer has an **eye toggle** and its own sliders. **Auto edits** set the whole stack in one tap, then you tune anything.

## The three images

1. **Main image** — the location. *Compose → ＋ Main image.*
2. **Subject** — a photo of a person or object. *Cut Out → Remove background → 💾 Add to Library →* then tap it in Compose to drop it in.
3. **Overlay** — a texture photo (rust, grain, a light leak, a painted wall). *Compose → 🎞️ Overlay.*

## Harmonizing — the part that makes it look real

A subject shot at golden hour dropped into an overcast yard reads as pasted on. **🎯 Match subject to the scene** fixes that automatically:

- it samples the main image **in the region where the subject is standing** (a subject in shade should match the shade, not the whole frame),
- samples the subject's own opaque pixels,
- and inverts each adjustment's model to solve for the **exposure, contrast, temperature, tint and saturation** that close the gap.

It runs automatically when you place a cutout, and the numbers land in the sliders — so it's a starting point you can *work off*, not a black box. Then, per subject:

| Control | What it fixes |
| --- | --- |
| **Shrink edge** | eats the halo of old background left around the cut |
| **Soften edge** | feathers a matte that's too crisp for the scene |
| **Darken edge** | kills bright fringing — the biggest "pasted on" tell |
| **Blur** / **Grain** | match the scene's focus and noise |
| **Contact shadow** | grounds the subject at its feet so it isn't floating |
| **Cast shadow** | angle, length, softness, strength |

The contact shadow is placed from the sprite's **opaque bounding box**, so it sits at the subject's actual feet, not at the bottom of a mostly-empty PNG.

## Auto edits

Each look **harmonizes the subject to the scene first**, then applies a creative offset across all layers — so the presets stay scene-aware instead of stamping fixed numbers on top.

| | |
| --- | --- |
| 🎯 **Auto blend** | pure harmonization, minimal grade |
| 🧱 **Rust & ruin** | leans into warm oxidised textures, soft-light overlay |
| 🌅 **Golden hour** | warm, lifted shadows, screen overlay |
| 🧊 **Cold concrete** | cool, desaturated, heavy vignette |
| 🎞️ **Bleach film** | crushed saturation, lifted blacks, grain |
| ⚫ **Ink noir** | black & white, hard contrast |

## Use it on your phone

Hosted straight from GitHub, nothing to install:

**https://raw.githack.com/theSaaSsin/Edit-app/main/index.html**

## Preview = export

`renderComposite()` draws both the live preview (downscaled to fit the stage) and the exported PNG (at the main image's full resolution). There is no second code path, so what you see is what downloads.

**🧩 Merge** bakes the current stack into a new scene version you can keep composing on top of, with a full history strip. **⬇ Download** exports without merging. **👁 Before** is hold-to-compare against the untouched main image.

Your **Library persists** in the browser between visits. **↺ New** clears the scene and cut-out but keeps the Library.

## Files

```
index.html   — tabs, cut-out & compose stages, library, layer panel, help
styles.css   — dark responsive UI, transparency checkerboard, layer cards & sliders
app.js       — on-device background removal (@imgly/background-removal),
               pixel engine (tone/colour/matte/shadows/blend/finish),
               scene→subject harmonizer, auto edits, one renderer for
               preview + export, history
```

No build step. The only runtime dependency is the background-removal model, loaded on demand from a public CDN and cached — after that first load the app works offline.

## Optional: photorealistic relighting

Compositing precisely is exactly what AI image apps are bad at, and relighting is what they're good at. So: compose and harmonize here → **Download** → open the free **Gemini app**, add the image, and paste the built-in **relight prompt** (there's a *Copy relight prompt* button). That app's image editing is free and separate from the developer API quota.

## Privacy

Everything is processed locally in your browser. No server, no uploads. The background-removal model is downloaded once (then cached); after that the app works offline.
