"""
Client for image-editing Spaces (Qwen-Image-Edit, inpainting, upscalers…).

Any Gradio Space exposes a documented HTTP API, so a CPU-only laptop can hand
off the GPU stage and get the result back. Unlike `remote_relight`, which talks
to a Space we wrote and whose signature we control, this targets *other
people's* Spaces — so it introspects rather than assumes.

That introspection is the whole point. Every image-edit Space orders its inputs
differently: some take (image, prompt), others (prompt, image, seed, steps,
guidance, …). Hardcoding a positional call per Space breaks the moment its
author adds a slider. `view_api()` reports the live signature, and arguments are
matched to it by name and type at call time.

Only Spaces with a public API are reachable this way. Services without one —
Perchance among them — are not, and driving their web UI programmatically would
both breach their terms and consume compute their ads are paying for.
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from PIL import Image

logger = logging.getLogger(__name__)


class RemoteEditError(RuntimeError):
    """Raised when a remote edit cannot be performed."""


#: Spaces known to expose an image-edit API, newest first. These are other
#: people's Spaces: they can be renamed, gated, or taken down at any time, so
#: they are a starting point to probe rather than a guarantee.
KNOWN_EDIT_SPACES = [
    "Qwen/Qwen-Image-Edit-2511",
    "Qwen/Qwen-Image-Edit-2509",
    "Qwen/Qwen-Image-Edit",
    "linoyts/Qwen-Image-Edit-2511-Fast",
    "multimodalart/Qwen-Image-Edit-Fast",
]

_IMAGE_HINTS = ("image", "img", "photo", "input_image", "source")
_PROMPT_HINTS = ("prompt", "instruction", "text", "edit")
_NEGATIVE_HINTS = ("negative", "neg_prompt")
_SEED_HINTS = ("seed",)
_STEPS_HINTS = ("steps", "num_inference", "inference_steps")
_GUIDANCE_HINTS = ("guidance", "cfg", "true_cfg")


class RemoteImageEditor:
    """
    Calls an image-edit Space, adapting to whatever signature it declares.

    Construction is cheap and offline-safe; the connection and API
    introspection happen on first use.
    """

    def __init__(
        self,
        space_id: str,
        hf_token: Optional[str] = None,
        api_name: Optional[str] = None,
    ):
        if not space_id or "/" not in space_id:
            raise ValueError(f"space_id should look like 'user/space-name', got {space_id!r}")
        self.space_id = space_id
        self.hf_token = hf_token or os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
        self.api_name = api_name
        self._client = None
        self._endpoints: Optional[Dict[str, List[dict]]] = None

    # ---- connection ----------------------------------------------------

    def _connect(self):
        if self._client is not None:
            return self._client
        try:
            from gradio_client import Client
        except ImportError as e:
            raise RemoteEditError("gradio_client is not installed. Run: pip install gradio_client") from e

        try:
            self._client = Client(self.space_id, hf_token=self.hf_token, verbose=False)
        except Exception as e:
            raise RemoteEditError(self._explain(e)) from e
        return self._client

    def endpoints(self) -> Dict[str, List[dict]]:
        """Named endpoints and their parameters, as the Space declares them."""
        if self._endpoints is not None:
            return self._endpoints

        client = self._connect()
        try:
            info = client.view_api(return_format="dict", print_info=False)
        except Exception as e:
            raise RemoteEditError(f"could not read the API of {self.space_id}: {e}") from e

        named = (info or {}).get("named_endpoints", {}) or {}
        self._endpoints = {
            name: spec.get("parameters", []) for name, spec in named.items()
        }
        return self._endpoints

    def pick_endpoint(self) -> str:
        """
        Choose the endpoint that actually performs an edit.

        Preference goes to one taking both an image and a text prompt; a Space
        often also exposes helpers (example loaders, LoRA switches) that would
        otherwise be picked by position.
        """
        if self.api_name:
            return self.api_name

        endpoints = self.endpoints()
        if not endpoints:
            raise RemoteEditError(f"{self.space_id} declares no named API endpoints")

        best, best_score = None, -1
        for name, params in endpoints.items():
            labels = " ".join(
                str(p.get("parameter_name") or p.get("label") or "").lower() for p in params
            )
            types = " ".join(str(p.get("component", "")).lower() for p in params)

            score = 0
            if "image" in types:
                score += 3
            if any(h in labels for h in _PROMPT_HINTS):
                score += 2
            if any(k in name.lower() for k in ("infer", "predict", "edit", "generate", "run")):
                score += 2
            if score > best_score:
                best, best_score = name, score

        if best is None or best_score <= 0:
            raise RemoteEditError(
                f"could not identify an edit endpoint on {self.space_id}; "
                f"pass api_name explicitly. Available: {list(endpoints)}"
            )
        logger.info("using endpoint %s on %s", best, self.space_id)
        return best

    # ---- calling -------------------------------------------------------

    @staticmethod
    def _matches(label: str, hints) -> bool:
        return any(h in label for h in hints)

    def _build_arguments(
        self,
        params: List[dict],
        image_path: str,
        prompt: str,
        negative_prompt: str,
        seed: Optional[int],
        steps: Optional[int],
        guidance: Optional[float],
    ) -> list:
        """
        Fill the endpoint's parameters positionally, matching by name and type.

        Anything unrecognised keeps the Space's own default, so a Space with
        extra controls still works without this client knowing about them.
        """
        from gradio_client import handle_file

        args = []
        image_used = False

        for param in params:
            label = str(param.get("parameter_name") or param.get("label") or "").lower()
            component = str(param.get("component", "")).lower()
            default = param.get("parameter_default")

            if component == "image" and not image_used:
                args.append(handle_file(image_path))
                image_used = True
            elif self._matches(label, _NEGATIVE_HINTS):
                args.append(negative_prompt)
            elif component in ("textbox", "text") and self._matches(label, _PROMPT_HINTS):
                args.append(prompt)
            elif self._matches(label, _SEED_HINTS) and seed is not None:
                args.append(seed)
            elif self._matches(label, _STEPS_HINTS) and steps is not None:
                args.append(steps)
            elif self._matches(label, _GUIDANCE_HINTS) and guidance is not None:
                args.append(guidance)
            elif component in ("textbox", "text") and not args:
                # A leading textbox with an unhelpful label is nearly always the prompt.
                args.append(prompt)
            else:
                args.append(default)

        if not image_used:
            raise RemoteEditError(
                f"{self.space_id} exposes no image input on this endpoint; "
                "it may be text-to-image rather than image-to-image"
            )
        return args

    def edit(
        self,
        image: Image.Image,
        prompt: str,
        negative_prompt: str = "",
        seed: Optional[int] = 0,
        steps: Optional[int] = None,
        guidance: Optional[float] = None,
        preserve_alpha: bool = True,
    ) -> Image.Image:
        """
        Send `image` with an edit instruction and return the result.

        With `preserve_alpha`, the source alpha is reapplied to the response —
        an edit model returns opaque RGB, which would otherwise silently discard
        a cutout's silhouette and any edge material already applied.
        """
        if not prompt or not prompt.strip():
            raise ValueError("prompt must not be empty")

        client = self._connect()
        endpoint = self.pick_endpoint()
        params = self.endpoints()[endpoint]

        rgba = image.convert("RGBA")

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "input.png"
            # Edit models read RGB; a transparent surround would be read as
            # black, so the cutout is flattened onto white for the round trip.
            flat = Image.new("RGB", rgba.size, (255, 255, 255))
            flat.paste(rgba, (0, 0), rgba)
            flat.save(source)

            args = self._build_arguments(
                params, str(source), prompt, negative_prompt, seed, steps, guidance
            )

            try:
                result = client.predict(*args, api_name=endpoint)
            except Exception as e:
                raise RemoteEditError(self._explain(e)) from e

        path = self._extract_image_path(result)
        if not path:
            raise RemoteEditError(f"{self.space_id} returned no image (got {type(result).__name__})")

        edited = Image.open(path).convert("RGBA")

        if preserve_alpha:
            if edited.size != rgba.size:
                edited = edited.resize(rgba.size, Image.Resampling.LANCZOS)
            edited.putalpha(rgba.split()[3])
        return edited

    @staticmethod
    def _extract_image_path(result: Any) -> Optional[str]:
        """Find the image path in a response, which Spaces shape inconsistently."""
        def valid(candidate) -> Optional[str]:
            if isinstance(candidate, str) and Path(candidate).exists():
                return candidate
            if isinstance(candidate, dict):
                for key in ("path", "image", "value", "url"):
                    found = valid(candidate.get(key))
                    if found:
                        return found
            return None

        direct = valid(result)
        if direct:
            return direct
        if isinstance(result, (list, tuple)):
            for item in result:
                found = valid(item)
                if found:
                    return found
        return None

    @staticmethod
    def _explain(error: Exception) -> str:
        text = str(error)
        lowered = text.lower()

        # Connection failures are checked first and by exception type. A proxy
        # that refuses the tunnel reports "403 Forbidden" inside the message,
        # which a substring check reads as an auth problem and sends the user
        # hunting for a token that was never the issue.
        if type(error).__name__ in ("ProxyError", "ConnectionError", "ConnectTimeout",
                                    "ReadTimeout", "MaxRetryError", "SSLError"):
            return (
                f"could not reach the network. Check your connection or proxy settings "
                f"(HTTPS_PROXY / NO_PROXY). ({text[:160]})"
            )
        if any(k in lowered for k in ("unable to connect to proxy", "tunnel connection failed",
                                      "max retries exceeded", "connection refused",
                                      "name or service not known", "temporary failure in name resolution")):
            return (
                f"could not reach the network — this looks like a proxy or DNS failure, "
                f"not an authorisation problem. ({text[:160]})"
            )

        if "quota" in lowered:
            return f"GPU quota exceeded on this Space; wait for the reset or use a PRO token. ({text})"
        if any(k in lowered for k in ("sleep", "starting", "building")):
            return f"the Space is asleep or building — open it in a browser once, then retry. ({text})"
        if "401" in text or "403" in lowered or "unauthorized" in lowered or "gated" in lowered:
            return f"not authorised; set HF_TOKEN to a token with access. ({text})"
        if "404" in text or "not found" in lowered:
            return f"Space not found — it may have been renamed or removed. ({text})"
        return f"remote edit failed: {text}"


def probe_spaces(space_ids: Optional[List[str]] = None, hf_token: Optional[str] = None) -> List[dict]:
    """
    Check which Spaces are reachable and expose a usable edit endpoint.

    Other people's Spaces come and go, so this reports live state rather than
    trusting the built-in list.
    """
    results = []
    for space_id in (space_ids or KNOWN_EDIT_SPACES):
        entry = {"space": space_id, "reachable": False, "endpoint": None, "error": None}
        try:
            editor = RemoteImageEditor(space_id, hf_token=hf_token)
            entry["endpoint"] = editor.pick_endpoint()
            entry["parameters"] = [
                str(p.get("parameter_name") or p.get("label") or "?")
                for p in editor.endpoints()[entry["endpoint"]]
            ]
            entry["reachable"] = True
        except Exception as e:
            entry["error"] = str(e)[:160]
        results.append(entry)
    return results
