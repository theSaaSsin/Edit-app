"""
G'MIC texture and style filters, driven over the CLI.

G'MIC is a multithreaded C++ engine, so these run fast on a laptop CPU — which
is the point: it is the one dependency here that adds heavy artistic filtering
without a GPU.

Two design decisions come from what G'MIC actually is in practice:

Presets are built from G'MIC's *core* primitives (blur, smooth, noise, blend,
quantize…) rather than its community filter pack. The pack ships separately,
updates over the network, and varies by build — on the machine this module was
written against, `cartoon` failed inside G'MIC's own stdlib while every core
primitive worked. Core commands are stable across builds.

Presets are also probed at runtime rather than trusted. `available_presets()`
runs each one on a tiny image once and caches the result, so the UI offers only
what this install can actually do instead of failing at export time.
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class GmicPreset:
    """A named G'MIC pipeline. `args` are separate argv tokens, never one string."""

    name: str
    description: str
    args: tuple

    def with_strength(self, strength: float) -> tuple:
        """Presets are applied at full strength; blending happens in apply()."""
        return self.args


#: Curated looks, each a pipeline of core primitives.
PRESETS: Dict[str, GmicPreset] = {
    p.name: p for p in [
        GmicPreset("oil_paint", "Painterly, smoothed planes with crisp edges",
                   ("smooth", "60,0,1,1,2", "sharpen", "80")),
        GmicPreset("film_grain", "Analogue grain, fine and slightly soft",
                   ("noise", "12,0", "blur", "0.4")),
        GmicPreset("sketch", "Inverted gradient sketch, line-drawing feel",
                   ("gradient_norm", "negate", "normalize", "0,255")),
        GmicPreset("glow", "Bloom lifted off the highlights",
                   ("+blur", "12", "blend", "screen,0.55")),
        GmicPreset("soft_focus", "Diffusion filter softness, keeps contrast",
                   ("+blur", "8", "blend", "softlight,0.6")),
        GmicPreset("local_contrast", "Punchy midtone separation",
                   ("+blur", "20", "blend", "overlay,0.45")),
        GmicPreset("vignette", "Darkened corners",
                   ("vignette", "60,90")),
        GmicPreset("halftone", "Chunky print-dot texture",
                   ("pixelize", "4", "sharpen", "200")),
        GmicPreset("dreamy", "Smoothed and bloomed, hazy",
                   ("smooth", "30,0,1,1,2", "+blur", "15", "blend", "screen,0.4")),
        GmicPreset("posterize", "Flat quantised colour bands",
                   ("quantize", "8,1")),
        GmicPreset("crosshatch", "Overlaid directional noise, drawn texture",
                   ("+noise", "40,2", "blend", "overlay,0.5")),
        GmicPreset("ink_edge", "Darkened contour lines over the image",
                   ("+gradient_norm", "negate.", "blend", "multiply,0.8")),
        GmicPreset("old_photo", "Aged print, G'MIC's own preset",
                   ("old_photo",)),
        GmicPreset("sepia", "Warm monochrome",
                   ("sepia",)),
        GmicPreset("solarize", "Tonal inversion above threshold",
                   ("solarize",)),
        GmicPreset("water", "Liquid surface displacement",
                   ("water", "30")),
        GmicPreset("ripple", "Concentric wave distortion",
                   ("ripple", "10")),
        GmicPreset("pixelize", "Blocky mosaic",
                   ("pixelize", "8")),
    ]
}

_available_cache: Optional[List[str]] = None


def gmic_path() -> Optional[str]:
    """Path to the gmic binary, or None if it is not installed."""
    return shutil.which("gmic")


def is_available() -> bool:
    return gmic_path() is not None


_ANSI = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")


def version() -> Optional[str]:
    """Version string, with G'MIC's terminal colour codes stripped."""
    binary = gmic_path()
    if not binary:
        return None
    try:
        out = subprocess.run([binary, "-version"], capture_output=True, text=True, timeout=20)
        for line in (out.stdout + out.stderr).splitlines():
            clean = _ANSI.sub("", line).strip()
            if "Version" in clean:
                return clean
    except Exception:
        pass
    return "unknown"


class GmicNotInstalled(RuntimeError):
    pass


