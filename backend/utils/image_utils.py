import numpy as np
from PIL import Image
from typing import Tuple, Union


def resize_image(image: Image.Image, size: Tuple[int, int], preserve_aspect: bool = True) -> Image.Image:
    """
    Resize image to specified size.

    Args:
        image: PIL Image
        size: (width, height) tuple
        preserve_aspect: If True, maintain aspect ratio and pad with transparency

    Returns:
        Resized image
    """
    if not preserve_aspect:
        return image.resize(size, Image.Resampling.LANCZOS)

    original_w, original_h = image.size
    target_w, target_h = size

    aspect = original_w / original_h
    target_aspect = target_w / target_h

    if aspect > target_aspect:
        new_w = target_w
        new_h = int(target_w / aspect)
    else:
        new_h = target_h
        new_w = int(target_h * aspect)

    resized = image.resize((new_w, new_h), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    offset_x = (target_w - new_w) // 2
    offset_y = (target_h - new_h) // 2
    canvas.paste(resized, (offset_x, offset_y), resized)

    return canvas


def normalize_image(image: Image.Image) -> np.ndarray:
    """
    Convert PIL Image to normalized numpy array (0-1 range).

    Args:
        image: PIL Image

    Returns:
        Normalized numpy array
    """
    array = np.array(image, dtype=np.float32)
    return array / 255.0


def convert_to_grayscale(image: Image.Image) -> Image.Image:
    """Convert image to grayscale."""
    return image.convert("L")


def ensure_image_format(image: Union[Image.Image, str], mode: str = "RGBA") -> Image.Image:
    """
    Ensure image is in correct format.

    Args:
        image: PIL Image or file path
        mode: Target image mode (RGBA, RGB, L, etc.)

    Returns:
        Image in target mode
    """
    if isinstance(image, str):
        image = Image.open(image)

    if image.mode != mode:
        image = image.convert(mode)

    return image
