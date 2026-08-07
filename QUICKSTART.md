# Quick Start

Two installs, depending on what you want to run.

## CPU-only (any laptop, ~60 MB, no GPU)

Covers the parts that make up the collage workflow: selection, edge materials,
tiled compositing, video carousel slicing, and the desktop studio.

```bash
pip install -r backend/requirements-cpu.txt
pip install PyQt6                    # only for the desktop studio
pip install "rembg[cpu]"             # only for automatic background removal
```

## Full stack (needs a CUDA GPU)

Adds the segmentation, depth, and neural relighting engines. On a CPU-only
machine these load but fall back — SDXL-class relighting is not practical
without a GPU.

```bash
pip install -r backend/requirements.txt
```

---

# The desktop studio

```bash
python -m backend.ui.studio [image.png]
```

Left pane is your image with the selection tinted over it, right pane is the
finished asset with its edge material.

| Action | How |
|---|---|
| Select | Drag on the left pane |
| Deselect | Right-drag, or Alt+drag |
| Switch tool | Brush / Control point radio buttons |
| Clean up edges | **Refine edges (GrabCut)** after a rough selection |
| Undo / redo | Ctrl+Z / Ctrl+Shift+Z |
| Export | **Export asset PNG**, or **Export subject + mask** for the pair |

**Edge snapping** makes the brush respect boundaries — it attenuates the stroke
where colour departs from the pixel under your cursor and where the gradient is
strong. Raise *sensitivity* to cling more tightly to one colour; drop *snapping*
to 0 for a plain manual brush.

**Control point** grows a selection from a click over similar colours, weighted
by distance, in the manner of Snapseed.

---

# Command line

```bash
# Edge materials — one style, or all of them at once
python -m backend.cli fx cutout.png out.png  --style torn_paper --width 30
python -m backend.cli fx cutout.png out_dir/ --style all

# Background removal, optionally with an edge material in the same pass
python -m backend.cli cutout photo.jpg asset.png --style burnt

# Scatter cutouts onto a large canvas
python -m backend.cli collage cutouts/ collage.png --count 40 --width 6000 --height 6000

# ...or write it as tiles, for canvases too big to hold in memory
python -m backend.cli collage cutouts/ tiles/ --width 30000 --height 30000 --tiles

# Cut a wide master video into Instagram carousel panels
python -m backend.cli slice master.mp4 panels/ --slides 4
```

## Edge materials

| Style | What it does |
|---|---|
| `torn_paper` | Jagged fibrous tear with an exposed white cardstock core |
| `tissue` | Thin crinkled material, feathered with capped opacity |
| `flesh` | Irregular liquid split with a red subdermal tint |
| `sticker` | Die-cut white bleed plus a soft contact shadow |
| `burnt` | Noise-eroded border ramping through ash to charcoal |

`--width` sets the edge size in pixels, `--intensity` (0.0–2.0) how pronounced
it is, `--seed` fixes the noise so a render repeats exactly.

---

# Python API

```python
from PIL import Image
from backend.pipeline import SelectionEngine, EdgeFXEngine, TiledCanvas

# Select
sel = SelectionEngine(Image.open("photo.jpg"))
sel.control_point(400, 300, radius=350, tolerance=30)
sel.refine_grabcut()
cutout = sel.cutout()

# Apply an edge material
piece = EdgeFXEngine().apply(cutout, style="torn_paper", width=28, seed=1)

# Compose on an unbounded canvas
canvas = TiledCanvas(background=(1, 1, 1, 1))
canvas.add_layer(piece, position=(1200, 800), scale=0.6, rotation=-12)
canvas.add_layer(piece, position=(2400, 1500), scale=0.4, blend_mode="multiply")
canvas.flatten((0, 0, 4000, 4000)).save("collage.png")
```

## Working at large canvas sizes

The canvas is a coordinate space, not a buffer — layers hold a transform and are
only rasterised for the region you ask for. Tiled output is bit-identical to a
whole-canvas render, so tiling costs nothing in quality.

```python
canvas.estimate_flatten_bytes(box)      # check before you commit
canvas.render_region((0, 0, 512, 512))  # just one region
canvas.render_preview(max_dimension=1600)  # whole doc, downscaled cheaply
canvas.export_tiles("tiles/")           # arbitrarily large, one tile of memory
```

`flatten()` refuses anything over ~1.5 GB of output rather than getting
OOM-killed. Past that, use `export_tiles()` or render sub-regions.

**On detail:** the canvas can be enormous, but cutouts are raster — a subject
photographed at 2000px carries 2000px of detail wherever you place it. Scaling
past native resolution interpolates rather than inventing detail.

---

# HTTP API

```bash
python backend/main.py     # http://localhost:8000, docs at /docs
```

| Endpoint | Purpose |
|---|---|
| `POST /edge-fx` | Apply an edge material (CPU-only) |
| `POST /cutout` | Background removal |
| `POST /composite` | Composite cutouts into a scene |
| `POST /carousel/slice` | Split a master video into carousel panels |
| `POST /carousel/parse-srt` | Parse subtitles into timed lyric frames |
| `POST /pipeline` | Full chain (needs GPU for the relight stage) |

---

# Troubleshooting

**`ModuleNotFoundError: torch`** — you are calling a GPU engine. The selection,
edge-FX, tiling, and video modules do not need it; install
`requirements-cpu.txt` and use those.

**Studio will not start** — `pip install PyQt6`. On bare Linux you may also need
`libegl1` and `libgl1`.

**Relighting is extremely slow** — expected without a CUDA GPU. SDXL on CPU runs
in minutes per image.

**Large flatten raises MemoryError** — that is the guard doing its job. Use
`export_tiles()` or a smaller region.
