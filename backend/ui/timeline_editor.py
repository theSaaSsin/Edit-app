"""
Gradio UI for video carousel timeline editing with drag-and-drop visual interface.
"""

import logging
import gradio as gr
from typing import List, Tuple
from PIL import Image, ImageDraw
import numpy as np
from pathlib import Path

from backend.pipeline.video_engine import VideoCarouselEngine, AnimationKeyframe, LyricFrame

logger = logging.getLogger(__name__)

engine = VideoCarouselEngine()


def create_timeline_visualization(
    total_slides: int,
    duration: int,
    keyframes: List[dict] = None,
    lyrics: List[dict] = None,
    fps: int = 30
) -> Image.Image:
    """
    Create visual timeline showing keyframes and lyric positions.

    Args:
        total_slides: Number of carousel slides
        duration: Total duration in seconds
        keyframes: Animation keyframes data
        lyrics: Lyric data
        fps: Frames per second

    Returns:
        Timeline visualization as PIL Image
    """
    try:
        timeline_width = 1200
        timeline_height = 400
        canvas = Image.new("RGB", (timeline_width, timeline_height), color=(40, 40, 40))
        draw = ImageDraw.Draw(canvas)

        pixels_per_second = timeline_width / duration
        marker_height = 30

        draw.rectangle([(0, 0), (timeline_width, marker_height)], fill=(60, 60, 60))

        for i in range(duration + 1):
            x = int(i * pixels_per_second)
            if x < timeline_width:
                draw.line([(x, marker_height - 5), (x, marker_height)], fill=(200, 200, 200), width=2)
                if i % 5 == 0:
                    draw.text((x + 5, 10), str(i) + "s", fill=(200, 200, 200))

        if keyframes:
            for kf in keyframes:
                x = int(kf.get("time", 0) * pixels_per_second)
                if 0 <= x < timeline_width:
                    draw.ellipse(
                        [(x - 6, marker_height + 20), (x + 6, marker_height + 32)],
                        fill=(0, 150, 255),
                        outline=(100, 200, 255),
                        width=2
                    )

        if lyrics:
            for lyric in lyrics:
                start_x = int(lyric.get("start_time", 0) * pixels_per_second)
                end_x = int(lyric.get("end_time", 0) * pixels_per_second)
                if 0 <= start_x < timeline_width:
                    draw.rectangle(
                        [(start_x, marker_height + 60), (min(end_x, timeline_width), marker_height + 85)],
                        fill=(150, 100, 200),
                        outline=(200, 150, 255),
                        width=1
                    )

        slide_section_width = timeline_width / total_slides
        for i in range(1, total_slides):
            x = int(i * slide_section_width)
            draw.line([(x, 0), (x, timeline_height)], fill=(100, 100, 100), width=1)

        return canvas
    except Exception as e:
        logger.error(f"Timeline visualization failed: {e}")
        return Image.new("RGB", (1200, 400), color=(200, 0, 0))


def add_keyframe(
    keyframe_list: str,
    time: float,
    x: int,
    y: int,
    scale: float,
    rotation: float,
    opacity: float
) -> str:
    """Add keyframe to timeline."""
    try:
        keyframes = eval(keyframe_list) if keyframe_list else []
        keyframes.append({
            "time": time,
            "x": x,
            "y": y,
            "scale": scale,
            "rotation": rotation,
            "opacity": opacity
        })
        keyframes.sort(key=lambda k: k["time"])
        return str(keyframes)
    except Exception as e:
        logger.error(f"Keyframe add failed: {e}")
        return keyframe_list


def remove_keyframe(keyframe_list: str, index: int) -> str:
    """Remove keyframe from timeline."""
    try:
        keyframes = eval(keyframe_list) if keyframe_list else []
        if 0 <= index < len(keyframes):
            keyframes.pop(index)
        return str(keyframes)
    except Exception as e:
        logger.error(f"Keyframe remove failed: {e}")
        return keyframe_list


def add_lyric(
    lyric_list: str,
    start_time: float,
    end_time: float,
    text: str,
    x: int,
    y: int
) -> str:
    """Add lyric to timeline."""
    try:
        lyrics = eval(lyric_list) if lyric_list else []
        lyrics.append({
            "start_time": start_time,
            "end_time": end_time,
            "text": text,
            "position": (x, y)
        })
        lyrics.sort(key=lambda l: l["start_time"])
        return str(lyrics)
    except Exception as e:
        logger.error(f"Lyric add failed: {e}")
        return lyric_list


def parse_srt_handler(srt_file) -> str:
    """Parse SRT file and return lyric list."""
    try:
        if srt_file is None:
            return "[]"

        lyrics = engine.parse_srt_file(srt_file.name)
        lyric_dicts = [
            {
                "start_time": l.start_time,
                "end_time": l.end_time,
                "text": l.text,
                "position": l.position
            }
            for l in lyrics
        ]
        return str(lyric_dicts)
    except Exception as e:
        logger.error(f"SRT parsing failed: {e}")
        return "[]"


