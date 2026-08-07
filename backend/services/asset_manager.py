import os
import shutil
import json
from pathlib import Path
from typing import List, Dict, Optional
from PIL import Image
import uuid
import logging

from backend.config.settings import Config

logger = logging.getLogger(__name__)


class AssetManager:
    """Manages asset storage, retrieval, and organization."""

    def __init__(self):
        self.inputs_path = Path(Config.INPUTS_PATH)
        self.cutouts_path = Path(Config.CUTOUTS_PATH)
        self.outputs_path = Path(Config.OUTPUTS_PATH)
        self.metadata_file = self.cutouts_path / "metadata.json"

        self._ensure_directories()
        self._load_metadata()

    def _ensure_directories(self):
        """Ensure all directories exist."""
        for path in [self.inputs_path, self.cutouts_path, self.outputs_path]:
            path.mkdir(parents=True, exist_ok=True)

    def _load_metadata(self):
        """Load asset metadata."""
        self.metadata = {}
        if self.metadata_file.exists():
            try:
                with open(self.metadata_file, "r") as f:
                    self.metadata = json.load(f)
            except Exception as e:
                logger.error(f"Failed to load metadata: {e}")
                self.metadata = {}

    def _save_metadata(self):
        """Save asset metadata."""
        try:
            with open(self.metadata_file, "w") as f:
                json.dump(self.metadata, f, indent=2, default=str)
        except Exception as e:
            logger.error(f"Failed to save metadata: {e}")

    def save_input(self, image: Image.Image, name: Optional[str] = None) -> str:
        """
        Save input image.

        Args:
            image: PIL Image to save
            name: Optional filename (auto-generated if not provided)

        Returns:
            Saved file path
        """
        try:
            filename = name or f"input_{uuid.uuid4().hex[:8]}.png"
            filepath = self.inputs_path / filename

            image.save(filepath, "PNG")
            logger.info(f"Saved input image: {filepath}")
            return str(filepath)
        except Exception as e:
            logger.error(f"Failed to save input: {e}")
            return None

    def save_cutout(self, image: Image.Image, metadata: Dict = None) -> str:
        """
        Save cutout with metadata.

        Args:
            image: PIL Image cutout (should have alpha channel)
            metadata: Optional metadata dictionary

        Returns:
            Cutout ID/filename
        """
        try:
            cutout_id = f"cutout_{uuid.uuid4().hex[:8]}"
            filepath = self.cutouts_path / f"{cutout_id}.png"

            image.save(filepath, "PNG")

            self.metadata[cutout_id] = {
                "filename": f"{cutout_id}.png",
                "width": image.width,
                "height": image.height,
                "size_kb": filepath.stat().st_size / 1024,
                **(metadata or {})
            }
            self._save_metadata()

            logger.info(f"Saved cutout: {cutout_id}")
            return cutout_id
        except Exception as e:
            logger.error(f"Failed to save cutout: {e}")
            return None

    def save_output(self, image: Image.Image, name: Optional[str] = None) -> str:
        """
        Save output composite.

        Args:
            image: PIL Image to save
            name: Optional filename

        Returns:
            Saved file path
        """
        try:
            filename = name or f"composite_{uuid.uuid4().hex[:8]}.png"
            filepath = self.outputs_path / filename

            image.save(filepath, "PNG")
            logger.info(f"Saved output: {filepath}")
            return str(filepath)
        except Exception as e:
            logger.error(f"Failed to save output: {e}")
            return None

    def load_cutout(self, cutout_id: str) -> Optional[Image.Image]:
        """Load cutout by ID."""
        try:
            if cutout_id not in self.metadata:
                logger.warning(f"Cutout not found: {cutout_id}")
                return None

            filepath = self.cutouts_path / self.metadata[cutout_id]["filename"]
            if not filepath.exists():
                logger.warning(f"Cutout file not found: {filepath}")
                return None

            return Image.open(filepath).convert("RGBA")
        except Exception as e:
            logger.error(f"Failed to load cutout: {e}")
            return None

    def load_image(self, filepath: str) -> Optional[Image.Image]:
        """Load image from any path."""
        try:
            return Image.open(filepath).convert("RGBA")
        except Exception as e:
            logger.error(f"Failed to load image: {e}")
            return None

    def list_cutouts(self) -> List[Dict]:
        """List all saved cutouts."""
        return [
            {
                "id": cutout_id,
                **metadata
            }
            for cutout_id, metadata in self.metadata.items()
        ]

    def list_outputs(self) -> List[Dict]:
        """List all saved outputs."""
        try:
            files = list(self.outputs_path.glob("*.png"))
            return [
                {
                    "filename": f.name,
                    "path": str(f),
                    "size_kb": f.stat().st_size / 1024,
                }
                for f in sorted(files, key=lambda x: x.stat().st_mtime, reverse=True)
            ]
        except Exception as e:
            logger.error(f"Failed to list outputs: {e}")
            return []

    def delete_cutout(self, cutout_id: str) -> bool:
        """Delete cutout by ID."""
        try:
            if cutout_id not in self.metadata:
                logger.warning(f"Cutout not found: {cutout_id}")
                return False

            filepath = self.cutouts_path / self.metadata[cutout_id]["filename"]
            if filepath.exists():
                filepath.unlink()

            del self.metadata[cutout_id]
            self._save_metadata()

            logger.info(f"Deleted cutout: {cutout_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete cutout: {e}")
            return False

    def clear_inputs(self) -> bool:
        """Clear all input images."""
        try:
            for f in self.inputs_path.glob("*.png"):
                f.unlink()
            logger.info("Cleared input directory")
            return True
        except Exception as e:
            logger.error(f"Failed to clear inputs: {e}")
            return False

    def clear_outputs(self) -> bool:
        """Clear all output composites."""
        try:
            for f in self.outputs_path.glob("*.png"):
                f.unlink()
            logger.info("Cleared output directory")
            return True
        except Exception as e:
            logger.error(f"Failed to clear outputs: {e}")
            return False

    def get_stats(self) -> Dict:
        """Get asset storage statistics."""
        try:
            inputs_size = sum(f.stat().st_size for f in self.inputs_path.glob("*")) / (1024 ** 2)
            cutouts_size = sum(f.stat().st_size for f in self.cutouts_path.glob("*.png")) / (1024 ** 2)
            outputs_size = sum(f.stat().st_size for f in self.outputs_path.glob("*.png")) / (1024 ** 2)

            return {
                "inputs_count": len(list(self.inputs_path.glob("*"))),
                "inputs_mb": round(inputs_size, 2),
                "cutouts_count": len(self.metadata),
                "cutouts_mb": round(cutouts_size, 2),
                "outputs_count": len(list(self.outputs_path.glob("*.png"))),
                "outputs_mb": round(outputs_size, 2),
                "total_mb": round(inputs_size + cutouts_size + outputs_size, 2),
            }
        except Exception as e:
            logger.error(f"Failed to get stats: {e}")
            return {}
