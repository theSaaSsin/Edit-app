"""
Scene compositing: layer stack, contact shadows, colour grading.

Blending is delegated to TiledCanvas so there is a single compositing
implementation in the codebase, and so a scene built here inherits the tiled
renderer's memory behaviour on large canvases.
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np
from PIL import Image, ImageFilter

from backend.pipeline.tiles import BLEND_MODES, TiledCanvas, TileLayer

logger = logging.getLogger(__name__)

COLOR_GRADES = ("neutral", "warm", "cool", "vintage", "cinematic", "high_contrast")


class CompositorEngine:
    """A bounded scene canvas with shadow casting and colour grading."""

    def __init__(self, canvas_size: Tuple[int, int] = (1920, 1080)):
        self.canvas = TiledCanvas(background=(0.0, 0.0, 0.0, 0.0))
        self.canvas_size = canvas_size

    # ---- layers ---------------------------------------------------------

    @property
    def layers(self) -> List[TileLayer]:
        return self.canvas.layers

    def set_canvas_size(self, width: int, height: int):
        if width <= 0 or height <= 0:
            raise ValueError(f"canvas size must be positive, got {width}x{height}")
        self.canvas_size = (width, height)

    def set_background(self, image: Optional[Image.Image] = None,
                       color: Optional[Sequence[float]] = None):
        """Set a background image (as the bottom layer) or a flat colour."""
        if image is not None:
            resized = image.convert("RGBA").resize(self.canvas_size, Image.Resampling.LANCZOS)
            layer = TileLayer(
                image=resized, name="background",
                position=(self.canvas_size[0] / 2, self.canvas_size[1] / 2),
            )
            self.canvas.layers.insert(0, layer)
        elif color is not None:
            self.canvas.background = tuple(c / 255.0 if c > 1 else c for c in color)

    def add_layer(
        self,
        image: Image.Image,
        name: Optional[str] = None,
        position: Tuple[int, int] = (0, 0),
        anchor: str = "topleft",
        **kwargs,
    ) -> TileLayer:
        """
        Place a layer. `position` is the top-left corner by default, which is what
        callers passing pixel offsets expect; pass anchor="centre" to position by
        the layer's centre instead.
        """
        image = image.convert("RGBA")
        if anchor == "topleft":
            scale = kwargs.get("scale", 1.0)
            centre = (position[0] + image.width * scale / 2,
                      position[1] + image.height * scale / 2)
        elif anchor == "centre":
            centre = (float(position[0]), float(position[1]))
        else:
            raise ValueError(f"anchor must be 'topleft' or 'centre', got {anchor!r}")

        return self.canvas.add_layer(
            image, name=name or f"layer_{len(self.layers)}", position=centre, **kwargs
        )

    # ---- shadows --------------------------------------------------------

    def cast_shadow(
        self,
        layer: TileLayer,
        light_direction: Tuple[float, float] = (1.0, 1.0),
        distance: int = 18,
        softness: int = 12,
        opacity: float = 0.45,
    ) -> TileLayer:
        """
        Insert a soft drop shadow directly beneath `layer` and return it.

        The shadow is a blurred copy of the layer's own alpha, so it follows the
        real silhouette — including any edge material already applied — rather
        than a bounding box.
        """
        if layer not in self.layers:
            raise ValueError(f"layer {layer.name!r} is not on this canvas")

        alpha = np.array(layer.image.split()[3])
        pad = max(softness * 3, 8)
        alpha = cv2.copyMakeBorder(alpha, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)

        if softness > 0:
            ksize = int(softness) * 2 + 1
            alpha = cv2.GaussianBlur(alpha, (ksize, ksize), 0)
        alpha = (alpha.astype(np.float32) * float(np.clip(opacity, 0, 1))).astype(np.uint8)

        shadow_rgba = np.zeros((*alpha.shape, 4), dtype=np.uint8)
        shadow_rgba[..., 3] = alpha
        shadow_image = Image.fromarray(shadow_rgba, "RGBA")

        shadow = TileLayer(
            image=shadow_image,
            name=f"{layer.name}_shadow",
            position=(layer.position[0] + light_direction[0] * distance,
                      layer.position[1] + light_direction[1] * distance),
            scale=layer.scale,
            rotation=layer.rotation,
            blend_mode="normal",
        )
        self.canvas.layers.insert(self.layers.index(layer), shadow)
        return shadow

    # ---- grading --------------------------------------------------------

    def apply_color_grade(self, image: Image.Image, grade: str = "neutral") -> Image.Image:
        """Apply a colour grade, preserving any alpha channel."""
        if grade not in COLOR_GRADES:
            raise ValueError(f"unknown grade {grade!r}, expected one of {COLOR_GRADES}")
        if grade == "neutral":
            return image

        rgb = np.array(image.convert("RGB"), dtype=np.float32) / 255.0

        if grade == "warm":
            rgb[..., 0] *= 1.10
            rgb[..., 2] *= 0.90
        elif grade == "cool":
            rgb[..., 0] *= 0.90
            rgb[..., 2] *= 1.10
        elif grade == "vintage":
            rgb *= 0.95
            rgb[..., 0] *= 1.05
            rgb = rgb * 0.92 + 0.06
        elif grade == "cinematic":
            rgb = rgb ** 0.9
            rgb[..., 0] *= 1.08
            rgb[..., 1] *= 0.97
        elif grade == "high_contrast":
            rgb = (rgb - 0.5) * 1.5 + 0.5

        graded = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), "RGB")
        if image.mode == "RGBA":
            graded = graded.convert("RGBA")
            graded.putalpha(image.split()[3])
        return graded

    # ---- output ---------------------------------------------------------

    def flatten(self, grade: str = "neutral") -> Image.Image:
        """Composite the scene over its canvas rectangle."""
        composite = self.canvas.render_region((0, 0, *self.canvas_size))
        return self.apply_color_grade(composite, grade)

    def export(self, filepath: str, grade: str = "neutral", format: str = "PNG") -> str:
        self.flatten(grade).save(filepath, format=format)
        logger.info("exported composite to %s", filepath)
        return filepath

    def get_layer_positions(self) -> List[Dict]:
        return [
            {
                "name": l.name,
                "position": l.position,
                "scale": l.scale,
                "rotation": l.rotation,
                "opacity": l.opacity,
                "blend_mode": l.blend_mode,
                "visible": l.visible,
            }
            for l in self.layers
        ]


# Kept so existing imports of `Layer` continue to resolve.
Layer = TileLayer

__all__ = ["CompositorEngine", "Layer", "COLOR_GRADES", "BLEND_MODES"]
