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

## Real night

🌙 **Night** converts a daytime photograph to night rather than dropping a blue grade over it — the sky has to actually become sky at night.

The sky is **re-exposed, not painted**: cloud structure is preserved and remapped, so what was a bright overcast becomes a dark overcast with its own shapes still in it, instead of a flat gradient. Daylight is then taken out of the scene by compressing the highlights that only a sun produces, and an ambient fill puts back what a night sky actually contributes.

One correction worth recording, because the intuition is wrong: **night shadows are neutral, not blue.** Measured against a reference night photograph, its shadows sat at +0.014 on the blue-yellow axis while the version here was at −0.091. The depth in a night image comes from *warm* highlights — sodium, windows, headlights — against neutral shadow, not from tinting the shadows cool.

Stars, horizon glow (with a side), sky hue, sky darkness, detail retention and lamp warmth are all on sliders.

### Finding the sky

Sky detection is a flood fill from the top of the frame, bounded by a gradient stop so it doesn't cross a roofline, then resolved with a guided filter — the same edge-aware solve the hair matte uses. Three things make it survive photographs it wasn't tuned on:

- **Two fills, not one.** A single tolerance is either strict (stops short of rooflines, leaves sky misclassified) or loose (leaks into buildings). Running both gives the bounds from the image: what the strict fill reaches is certainly sky, what the loose fill can't reach is certainly not, and the guided filter resolves the band between against the photograph.
- **A morphological close** bridges aerials, wires and bare branches, which are strong gradients that otherwise slice the sky into strips — visible as hard bands once it's re-lit.
- **A blown-highlight continuation.** Sky that clips to white has lost its colour, so a fill measuring distance from a coloured seed stops dead at the clip point. Each fill continues through connected near-white, texture-free pixels, with the threshold set from the found sky's own median luminance so it tracks exposure rather than assuming it.

It is **deliberately biased towards precision**. Benchmarked on twelve labelled photographs, an earlier version got every sky scene right and every *no*-sky scene wrong — it never once said "no sky". An indoor ceiling is smoother and brighter than the cluttered room beneath it, exactly like sky over a street. So it now demands strong evidence and otherwise reports nothing, and confidence scales the treatment down rather than switching it off. Currently **9/12 with zero false positives**: it misses three hard-but-real skies, which cost one tap to add by hand, rather than confidently wrecking a photograph that has no sky in it, which is silent and much worse.

## Advanced masking

Every mask in the app — the subject cut-out, the sky, light blockers, the depth map, windows — is editable by hand with the same tools, because no detector is right on every photograph and the fix should never be "try a different photo".

| | |
| --- | --- |
| **＋ / −** | paint the mask in or out, with size, softness and strength |
| **Wand ＋ / −** | tap to grow a region through anything close to it in colour |
| **Burn / Dodge** | the Photoshop hair-channel technique, below |
| **Tighten / Feather** | pull the matte in hard, then soften the result |

**Dodge & burn on a mask** is the trick that gets hair out of a background: burn at a low exposure restricted to shadows drives the nearly-dark band of a strand to solid, dodge at a high exposure restricted to highlights drives the nearly-light background to clear, and between them the soft middle of the matte separates into an actual edge. It's exposed as two sliders per subject and works on any mask, not just hair.

Hand edits sit **on top of** the detection rather than inside it, so re-detecting or moving the detection sliders never discards them.

## Placeable lights

💡 **Light** drops a light source into the scene and the scene re-solves around it — colour and type (sodium, headlight, interior, window, lamp), radius, intensity, falloff, and shadows.

Lights are **multiplicative on the albedo**, so they light the picture that's there instead of pasting a glow over it, with a highlight roll-off above 0.72 to stop bright areas welding to flat white. They're attenuated by the sky mask, so a street lamp doesn't illuminate the clouds.

### Occlusion — shadows that respect depth

A shadow map is ray-marched in 2D from each light against an occluder buffer built from the subjects and any hand-painted blockers. Two corrections that a naive march gets wrong, both caught by measurement:

- **The march has to walk out of its own occluder first.** Starting inside one, every wall shadowed itself.
- **Blockage accrues per unit distance, not per step.** Weighted per step, thin walls blocked what was near them and not what was far.

There's also a **depth map** you can paint: mark what's nearer and what's further, and a shadow stops at the surface it should land on instead of smearing across every wall in the frame at every depth.

## Lit windows

🪟 **Lit windows** turns a dark facade into an inhabited one. Tapping is the primary path, not a fallback: **Tap windows**, then one tap per window.

That is a deliberate choice. On a daytime photo windows are *darker* than the wall — you're looking into an unlit room — and once the detector searched for dark regions instead of bright ones it found mortar patches, litter and, on one test photo, a football. **✨ Suggest** is still there and still useful as a starting point, but it proposes; you decide.

What keeps a tap honest is **shape, not brightness**. A window is a solid rectangle — a claim about geometry rather than about what the thing is, which is why it holds where the brightness heuristics didn't. Measured over 16 taps on a tower block:

| | fill of bounding box |
| --- | --- |
| the 11 real windows | 0.63 – 0.89 |
| the 5 grabs that escaped along the facade | 0.30 – 0.43 |

No overlap. So a grab that fails the test is **retried at a tighter tolerance** rather than rejected — an escape is nearly always the fill leaking through one soft edge — and if every tolerance leaks, a window the median size of the ones already placed is dropped at the tap point. A tap always lands something you can see and tap again to remove. A size floor sits under the fill test, because a sliver of window frame is solid enough to pass on fill alone.

Brightness, warmth, spill and variation are global; the seeded variation stops a row of windows reading as identical. Tap a lit window again to switch it off.

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

Hosted straight from GitHub, nothing to install. This link always serves the newest pushed version — bookmark it:

**https://raw.githack.com/theSaaSsin/Edit-app/claude/image-filter-creator-repo-j78mf3/index.html**

(The development branch is where the work lands. Once it's merged, the same page is at `.../Edit-app/main/index.html`.)

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
