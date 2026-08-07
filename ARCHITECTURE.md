# Image Edit Workspace — Architecture & Implementation

## Overview

A professional, modular image processing pipeline combining semantic segmentation, depth estimation, neural relighting, and compositing into a unified workspace. Built entirely on open-source tools with zero cloud dependencies.

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Frontend (Browser)                         │
│         (index.html, app.js, styles.css)                   │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTP/REST
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              FastAPI Backend (main.py)                      │
│  ├─ /cutout       - Semantic segmentation                  │
│  ├─ /depth        - Depth estimation                       │
│  ├─ /relight      - Neural relighting                      │
│  ├─ /composite    - Layer compositing                      │
│  ├─ /pipeline     - Full end-to-end workflow               │
│  └─ /assets       - Asset management endpoints             │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   ┌─────────┐  ┌──────────┐  ┌─────────┐
   │Workflow │  │  Asset   │  │Utilities│
   │ Orches  │  │ Manager  │  │ (image, │
   │ trator  │  │          │  │  file)  │
   └────┬────┘  └──────────┘  └─────────┘
        │
   ┌────┴──────────────────────────────┐
   │                                    │
   ▼                                    ▼
┌──────────────────┐          ┌──────────────────┐
│ PIPELINE MODULES │          │  FILE SYSTEM     │
├──────────────────┤          ├──────────────────┤
│ Segmenter        │          │ inputs/          │
│ ├─ Rembg         │          │ cutouts/         │
│ ├─ BiRefNet      │          │ outputs/         │
│ └─ SAM 2         │          │ metadata.json    │
│                  │          └──────────────────┘
│ Depth Engine     │
│ ├─ Depth Anything│
│ ├─ ZoeDepth      │
│ └─ Marigold      │
│                  │
│ Relighter        │
│ ├─ IC-Light      │
│ ├─ SDXL          │
│ ├─ SDXL Turbo    │
│ └─ Flux.1 Dev    │
│                  │
│ Compositor       │
│ ├─ Layer blend   │
│ ├─ Shadows       │
│ └─ Color grade   │
└──────────────────┘
```

## Module Structure

```
backend/
├── config/
│   └── settings.py          # Configuration, model paths, device settings
├── pipeline/
│   ├── __init__.py
│   ├── segmenter.py         # Background removal (SAM 2, BiRefNet, Rembg)
│   ├── depth_engine.py      # Depth estimation (Depth Anything V2, ZoeDepth, Marigold)
│   ├── relighter.py         # Neural relighting (IC-Light, SDXL, Flux)
│   └── compositor.py        # Layer compositing, shadows, color grading
├── services/
│   ├── __init__.py
│   ├── workflow.py          # Orchestrates pipeline stages
│   └── asset_manager.py     # File I/O, metadata, library management
├── utils/
│   ├── __init__.py
│   ├── image_utils.py       # Image manipulation helpers
│   └── file_utils.py        # File system helpers
├── main.py                  # FastAPI application
└── requirements.txt         # Python dependencies
```

## Pipeline Stages

### Stage 1: Segmentation (Semantic Isolation)

**Purpose:** Extract edge-perfect alpha masks for foreground subjects.

**Models:**
- **Rembg** (U2Net): Fast, lightweight, great for general subjects
- **BiRefNet**: Specialized for detailed boundaries (hair, glass, fabric)
- **SAM 2**: Interactive zero-shot segmentation with point prompts

**Endpoint:**
```bash
POST /cutout
Content-Type: multipart/form-data
file: <image>
model: "rembg" | "birefnet" | "sam2"

Response: { "status": "success", "cutout_id": "cutout_abc123" }
```

### Stage 2: Depth Estimation (Spatial Geometry Mapping)

**Purpose:** Generate depth maps for realistic shadow and occlusion rendering.

**Models:**
- **Depth Anything V2**: High-fidelity monocular depth, real-time capable
- **ZoeDepth**: Affine-invariant depth for fine structural details
- **Marigold**: Physics-aware depth with LCM optimization

**Features:**
- Normalized depth maps (0-1)
- Surface normal computation
- Ambient occlusion approximation

**Endpoint:**
```bash
POST /depth
Content-Type: multipart/form-data
file: <image>
model: "depth_anything_v2" | "zoedepth" | "marigold"

Response: { "status": "success", "depth": <map>, "normals": <map> }
```

### Stage 3: Relighting (Neural Light Transport)

**Purpose:** Override native lighting using physics-aware diffusion conditioning.

**Models:**
- **IC-Light**: Specialized directional lighting control
- **SDXL**: Stable Diffusion XL for versatile relighting
- **SDXL Turbo**: Faster alternative with fewer diffusion steps
- **Flux.1 Dev**: High-quality advanced relighting

**Light Directions:**
- `front`, `side`, `back`, `rim`, `fill`, `top`, `bottom`

**Endpoint:**
```bash
POST /relight
Content-Type: multipart/form-data
file: <cutout>
light_direction: "front"
light_intensity: 1.0
model: "sdxl" | "ic_light" | "flux_dev"
prompt: <optional custom prompt>

