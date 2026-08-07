---
title: Relight Endpoint
emoji: 💡
colorFrom: indigo
colorTo: purple
sdk: gradio
sdk_version: 4.44.0
app_file: app.py
pinned: false
short_description: Neural relighting for RGBA cutouts, alpha preserved
---

# Relight endpoint

The GPU stage of the [Edit-app](https://github.com/theSaaSsin/Edit-app) collage
workspace. Selection, edge materials and compositing run locally on CPU; only
the relight needs a GPU, so only the cutout comes here.

Alpha is carried around the diffusion pass and reapplied at original
resolution, so a torn-paper or burnt edge applied locally survives the round
trip unchanged.

## Hardware

Set the Space hardware to **ZeroGPU** in settings. Each call is allocated an
H200 slice for the duration of the decorated function (90s ceiling here; a
relight typically takes 5-10s).

## Calling it from the studio

```bash
pip install gradio_client
export HF_TOKEN=hf_...
python -m backend.cli relight cutout.png relit.png --space <user>/relight-endpoint --direction side
```
