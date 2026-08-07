"""
Interactive selection: edge-aware brush, colour control points, +/- mask algebra.

The mask is a float32 field in [0, 1] the same size as the image, so partial
selection is representable everywhere and every operation is a blend rather than
a binary set. Painting composites a stamp into that field with `max` (add) or
`min` against the inverse (subtract), which keeps strokes idempotent — going
over the same spot twice does not darken it, matching how raster editors behave.

"Edge-aware" here is a colour and gradient heuristic, not a learned model: the
brush stamp is attenuated where a pixel differs from the colour under the brush
centre, and where it sits on a strong gradient. That is cheap enough to run per
stroke on CPU and is what makes the brush stop at an object boundary instead of
bleeding across it.
"""

from __future__ import annotations

import logging
from typing import Optional, Tuple

import cv2
import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)


def _as_bgr_u8(image: Image.Image) -> np.ndarray:
    return cv2.cvtColor(np.array(image.convert("RGB")), cv2.COLOR_RGB2BGR)


class SelectionEngine:
    """
    Holds an image and its live selection mask.

    Precomputes the Lab conversion and gradient magnitude once, since every
    stroke and control point reads them; recomputing per stroke is what makes
    naive versions of this feel laggy.
    """

    def __init__(self, image: Image.Image):
        self.image = image.convert("RGBA")
        self.height, self.width = self.image.height, self.image.width

        bgr = _as_bgr_u8(self.image)
        self.lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)

        grey = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        gx = cv2.Sobel(grey, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(grey, cv2.CV_32F, 0, 1, ksize=3)
        magnitude = np.sqrt(gx * gx + gy * gy)
        peak = float(magnitude.max())
        self.gradient = magnitude / peak if peak > 1e-6 else magnitude

        self.mask = np.zeros((self.height, self.width), dtype=np.float32)
        self._undo_stack: list[np.ndarray] = []
        self._redo_stack: list[np.ndarray] = []

    # ---- history -------------------------------------------------------

    def checkpoint(self):
        """Record the current mask so the next edit can be undone."""
        self._undo_stack.append(self.mask.copy())
        self._redo_stack.clear()
        if len(self._undo_stack) > 40:
            self._undo_stack.pop(0)

    def undo(self) -> bool:
        if not self._undo_stack:
            return False
        self._redo_stack.append(self.mask.copy())
        self.mask = self._undo_stack.pop()
        return True

    def redo(self) -> bool:
        if not self._redo_stack:
            return False
        self._undo_stack.append(self.mask.copy())
        self.mask = self._redo_stack.pop()
        return True

    # ---- painting ------------------------------------------------------

    def _stamp(
        self,
        cx: int,
        cy: int,
        radius: int,
        hardness: float,
        snap: float,
        sensitivity: float,
    ) -> Optional[Tuple[Box_, np.ndarray]]:
        """
        Build one brush stamp, restricted to its bounding box.

        Working in the local box rather than full-image arrays is what keeps a
        stroke cheap on a large document: cost scales with brush area, not
        canvas area.
        """
        radius = max(1, int(radius))
        x0, y0 = max(0, cx - radius), max(0, cy - radius)
        x1, y1 = min(self.width, cx + radius + 1), min(self.height, cy + radius + 1)
        if x1 <= x0 or y1 <= y0:
            return None

        ys, xs = np.mgrid[y0:y1, x0:x1]
        distance = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2) / radius

        # Radial falloff: hardness 1 is a hard disc, 0 is a full gradient.
        hardness = float(np.clip(hardness, 0.0, 1.0))
        inner = hardness
        falloff = np.clip((1.0 - distance) / max(1e-6, 1.0 - inner), 0.0, 1.0)
        stamp = np.where(distance <= inner, 1.0, falloff).astype(np.float32)
        stamp[distance > 1.0] = 0.0

        if snap > 0.0:
            cy_c = int(np.clip(cy, 0, self.height - 1))
            cx_c = int(np.clip(cx, 0, self.width - 1))
            centre_lab = self.lab[cy_c, cx_c]

            patch = self.lab[y0:y1, x0:x1]
            delta_e = np.linalg.norm(patch - centre_lab, axis=-1)

            # sensitivity 0-100 -> tolerance in Lab units. Low sensitivity means
            # a wide tolerance (the brush ignores colour); high means it clings
            # tightly to the colour under the cursor.
            tolerance = np.interp(np.clip(sensitivity, 0, 100), [0, 100], [120.0, 8.0])
            colour_weight = np.exp(-(delta_e ** 2) / (2.0 * tolerance ** 2))

            edge_weight = 1.0 - np.clip(self.gradient[y0:y1, x0:x1] * 4.0, 0.0, 1.0)
            guided = colour_weight * (0.4 + 0.6 * edge_weight)

            snap = float(np.clip(snap, 0.0, 1.0))
            stamp = stamp * ((1.0 - snap) + snap * guided)

        return (x0, y0, x1, y1), stamp.astype(np.float32)

    def paint(
        self,
        x: int,
        y: int,
        radius: int = 40,
        hardness: float = 0.5,
        subtract: bool = False,
        snap: float = 0.0,
        sensitivity: float = 50.0,
    ) -> bool:
        """
        Apply one brush dab. `subtract=True` erases (the modifier-key path).

        Returns False when the dab lands entirely off-canvas.
        """
        result = self._stamp(x, y, radius, hardness, snap, sensitivity)
        if result is None:
            return False
        (x0, y0, x1, y1), stamp = result

        region = self.mask[y0:y1, x0:x1]
        if subtract:
            np.minimum(region, 1.0 - stamp, out=region)
        else:
            np.maximum(region, stamp, out=region)
        return True

    def paint_stroke(self, points, **kwargs) -> int:
        """
        Paint along a polyline, interpolating so fast cursor movement does not
        leave gaps between dabs.
        """
        radius = kwargs.get("radius", 40)
        spacing = max(1.0, radius * 0.25)

        applied = 0
        previous = None
        for point in points:
            if previous is None:
                applied += bool(self.paint(int(point[0]), int(point[1]), **kwargs))
            else:
                dx, dy = point[0] - previous[0], point[1] - previous[1]
                steps = max(1, int(np.hypot(dx, dy) / spacing))
                for i in range(1, steps + 1):
                    t = i / steps
                    applied += bool(
                        self.paint(int(previous[0] + dx * t), int(previous[1] + dy * t), **kwargs)
                    )
            previous = point
        return applied

    # ---- control points ------------------------------------------------

    def control_point(
        self,
        x: int,
        y: int,
        radius: int = 200,
        tolerance: float = 25.0,
        subtract: bool = False,
        feather: float = 0.35,
    ) -> bool:
        """
        Snapseed-style point selection: grow from a click over pixels of similar
        colour, weighted by distance so the influence fades out at `radius`.

        Selection strength is the product of a colour term (CIE76 Delta-E against
        the clicked pixel) and a spatial term, so a similar colour far away is
        not picked up and a dissimilar colour nearby is not either.
        """
        if not (0 <= x < self.width and 0 <= y < self.height):
            return False

        radius = max(1, int(radius))
        x0, y0 = max(0, x - radius), max(0, y - radius)
        x1, y1 = min(self.width, x + radius + 1), min(self.height, y + radius + 1)

        target = self.lab[y, x]
        patch = self.lab[y0:y1, x0:x1]
        delta_e = np.linalg.norm(patch - target, axis=-1)
        colour_weight = np.exp(-(delta_e ** 2) / (2.0 * max(1e-3, tolerance) ** 2))

        ys, xs = np.mgrid[y0:y1, x0:x1]
        distance = np.sqrt((xs - x) ** 2 + (ys - y) ** 2) / radius
        feather = float(np.clip(feather, 0.0, 1.0))
        spatial = np.clip((1.0 - distance) / max(1e-6, feather), 0.0, 1.0)

        weight = (colour_weight * spatial).astype(np.float32)

        region = self.mask[y0:y1, x0:x1]
        if subtract:
            np.minimum(region, 1.0 - weight, out=region)
        else:
            np.maximum(region, weight, out=region)
        return True

    # ---- refinement ----------------------------------------------------

    def refine_grabcut(self, iterations: int = 3) -> bool:
        """
        Refine the current mask with GrabCut, seeded from the painted selection.

        Confident areas become definite foreground/background and the uncertain
        middle is left for GrabCut to resolve, which cleans up a roughly painted
        selection considerably. No-ops when the mask has no confident foreground,
        since GrabCut cannot run without one.
        """
        confident_fg = self.mask > 0.7
        if not confident_fg.any():
            logger.warning("grabcut needs some confidently selected area first")
            return False
        if confident_fg.all():
            logger.warning("grabcut needs some unselected area to contrast against")
            return False

        gc = np.full(self.mask.shape, cv2.GC_PR_BGD, dtype=np.uint8)
        gc[self.mask > 0.3] = cv2.GC_PR_FGD
        gc[confident_fg] = cv2.GC_FGD
        gc[self.mask < 0.05] = cv2.GC_BGD

        try:
            cv2.grabCut(
                _as_bgr_u8(self.image), gc, None,
                np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64),
                iterations, cv2.GC_INIT_WITH_MASK,
            )
        except cv2.error as e:
            logger.error("grabcut failed: %s", e)
            return False

        self.mask = np.where((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD), 1.0, 0.0).astype(np.float32)
        return True

    def feather_mask(self, radius: int):
        """Soften the selection edge by `radius` pixels."""
        if radius <= 0:
            return
        ksize = int(radius) * 2 + 1
        self.mask = cv2.GaussianBlur(self.mask, (ksize, ksize), 0)

    def invert(self):
        self.mask = 1.0 - self.mask

    def clear(self):
        self.mask[:] = 0.0

    def select_all(self):
        self.mask[:] = 1.0

    # ---- output --------------------------------------------------------

    def mask_image(self) -> Image.Image:
        """The selection as an 8-bit greyscale image."""
        return Image.fromarray((np.clip(self.mask, 0, 1) * 255).astype(np.uint8), "L")

    def cutout(self, defringe_radius: int = 4) -> Image.Image:
        """
        Apply the selection as an alpha channel, with halo suppression.

        Reuses the edge-FX defringe so a selection made here and a cutout made by
        the segmentation models get identical fringe handling.
        """
        from backend.pipeline.edge_fx import defringe

        rgb = np.array(self.image.convert("RGB"))
        alpha = (np.clip(self.mask, 0, 1) * 255).astype(np.uint8)
        rgb = defringe(rgb, alpha, radius=defringe_radius)
        return Image.fromarray(np.dstack([rgb, alpha]), "RGBA")

    def overlay(self, colour: Tuple[int, int, int] = (255, 40, 90), strength: float = 0.45) -> Image.Image:
        """Source image tinted where selected, for the editing viewport."""
        base = np.array(self.image.convert("RGB")).astype(np.float32)
        tint = np.array(colour, dtype=np.float32)
        weight = (np.clip(self.mask, 0, 1) * strength)[:, :, None]
        blended = base * (1 - weight) + tint * weight
        return Image.fromarray(blended.astype(np.uint8), "RGB")


Box_ = Tuple[int, int, int, int]
