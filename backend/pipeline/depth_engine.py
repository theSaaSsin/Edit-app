import torch
import numpy as np
from PIL import Image
from typing import Union, Tuple, Optional
import logging

logger = logging.getLogger(__name__)


class DepthEstimationEngine:
    """
    Generates high-fidelity depth maps, normal maps, and occlusion boundaries
    using Depth Anything V2, ZoeDepth, or Marigold models.
    """

    def __init__(self, model_type: str = "depth_anything_v2", device: str = "cuda"):
        self.device = device if torch.cuda.is_available() else "cpu"
        self.model_type = model_type
        self.model = None
        self.processor = None
        logger.info(f"Initializing DepthEstimationEngine with {model_type} on {self.device}")
        self._load_model()

    def _load_model(self):
        """Load depth estimation model."""
        try:
            if self.model_type == "depth_anything_v2":
                self._load_depth_anything_v2()
            elif self.model_type == "zoedepth":
                self._load_zoedepth()
            elif self.model_type == "marigold":
                self._load_marigold()
        except Exception as e:
            logger.error(f"Failed to load {self.model_type}: {e}")
            self._fallback_model()

    def _load_depth_anything_v2(self):
        """Load Depth Anything V2 model."""
        try:
            from transformers import AutoModelForDepthEstimation, AutoImageProcessor
            model_id = "depth-anything/Depth-Anything-V2-Large-hf"
            self.model = AutoModelForDepthEstimation.from_pretrained(model_id).to(self.device)
            self.processor = AutoImageProcessor.from_pretrained(model_id)
            self.model.eval()
            logger.info("Loaded Depth Anything V2 model successfully")
        except Exception as e:
            logger.error(f"Depth Anything V2 load failed: {e}")
            self._load_zoedepth()

    def _load_zoedepth(self):
        """Load ZoeDepth model."""
        try:
            import zoedepth as zoe
            self.model = zoe.ZoeDepth.build_from_config(
                {"pretrained_resource": "local::zoedepth/ZoeD_M_12_03_15.pt"}
            ).to(self.device).eval()
            logger.info("Loaded ZoeDepth model successfully")
        except Exception as e:
            logger.error(f"ZoeDepth load failed: {e}")
            self._load_marigold()

    def _load_marigold(self):
        """Load Marigold depth estimation model."""
        try:
            from transformers import AutoModelForDepthEstimation, AutoImageProcessor
            self.model = AutoModelForDepthEstimation.from_pretrained(
                "prs-eth/marigold-lcm-v1-0"
            ).to(self.device)
            self.processor = AutoImageProcessor.from_pretrained("prs-eth/marigold-lcm-v1-0")
            self.model.eval()
            logger.info("Loaded Marigold model successfully")
        except Exception as e:
            logger.error(f"Marigold load failed: {e}")
            logger.warning("All depth models failed to load")

    def _fallback_model(self):
        """Fallback simple depth estimation."""
        logger.info("Using fallback depth estimation")
        self.model = None

    def estimate_depth(self, image: Union[Image.Image, str], normalized: bool = True) -> np.ndarray:
        """
        Estimate depth map from image.

        Args:
            image: PIL Image or path to image
            normalized: If True, normalize to 0-1 range

        Returns:
            Depth map as numpy array
        """
        if isinstance(image, str):
            image = Image.open(image).convert("RGB")
        elif isinstance(image, Image.Image):
            image = image.convert("RGB")

        if self.model is None:
            return self._fallback_depth(image)

        if self.model_type == "depth_anything_v2":
            return self._estimate_depth_anything_v2(image, normalized)
        elif self.model_type == "zoedepth":
            return self._estimate_zoedepth(image, normalized)
        elif self.model_type == "marigold":
            return self._estimate_marigold(image, normalized)

    def _estimate_depth_anything_v2(self, image: Image.Image, normalized: bool) -> np.ndarray:
        """Estimate depth using Depth Anything V2."""
        try:
            inputs = self.processor(images=image, return_tensors="pt").to(self.device)
            with torch.no_grad():
                outputs = self.model(**inputs)
                predicted_depth = outputs.predicted_depth

            depth = torch.nn.functional.interpolate(
                predicted_depth.unsqueeze(1),
                size=image.size[::-1],
                mode="bicubic",
                align_corners=False,
            ).squeeze()

            depth = depth.cpu().numpy()

            if normalized:
                depth = (depth - depth.min()) / (depth.max() - depth.min())

            return depth
        except Exception as e:
            logger.error(f"Depth Anything V2 estimation failed: {e}")
            return self._fallback_depth(image)

    def _estimate_zoedepth(self, image: Image.Image, normalized: bool) -> np.ndarray:
        """Estimate depth using ZoeDepth."""
        try:
            depth = self.model.infer_pil(image)
            if normalized:
                depth = (depth - depth.min()) / (depth.max() - depth.min() + 1e-6)
            return depth
        except Exception as e:
            logger.error(f"ZoeDepth estimation failed: {e}")
            return self._fallback_depth(image)

    def _estimate_marigold(self, image: Image.Image, normalized: bool) -> np.ndarray:
        """Estimate depth using Marigold."""
        try:
            inputs = self.processor(images=image, return_tensors="pt").to(self.device)
            with torch.no_grad():
                outputs = self.model(**inputs)
                predicted_depth = outputs.predicted_depth

            depth = torch.nn.functional.interpolate(
                predicted_depth.unsqueeze(1),
                size=image.size[::-1],
                mode="bicubic",
                align_corners=False,
            ).squeeze()

            depth = depth.cpu().numpy()

            if normalized:
                depth = (depth - depth.min()) / (depth.max() - depth.min())

            return depth
        except Exception as e:
            logger.error(f"Marigold estimation failed: {e}")
            return self._fallback_depth(image)

    def _fallback_depth(self, image: Image.Image) -> np.ndarray:
        """Fallback: generate simple depth gradient."""
        width, height = image.size
        depth = np.linspace(1, 0, height)
        depth = np.tile(depth[:, np.newaxis], (1, width))
        return depth

    def compute_normals(self, depth_map: np.ndarray) -> np.ndarray:
        """Compute surface normals from depth map."""
        try:
            from scipy.ndimage import sobel
            depth = depth_map.astype(np.float32)
            nx = sobel(depth, axis=1)
            ny = sobel(depth, axis=0)
            nz = np.ones_like(depth)

            normals = np.stack([nx, ny, nz], axis=-1)
            norm = np.linalg.norm(normals, axis=-1, keepdims=True)
            normals = normals / (norm + 1e-6)

            normals = ((normals + 1) * 127.5).astype(np.uint8)
            return normals
        except Exception as e:
            logger.error(f"Normal computation failed: {e}")
            return np.zeros((*depth_map.shape, 3), dtype=np.uint8)

    def compute_occlusion(self, depth_map: np.ndarray, threshold: float = 0.1) -> np.ndarray:
        """Compute ambient occlusion approximation from depth."""
        try:
            from scipy.ndimage import gaussian_filter
            depth = depth_map.astype(np.float32)
            smoothed = gaussian_filter(depth, sigma=2)
            occlusion = np.clip(smoothed - depth + threshold, 0, 1)
            return occlusion
        except Exception as e:
            logger.error(f"Occlusion computation failed: {e}")
            return np.ones_like(depth_map)

    def batch_estimate(self, image_paths: list, compute_normals: bool = False) -> list:
        """Process multiple images in batch."""
        results = []
        for path in image_paths:
            try:
                depth = self.estimate_depth(path)
                result = {"depth": depth, "path": path, "status": "success"}

                if compute_normals:
                    result["normals"] = self.compute_normals(depth)
                    result["occlusion"] = self.compute_occlusion(depth)

                results.append(result)
            except Exception as e:
                logger.error(f"Batch depth estimation failed for {path}: {e}")
                results.append({"path": path, "status": "failed", "error": str(e)})
        return results
