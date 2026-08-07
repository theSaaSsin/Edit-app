"""
Relight endpoint for Hugging Face ZeroGPU.

This is the one stage of the workspace that genuinely needs a GPU. Everything
else — selection, edge materials, tiled compositing — runs locally on CPU, so
only the cutout travels here and only for the few seconds a relight takes.

ZeroGPU allocates hardware per decorated call rather than holding a GPU for the
life of the Space, which is why CUDA work must happen inside a @spaces.GPU
function. Loading the pipeline at import time keeps cold starts down; the move
to CUDA happens on first call, once hardware actually exists.

Deploy:
    huggingface-cli repo create relight-endpoint --type space --space_sdk gradio
    # set the Space hardware to ZeroGPU in its settings, then push this folder
"""

from __future__ import annotations

import logging
import os

import gradio as gr
import numpy as np
import spaces
import torch
from PIL import Image

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MODEL_ID = os.environ.get("RELIGHT_MODEL", "stabilityai/stable-diffusion-xl-refiner-1.0")
MAX_SIDE = 1024

LIGHT_PROMPTS = {
    "front": "evenly lit from the front, soft frontal key light",
    "side": "dramatic side lighting, strong key from one side, deep falloff",
    "back": "backlit, bright rim separating subject from background",
    "rim": "rim lighting, glowing contour edge light",
    "fill": "soft diffuse fill light, shadowless, overcast",
    "top": "overhead lighting from above, downward shadows",
    "bottom": "lit from below, upward shadows, uplighting",
}

NEGATIVE = "blurry, low quality, distorted, deformed, watermark, text, oversaturated"

_pipe = None


def _load_pipeline():
    """Load once at import; the CUDA move is deferred to the first GPU call."""
    global _pipe
    if _pipe is not None:
        return _pipe

    from diffusers import StableDiffusionXLImg2ImgPipeline

    logger.info("loading %s", MODEL_ID)
    _pipe = StableDiffusionXLImg2ImgPipeline.from_pretrained(
        MODEL_ID, torch_dtype=torch.float16, use_safetensors=True, variant="fp16"
    )
    _pipe.set_progress_bar_config(disable=True)
    return _pipe


def _fit(image: Image.Image, max_side: int = MAX_SIDE) -> Image.Image:
    """
    Downscale to the diffusion working size, on a multiple of 8.

    SDXL needs dimensions divisible by 8; feeding it arbitrary sizes either
    errors or silently resamples and returns something misaligned with the
    caller's alpha channel.
    """
    scale = min(1.0, max_side / max(image.size))
    width = max(8, int(image.width * scale) // 8 * 8)
    height = max(8, int(image.height * scale) // 8 * 8)
    if (width, height) == image.size:
        return image
    return image.resize((width, height), Image.Resampling.LANCZOS)


def build_prompt(direction: str, intensity: float, extra: str = "") -> str:
    lighting = LIGHT_PROMPTS.get(direction, LIGHT_PROMPTS["front"])
    strength = "subtle " if intensity < 0.8 else "intense " if intensity > 1.3 else ""
    parts = [p for p in (extra.strip(), f"{strength}{lighting}",
                         "professional photograph, natural light falloff, sharp focus") if p]
    return ", ".join(parts)


@spaces.GPU(duration=90)
def relight(
    image: Image.Image,
    direction: str = "front",
    intensity: float = 1.0,
    prompt: str = "",
    steps: int = 24,
    guidance: float = 6.5,
    seed: int = 0,
) -> Image.Image:
    """
    Relight an RGBA cutout, preserving its alpha channel.

    Diffusion runs on RGB only. The alpha is carried around it and reapplied at
    the end at the original resolution, so the silhouette the caller cut is the
    silhouette that comes back — any edge material applied locally survives the
    round trip intact.
    """
    if image is None:
        raise gr.Error("No image supplied.")

    original_size = image.size
    rgba = image.convert("RGBA")
    alpha = rgba.split()[3]

    # Composite onto mid grey. Relighting against black makes the model treat
    # the surround as shadow and darken the subject's edges to match.
    backdrop = Image.new("RGB", rgba.size, (127, 127, 127))
    backdrop.paste(rgba, (0, 0), rgba)
    working = _fit(backdrop)

    pipe = _load_pipeline()
    pipe.to("cuda")

    strength = float(np.clip(0.25 + (intensity - 1.0) * 0.18, 0.15, 0.75))
    generator = torch.Generator(device="cuda").manual_seed(int(seed)) if seed else None

    logger.info("relight direction=%s intensity=%.2f strength=%.2f", direction, intensity, strength)
    result = pipe(
        prompt=build_prompt(direction, intensity, prompt),
        negative_prompt=NEGATIVE,
        image=working,
        strength=strength,
        num_inference_steps=int(steps),
        guidance_scale=float(guidance),
        generator=generator,
    ).images[0]

    result = result.resize(original_size, Image.Resampling.LANCZOS).convert("RGBA")
    result.putalpha(alpha)
    return result


with gr.Blocks(title="Relight endpoint") as demo:
    gr.Markdown(
        "# Relight endpoint\n"
        "Neural relighting for RGBA cutouts. Alpha is preserved, so edge materials "
        "applied locally survive the round trip.\n\n"
        "Called from the Edit-app studio via `backend.services.remote_relight`, "
        "or used directly below."
    )
    with gr.Row():
        with gr.Column():
            image_in = gr.Image(label="Cutout (RGBA)", type="pil", image_mode="RGBA")
            direction_in = gr.Dropdown(
                list(LIGHT_PROMPTS), value="front", label="Light direction"
            )
            intensity_in = gr.Slider(0.5, 2.0, 1.0, step=0.05, label="Intensity")
            prompt_in = gr.Textbox(label="Extra prompt", placeholder="golden hour, warm tungsten…")
            with gr.Accordion("Advanced", open=False):
                steps_in = gr.Slider(8, 50, 24, step=1, label="Steps")
                guidance_in = gr.Slider(1.0, 12.0, 6.5, step=0.1, label="Guidance")
                seed_in = gr.Number(value=0, label="Seed (0 = random)", precision=0)
            run = gr.Button("Relight", variant="primary")
        image_out = gr.Image(label="Relit", type="pil", image_mode="RGBA", format="png")

    run.click(
        relight,
        inputs=[image_in, direction_in, intensity_in, prompt_in, steps_in, guidance_in, seed_in],
        outputs=image_out,
        api_name="relight",
    )

if __name__ == "__main__":
    demo.queue(max_size=20).launch()
