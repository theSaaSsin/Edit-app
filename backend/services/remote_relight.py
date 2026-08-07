"""
Client for a remote relight endpoint (a Hugging Face ZeroGPU Space).

Relighting is the only stage of the workspace that needs a GPU. Rather than
requiring one locally, the cutout is sent to a Space that holds a GPU only for
the seconds the relight takes, and the result comes back with its alpha intact.

Everything else stays local, so this is a single optional network hop in an
otherwise offline pipeline — and `relight_or_local` falls back to the CPU
adjustment when the endpoint is unreachable or out of quota, so a workflow built
around it does not hard-fail without the network.
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Optional

from PIL import Image

logger = logging.getLogger(__name__)

LIGHT_DIRECTIONS = ("front", "side", "back", "rim", "fill", "top", "bottom")


class RemoteRelightError(RuntimeError):
    """Raised when the remote endpoint cannot serve a relight."""


class RemoteRelighter:
    """
    Calls a Gradio Space's `/relight` endpoint.

    The client is created lazily on first use so constructing this object is
    cheap and offline-safe — connecting in __init__ would make merely importing
    a workflow require the network.
    """

    def __init__(
        self,
        space_id: str,
        hf_token: Optional[str] = None,
        api_name: str = "/relight",
        timeout: int = 180,
    ):
        if not space_id or "/" not in space_id:
            raise ValueError(
                f"space_id should look like 'user/space-name', got {space_id!r}"
            )
        self.space_id = space_id
        self.api_name = api_name
        self.timeout = timeout
        # HF_TOKEN is respected so private Spaces and PRO quota work without
        # the token ever being passed on a command line.
        self.hf_token = hf_token or os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
        self._client = None

    def _connect(self):
        if self._client is not None:
            return self._client

        try:
            from gradio_client import Client
        except ImportError as e:
            raise RemoteRelightError(
                "gradio_client is not installed. Run: pip install gradio_client"
            ) from e

        try:
            self._client = Client(self.space_id, hf_token=self.hf_token, verbose=False)
        except Exception as e:
            raise RemoteRelightError(
                f"could not reach Space {self.space_id!r}: {e}. "
                "Check the name, that it is running, and that HF_TOKEN is set if it is private."
            ) from e

        logger.info("connected to %s", self.space_id)
        return self._client

    def relight(
        self,
        cutout: Image.Image,
        direction: str = "front",
        intensity: float = 1.0,
        prompt: str = "",
        steps: int = 24,
        guidance: float = 6.5,
        seed: int = 0,
    ) -> Image.Image:
        """
        Relight a cutout remotely. Raises RemoteRelightError on any failure.

        The alpha channel is reapplied locally from the source rather than
        trusted from the response, so a remote change of model or resolution
        cannot silently alter the silhouette.
        """
        if direction not in LIGHT_DIRECTIONS:
            raise ValueError(
                f"unknown direction {direction!r}, expected one of {LIGHT_DIRECTIONS}"
            )

        from gradio_client import handle_file

        client = self._connect()
        rgba = cutout.convert("RGBA")

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "cutout.png"
            rgba.save(source)

            try:
                result_path = client.predict(
                    handle_file(str(source)),
                    direction,
                    float(intensity),
                    prompt,
                    int(steps),
                    float(guidance),
                    int(seed),
                    api_name=self.api_name,
                )
            except Exception as e:
                raise RemoteRelightError(self._explain(e)) from e

            if not result_path or not Path(result_path).exists():
                raise RemoteRelightError("endpoint returned no image")

            relit = Image.open(result_path).convert("RGBA")

        if relit.size != rgba.size:
            relit = relit.resize(rgba.size, Image.Resampling.LANCZOS)
        relit.putalpha(rgba.split()[3])
        return relit

    @staticmethod
    def _explain(error: Exception) -> str:
        """Turn the endpoint's failure into something actionable."""
        text = str(error)
        lowered = text.lower()

        # Checked before the auth cases: a proxy that refuses the tunnel puts
        # "403 Forbidden" in the message, which a substring check misreads as an
        # authorisation failure and sends the user after a token needlessly.
        if type(error).__name__ in ("ProxyError", "ConnectionError", "ConnectTimeout",
                                    "ReadTimeout", "MaxRetryError", "SSLError"):
            return (f"could not reach the network. Check your connection or proxy settings "
                    f"(HTTPS_PROXY / NO_PROXY). ({text[:160]})")
        if any(k in lowered for k in ("unable to connect to proxy", "tunnel connection failed",
                                      "max retries exceeded", "connection refused",
                                      "name or service not known")):
            return (f"could not reach the network — this looks like a proxy or DNS failure, "
                    f"not an authorisation problem. ({text[:160]})")

        if "quota" in lowered:
            return (
                f"GPU quota exceeded on the Space. Wait for the window to reset, or use a "
                f"PRO account for a larger daily allowance. ({text})"
            )
        if "sleep" in lowered or "starting" in lowered or "building" in lowered:
            return (
                f"the Space is asleep or still building — open it in a browser once to wake "
                f"it, then retry. ({text})"
            )
        if "401" in text or "403" in lowered or "unauthorized" in lowered:
            return f"not authorised. Set HF_TOKEN to a token with access to this Space. ({text})"
        return f"remote relight failed: {text}"


def relight_or_local(
    cutout: Image.Image,
    space_id: Optional[str] = None,
    direction: str = "front",
    intensity: float = 1.0,
    prompt: str = "",
    **kwargs,
) -> tuple[Image.Image, str]:
    """
    Relight remotely when a Space is configured, otherwise adjust locally.

    Returns (image, backend) where backend is "remote" or "local", so callers
    can tell the user which one actually ran rather than presenting a CPU
    brightness adjustment as a neural relight.
    """
    space_id = space_id or os.environ.get("RELIGHT_SPACE")

    if space_id:
        try:
            relit = RemoteRelighter(space_id).relight(
                cutout, direction=direction, intensity=intensity, prompt=prompt, **kwargs
            )
            return relit, "remote"
        except (RemoteRelightError, ValueError) as e:
            logger.warning("falling back to local: %s", e)

    from backend.pipeline.edge_fx import _to_arrays, _to_image
    from PIL import ImageEnhance

    rgb, alpha = _to_arrays(cutout.convert("RGBA"))
    adjusted = ImageEnhance.Brightness(Image.fromarray(rgb, "RGB")).enhance(intensity)
    adjusted = ImageEnhance.Contrast(adjusted).enhance(1.0 + (intensity - 1.0) * 0.3)

    import numpy as np
    return _to_image(np.array(adjusted), alpha), "local"
