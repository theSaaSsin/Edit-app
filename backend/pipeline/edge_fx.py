"""
Procedural edge-material FX for cutout masks.

All operations are pure NumPy/OpenCV and run on CPU in well under a second for
typical 2000px cutouts, so this module has no GPU dependency.

The shared technique across styles: an alpha mask is a scalar field. Displacing
its *boundary* organically is done by warping the whole field with a smooth
low-frequency noise vector map and re-thresholding, rather than by editing
contour point lists — warping keeps holes and disjoint islands intact, which
contour editing does not.
"""

import logging
from typing import Tuple, Optional

import cv2
import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

EDGE_STYLES = ("none", "torn_paper", "tissue", "flesh", "sticker", "burnt")


def _to_arrays(image: Image.Image) -> Tuple[np.ndarray, np.ndarray]:
    """Split an RGBA PIL image into an RGB uint8 array and an alpha uint8 array."""
    rgba = np.array(image.convert("RGBA"))
    return rgba[:, :, :3].copy(), rgba[:, :, 3].copy()


def _to_image(rgb: np.ndarray, alpha: np.ndarray) -> Image.Image:
    rgba = np.dstack([rgb.astype(np.uint8), alpha.astype(np.uint8)])
    return Image.fromarray(rgba, "RGBA")


def value_noise(shape: Tuple[int, int], scale: float, seed: Optional[int] = None) -> np.ndarray:
    """
    Smooth value noise in [-1, 1].

    Generates white noise at 1/scale resolution and bicubically upsamples it. At
    the sizes used here this is visually equivalent to Perlin noise and about an
    order of magnitude cheaper, which matters for interactive CPU preview.
    """
    rng = np.random.default_rng(seed)
    h, w = shape
    small_h = max(2, int(h / max(scale, 1.0)))
    small_w = max(2, int(w / max(scale, 1.0)))
    small = rng.random((small_h, small_w), dtype=np.float32)
    noise = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)
    return np.clip(noise * 2.0 - 1.0, -1.0, 1.0)


def fractal_noise(
    shape: Tuple[int, int],
    scale: float,
    octaves: int = 4,
    persistence: float = 0.5,
    seed: Optional[int] = None,
) -> np.ndarray:
    """Sum octaves of value noise so edges get both large sweeps and fine grain."""
    total = np.zeros(shape, dtype=np.float32)
    amplitude = 1.0
    norm = 0.0
    for octave in range(octaves):
        octave_seed = None if seed is None else seed + octave
        total += amplitude * value_noise(shape, scale / (2 ** octave), octave_seed)
        norm += amplitude
        amplitude *= persistence
    return total / max(norm, 1e-6)


def displace_alpha(
    alpha: np.ndarray,
    amplitude: float,
    scale: float,
    octaves: int = 4,
    seed: Optional[int] = None,
) -> np.ndarray:
    """
    Warp an alpha field along a smooth noise vector map.

    Two independent noise fields become per-pixel (dx, dy) offsets fed to
    cv2.remap. Because the same continuous map is sampled everywhere, the
    boundary deforms organically while the interior stays solid.
    """
    h, w = alpha.shape
    dx = fractal_noise((h, w), scale, octaves, seed=seed) * amplitude
    dy = fractal_noise((h, w), scale, octaves, seed=None if seed is None else seed + 977) * amplitude

    grid_x, grid_y = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    map_x = (grid_x + dx).astype(np.float32)
    map_y = (grid_y + dy).astype(np.float32)

    return cv2.remap(
        alpha, map_x, map_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )


def edge_band(alpha: np.ndarray, width: int) -> np.ndarray:
    """
    Float mask in [0, 1] that is 1 at the alpha boundary and falls to 0 `width`
    pixels inside it. Built from a distance transform so the falloff is metric
    rather than iteration-count based.
    """
    if width <= 0:
        return np.zeros_like(alpha, dtype=np.float32)
    solid = (alpha > 127).astype(np.uint8)
    distance = cv2.distanceTransform(solid, cv2.DIST_L2, 5)
    band = 1.0 - np.clip(distance / float(width), 0.0, 1.0)
    return (band * solid).astype(np.float32)


def defringe(rgb: np.ndarray, alpha: np.ndarray, radius: int = 4) -> np.ndarray:
    """
    Anti-halo colour bleed.

    Semi-transparent boundary pixels carry colour averaged with the old
    background, which reads as a halo over a new backdrop. This pushes solid
    interior colour outward across the transparent fringe: each channel is blurred
    with alpha as a weight, so only opaque pixels contribute, and the result
    replaces colour wherever alpha is partial.
    """
    if radius <= 0:
        return rgb

    weight = (alpha.astype(np.float32) / 255.0)[:, :, None]
    ksize = radius * 2 + 1

    weighted = cv2.GaussianBlur((rgb.astype(np.float32) * weight), (ksize, ksize), 0)
    weight_sum = cv2.GaussianBlur(weight, (ksize, ksize), 0)
    bled = weighted / np.maximum(weight_sum[:, :, None] if weight_sum.ndim == 2 else weight_sum, 1e-4)

    partial = ((alpha > 0) & (alpha < 250))[:, :, None]
    return np.where(partial, np.clip(bled, 0, 255), rgb).astype(np.uint8)


