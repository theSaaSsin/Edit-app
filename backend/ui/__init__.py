"""
User interfaces.

Lazy imports: the timeline editor needs gradio and the studio needs PyQt6, and
neither should be required to use the other.
"""

_LAZY = {
    "create_carousel_timeline_ui": ".timeline_editor",
    "StudioWindow": ".studio",
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
