"""Service layer. Lazy imports keep torch off the critical path for CPU-only use."""

_LAZY = {
    "WorkflowOrchestrator": ".workflow",
    "AssetManager": ".asset_manager",
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
