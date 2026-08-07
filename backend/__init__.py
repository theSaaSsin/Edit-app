"""
Image Edit Workspace - Professional image processing pipeline.
Integrates segmentation, depth estimation, relighting, and compositing.
"""

__version__ = "0.1.0"

from backend.pipeline import (
    SegmentationEngine,
    DepthEstimationEngine,
    RelightingEngine,
    CompositorEngine,
)
from backend.services import WorkflowOrchestrator, AssetManager

__all__ = [
    "SegmentationEngine",
    "DepthEstimationEngine",
    "RelightingEngine",
    "CompositorEngine",
    "WorkflowOrchestrator",
    "AssetManager",
]
