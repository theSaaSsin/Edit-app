import logging
from typing import Dict, List, Optional, Tuple
from PIL import Image
import json
from datetime import datetime

from backend.pipeline import (
    SegmentationEngine,
    DepthEstimationEngine,
    RelightingEngine,
    CompositorEngine,
)
from backend.config.settings import Config

logger = logging.getLogger(__name__)


class WorkflowOrchestrator:
    """
    Main orchestration layer coordinating all pipeline stages.
    Manages segmentation → depth → relighting → compositing workflows.
    """

    def __init__(self):
        logger.info("Initializing WorkflowOrchestrator")
        self.segmenter = SegmentationEngine(device=Config.DEVICE)
        self.depth_engine = DepthEstimationEngine(device=Config.DEVICE)
        self.relighter = RelightingEngine(device=Config.DEVICE)
        self.compositor = CompositorEngine()

        self.workflow_state = {}
        self.history = []

    def cutout_workflow(self, image_path: str, model: str = "rembg") -> Dict:
        """
        Stage 1: Extract perfect alpha cutout.

        Args:
            image_path: Path to input image
            model: "rembg", "birefnet", or "sam2"

        Returns:
            {"cutout": PIL.Image, "mask": np.ndarray, "metadata": {...}}
        """
        try:
            logger.info(f"Starting cutout workflow: {image_path}")
            self.segmenter.model_type = model

            cutout, mask = self.segmenter.segment(image_path)

            result = {
                "status": "success",
                "cutout": cutout,
                "mask": mask,
                "model": model,
                "timestamp": datetime.now().isoformat(),
                "input_path": image_path,
            }

            self._record_workflow("cutout", result)
            return result
        except Exception as e:
            logger.error(f"Cutout workflow failed: {e}")
            return {"status": "failed", "error": str(e)}

    def depth_workflow(self, image_path: str, model: str = "depth_anything_v2") -> Dict:
        """
        Stage 2: Generate depth maps and surface normals.

        Args:
            image_path: Path to input image
            model: "depth_anything_v2", "zoedepth", or "marigold"

        Returns:
            {"depth": np.ndarray, "normals": np.ndarray, "occlusion": np.ndarray}
        """
        try:
            logger.info(f"Starting depth workflow: {image_path}")
            self.depth_engine.model_type = model

            depth = self.depth_engine.estimate_depth(image_path)
            normals = self.depth_engine.compute_normals(depth)
            occlusion = self.depth_engine.compute_occlusion(depth)

            result = {
                "status": "success",
                "depth": depth,
                "normals": normals,
                "occlusion": occlusion,
                "model": model,
                "timestamp": datetime.now().isoformat(),
                "input_path": image_path,
            }

            self._record_workflow("depth", result)
            return result
        except Exception as e:
            logger.error(f"Depth workflow failed: {e}")
            return {"status": "failed", "error": str(e)}

    def relighting_workflow(
        self,
        cutout_image: Image.Image,
        light_direction: str = "front",
        light_intensity: float = 1.0,
        prompt: Optional[str] = None,
        model: str = "sdxl",
    ) -> Dict:
        """
        Stage 3: Apply neural light transport.

        Args:
            cutout_image: PIL Image cutout
            light_direction: "front", "side", "back", "rim", "fill"
            light_intensity: 0.5 to 2.0
            prompt: Custom relighting prompt
            model: "ic_light", "sdxl", "sdxl_turbo", "flux_dev"

        Returns:
            {"relit": PIL.Image, "metadata": {...}}
        """
        try:
            logger.info(f"Starting relighting workflow: {light_direction}")
            self.relighter.model_type = model

            relit = self.relighter.relight(
                cutout_image,
                light_direction=light_direction,
                light_intensity=light_intensity,
                prompt=prompt,
            )

            result = {
                "status": "success",
                "relit": relit,
                "light_direction": light_direction,
                "light_intensity": light_intensity,
                "model": model,
                "timestamp": datetime.now().isoformat(),
            }

            self._record_workflow("relighting", result)
            return result
        except Exception as e:
            logger.error(f"Relighting workflow failed: {e}")
            return {"status": "failed", "error": str(e)}

    def compositing_workflow(
        self,
        background_image: Image.Image,
        cutout_images: List[Image.Image],
        positions: List[Tuple[int, int]] = None,
        cast_shadows: bool = True,
        color_grade: str = "neutral",
    ) -> Dict:
        """
        Stage 4: Composite cutouts into scene with shadows and grading.

        Args:
            background_image: Base scene image
            cutout_images: List of cutout layers
            positions: List of (x, y) positions for each cutout
            cast_shadows: Whether to add drop shadows
            color_grade: "neutral", "warm", "cool", "vintage", "cinematic", "high_contrast"

        Returns:
            {"composite": PIL.Image, "metadata": {...}}
        """
        try:
            logger.info("Starting compositing workflow")
            width, height = background_image.size

            # A fresh compositor per call; reusing one accumulates layers from
            # every previous composite.
            self.compositor = CompositorEngine(canvas_size=(width, height))
            self.compositor.set_background(background_image)

            placed = []
            for i, cutout in enumerate(cutout_images):
                pos = positions[i] if positions and i < len(positions) else (0, 0)
                placed.append(self.compositor.add_layer(cutout, name=f"cutout_{i}", position=pos))

            if cast_shadows:
                for layer in placed:
                    self.compositor.cast_shadow(layer)

            composite = self.compositor.flatten(grade=color_grade)

            result = {
                "status": "success",
                "composite": composite,
                "cast_shadows": cast_shadows,
                "color_grade": color_grade,
                "layer_count": len(cutout_images),
                "timestamp": datetime.now().isoformat(),
            }

            self._record_workflow("compositing", result)
            return result
        except Exception as e:
            logger.error(f"Compositing workflow failed: {e}")
            return {"status": "failed", "error": str(e)}

    def full_pipeline(
        self,
        input_image: str,
        background_image: str,
        light_direction: str = "front",
        color_grade: str = "neutral",
        segmentation_model: str = "rembg",
        depth_model: str = "depth_anything_v2",
        relighting_model: str = "sdxl",
    ) -> Dict:
        """
        Execute complete pipeline: cutout → depth → relight → composite.

        Args:
            input_image: Path to image for cutout
            background_image: Path to background scene
            light_direction: Relighting direction
            color_grade: Final color grade
            segmentation_model: Model for segmentation
            depth_model: Model for depth estimation
            relighting_model: Model for relighting

        Returns:
            {"status": "success/failed", "final_composite": PIL.Image, "stages": {...}}
        """
        try:
            logger.info("Starting full pipeline")
            stages = {}

            # Stage 1: Cutout
            cutout_result = self.cutout_workflow(input_image, segmentation_model)
            if cutout_result["status"] != "success":
                return {"status": "failed", "error": "Cutout stage failed", "stages": stages}
            stages["cutout"] = cutout_result

            # Stage 2: Depth
            depth_result = self.depth_workflow(input_image, depth_model)
            if depth_result["status"] == "success":
                stages["depth"] = depth_result

            # Stage 3: Relight
            relight_result = self.relighting_workflow(
                cutout_result["cutout"],
                light_direction=light_direction,
                model=relighting_model,
            )
            if relight_result["status"] != "success":
                logger.warning("Relighting stage failed, using cutout")
                relit_image = cutout_result["cutout"]
            else:
                relit_image = relight_result["relit"]
                stages["relighting"] = relight_result

            # Stage 4: Composite
            bg_image = Image.open(background_image)
            composite_result = self.compositing_workflow(
                bg_image,
                [relit_image],
                positions=[(50, 50)],
                cast_shadows=True,
                color_grade=color_grade,
            )
            stages["compositing"] = composite_result

            return {
                "status": "success",
                "final_composite": composite_result["composite"],
                "stages": stages,
                "timestamp": datetime.now().isoformat(),
            }
        except Exception as e:
            logger.error(f"Full pipeline failed: {e}")
            return {"status": "failed", "error": str(e), "stages": stages}

    def _record_workflow(self, stage: str, result: Dict):
        """Record workflow execution in history."""
        self.history.append({
            "stage": stage,
            "result": result,
            "timestamp": datetime.now().isoformat(),
        })
        logger.info(f"Recorded workflow stage: {stage}")

    def get_history(self, limit: int = 10) -> List[Dict]:
        """Get recent workflow history."""
        return self.history[-limit:]

    def clear_history(self):
        """Clear workflow history."""
        self.history = []
        logger.info("Cleared workflow history")
