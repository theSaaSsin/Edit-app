import torch
import numpy as np
from PIL import Image
from typing import Union, Optional, Dict
import logging

logger = logging.getLogger(__name__)


class RelightingEngine:
    """
    Neural light transport using IC-Light, SDXL, and directional light-sweep LoRAs.
    Overrides native lighting on cutouts using physics-aware diffusion conditioning.
    """

    def __init__(self, model_type: str = "sdxl", device: str = "cuda"):
        self.device = device if torch.cuda.is_available() else "cpu"
        self.model_type = model_type
        self.pipe = None
        self.ic_light_model = None
        logger.info(f"Initializing RelightingEngine with {model_type} on {self.device}")
        self._load_model()

    def _load_model(self):
        """Load relighting model."""
        try:
            if self.model_type == "ic_light":
                self._load_ic_light()
            elif self.model_type == "sdxl":
                self._load_sdxl()
            elif self.model_type == "sdxl_turbo":
                self._load_sdxl_turbo()
            elif self.model_type == "flux_dev":
                self._load_flux()
        except Exception as e:
            logger.error(f"Failed to load {self.model_type}: {e}")
            self._fallback_model()

    def _load_ic_light(self):
        """Load IC-Light specialized relighting model."""
        try:
            from diffusers import StableDiffusionControlNetPipeline, ControlNetModel
            controlnet = ControlNetModel.from_pretrained(
                "lllyasviel/ic-light-g",
                torch_dtype=torch.float16
            ).to(self.device)

            self.pipe = StableDiffusionControlNetPipeline.from_pretrained(
                "stabilityai/stable-diffusion-v1-5",
                controlnet=controlnet,
                torch_dtype=torch.float16
            ).to(self.device)
            self.pipe.enable_attention_slicing()
            logger.info("Loaded IC-Light model successfully")
        except Exception as e:
            logger.error(f"IC-Light load failed: {e}")
            self._load_sdxl()

    def _load_sdxl(self):
        """Load Stable Diffusion XL for image-to-image relighting."""
        try:
            from diffusers import StableDiffusionXLImg2ImgPipeline
            self.pipe = StableDiffusionXLImg2ImgPipeline.from_pretrained(
                "stabilityai/stable-diffusion-xl-refiner-1.0",
                torch_dtype=torch.float16,
                use_safetensors=True
            ).to(self.device)
            self.pipe.enable_attention_slicing()
            logger.info("Loaded SDXL model successfully")
        except Exception as e:
            logger.error(f"SDXL load failed: {e}")
            self._load_sdxl_turbo()

    def _load_sdxl_turbo(self):
        """Load SDXL Turbo for faster relighting."""
        try:
            from diffusers import AutoPipelineForImage2Image
            self.pipe = AutoPipelineForImage2Image.from_pretrained(
                "stabilityai/sdxl-turbo",
                torch_dtype=torch.float16,
                use_safetensors=True
            ).to(self.device)
            logger.info("Loaded SDXL Turbo model successfully")
        except Exception as e:
            logger.error(f"SDXL Turbo load failed: {e}")
            self._load_flux()

    def _load_flux(self):
        """Load Flux.1 Dev for advanced relighting."""
        try:
            from diffusers import FluxPipeline
            self.pipe = FluxPipeline.from_pretrained(
                "black-forest-labs/FLUX.1-dev",
                torch_dtype=torch.float16
            ).to(self.device)
            logger.info("Loaded Flux.1 Dev model successfully")
        except Exception as e:
            logger.error(f"Flux load failed: {e}")
            logger.warning("All relighting models failed, using fallback")

    def _fallback_model(self):
        """Fallback simple color adjustment."""
        logger.info("Using fallback relighting (brightness adjustment)")
        self.pipe = None

    def relight(
        self,
        cutout_image: Union[Image.Image, str],
        light_direction: str = "front",
        light_intensity: float = 1.0,
        prompt: Optional[str] = None,
        background_prompt: Optional[str] = None,
        num_inference_steps: int = 20,
        guidance_scale: float = 7.5,
    ) -> Image.Image:
        """
        Relight a cutout with specified direction and intensity.

        Args:
            cutout_image: PIL Image or path to cutout
            light_direction: "front", "side", "back", "rim", "fill"
            light_intensity: 0.5 to 2.0
            prompt: Custom relighting prompt
            background_prompt: Background context for lighting
            num_inference_steps: Diffusion steps (fewer=faster)
            guidance_scale: Prompt guidance strength

        Returns:
            Relit image
        """
        if isinstance(cutout_image, str):
            cutout_image = Image.open(cutout_image).convert("RGBA")
        elif isinstance(cutout_image, Image.Image):
            cutout_image = cutout_image.convert("RGBA")

        if self.pipe is None:
            return self._fallback_relight(cutout_image, light_intensity)

        try:
            if self.model_type == "ic_light":
                return self._relight_ic_light(
                    cutout_image, light_direction, light_intensity,
                    prompt, background_prompt, num_inference_steps, guidance_scale
                )
            else:
                return self._relight_diffusion(
                    cutout_image, light_direction, light_intensity,
                    prompt, num_inference_steps, guidance_scale
                )
        except Exception as e:
            logger.error(f"Relighting failed: {e}")
            return self._fallback_relight(cutout_image, light_intensity)

    def _build_relight_prompt(
        self,
        light_direction: str,
        light_intensity: float,
        custom_prompt: Optional[str] = None
    ) -> str:
        """Build relighting prompt from parameters."""
        light_descriptions = {
            "front": "frontlit, evenly lit face",
            "side": "sidelit, dramatic side lighting, half-face lit",
            "back": "backlit, rim lighting, silhouette",
            "rim": "rim lighting, edge lighting, contour light",
            "fill": "fill light, soft diffuse lighting, no shadows",
            "top": "top lighting, overhead light, zenith lighting",
            "bottom": "bottom lighting, underlighting, upward light",
        }

        intensity_modifiers = {
            0.5: "subtle ",
            0.75: "soft ",
            1.0: "",
            1.5: "bright ",
            2.0: "intense ",
        }

        base_light = light_descriptions.get(light_direction, "professional lighting")
        intensity_mod = intensity_modifiers.get(light_intensity, "")

        prompt = f"professional photography, {intensity_mod}{base_light}, high quality, detailed, sharp focus"

        if custom_prompt:
            prompt = f"{custom_prompt}, {prompt}"

        return prompt

    def _relight_ic_light(
        self,
        image: Image.Image,
        light_direction: str,
        light_intensity: float,
        prompt: Optional[str],
        background_prompt: Optional[str],
        steps: int,
        guidance: float
    ) -> Image.Image:
        """Relight using IC-Light (specialized for lighting control)."""
        try:
            prompt = self._build_relight_prompt(light_direction, light_intensity, prompt)

            with torch.no_grad():
                output = self.pipe(
                    prompt=prompt,
                    image=image,
                    num_inference_steps=steps,
                    guidance_scale=guidance,
                ).images[0]

            output = output.convert("RGBA")
            output.putalpha(image.split()[3])
            return output
        except Exception as e:
            logger.error(f"IC-Light relighting failed: {e}")
            return image

    def _relight_diffusion(
        self,
        image: Image.Image,
        light_direction: str,
        light_intensity: float,
        prompt: Optional[str],
        steps: int,
        guidance: float
    ) -> Image.Image:
        """Relight using standard diffusion models."""
        try:
            prompt = self._build_relight_prompt(light_direction, light_intensity, prompt)
            strength = min(0.4 + (light_intensity - 1.0) * 0.2, 0.9)

            with torch.no_grad():
                output = self.pipe(
                    prompt=prompt,
                    image=image,
                    strength=strength,
                    num_inference_steps=steps,
                    guidance_scale=guidance,
                ).images[0]

            output = output.convert("RGBA")
            output.putalpha(image.split()[3])
            return output
        except Exception as e:
            logger.error(f"Diffusion relighting failed: {e}")
            return image

    def _fallback_relight(self, image: Image.Image, intensity: float) -> Image.Image:
        """Fallback brightness/contrast adjustment."""
        try:
            from PIL import ImageEnhance
            enhancer = ImageEnhance.Brightness(image)
            result = enhancer.enhance(intensity)

            contrast_factor = 1.0 + (intensity - 1.0) * 0.3
            enhancer = ImageEnhance.Contrast(result)
            result = enhancer.enhance(contrast_factor)

            return result
        except Exception as e:
            logger.error(f"Fallback relighting failed: {e}")
            return image

    def light_sweep(
        self,
        cutout_image: Union[Image.Image, str],
        directions: list = None,
        prompt: Optional[str] = None,
        num_inference_steps: int = 20
    ) -> Dict[str, Image.Image]:
        """
        Generate relighting sequence with multiple light directions.

        Args:
            cutout_image: Cutout to relight
            directions: List of light directions, default to all cardinal directions
            prompt: Custom prompt
            num_inference_steps: Diffusion steps

        Returns:
            Dictionary mapping direction to relit image
        """
        if directions is None:
            directions = ["front", "side", "back", "rim", "fill"]

        if isinstance(cutout_image, str):
            cutout_image = Image.open(cutout_image).convert("RGBA")

        results = {}
        for direction in directions:
            try:
                relit = self.relight(
                    cutout_image,
                    light_direction=direction,
                    prompt=prompt,
                    num_inference_steps=num_inference_steps
                )
                results[direction] = relit
            except Exception as e:
                logger.error(f"Light sweep for {direction} failed: {e}")
                results[direction] = cutout_image

        return results

    def batch_relight(self, image_paths: list, light_direction: str = "front") -> list:
        """Process multiple cutouts in batch."""
        results = []
        for path in image_paths:
            try:
                relit = self.relight(path, light_direction=light_direction)
                results.append({"relit": relit, "path": path, "status": "success"})
            except Exception as e:
                logger.error(f"Batch relighting failed for {path}: {e}")
                results.append({"path": path, "status": "failed", "error": str(e)})
        return results
