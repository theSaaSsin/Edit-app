"""
Tiled compositing over an unbounded canvas.

The canvas is a coordinate space, not a buffer. Layers store a source image plus
an affine transform; nothing is rasterised until a specific region is requested.
Peak memory therefore tracks tile area rather than canvas area, which is what
makes large collages viable on a laptop: a 40000x40000 document flattened whole
would need 6.4 GB, but rendered in 512px tiles it needs a few megabytes at a
time regardless of how big the document is.

Each tile is produced by mapping tile pixels *back* into each layer's source
space with an inverse affine, so a layer is only ever sampled over the part that
actually lands in the tile. No intermediate full-canvas buffer exists at any
point.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Iterator, List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

BLEND_MODES = ("normal", "multiply", "screen", "overlay", "darken", "lighten", "difference")

DEFAULT_TILE = 512

Box = Tuple[int, int, int, int]  # (x0, y0, x1, y1), half-open


@dataclass
class TileLayer:
    """A source image placed on the canvas by an affine transform."""

    image: Image.Image
    name: str = "layer"
    position: Tuple[float, float] = (0.0, 0.0)  # where the layer centre lands
    scale: float = 1.0
    rotation: float = 0.0  # degrees, counter-clockwise
    opacity: float = 1.0
    blend_mode: str = "normal"
    visible: bool = True

    def __post_init__(self):
        if self.image.mode != "RGBA":
            self.image = self.image.convert("RGBA")
        if self.blend_mode not in BLEND_MODES:
            raise ValueError(f"unknown blend mode {self.blend_mode!r}, expected one of {BLEND_MODES}")
        # Checked here rather than at rasterise time so bounds() cannot silently
        # report a collapsed box for a layer that can never be drawn.
        if abs(self.scale) < 1e-6:
            raise ValueError(f"layer {self.name!r} has scale {self.scale}, which is not invertible")

    @property
    def source_centre(self) -> Tuple[float, float]:
        return self.image.width / 2.0, self.image.height / 2.0

    def _matrix(self) -> Tuple[float, float, float, float]:
        """Forward linear part (rotate then scale), row-major (a, b, c, d)."""
        theta = math.radians(self.rotation)
        cos_t, sin_t = math.cos(theta), math.sin(theta)
        s = self.scale
        return s * cos_t, -s * sin_t, s * sin_t, s * cos_t

    def _inverse_matrix(self) -> Tuple[float, float, float, float]:
        a, b, c, d = self._matrix()
        det = a * d - b * c
        if abs(det) < 1e-12:
            raise ValueError(f"layer {self.name!r} has a degenerate transform (scale={self.scale})")
        return d / det, -b / det, -c / det, a / det

    def bounds(self) -> Box:
        """Axis-aligned bounding box of this layer in canvas coordinates."""
        a, b, c, d = self._matrix()
        cx, cy = self.source_centre
        px, py = self.position

        corners = []
        for u, v in ((0, 0), (self.image.width, 0), (0, self.image.height),
                     (self.image.width, self.image.height)):
            du, dv = u - cx, v - cy
            corners.append((px + a * du + b * dv, py + c * du + d * dv))

        xs = [p[0] for p in corners]
        ys = [p[1] for p in corners]
        return (
            int(math.floor(min(xs))), int(math.floor(min(ys))),
            int(math.ceil(max(xs))), int(math.ceil(max(ys))),
        )

    def rasterise(self, box: Box) -> Optional[Image.Image]:
        """
        Render this layer into `box` (canvas coords), or None if it misses.

        PIL's AFFINE transform takes the *inverse* mapping — output pixel to
        source pixel — which is exactly the direction needed to sample only the
        region covered by the box.
        """
        x0, y0, x1, y1 = box
        lx0, ly0, lx1, ly1 = self.bounds()
        if lx1 <= x0 or lx0 >= x1 or ly1 <= y0 or ly0 >= y1:
            return None

        ia, ib, ic, idd = self._inverse_matrix()
        cx, cy = self.source_centre
        px, py = self.position

        # output (x, y) -> canvas (x0 + x, y0 + y) -> source
        ox, oy = x0 - px, y0 - py
        cst_x = cx + ia * ox + ib * oy
        cst_y = cy + ic * ox + idd * oy

        return self.image.transform(
            (x1 - x0, y1 - y0),
            Image.Transform.AFFINE,
            (ia, ib, cst_x, ic, idd, cst_y),
            resample=Image.Resampling.BILINEAR,
            fillcolor=(0, 0, 0, 0),
        )


def _blend_channel(mode: str, cb: np.ndarray, cs: np.ndarray) -> np.ndarray:
    """Separable blend functions, operating on colours in [0, 1]."""
    if mode == "normal":
        return cs
    if mode == "multiply":
        return cb * cs
    if mode == "screen":
        return cb + cs - cb * cs
    if mode == "overlay":
        return np.where(cb <= 0.5, 2 * cb * cs, 1 - 2 * (1 - cb) * (1 - cs))
    if mode == "darken":
        return np.minimum(cb, cs)
    if mode == "lighten":
        return np.maximum(cb, cs)
    if mode == "difference":
        return np.abs(cb - cs)
    raise ValueError(f"unknown blend mode {mode!r}")


def composite_over(backdrop: np.ndarray, source: np.ndarray, mode: str = "normal") -> np.ndarray:
    """
    Porter-Duff source-over with a separable blend function.

    Both arrays are float32 HxWx4 with unpremultiplied colour in [0, 1]. The
    blend function only applies where the backdrop is opaque; where it is
    transparent the source shows through unblended. That is the standard
    formulation, and it is why a multiply layer over empty canvas stays visible
    instead of going black.
    """
    cb, ab = backdrop[..., :3], backdrop[..., 3:4]
    cs, as_ = source[..., :3], source[..., 3:4]

    blended = _blend_channel(mode, np.clip(cb, 0, 1), np.clip(cs, 0, 1))
    effective_src = (1 - ab) * cs + ab * blended

    ao = as_ + ab * (1 - as_)
    co = as_ * effective_src + (1 - as_) * ab * cb

    out = np.empty_like(backdrop)
    # Unpremultiply, guarding fully transparent pixels.
    np.divide(co, np.maximum(ao, 1e-6), out=out[..., :3])
    out[..., 3:4] = ao
    return np.clip(out, 0, 1)


class TiledCanvas:
    """An unbounded layer stack rendered on demand, one tile at a time."""

    def __init__(self, background: Optional[Sequence[float]] = None, tile_size: int = DEFAULT_TILE):
        if tile_size < 32:
            raise ValueError("tile_size must be at least 32")
        self.layers: List[TileLayer] = []
        self.tile_size = tile_size
        self.background = tuple(background) if background else (0.0, 0.0, 0.0, 0.0)

    def add_layer(self, image: Image.Image, **kwargs) -> TileLayer:
        layer = TileLayer(image=image, **kwargs)
        self.layers.append(layer)
        return layer

    def content_bounds(self) -> Box:
        """Union of every visible layer's bounds. (0,0,0,0) when empty."""
        boxes = [l.bounds() for l in self.layers if l.visible]
        if not boxes:
            return (0, 0, 0, 0)
        return (
            min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes),
        )

    def render_region(self, box: Box) -> Image.Image:
        """Composite every intersecting layer into `box`. Peak cost is box area."""
        x0, y0, x1, y1 = box
        width, height = x1 - x0, y1 - y0
        if width <= 0 or height <= 0:
            raise ValueError(f"empty region {box}")

        acc = np.empty((height, width, 4), dtype=np.float32)
        acc[..., :] = self.background

        for layer in self.layers:
            if not layer.visible or layer.opacity <= 0:
                continue
            patch = layer.rasterise(box)
            if patch is None:
                continue

            src = np.asarray(patch, dtype=np.float32) / 255.0
            if layer.opacity < 1.0:
                src = src.copy()
                src[..., 3] *= layer.opacity
            if not src[..., 3].any():
                continue

            acc = composite_over(acc, src, layer.blend_mode)

        return Image.fromarray((acc * 255.0 + 0.5).astype(np.uint8), "RGBA")

    def iter_tiles(self, box: Optional[Box] = None) -> Iterator[Tuple[Box, Image.Image]]:
        """Yield (tile_box, tile_image) covering `box`, defaulting to content bounds."""
        x0, y0, x1, y1 = box if box is not None else self.content_bounds()
        if x1 <= x0 or y1 <= y0:
            return

        step = self.tile_size
        for ty in range(y0, y1, step):
            for tx in range(x0, x1, step):
                tile_box = (tx, ty, min(tx + step, x1), min(ty + step, y1))
                yield tile_box, self.render_region(tile_box)

    def estimate_flatten_bytes(self, box: Optional[Box] = None) -> int:
        """Bytes a full flatten of `box` would need for the output image alone."""
        x0, y0, x1, y1 = box if box is not None else self.content_bounds()
        return max(0, (x1 - x0)) * max(0, (y1 - y0)) * 4

    def flatten(self, box: Optional[Box] = None, max_bytes: int = 1_500_000_000) -> Image.Image:
        """
        Render `box` into a single image, assembled tile by tile.

        The output must fit in memory by definition; `max_bytes` refuses
        obviously impossible sizes up front with an actionable message rather
        than letting the process get OOM-killed. Use `iter_tiles` or
        `export_tiles` for documents beyond that.
        """
        x0, y0, x1, y1 = box if box is not None else self.content_bounds()
        if x1 <= x0 or y1 <= y0:
            return Image.new("RGBA", (1, 1), (0, 0, 0, 0))

        needed = (x1 - x0) * (y1 - y0) * 4
        if needed > max_bytes:
            raise MemoryError(
                f"flattening {x1-x0}x{y1-y0} needs ~{needed/1e9:.1f} GB for the output image; "
                f"use iter_tiles()/export_tiles(), render a sub-region, or raise max_bytes"
            )

        out = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
        for (tx0, ty0, _, _), tile in self.iter_tiles((x0, y0, x1, y1)):
            out.paste(tile, (tx0 - x0, ty0 - y0))
        return out

    def export_tiles(self, out_dir, box: Optional[Box] = None, prefix: str = "tile") -> List[str]:
        """Write each tile to its own PNG. Memory stays at one tile regardless of size."""
        from pathlib import Path

        directory = Path(out_dir)
        directory.mkdir(parents=True, exist_ok=True)

        paths = []
        for (tx0, ty0, tx1, ty1), tile in self.iter_tiles(box):
            path = directory / f"{prefix}_{tx0}_{ty0}.png"
            tile.save(path)
            paths.append(str(path))
        logger.info("exported %d tiles to %s", len(paths), directory)
        return paths

    def render_preview(self, max_dimension: int = 1600, box: Optional[Box] = None) -> Image.Image:
        """
        Downscaled view of the whole document, for a GUI viewport.

        Layer scales are divided by the same factor rather than rendering full
        size and shrinking, so cost tracks the preview size, not the document.
        """
        x0, y0, x1, y1 = box if box is not None else self.content_bounds()
        if x1 <= x0 or y1 <= y0:
            return Image.new("RGBA", (1, 1), (0, 0, 0, 0))

        span = max(x1 - x0, y1 - y0)
        factor = min(1.0, max_dimension / span)
        if factor >= 1.0:
            return self.flatten((x0, y0, x1, y1))

        proxy = TiledCanvas(background=self.background, tile_size=self.tile_size)
        for layer in self.layers:
            proxy.layers.append(
                TileLayer(
                    image=layer.image,
                    name=layer.name,
                    position=((layer.position[0] - x0) * factor, (layer.position[1] - y0) * factor),
                    scale=layer.scale * factor,
                    rotation=layer.rotation,
                    opacity=layer.opacity,
                    blend_mode=layer.blend_mode,
                    visible=layer.visible,
                )
            )
        width = max(1, int((x1 - x0) * factor))
        height = max(1, int((y1 - y0) * factor))
        return proxy.render_region((0, 0, width, height))