def _run(input_path: Path, output_path: Path, args: tuple, timeout: int = 180):
    binary = gmic_path()
    if not binary:
        raise GmicNotInstalled(
            "G'MIC is not installed.\n"
            "  Debian/Ubuntu:  sudo apt install gmic\n"
            "  macOS:          brew install gmic\n"
            "  Windows/other:  https://gmic.eu/download.shtml"
        )

    # Each token stays a separate argv element; joining them into one string is
    # the classic way to make G'MIC reject an otherwise valid pipeline.
    command = [binary, str(input_path), *args, "output", str(output_path)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)

    if result.returncode != 0 or not output_path.exists():
        detail = ""
        for line in (result.stderr or "").splitlines():
            if "Error" in line:
                detail = _ANSI.sub("", line).strip()
                break
        raise RuntimeError(f"g'mic failed ({' '.join(args)}): {detail or result.returncode}")


def available_presets(force: bool = False) -> List[str]:
    """
    Names of presets this G'MIC build can actually run.

    Probed once against a tiny image and cached, so the cost is paid at startup
    rather than as a surprise failure during export.
    """
    global _available_cache
    if _available_cache is not None and not force:
        return _available_cache

    if not is_available():
        _available_cache = []
        return _available_cache

    working = []
    with tempfile.TemporaryDirectory() as tmp:
        probe = Path(tmp) / "probe.png"
        Image.effect_noise((32, 32), 40).convert("RGB").save(probe)

        for name, preset in PRESETS.items():
            out = Path(tmp) / f"{name}.png"
            try:
                _run(probe, out, preset.args, timeout=45)
                working.append(name)
            except Exception as e:
                logger.debug("preset %s unavailable: %s", name, e)

    _available_cache = working
    logger.info("g'mic: %d/%d presets available", len(working), len(PRESETS))
    return working


def apply_preset(
    image: Image.Image,
    preset: str,
    strength: float = 1.0,
    timeout: int = 180,
) -> Image.Image:
    """
    Apply a named preset, preserving any alpha channel.

    G'MIC filters operate on colour and will happily mangle or drop an alpha
    channel, so alpha is detached, the RGB is processed, and the original alpha
    is reattached. That keeps a filtered cutout's silhouette — and any edge
    material already applied — exactly intact.

    `strength` below 1.0 blends the result back toward the original, which gives
    a continuous dial over presets that have no intensity parameter of their own.
    """
    if preset not in PRESETS:
        raise ValueError(f"unknown preset {preset!r}; known: {sorted(PRESETS)}")

    strength = float(np.clip(strength, 0.0, 1.0))
    if strength == 0.0:
        return image

    rgba = image.convert("RGBA")
    alpha = rgba.split()[3]
    rgb = rgba.convert("RGB")

    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "in.png"
        target = Path(tmp) / "out.png"
        rgb.save(source)
        _run(source, target, PRESETS[preset].args, timeout=timeout)
        filtered = Image.open(target).convert("RGB")

    # Some filters (displacements especially) change dimensions.
    if filtered.size != rgb.size:
        filtered = filtered.resize(rgb.size, Image.Resampling.LANCZOS)

    if strength < 1.0:
        filtered = Image.blend(rgb, filtered, strength)

    result = filtered.convert("RGBA")
    result.putalpha(alpha)
    return result


def apply_custom(image: Image.Image, args: List[str], timeout: int = 180) -> Image.Image:
    """
    Run an arbitrary G'MIC pipeline, e.g. ["blur", "3", "sharpen", "100"].

    Pass each token separately. Alpha is preserved as in apply_preset.
    """
    if not args:
        raise ValueError("no g'mic arguments given")

    rgba = image.convert("RGBA")
    alpha = rgba.split()[3]
    rgb = rgba.convert("RGB")

    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "in.png"
        target = Path(tmp) / "out.png"
        rgb.save(source)
        _run(source, target, tuple(args), timeout=timeout)
        filtered = Image.open(target).convert("RGB")

    if filtered.size != rgb.size:
        filtered = filtered.resize(rgb.size, Image.Resampling.LANCZOS)

    result = filtered.convert("RGBA")
    result.putalpha(alpha)
    return result


def describe_presets() -> List[tuple]:
    """(name, description, available) for every preset, for UI listings."""
    available = set(available_presets())
    return [(p.name, p.description, p.name in available) for p in PRESETS.values()]
