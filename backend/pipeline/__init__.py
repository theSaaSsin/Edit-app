"""
Pipeline modules.

Imports are lazy: the segmentation/depth/relighting engines pull in torch, which
is a multi-gigabyte dependency. Importing this package to use the CPU-only
edge-FX or compositing modules must not require it.
"""

_LAZY = {
    "SegmentationEngine": ".segmenter",
    "DepthEstimationEngine": ".depth_engine",
    "RelightingEngine": ".relighter",
    "CompositorEngine": ".compositor",
    "VideoCarouselEngine": ".video_engine",
    "AnimationKeyframe": ".video_engine",
    "LyricFrame": ".video_engine",
    "EdgeFXEngine": ".edge_fx",
    "EDGE_STYLES": ".edge_fx",
    "gmic_fx": ".gmic_fx",
    "TiledCanvas": ".tiles",
    "TileLayer": ".tiles",
    "BLEND_MODES": ".tiles",
    "SelectionEngine": ".selection",
    "COLOR_GRADES": ".compositor",
}

__all__ = list(_LAZY)


def __getattr__(name):
    if name not in _LAZY:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from importlib import import_module
    module = import_module(_LAZY[name], __name__)
    value = getattr(module, name)
    globals()[name] = value
    return value


def __dir__():
    return sorted(__all__)
