import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from typing import List, Tuple, Optional, Dict
import logging

logger = logging.getLogger(__name__)


class Layer:
    """Represents a single compositing layer."""

    def __init__(self, image: Image.Image, name: str = "layer"):
        self.image = image.convert("RGBA")
        self.name = name
        self.opacity = 1.0
        self.blend_mode = "normal"
        self.position = (0, 0)
        self.scale = (1.0, 1.0)
        self.rotation = 0.0
        self.visible = True

    def apply_transform(self) -> Image.Image:
        """Apply position, scale, and rotation to layer."""
        if self.rotation != 0:
            self.image = self.image.rotate(self.rotation, expand=False, resample=Image.Resampling.BICUBIC)

        if self.scale != (1.0, 1.0):
            new_size = (
                int(self.image.width * self.scale[0]),
                int(self.image.height * self.scale[1])
            )
            self.image = self.image.resize(new_size, Image.Resampling.LANCZOS)

        return self.image

    def set_opacity(self, opacity: float):
        """Set layer opacity (0-1)."""
        self.opacity = max(0, min(1, opacity))

    def render(self, canvas_size: Tuple[int, int]) -> Image.Image:
        """Render layer on transparent background."""
        transformed = self.apply_transform()
        canvas = Image.new("RGBA", canvas_size, (0, 0, 0, 0))

        if self.visible:
            alpha = transformed.split()[3]
            alpha = alpha.point(lambda p: int(p * self.opacity))
            transformed.putalpha(alpha)
            canvas.paste(transformed, self.position, transformed)

        return canvas


