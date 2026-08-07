import logging
from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Tuple
from PIL import Image
from pathlib import Path
import io
import json

from backend.config.settings import Config
from backend.services import WorkflowOrchestrator, AssetManager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Image Edit Workspace",
    description="Professional image cutout, depth, relighting, and compositing pipeline",
    version="0.1.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

orchestrator = WorkflowOrchestrator()
asset_manager = AssetManager()


class CutoutRequest(BaseModel):
    model: str = "rembg"


class DepthRequest(BaseModel):
    model: str = "depth_anything_v2"


class RelightRequest(BaseModel):
    light_direction: str = "front"
    light_intensity: float = 1.0
    prompt: Optional[str] = None
    model: str = "sdxl"


class CompositeRequest(BaseModel):
    cutout_ids: List[str]
    positions: List[Tuple[int, int]] = None
    cast_shadows: bool = True
    color_grade: str = "neutral"


class FullPipelineRequest(BaseModel):
    light_direction: str = "front"
    color_grade: str = "neutral"
    segmentation_model: str = "rembg"
    depth_model: str = "depth_anything_v2"
    relighting_model: str = "sdxl"


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "device": Config.DEVICE,
        "assets": asset_manager.get_stats()
    }


@app.post("/cutout")
async def cutout(
    file: UploadFile = File(...),
    request: CutoutRequest = None
):
    """
    Remove background from image and return cutout.

    Returns: {"status": "success", "cutout_id": "...", "metadata": {...}}
    """
    try:
        contents = await file.read()
        image = Image.open(io.BytesIO(contents)).convert("RGBA")

        input_path = asset_manager.save_input(image, name=file.filename)
        if not input_path:
            raise HTTPException(status_code=400, detail="Failed to save input image")

        result = orchestrator.cutout_workflow(input_path, model=request.model)
        if result["status"] != "success":
            raise HTTPException(status_code=400, detail=result.get("error", "Cutout failed"))

        cutout_id = asset_manager.save_cutout(
            result["cutout"],
            metadata={"source_file": file.filename, "model": request.model}
        )

        return {
            "status": "success",
            "cutout_id": cutout_id,
            "message": "Cutout created successfully"
        }
    except Exception as e:
        logger.error(f"Cutout endpoint failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/depth")
async def depth(
    file: UploadFile = File(...),
    request: DepthRequest = None
):
    """
    Generate depth map from image.

    Returns: {"status": "success", "depth": "...", "normals": "..."}
    """
    try:
        contents = await file.read()
        image = Image.open(io.BytesIO(contents))

        input_path = asset_manager.save_input(image, name=file.filename)
        if not input_path:
            raise HTTPException(status_code=400, detail="Failed to save input image")

        result = orchestrator.depth_workflow(input_path, model=request.model)
        if result["status"] != "success":
            raise HTTPException(status_code=400, detail=result.get("error", "Depth estimation failed"))

        depth_img = Image.fromarray((result["depth"] * 255).astype("uint8"), mode="L")
        depth_buffer = io.BytesIO()
        depth_img.save(depth_buffer, format="PNG")

        normals_img = Image.fromarray(result["normals"], mode="RGB")
        normals_buffer = io.BytesIO()
        normals_img.save(normals_buffer, format="PNG")

        return {
            "status": "success",
            "message": "Depth map generated successfully",
            "metadata": {
                "model": request.model,
                "width": depth_img.width,
                "height": depth_img.height
            }
        }
    except Exception as e:
        logger.error(f"Depth endpoint failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/relight")
async def relight(
    file: UploadFile = File(...),
    request: RelightRequest = None
):
    """
    Apply neural relighting to cutout.

    Returns: {"status": "success", "relit_id": "..."}
    """
    try:
        contents = await file.read()
        image = Image.open(io.BytesIO(contents)).convert("RGBA")

        result = orchestrator.relighting_workflow(
            image,
            light_direction=request.light_direction,
            light_intensity=request.light_intensity,
            prompt=request.prompt,
            model=request.model
        )

        if result["status"] != "success":
            raise HTTPException(status_code=400, detail=result.get("error", "Relighting failed"))

        output_path = asset_manager.save_output(result["relit"])
        if not output_path:
            raise HTTPException(status_code=400, detail="Failed to save relit image")

        return {
            "status": "success",
            "message": "Image relit successfully",
            "file_path": output_path
        }
    except Exception as e:
        logger.error(f"Relight endpoint failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/composite")