def create_carousel_timeline_ui():
    """Create Gradio interface for carousel timeline editing."""
    with gr.Blocks(title="Video Carousel Timeline Editor") as interface:
        gr.Markdown("# 🎬 Instagram Video Carousel Timeline Editor")
        gr.Markdown("Drag and drop animation keyframes, add lyric overlays, and preview your seamless carousel.")

        with gr.Row():
            with gr.Column(scale=2):
                gr.Markdown("### Timeline Configuration")

                total_slides = gr.Slider(
                    minimum=2,
                    maximum=10,
                    value=4,
                    step=1,
                    label="Number of Slides"
                )
                duration = gr.Slider(
                    minimum=5,
                    maximum=60,
                    value=10,
                    step=1,
                    label="Duration (seconds)"
                )

                gr.Markdown("### Animation Keyframes")
                keyframe_list = gr.Textbox(
                    value="[]",
                    label="Keyframes (JSON)",
                    lines=4,
                    interactive=True
                )

                with gr.Row():
                    kf_time = gr.Number(value=0, label="Time (s)")
                    kf_x = gr.Number(value=0, label="X")
                    kf_y = gr.Number(value=0, label="Y")

                with gr.Row():
                    kf_scale = gr.Slider(0.1, 3.0, 1.0, label="Scale")
                    kf_rotation = gr.Slider(-180, 180, 0, label="Rotation (°)")
                    kf_opacity = gr.Slider(0, 1, 1.0, label="Opacity")

                add_kf_btn = gr.Button("➕ Add Keyframe", variant="primary")
                remove_kf_idx = gr.Number(value=0, label="Remove Keyframe (Index)")
                remove_kf_btn = gr.Button("❌ Remove Keyframe", variant="stop")

                gr.Markdown("### Lyric Overlays")
                lyric_list = gr.Textbox(
                    value="[]",
                    label="Lyrics (JSON)",
                    lines=4,
                    interactive=True
                )

                with gr.Row():
                    lyric_start = gr.Number(value=0, label="Start Time (s)")
                    lyric_end = gr.Number(value=3, label="End Time (s)")

                lyric_text = gr.Textbox(label="Lyric Text")

                with gr.Row():
                    lyric_x = gr.Number(value=100, label="X Position")
                    lyric_y = gr.Number(value=100, label="Y Position")

                add_lyric_btn = gr.Button("➕ Add Lyric", variant="primary")

                gr.Markdown("### Import Lyrics")
                srt_upload = gr.File(label="Upload SRT File", file_types=[".srt"])
                parse_srt_btn = gr.Button("📄 Parse SRT")

            with gr.Column(scale=3):
                gr.Markdown("### Timeline Visualization")
                timeline_viz = gr.Image(
                    label="Timeline Preview",
                    type="pil",
                    interactive=False
                )

                gr.Markdown("### Export & Preview")
                preview_btn = gr.Button("👁️ Update Timeline Preview", variant="primary")

                export_format = gr.Radio(
                    choices=["JSON Timeline", "HTML Preview"],
                    value="JSON Timeline",
                    label="Export Format"
                )
                export_btn = gr.Button("💾 Export", variant="secondary")
                export_output = gr.Textbox(
                    label="Export Result",
                    lines=10,
                    interactive=False
                )

        def update_timeline(_):
            return create_timeline_visualization(
                total_slides.value,
                int(duration.value),
                keyframes=eval(keyframe_list.value) if keyframe_list.value != "[]" else None,
                lyrics=eval(lyric_list.value) if lyric_list.value != "[]" else None
            )

        def on_add_keyframe():
            new_list = add_keyframe(
                keyframe_list.value,
                kf_time.value,
                int(kf_x.value),
                int(kf_y.value),
                kf_scale.value,
                kf_rotation.value,
                kf_opacity.value
            )
            keyframe_list.value = new_list
            return new_list, update_timeline(None)

        def on_remove_keyframe():
            new_list = remove_keyframe(keyframe_list.value, int(remove_kf_idx.value))
            keyframe_list.value = new_list
            return new_list, update_timeline(None)

        def on_add_lyric():
            new_list = add_lyric(
                lyric_list.value,
                lyric_start.value,
                lyric_end.value,
                lyric_text.value,
                int(lyric_x.value),
                int(lyric_y.value)
            )
            lyric_list.value = new_list
            return new_list, update_timeline(None)

        def on_parse_srt():
            new_list = parse_srt_handler(srt_upload.value)
            lyric_list.value = new_list
            return new_list, update_timeline(None)

        def on_export():
            if export_format.value == "JSON Timeline":
                export_data = {
                    "slides": int(total_slides.value),
                    "duration": int(duration.value),
                    "keyframes": eval(keyframe_list.value),
                    "lyrics": eval(lyric_list.value)
                }
                return str(export_data)
            else:
                return "<html><body>HTML preview not yet implemented</body></html>"

        add_kf_btn.click(on_add_keyframe, outputs=[keyframe_list, timeline_viz])
        remove_kf_btn.click(on_remove_keyframe, outputs=[keyframe_list, timeline_viz])
        add_lyric_btn.click(on_add_lyric, outputs=[lyric_list, timeline_viz])
        parse_srt_btn.click(on_parse_srt, outputs=[lyric_list, timeline_viz])
        preview_btn.click(update_timeline, outputs=timeline_viz)
        export_btn.click(on_export, outputs=export_output)

    return interface


if __name__ == "__main__":
    interface = create_carousel_timeline_ui()
    interface.launch(share=False, server_name="0.0.0.0", server_port=7860)
