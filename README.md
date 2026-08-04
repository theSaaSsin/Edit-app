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

- it samples the main image **as it currently looks — with your grade baked in**, not the raw upload,
- **in the region where the subject is standing** (a subject in shade should match the shade, not the whole frame),
- samples the subject's own opaque pixels,
- and inverts each adjustment's model to solve for the **exposure, contrast, temperature, tint and saturation** that close the gap.

Sampling the *graded* scene is the whole point: the target has to be the scene you're actually on. Each subject carries a **Follow the scene** switch (on by default) — while it's on, the match re-runs whenever you grade the main image or drag the subject somewhere new, so cooling the scene pulls the subject blue with it. Move any of the subject's own light-and-colour sliders and the follow switches off, because you've taken over.

> Overlay and Finish are deliberately *excluded* from the sampling. They composite on top of the subject too, so they move both sides equally — folding them into the target would double-count them. `base.adj` is the only thing that shifts the scene out from under the subject.

The numbers land in the sliders, so it's a starting point you can *work off*, not a black box. Then, per subject:

| Control | What it fixes |
| --- | --- |
| **Shrink edge** | eats the halo of old background left around the cut |
| **Soften edge** | feathers a matte that's too crisp for the scene |
| **Darken edge** | kills bright fringing — the biggest "pasted on" tell |
| **Blur** / **Grain** | match the scene's focus and noise |
| **Contact shadow** | grounds the subject at its feet so it isn't floating |
| **Cast shadow** | angle, length, softness, strength |

The contact shadow is placed from the sprite's **opaque bounding box**, so it sits at the subject's actual feet, not at the bottom of a mostly-empty PNG.

## Cut-out models

Side by side on a backlit portrait, the model matters far more than any amount of edge post-processing:

| | |
| --- | --- |
| **Fast** | isnet fp16 — quick, small download, default |
| **Sharper** | isnet full precision — better edges |
| **Best for hair** | BiRefNet — the golden rim of blown sky that the others weld onto hair simply isn't there |

BiRefNet is a much larger first download, so it stays opt-in; if it can't load, the app falls back to Fast and says so.

## Fixing the cut edge

Background removal returns a hard silhouette. On the sample photo the matte came back **688k fully-transparent and 615k fully-opaque pixels with nothing in between** — every hair strand either chopped off or welded to a chunk of blown-out sky.

So a cutout is **not** stored as one flattened PNG. It keeps **the original photo plus a separate greyscale mask**, because removal zeroes the RGB it erases — flatten it and a restore brush would have nothing to paint back. Cutouts are also auto-trimmed to their content on save, so a subject that filled a quarter of its frame doesn't drag an empty margin around with it.

**✨ Refine hair** estimates the local foreground colour F and background colour B around the edge by push-pull blurring the confidently-inside and confidently-outside pixels, then solves each band pixel for where it sits on the F→B colour line:

```
alpha = clamp( (C-B)·(F-B) / |F-B|² )
```

Hair against a bright sky separates strongly on that line, so strands come back as genuine partial alpha. The same F and B then un-mix the colour — `F = (C-(1-a)B)/a` — which removes the background spill that reads as a glowing rim. *Reach* controls how far out it looks for strands, *De-spill* how hard it un-mixes.

**✂️ Edge brush** paints straight onto the mask of the selected subject, at the subject's own resolution, with size / softness / strength:

| | |
| --- | --- |
| 🩹 **Erase** | cut leftover background away |
| 🖌 **Restore** | paint the subject back in — works because the original photo is still there |
| 💡 **Fix light** | desaturate, cool and pull down the highlights *only where you brush* |

Fix light is the answer to a rim light that belongs to the photo the subject came from, not to the scene it's going into. Global colour matching can't touch a *directional* light mismatch; painting it out can.

Refine reads the *current* mask, so a rough hand-brushed fix is a valid input: block the edge in loosely, then let Refine solve the strands.

## Glow specks

🪰 **Glow specks** draws additive points of light — fireflies, embers, dust catching a lamp. Count, size, brightness, spread, height and colour, with a seeded shuffle so a swarm is reproducible. They're drawn rather than pasted, so they glow *into* the scene instead of sitting on top of it. The **🌙 Night** and **🪰 Fireflies** auto edits turn the scene to dusk and switch the swarm on.

## Auto edits

Each look **grades the scene first, then matches the subject to the graded scene**, then adds its creative offset — so the presets stay scene-aware instead of stamping fixed numbers on top. (Doing those first two in the other order is exactly the bug: you match the subject to a scene, then move the scene out from under it.)

| | |
| --- | --- |
| 🎯 **Auto blend** | pure harmonization, minimal grade |
| 🧱 **Rust & ruin** | leans into warm oxidised textures, soft-light overlay |
| 🌅 **Golden hour** | warm, lifted shadows, screen overlay |
| 🧊 **Cold concrete** | cool, desaturated, heavy vignette |
| 🎞️ **Bleach film** | crushed saturation, lifted blacks, grain |
| ⚫ **Ink noir** | black & white, hard contrast |
| 🌙 **Night** | dusk, cooled and crushed, with a few fireflies |
| 🪰 **Fireflies** | dusk with a full swarm |

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