async def composite(
    background: UploadFile = File(...),
    request: CompositeRequest = None
):
    """
    Composite cutouts into scene with shadows and grading.

    Returns: {"status": "success", "composite_id": "..."}
    """
    try:
        bg_contents = await background.read()
        bg_image = Image.open(io.BytesIO(bg_contents))

        cutouts = []
        for cutout_id in request.cutout_ids:
            cutout = asset_manager.load_cutout(cutout_id)
            if cutout:
                cutouts.append(cutout)

        if not cutouts:
            raise HTTPException(status_code=400, detail="No valid cutouts found")

        result = orchestrator.compositing_workflow(
            bg_image,
            cutouts,
            positions=request.positions,
            cast_shadows=request.cast_shadows,
            color_grade=request.color_grade
        )

        if result["status"] != "success":
            raise HTTPException(status_code=400, detail=result.get("error", "Compositing failed"))

        output_path = asset_manager.save_output(result["composite"])
        if not output_path:
            raise HTTPException(status_code=400, detail="Failed to save composite")

        return {
            "status": "success",
            "message": "Composite created successfully",
            "file_path": output_path
        }
    except Exception as e:
        logger.error(f"Composite endpoint failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/pipeline")
async def full_pipeline(
    image: UploadFile = File(...),
    background: UploadFile = File(...),
    request: FullPipelineRequest = None
):
    """
    Execute complete pipeline: cutout → depth → relight → composite.

    Returns: {"status": "success", "composite_path": "..."}
    """
    try:
        img_contents = await image.read()
        bg_contents = await background.read()

        img_path = asset_manager.save_input(
            Image.open(io.BytesIO(img_contents)),
            name=image.filename
        )
        bg_path = asset_manager.save_input(
            Image.open(io.BytesIO(bg_contents)),
            name=background.filename
        )

        if not img_path or not bg_path:
            raise HTTPException(status_code=400, detail="Failed to save input images")

        result = orchestrator.full_pipeline(
            img_path,
            bg_path,
            light_direction=request.light_direction,
            color_grade=request.color_grade,
            segmentation_model=request.segmentation_model,
            depth_model=request.depth_model,
            relighting_model=request.relighting_model,
        )

        if result["status"] != "success":
            raise HTTPException(status_code=400, detail=result.get("error", "Pipeline failed"))

        output_path = asset_manager.save_output(result["final_composite"])
        if not output_path:
            raise HTTPException(status_code=400, detail="Failed to save output")

        return {
            "status": "success",
            "message": "Pipeline completed successfully",
            "file_path": output_path,
            "stages": {k: v.get("status", "unknown") for k, v in result.get("stages", {}).items()}
        }
    except Exception as e:
        logger.error(f"Pipeline endpoint failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/cutouts")
async def list_cutouts():
    """List all saved cutouts."""
    return {"cutouts": asset_manager.list_cutouts()}


@app.get("/outputs")
async def list_outputs():
    """List all saved outputs."""
    return {"outputs": asset_manager.list_outputs()}


@app.get("/cutout/{cutout_id}")
async def get_cutout(cutout_id: str):
    """Download cutout image."""
    cutout = asset_manager.load_cutout(cutout_id)
    if not cutout:
        raise HTTPException(status_code=404, detail="Cutout not found")

    buffer = io.BytesIO()
    cutout.save(buffer, format="PNG")
    buffer.seek(0)

    return FileResponse(
        buffer,
        media_type="image/png",
        filename=f"{cutout_id}.png"
    )


@app.delete("/cutout/{cutout_id}")
async def delete_cutout(cutout_id: str):
    """Delete cutout."""
    if asset_manager.delete_cutout(cutout_id):
        return {"status": "success", "message": "Cutout deleted"}
    raise HTTPException(status_code=404, detail="Cutout not found")


@app.get("/stats")
async def get_stats():
    """Get storage statistics."""
    return asset_manager.get_stats()


@app.get("/history")
async def get_history(limit: int = 10):
    """Get workflow history."""
    return {"history": orchestrator.get_history(limit)}


@app.delete("/history")
async def clear_history():
    """Clear workflow history."""
    orchestrator.clear_history()
    return {"status": "success", "message": "History cleared"}