Response: { "status": "success", "file_path": "..." }
```

### Stage 4: Compositing (Final Assembly)

**Purpose:** Layer cutouts into scene with shadows, blending, and color grading.

**Features:**
- Multiple blend modes (normal, multiply, screen, overlay)
- Realistic drop shadows with light direction
- Color grading (warm, cool, vintage, cinematic, high-contrast)
- Non-destructive layer management

**Endpoint:**
```bash
POST /composite
Content-Type: multipart/form-data
background: <image>
cutout_ids: ["cutout_abc", "cutout_xyz"]
positions: [[50, 50], [200, 100]]
cast_shadows: true
color_grade: "cinematic"

Response: { "status": "success", "file_path": "..." }
```

## Full Pipeline Workflow

Execute complete cutout → depth → relight → composite in one call:

```bash
POST /pipeline
Content-Type: multipart/form-data
image: <foreground subject>
background: <scene image>
light_direction: "side"
color_grade: "cinematic"
segmentation_model: "rembg"
depth_model: "depth_anything_v2"
relighting_model: "sdxl"

Response: {
    "status": "success",
    "file_path": ".../outputs/composite_xyz.png",
    "stages": {
        "cutout": "success",
        "depth": "success",
        "relighting": "success",
        "compositing": "success"
    }
}
```

## Asset Management

### Cutout Library

All cutouts are persisted with metadata:
- Automatic unique ID generation
- Resolution tracking
- File size monitoring
- Searchable metadata

```bash
GET /cutouts                    # List all cutouts
GET /cutout/{cutout_id}         # Download cutout PNG
DELETE /cutout/{cutout_id}      # Remove from library
```

### Storage Structure

```
assets/
├── inputs/           # Source images (temporary)
├── cutouts/          # Persistent cutout library
│   ├── cutout_abc.png
│   ├── cutout_xyz.png
│   └── metadata.json
└── outputs/          # Final composites
```

## Configuration

All settings in `backend/config/settings.py`:

```python
DEVICE = "cuda"              # GPU acceleration
MAX_IMAGE_SIZE = 4096        # Maximum supported resolution
MODELS_PATH = "..."          # Local model weights cache
PIPELINE_ORDER = [           # Execution sequence
    "segmentation",
    "depth_estimation",
    "relighting",
    "compositing"
]
```

## Installation & Setup

### 1. Install Dependencies

```bash
cd backend
pip install -r requirements.txt
```

### 2. Start Backend Server

```bash
cd backend
python main.py
```

Server runs at `http://localhost:8000`

### 3. API Documentation

Interactive Swagger UI: `http://localhost:8000/docs`

## Usage Examples

### Python Client

```python
import requests
from pathlib import Path

BASE_URL = "http://localhost:8000"

# Cutout workflow
with open("photo.png", "rb") as f:
    r = requests.post(
        f"{BASE_URL}/cutout",
        files={"file": f},
        data={"model": "rembg"}
    )
    cutout_id = r.json()["cutout_id"]

# Relighting workflow
with open("cutout.png", "rb") as f:
    r = requests.post(
        f"{BASE_URL}/relight",
        files={"file": f},
        data={
            "light_direction": "side",
            "light_intensity": 1.5,
            "model": "sdxl"
        }
    )
    relit_path = r.json()["file_path"]

# Full pipeline
with open("subject.png", "rb") as f1, open("background.png", "rb") as f2:
    r = requests.post(
        f"{BASE_URL}/pipeline",
        files={
            "image": f1,
            "background": f2
        },
        data={
            "light_direction": "front",
            "color_grade": "cinematic"
        }
    )
    final_composite = r.json()["file_path"]
```

### Command Line

```bash
# Cutout
curl -X POST http://localhost:8000/cutout \
  -F "file=@photo.png" \
  -F "model=rembg"

# Full pipeline
curl -X POST http://localhost:8000/pipeline \
  -F "image=@subject.png" \
  -F "background=@scene.png" \
  -F "light_direction=side" \
  -F "color_grade=cinematic"
```

## Workflow Flexibility

The architecture supports multiple workflow patterns:

### Pattern 1: Sequential (Classic)
```
Input → Cutout → Relight → Composite → Output
```

### Pattern 2: Multi-Subject
```
Background + [Cutout₁, Cutout₂, Cutout₃] → Composite → Output
```

### Pattern 3: Light Sweep
```
Cutout → [Relight (Front), Relight (Side), Relight (Back)] → Multi-Output
```

### Pattern 4: Depth-Aware
```
Input → [Cutout, Depth] → Context-aware Relighting → Composite
```

## Model Selection Guide

**For Speed:**
- Segmentation: Rembg
- Depth: Depth Anything V2 (large)
- Relighting: SDXL Turbo

**For Quality:**
- Segmentation: BiRefNet
- Depth: Marigold
- Relighting: Flux.1 Dev

**For Balance:**
- Segmentation: Rembg
- Depth: Depth Anything V2
- Relighting: SDXL

## Performance Notes

- All models run locally on GPU (CUDA/ROCm)
- First model load downloads weights (~2-8GB per model)
- Subsequent calls are much faster (cached)
- Batch processing supported for high throughput

## Future Extensions

- LoRA fine-tuning for custom lighting styles
- Real-time preview with WebSockets
- Advanced color science (OpenColorIO integration)
- 3D billboard projection (Blender integration)
- Video support (frame sequences)
- Animation loops (AnimateDiff)

## Known Limitations

- Large images (>4096px) may require memory optimization
- Relighting with large batch counts requires sequential processing
- Color grading is CSS-based (not professional LUT support yet)
- No realtime GPU memory monitoring
