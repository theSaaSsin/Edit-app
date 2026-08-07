import torch
import numpy as np
from PIL import Image
from pathlib import Path
from typing import Optional, Tuple, Union
import logging

logger = logging.getLogger(__name__)


class SegmentationEngine:
    """
    Handles semantic isolation and background removal using multiple models.
    Supports SAM 2, BiRefNet, Rembg for progressive edge-perfect cutouts.
    """

    def __init__(self, model_type: str = "rembg", device: str = "cuda"):
        self.device = device if torch.cuda.is_available() else "cpu"
        self.model_type = model_type
        self.model = None
        self.processor = None
        logger.info(f"Initializing SegmentationEngine with {model_type} on {self.device}")
        self._load_model()

    def _load_model(self):
        """Load segmentation model based on type."""
        try:
            if self.model_type == "rembg":
                self._load_rembg()
            elif self.model_type == "birefnet":
                self._load_birefnet()
            elif self.model_type == "sam2":
                self._load_sam2()
        except Exception as e:
            logger.error(f"Failed to load {self.model_type}: {e}")
            self._fallback_model()

    def _load_rembg(self):
        """Load Rembg U2Net model for fast background removal."""
        try:
            from rembg import remove
            self.model = remove
            logger.info("Loaded Rembg model successfully")
        except ImportError:
            logger.warning("Rembg not installed, installing...")
            import subprocess
            subprocess.run(["pip", "install", "rembg[cpu]"], check=True)
            from rembg import remove
            self.model = remove

    def _load_birefnet(self):
        """Load BiRefNet for detailed boundary extraction."""
        try:
            from transformers import AutoModelForImageSegmentation
            self.model = AutoModelForImageSegmentation.from_pretrained(
                "ZhengPeng7/BiRefNet",
                trust_remote_code=True
            ).to(self.device)
            self.model.eval()
            logger.info("Loaded BiRefNet model successfully")
        except Exception as e:
            logger.error(f"BiRefNet load failed: {e}")
            self._load_rembg()

    def _load_sam2(self):
        """Load Segment Anything Model 2 for interactive segmentation."""
        try:
            from transformers import AutoModelForMaskGeneration
            self.model = AutoModelForMaskGeneration.from_pretrained(
                "facebook/sam2-hiera-large"
            ).to(self.device)
            self.model.eval()
            logger.info("Loaded SAM 2 model successfully")
        except Exception as e:
            logger.error(f"SAM 2 load failed: {e}")
            self._load_rembg()

    def _fallback_model(self):
        """Fallback to simple model loading."""
        logger.info("Using fallback segmentation model")
        self.model_type = "rembg"
        self._load_rembg()

    def segment(self, image: Union[Image.Image, str], **kwargs) -> Tuple[Image.Image, np.ndarray]:
        """
        Remove background from image and return cutout + alpha mask.

        Args:
            image: PIL Image or path to image
            **kwargs: Additional model-specific parameters

        Returns:
            (cutout_image, alpha_mask)
        """
        if isinstance(image, str):
            image = Image.open(image).convert("RGBA")
        elif isinstance(image, Image.Image):
            image = image.convert("RGBA")

        if self.model_type == "rembg":
            return self._segment_rembg(image, **kwargs)
        elif self.model_type == "birefnet":
            return self._segment_birefnet(image, **kwargs)
        elif self.model_type == "sam2":
            return self._segment_sam2(image, **kwargs)

    def _segment_rembg(self, image: Image.Image, **kwargs) -> Tuple[Image.Image, np.ndarray]:
        """Fast background removal using Rembg."""
        try:
            output = self.model(image)
            output = output.convert("RGBA")
            alpha = np.array(output.split()[3])
            return output, alpha
        except Exception as e:
            logger.error(f"Rembg segmentation failed: {e}")
            return image, np.ones((image.height, image.width), dtype=np.uint8) * 255

    def _segment_birefnet(self, image: Image.Image, **kwargs) -> Tuple[Image.Image, np.ndarray]:
        """Detailed boundary extraction using BiRefNet."""
        try:
            from torchvision.transforms import Compose, ToTensor, Normalize, Resize
            transform = Compose([
                Resize((1024, 1024)),
                ToTensor(),
                Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])
            ])
            image_tensor = transform(image).unsqueeze(0).to(self.device)

            with torch.no_grad():
                mask = self.model(image_tensor)

            mask = torch.sigmoid(mask).squeeze().cpu().numpy()
            mask = (mask * 255).astype(np.uint8)
            mask = Image.fromarray(mask, mode="L")
            mask = mask.resize((image.width, image.height), Image.Resampling.LANCZOS)

            result = image.copy()
            result.putalpha(mask)
            return result, np.array(mask)
        except Exception as e:
            logger.error(f"BiRefNet segmentation failed: {e}")
            return image, np.ones((image.height, image.width), dtype=np.uint8) * 255

    def _segment_sam2(self, image: Image.Image, points: Optional[list] = None, **kwargs) -> Tuple[Image.Image, np.ndarray]:
        """Interactive segmentation using SAM 2."""
        try:
            from transformers import pipeline
            pipe = pipeline("mask-generation", model="facebook/sam2-hiera-large", device=self.device)
            outputs = pipe(image)

            if outputs and len(outputs) > 0:
                mask = outputs[0]["masks"][0]
                mask = (mask * 255).astype(np.uint8)
                mask_img = Image.fromarray(mask, mode="L")

                result = image.copy()
                result.putalpha(mask_img)
                return result, mask
            else:
                logger.warning("SAM 2 produced no masks")
                return image, np.ones((image.height, image.width), dtype=np.uint8) * 255
        except Exception as e:
            logger.error(f"SAM 2 segmentation failed: {e}")
            return image, np.ones((image.height, image.width), dtype=np.uint8) * 255

    def batch_segment(self, image_paths: list, **kwargs) -> list:
        """Process multiple images in batch."""
        results = []
        for path in image_paths:
            try:
                cutout, mask = self.segment(path, **kwargs)
                results.append({"cutout": cutout, "mask": mask, "path": path, "status": "success"})
            except Exception as e:
                logger.error(f"Batch segmentation failed for {path}: {e}")
                results.append({"path": path, "status": "failed", "error": str(e)})
        return results