def bleed_color_outward(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """
    Fill transparent pixels with the colour of their nearest opaque pixel.

    Every style below moves alpha *outward* past the original silhouette. Those
    newly-opaque pixels would otherwise expose the RGB stored under full
    transparency, which is black in a normal cutout — producing a black rim. This
    pre-fills the whole transparent region so any outward move lands on real
    colour.

    `distanceTransformWithLabels` labels each pixel with the index of its nearest
    zero pixel, numbered in raster order, which lets one call resolve the entire
    nearest-neighbour map.
    """
    holes = (alpha < 128).astype(np.uint8)
    if not holes.any() or holes.all():
        return rgb

    _, labels = cv2.distanceTransformWithLabels(
        holes, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL
    )
    src_y, src_x = np.where(holes == 0)
    idx = np.clip(labels - 1, 0, len(src_y) - 1)
    return rgb[src_y[idx], src_x[idx]]


def feather(alpha: np.ndarray, radius: int) -> np.ndarray:
    """Gaussian-soften the alpha channel by `radius` pixels."""
    if radius <= 0:
        return alpha
    ksize = radius * 2 + 1
    return cv2.GaussianBlur(alpha, (ksize, ksize), 0)


class EdgeFXEngine:
    """Applies procedural material treatments to a cutout's boundary."""

    def apply(
        self,
        cutout: Image.Image,
        style: str = "none",
        intensity: float = 1.0,
        width: int = 24,
        seed: Optional[int] = None,
    ) -> Image.Image:
        """
        Args:
            cutout: RGBA cutout with a real alpha channel.
            style: one of EDGE_STYLES.
            intensity: 0.0-2.0 multiplier on the style's characteristic distortion.
            width: characteristic size in pixels (tear depth, bleed width, char band).
            seed: fixes the noise so repeated renders match.

        Returns:
            New RGBA image, possibly larger than the input when the style expands
            outward (sticker bleed, drop shadow).
        """
        if style not in EDGE_STYLES:
            raise ValueError(f"unknown edge style {style!r}, expected one of {EDGE_STYLES}")

        rgb, alpha = _to_arrays(cutout)
        if not alpha.any():
            logger.warning("cutout has a fully transparent alpha channel; returning unchanged")
            return cutout

        rgb = defringe(rgb, alpha)

        if style == "none":
            return _to_image(rgb, alpha)

        # Styles displace alpha outward, so colour must already exist out there.
        rgb = bleed_color_outward(rgb, alpha)

        if style == "torn_paper":
            return self._torn_paper(rgb, alpha, intensity, width, seed)
        if style == "tissue":
            return self._tissue(rgb, alpha, intensity, width, seed)
        if style == "flesh":
            return self._flesh(rgb, alpha, intensity, width, seed)
        if style == "sticker":
            return self._sticker(rgb, alpha, intensity, width)
        if style == "burnt":
            return self._burnt(rgb, alpha, intensity, width, seed)

    def _torn_paper(self, rgb, alpha, intensity, width, seed) -> Image.Image:
        """Jagged fibrous tear with exposed white cardstock core underneath."""
        torn = displace_alpha(alpha, amplitude=width * intensity, scale=width * 1.5, octaves=5, seed=seed)

        grain = fractal_noise(torn.shape, scale=3.0, octaves=2, seed=seed)
        fibre_band = edge_band(torn, max(2, width // 3))
        torn = np.clip(torn.astype(np.float32) + grain * 90.0 * fibre_band, 0, 255).astype(np.uint8)

        # The white core sits slightly outside the tear, offset along the tear
        # direction, so it reads as paper thickness rather than an outline.
        core = displace_alpha(torn, amplitude=width * 0.35 * intensity, scale=width * 1.2, octaves=3,
                              seed=None if seed is None else seed + 41)
        core_width = max(2, int(width * 0.4 * intensity))
        core = cv2.dilate(
            core, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (core_width * 2 + 1, core_width * 2 + 1))
        )

        combined_alpha = np.maximum(torn, core)
        core_only = (core.astype(np.float32) - torn.astype(np.float32)).clip(0, 255) / 255.0
        paper = np.full_like(rgb, 246)
        out_rgb = (rgb * (1 - core_only[:, :, None]) + paper * core_only[:, :, None]).astype(np.uint8)

        return _to_image(out_rgb, combined_alpha)

    def _tissue(self, rgb, alpha, intensity, width, seed) -> Image.Image:
        """Thin crinkled tissue: heavily feathered edge with capped opacity."""
        warped = displace_alpha(alpha, amplitude=width * 0.4 * intensity, scale=width * 2.0, seed=seed)
        soft = feather(warped, max(2, int(width * 0.6)))

        band = edge_band(soft, width)
        crinkle = (fractal_noise(soft.shape, scale=width * 0.5, octaves=3, seed=seed) + 1.0) * 0.5

        thinned = soft.astype(np.float32) * (1.0 - band * (0.55 * intensity) * crinkle)
        return _to_image(rgb, np.clip(thinned, 0, 255).astype(np.uint8))

    def _flesh(self, rgb, alpha, intensity, width, seed) -> Image.Image:
        """Irregular liquid split with a red/pink subdermal tint at the boundary."""
        split = displace_alpha(alpha, amplitude=width * 1.4 * intensity, scale=width * 0.8, octaves=3, seed=seed)
        split = feather(split, max(1, width // 6))

        band = edge_band(split, width)[:, :, None]
        raw = np.array([148.0, 32.0, 44.0], dtype=np.float32)
        tint_strength = np.clip(band * intensity, 0, 1)
        out_rgb = (rgb.astype(np.float32) * (1 - tint_strength) + raw * tint_strength).astype(np.uint8)

        return _to_image(out_rgb, split)

    def _sticker(self, rgb, alpha, intensity, width) -> Image.Image:
        """Die-cut sticker: uniform white bleed plus a soft contact shadow."""
        bleed = max(4, int(width * intensity))
        pad = bleed * 3

        rgb = cv2.copyMakeBorder(rgb, pad, pad, pad, pad, cv2.BORDER_REPLICATE)
        alpha = cv2.copyMakeBorder(alpha, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)

        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (bleed * 2 + 1, bleed * 2 + 1))
        sticker = cv2.dilate(alpha, kernel)
        sticker = feather(sticker, 1)

        shadow = cv2.GaussianBlur(sticker, (bleed * 2 + 1, bleed * 2 + 1), 0)
        shadow = (shadow.astype(np.float32) * 0.45).astype(np.uint8)
        shadow = np.roll(shadow, shift=(bleed // 2, bleed // 3), axis=(0, 1))

        subject = (alpha.astype(np.float32) / 255.0)[:, :, None]
        white = np.full_like(rgb, 255)
        face = (rgb * subject + white * (1 - subject)).astype(np.uint8)

        # Shadow only shows where the sticker body does not already cover it.
        combined_alpha = np.maximum(sticker, shadow)
        sticker_f = (sticker.astype(np.float32) / 255.0)[:, :, None]
        out_rgb = (face * sticker_f).astype(np.uint8)

        return _to_image(out_rgb, combined_alpha)

    def _burnt(self, rgb, alpha, intensity, width, seed) -> Image.Image:
        """Eroded char: noise eats the border, colour ramps to ash then charcoal."""
        noise = (fractal_noise(alpha.shape, scale=width * 0.7, octaves=4, seed=seed) + 1.0) * 0.5
        band = edge_band(alpha, int(width * 1.5 * intensity))

        # Erode probabilistically: deeper in the band and noisier -> more likely gone.
        eaten = alpha.astype(np.float32) * (1.0 - np.clip(band * (0.4 + noise * 0.9) * intensity, 0, 1))
        eaten = np.where(eaten < 40, 0, eaten)
        burnt_alpha = feather(eaten.astype(np.uint8), 1)

        # The char ramp must cover the semi-transparent rim as well as the solid
        # band just inside it. edge_band only measures inward from the >127
        # contour, so partially-transparent pixels outside it would keep their
        # original colour and read as an un-burnt halo. Those are the most burnt
        # pixels of all, so they are forced to full char.
        inside = edge_band(burnt_alpha, int(width * intensity))
        rim = np.where(burnt_alpha > 0, 1.0 - burnt_alpha.astype(np.float32) / 255.0, 0.0)
        char = np.clip(np.maximum(inside, rim), 0, 1)[:, :, None]

        ash = np.array([92.0, 74.0, 58.0], dtype=np.float32)
        charcoal = np.array([26.0, 20.0, 18.0], dtype=np.float32)

        # Two-stop ramp: image -> ash across the band, ash -> charcoal at the lip.
        ramp = np.clip(char * (0.6 + noise[:, :, None] * 0.4), 0, 1)
        scorched = rgb.astype(np.float32) * (1 - ramp) + ash * ramp
        lip = np.clip((char - 0.5) / 0.5, 0, 1)
        scorched = scorched * (1 - lip) + charcoal * lip

        return _to_image(np.clip(scorched, 0, 255).astype(np.uint8), burnt_alpha)