class CompositorEngine:
    """
    Final compositing layer orchestration, shadow casting, color grading,
    and unified color profile management via OpenColorIO.
    """

    def __init__(self):
        self.layers: List[Layer] = []
        self.canvas_size = (1920, 1080)
        self.background_color = (255, 255, 255, 255)
        logger.info("Initialized CompositorEngine")

    def add_layer(self, image: Image.Image, name: str = None, position: Tuple[int, int] = (0, 0)) -> Layer:
        """Add a layer to the composition."""
        layer = Layer(image, name or f"layer_{len(self.layers)}")
        layer.position = position
        self.layers.append(layer)
        logger.info(f"Added layer: {layer.name}")
        return layer

    def set_canvas_size(self, width: int, height: int):
        """Set the canvas size."""
        self.canvas_size = (width, height)
        logger.info(f"Canvas size set to {width}x{height}")

    def set_background(self, image: Image.Image = None, color: Tuple[int, int, int, int] = None):
        """Set background image or solid color."""
        if image:
            self.layers.insert(0, Layer(image, "background"))
        elif color:
            self.background_color = color

    def cast_shadows(
        self,
        layer_index: int,
        light_direction: Tuple[float, float] = (1, 1),
        shadow_softness: int = 10,
        shadow_opacity: float = 0.5,
        shadow_distance: int = 15
    ) -> Image.Image:
        """
        Cast realistic drop shadow from layer.

        Args:
            layer_index: Which layer to cast shadow from
            light_direction: (x, y) direction of light source
            shadow_softness: Gaussian blur radius
            shadow_opacity: Shadow transparency
            shadow_distance: Offset distance from layer

        Returns:
            Shadow layer
        """
        try:
            layer = self.layers[layer_index]
            source = layer.apply_transform()

            alpha = np.array(source.split()[3])
            shadow = Image.new("RGBA", source.size, (0, 0, 0, 0))
            shadow_data = np.array(shadow)

            shadow_alpha = (alpha * shadow_opacity * 255).astype(np.uint8)
            shadow_data[:, :, 3] = shadow_alpha

            shadow = Image.fromarray(shadow_data, "RGBA")
            shadow = shadow.filter(ImageFilter.GaussianBlur(radius=shadow_softness))

            offset_x = int(light_direction[0] * shadow_distance)
            offset_y = int(light_direction[1] * shadow_distance)

            shadow_layer = Layer(shadow, f"{layer.name}_shadow")
            shadow_layer.position = (
                layer.position[0] + offset_x,
                layer.position[1] + offset_y
            )
            return shadow_layer.render(self.canvas_size)
        except Exception as e:
            logger.error(f"Shadow casting failed: {e}")
            return Image.new("RGBA", self.canvas_size, (0, 0, 0, 0))

    def blend_layers(self) -> Image.Image:
        """Composite all layers using specified blend modes."""
        canvas = Image.new("RGBA", self.canvas_size, self.background_color)
        canvas_array = np.array(canvas, dtype=np.float32) / 255.0

        for layer in self.layers:
            if not layer.visible:
                continue

            layer_render = layer.render(self.canvas_size)
            layer_array = np.array(layer_render, dtype=np.float32) / 255.0

            if layer.blend_mode == "normal":
                canvas_array = self._blend_normal(canvas_array, layer_array)
            elif layer.blend_mode == "multiply":
                canvas_array = self._blend_multiply(canvas_array, layer_array)
            elif layer.blend_mode == "screen":
                canvas_array = self._blend_screen(canvas_array, layer_array)
            elif layer.blend_mode == "overlay":
                canvas_array = self._blend_overlay(canvas_array, layer_array)
            else:
                canvas_array = self._blend_normal(canvas_array, layer_array)

        canvas_array = np.clip(canvas_array * 255, 0, 255).astype(np.uint8)
        return Image.fromarray(canvas_array, "RGBA")

    @staticmethod
    def _blend_normal(bg: np.ndarray, fg: np.ndarray) -> np.ndarray:
        """Normal blend mode."""
        alpha = fg[:, :, 3:4]
        result = bg * (1 - alpha) + fg * alpha
        return result

    @staticmethod
    def _blend_multiply(bg: np.ndarray, fg: np.ndarray) -> np.ndarray:
        """Multiply blend mode."""
        alpha = fg[:, :, 3:4]
        result = bg * fg[:, :, :3] * (1 - alpha) + bg * alpha
        return np.concatenate([result, bg[:, :, 3:4]], axis=2)

    @staticmethod
    def _blend_screen(bg: np.ndarray, fg: np.ndarray) -> np.ndarray:
        """Screen blend mode."""
        alpha = fg[:, :, 3:4]
        result = 1 - (1 - bg[:, :, :3]) * (1 - fg[:, :, :3])
        result = bg[:, :, :3] * (1 - alpha) + result * alpha
        return np.concatenate([result, bg[:, :, 3:4]], axis=2)

    @staticmethod
    def _blend_overlay(bg: np.ndarray, fg: np.ndarray) -> np.ndarray:
        """Overlay blend mode."""
        alpha = fg[:, :, 3:4]
        mask = bg[:, :, :3] < 0.5
        result = np.where(
            mask,
            2 * bg[:, :, :3] * fg[:, :, :3],
            1 - 2 * (1 - bg[:, :, :3]) * (1 - fg[:, :, :3])
        )
        result = bg[:, :, :3] * (1 - alpha) + result * alpha
        return np.concatenate([result, bg[:, :, 3:4]], axis=2)

    def apply_color_grade(self, image: Image.Image, grade: str = "neutral") -> Image.Image:
        """
        Apply color grading/LUT to composite.

        Args:
            image: Image to grade
            grade: "neutral", "warm", "cool", "vintage", "cinematic", "high_contrast"

        Returns:
            Graded image
        """
        try:
            img_array = np.array(image.convert("RGB"), dtype=np.float32) / 255.0

            grades = {
                "neutral": lambda x: x,
                "warm": lambda x: self._grade_warm(x),
                "cool": lambda x: self._grade_cool(x),
                "vintage": lambda x: self._grade_vintage(x),
                "cinematic": lambda x: self._grade_cinematic(x),
                "high_contrast": lambda x: self._grade_high_contrast(x),
            }

            grade_fn = grades.get(grade, lambda x: x)
            graded = grade_fn(img_array)

            graded = np.clip(graded * 255, 0, 255).astype(np.uint8)
            result = Image.fromarray(graded, "RGB")

            if image.mode == "RGBA":
                alpha = image.split()[3]
                result.putalpha(alpha)

            return result
        except Exception as e:
            logger.error(f"Color grading failed: {e}")
            return image

    @staticmethod
    def _grade_warm(img: np.ndarray) -> np.ndarray:
        """Warm color grade."""
        img[:, :, 0] = np.minimum(img[:, :, 0] * 1.1, 1.0)
        img[:, :, 2] = img[:, :, 2] * 0.9
        return img

    @staticmethod
    def _grade_cool(img: np.ndarray) -> np.ndarray:
        """Cool color grade."""
        img[:, :, 0] = img[:, :, 0] * 0.9
        img[:, :, 2] = np.minimum(img[:, :, 2] * 1.1, 1.0)
        return img

    @staticmethod
    def _grade_vintage(img: np.ndarray) -> np.ndarray:
        """Vintage color grade."""
        img = img * 0.95
        img[:, :, 0] = np.minimum(img[:, :, 0] * 1.05, 1.0)
        return img

    @staticmethod
    def _grade_cinematic(img: np.ndarray) -> np.ndarray:
        """Cinematic color grade."""
        img = img ** 0.9
        img[:, :, 0] = img[:, :, 0] * 1.1
        img[:, :, 1] = img[:, :, 1] * 0.95
        return np.clip(img, 0, 1)

    @staticmethod
    def _grade_high_contrast(img: np.ndarray) -> np.ndarray:
        """High contrast color grade."""
        return np.clip((img - 0.5) * 1.5 + 0.5, 0, 1)

    def flatten(self) -> Image.Image:
        """Composite all layers and apply color grading."""
        composite = self.blend_layers()
        return composite

    def export(self, filepath: str, format: str = "PNG"):
        """Export final composite."""
        try:
            composite = self.flatten()
            composite.save(filepath, format=format)
            logger.info(f"Exported composite to {filepath}")
            return filepath
        except Exception as e:
            logger.error(f"Export failed: {e}")
            return None

    def get_layer_positions(self) -> List[Dict]:
        """Get all layer positions and transforms."""
        return [
            {
                "name": layer.name,
                "position": layer.position,
                "scale": layer.scale,
                "rotation": layer.rotation,
                "opacity": layer.opacity,
                "visible": layer.visible
            }
            for layer in self.layers
        ]
