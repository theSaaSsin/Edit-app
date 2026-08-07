# Quick Start Guide

## Setup (2 minutes)

```bash
# 1. Install Python dependencies
cd Edit-app/backend
pip install -r requirements.txt

# 2. Start the backend server
python main.py

# Server runs at http://localhost:8000
# API docs at http://localhost:8000/docs
```

## Basic Usage

### 1. Remove Background from Image

```bash
curl -X POST http://localhost:8000/cutout \
  -F "file=@your_photo.png" \
  -F "model=rembg"
```

Response:
```json
{
  "status": "success",
  "cutout_id": "cutout_abc123",
  "message": "Cutout created successfully"
}
```

### 2. Generate Depth Map

```bash
curl -X POST http://localhost:8000/depth \
  -F "file=@your_photo.png"
```

### 3. Relight Your Cutout

```bash
curl -X POST http://localhost:8000/relight \
  -F "file=@cutout.png" \
  -F "light_direction=side" \
  -F "light_intensity=1.5"
```

### 4. Composite into Scene

```bash
curl -X POST http://localhost:8000/composite \
  -F "background=@scene.png" \
  -F 'cutout_ids=["cutout_abc123"]' \
  -F 'positions=[[50,50]]' \
  -F "color_grade=cinematic"
```

### 5. Full Pipeline (One Call)

```bash
curl -X POST http://localhost:8000/pipeline \
  -F "image=@subject.png" \
  -F "background=@scene.png" \
  -F "light_direction=front" \
  -F "color_grade=warm"
```

## Available Models

### Segmentation
- `rembg` - Fast, general purpose (default)
- `birefnet` - Detailed boundaries
- `sam2` - Interactive, zero-shot

### Depth Estimation
- `depth_anything_v2` - Balanced quality/speed (default)
- `zoedepth` - Fine details
- `marigold` - Physics-aware

### Relighting
- `sdxl` - Versatile, high quality (default)
- `ic_light` - Specialized lighting control
- `sdxl_turbo` - Faster alternative
- `flux_dev` - Most advanced

### Light Directions
- `front` - Direct front lighting
- `side` - Dramatic side lighting
- `back` - Backlit/rim lighting
- `rim` - Edge lighting
- `fill` - Soft fill light
- `top` - Overhead lighting
- `bottom` - Underlighting

### Color Grades
- `neutral` - No grading
- `warm` - Warm tones (+yellow/red)
- `cool` - Cool tones (+blue)
- `vintage` - Retro feel
- `cinematic` - Film-like
- `high_contrast` - Punchy contrast

## Python Example

```python
import requests
from PIL import Image

# Cutout
with open("photo.png", "rb") as f:
    r = requests.post(
        "http://localhost:8000/cutout",
        files={"file": f},
        data={"model": "rembg"}
    )
    cutout_id = r.json()["cutout_id"]
    print(f"Created cutout: {cutout_id}")

# Relight
with open("photo.png", "rb") as f:
    r = requests.post(
        "http://localhost:8000/relight",
        files={"file": f},
        data={
            "light_direction": "side",
            "light_intensity": 1.2,
            "model": "sdxl"
        }
    )
    output_path = r.json()["file_path"]
    print(f"Relit image saved to: {output_path}")

# Full pipeline
with open("subject.png", "rb") as img, open("background.png", "rb") as bg:
    r = requests.post(
        "http://localhost:8000/pipeline",
        files={"image": img, "background": bg},
        data={
            "light_direction": "front",
            "color_grade": "cinematic",
            "segmentation_model": "rembg",
            "depth_model": "depth_anything_v2",
            "relighting_model": "sdxl"
        }
    )
    result = r.json()
    print(f"Final composite: {result['file_path']}")
```

## Working with Your Library

```bash
# List all cutouts
curl http://localhost:8000/cutouts

# Download specific cutout
curl http://localhost:8000/cutout/{cutout_id} > my_cutout.png

# Delete cutout
curl -X DELETE http://localhost:8000/cutout/{cutout_id}

# List all outputs
curl http://localhost:8000/outputs

# Storage stats
curl http://localhost:8000/stats

# Workflow history
curl http://localhost:8000/history
```

## Frontend Integration

The backend API is designed to work with the browser frontend. The frontend sends images to these endpoints and displays results.

Example from JavaScript:
```javascript
// Cutout endpoint
const formData = new FormData();
formData.append('file', imageFile);
formData.append('model', 'rembg');

fetch('http://localhost:8000/cutout', {
  method: 'POST',
  body: formData
})
.then(r => r.json())
.then(data => {
  console.log('Cutout ID:', data.cutout_id);
  // Use cutout_id in further workflows
});
```

## Troubleshooting

### ModuleNotFoundError
Make sure all dependencies are installed:
```bash
pip install -r backend/requirements.txt
```

### CUDA Out of Memory
Reduce image size or use smaller models:
```bash
# Use turbo versions
-F "model=sdxl_turbo"
```

### Slow First Load
Models are downloaded and cached on first use. Subsequent calls are faster.

### Port Already in Use
Change port in backend/config/settings.py:
```python
PORT = 8001  # Change from default 8000
```

## Next Steps

1. Read [ARCHITECTURE.md](ARCHITECTURE.md) for deep dive
2. Explore API docs at `http://localhost:8000/docs`
3. Build custom workflows combining endpoints
4. Integrate with your own frontend or application
