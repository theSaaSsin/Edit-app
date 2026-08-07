"""
Image Edit Workspace - modular local image/video processing pipeline.

Nothing heavy is imported at package level; pull engines from their submodules
(e.g. `from backend.pipeline import EdgeFXEngine`) so a CPU-only install does not
need torch.
"""

__version__ = "0.1.0"
