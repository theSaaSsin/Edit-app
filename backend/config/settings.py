import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = BASE_DIR / "backend"
MODELS_DIR = BACKEND_DIR / "models"
ASSETS_DIR = BASE_DIR / "assets"

ASSETS_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

(ASSETS_DIR / "inputs").mkdir(parents=True, exist_ok=True)
(ASSETS_DIR / "cutouts").mkdir(parents=True, exist_ok=True)
(ASSETS_DIR / "outputs").mkdir(parents=True, exist_ok=True)

class Config:
    DEBUG = os.getenv("DEBUG", "False") == "True"
    HOST = os.getenv("HOST", "0.0.0.0")
    PORT = int(os.getenv("PORT", 8000))
    RELOAD = os.getenv("RELOAD", "True") == "True"

    MODELS_PATH = str(MODELS_DIR)
    ASSETS_PATH = str(ASSETS_DIR)
    INPUTS_PATH = str(ASSETS_DIR / "inputs")
    CUTOUTS_PATH = str(ASSETS_DIR / "cutouts")
    OUTPUTS_PATH = str(ASSETS_DIR / "outputs")

    DEVICE = os.getenv("DEVICE", "cuda")

    MAX_BATCH_SIZE = 8
    MAX_IMAGE_SIZE = 4096

    SEGMENTATION_MODELS = {
        "sam2": "facebook/sam2-hiera-large",
        "birefnet": "ZhengPeng7/BiRefNet",
        "rembg": "u2net",
    }

    DEPTH_MODELS = {
        "depth_anything_v2": "depth-anything/Depth-Anything-V2-Large-hf",
        "zoedepth": "isl-org/ZoeDepth",
        "marigold": "prs-eth/marigold-lcm-v1-0",
    }

    RELIGHTING_MODELS = {
        "sdxl": "stabilityai/stable-diffusion-xl-base-1.0",
        "sdxl_turbo": "stabilityai/sdxl-turbo",
        "ic_light": "lllyasviel/ic-light-g",
        "flux_dev": "black-forest-labs/FLUX.1-dev",
    }

    PIPELINE_ORDER = [
        "segmentation",
        "depth_estimation",
        "relighting",
        "compositing"
    ]