@app.post("/edge-fx")
async def edge_fx(
    file: UploadFile = File(...),
    style: str = "torn_paper",
    intensity: float = 1.0,
    width: int = 24,
    seed: Optional[int] = None,
):
    """
    Apply a procedural edge material to a cutout.

    Styles: none, torn_paper, tissue, flesh, sticker, burnt.
    CPU-only — no GPU or torch required.
    """
    try:
        from backend.pipeline.edge_fx import EdgeFXEngine

        contents = await file.read()
        cutout = Image.open(io.BytesIO(contents))

        result = EdgeFXEngine().apply(
            cutout, style=style, intensity=intensity, width=width, seed=seed
        )
        output_path = asset_manager.save_output(result, name=f"fx_{style}_{file.filename}")

        return {
            "status": "success",
            "style": style,
            "file_path": output_path,
            "size": result.size,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Edge FX endpoint failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Video Carousel Endpoints

video_engine = None

def get_video_engine():
    """Lazy load video engine."""
    global video_engine
    if video_engine is None:
        from backend.pipeline.video_engine import VideoCarouselEngine
        video_engine = VideoCarouselEngine()
    return video_engine


class CarouselTimelineRequest(BaseModel):
    total_slides: int = 4
    duration: int = 10
    fps: int = 30


class CarouselSliceRequest(BaseModel):
    quality: str = "medium"


class CarouselAudioRequest(BaseModel):
    audio_path: str


@app.post("/carousel/timeline")
async def carousel_timeline(
    background: UploadFile = File(...),
    cutout: UploadFile = File(...),
    request: CarouselTimelineRequest = None
):
    """
    Create carousel timeline specification.

    Returns: {"status": "success", "specs": {...}}
    """
    try:
        engine = get_video_engine()

        bg_contents = await background.read()
        bg_image = Image.open(io.BytesIO(bg_contents))

        cutout_contents = await cutout.read()
        cutout_image = Image.open(io.BytesIO(cutout_contents))

        result = engine.create_carousel_timeline(
            total_slides=request.total_slides,
            duration=request.duration,
            background_image=bg_image,
            cutout_image=cutout_image,
            fps=request.fps
        )

        return result
    except Exception as e:
        logger.error(f"Carousel timeline endpoint failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/carousel/slice")
async def carousel_slice(
    master_video: UploadFile = File(...),
    total_slides: int = 4,
    quality: str = "medium"
):
    """
    Slice master panoramic video into Instagram carousel panels.

    Returns: {"status": "success", "panels": [paths...]}
    """
    try:
        engine = get_video_engine()

        contents = await master_video.read()
        video_path = str(Path(Config.INPUTS_PATH) / master_video.filename)
        with open(video_path, "wb") as f:
            f.write(contents)

        output_dir = str(Path(Config.OUTPUTS_PATH) / "carousel_panels")

        result = engine.slice_carousel_video(
            video_path,
            output_dir,
            total_slides=total_slides,
            quality=quality
        )

        return result
    except Exception as e:
        logger.error(f"Carousel slice endpoint failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/carousel/parse-srt")
async def carousel_parse_srt(srt_file: UploadFile = File(...)):
    """
    Parse SRT subtitle file into lyric frames.

    Returns: {"status": "success", "lyrics": [...]}
    """
    try:
        engine = get_video_engine()

        contents = await srt_file.read()
        srt_path = f"/tmp/{srt_file.filename}"
        with open(srt_path, "wb") as f:
            f.write(contents)

        lyrics = engine.parse_srt_file(srt_path)

        lyric_dicts = [
            {
                "start_time": l.start_time,
                "end_time": l.end_time,
                "text": l.text,
                "position": l.position
            }
            for l in lyrics
        ]

        return {"status": "success", "lyrics": lyric_dicts, "count": len(lyrics)}
    except Exception as e:
        logger.error(f"SRT parse endpoint failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/carousel/parse-lrc")
async def carousel_parse_lrc(lrc_file: UploadFile = File(...)):
    """
    Parse LRC lyrics file into lyric frames.

    Returns: {"status": "success", "lyrics": [...]}
    """
    try:
        engine = get_video_engine()

        contents = await lrc_file.read()
        lrc_path = f"/tmp/{lrc_file.filename}"
        with open(lrc_path, "wb") as f:
            f.write(contents)

        lyrics = engine.parse_lrc_file(lrc_path)

        lyric_dicts = [
            {
                "start_time": l.start_time,
                "end_time": l.end_time,
                "text": l.text,
                "position": l.position
            }
            for l in lyrics
        ]

        return {"status": "success", "lyrics": lyric_dicts, "count": len(lyrics)}
    except Exception as e:
        logger.error(f"LRC parse endpoint failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/carousel/add-audio")
async def carousel_add_audio(
    video: UploadFile = File(...),
    audio: UploadFile = File(...)
):
    """
    Attach audio track to video.

    Returns: {"status": "success", "output": path}
    """
    try:
        engine = get_video_engine()

        video_contents = await video.read()
        video_path = str(Path(Config.INPUTS_PATH) / video.filename)
        with open(video_path, "wb") as f:
            f.write(video_contents)

        audio_contents = await audio.read()
        audio_path = str(Path(Config.INPUTS_PATH) / audio.filename)
        with open(audio_path, "wb") as f:
            f.write(audio_contents)

        output_path = str(Path(Config.OUTPUTS_PATH) / f"with_audio_{video.filename}")

        result = engine.add_audio_track(video_path, audio_path, output_path)
        return result
    except Exception as e:
        logger.error(f"Add audio endpoint failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/carousel/validate")
async def carousel_validate(
    panel_count: int = 4,
    canvas_width: int = 4320,
    canvas_height: int = 1350
):
    """
    Validate carousel layout parameters.

    Returns: {"valid": bool, "issues": [...], "recommendations": [...]}
    """
    try:
        engine = get_video_engine()
        result = engine.validate_carousel_layout(panel_count, canvas_width, canvas_height)
        return result
    except Exception as e:
        logger.error(f"Validate endpoint failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host=Config.HOST,
        port=Config.PORT,
        reload=Config.RELOAD
    )
