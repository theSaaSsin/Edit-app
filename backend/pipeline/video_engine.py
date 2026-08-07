import logging
from pathlib import Path
from typing import List, Tuple, Optional, Dict
import numpy as np
from PIL import Image
import subprocess
import json
from dataclasses import dataclass
from datetime import timedelta

logger = logging.getLogger(__name__)


@dataclass
class LyricFrame:
    """Represents a timed text overlay."""
    start_time: float
    end_time: float
    text: str
    position: Tuple[int, int]
    font_size: int = 65
    color: Tuple[int, int, int] = (255, 255, 255)
    font: str = "Arial"


@dataclass
class AnimationKeyframe:
    """Represents an animation keyframe for cutout movement."""
    time: float
    x: int
    y: int
    scale: float = 1.0
    rotation: float = 0.0
    opacity: float = 1.0


class VideoCarouselEngine:
    """
    Creates seamless Instagram video carousels with animated cutout layers,
    lyric overlays, and perfect seam alignment across multiple video panels.
    """

    INSTAGRAM_SLIDE_WIDTH = 1080
    INSTAGRAM_SLIDE_HEIGHT = 1350
    DEFAULT_FPS = 30
    DEFAULT_BITRATE = "5000k"

    def __init__(self):
        self.check_dependencies()
        logger.info("Initialized VideoCarouselEngine")

    @staticmethod
    def check_dependencies():
        """Verify FFmpeg and Python video libraries are available."""
        try:
            subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
            logger.info("FFmpeg is available")
        except Exception as e:
            logger.warning(f"FFmpeg not found: {e}")

    def create_carousel_timeline(
        self,
        total_slides: int,
        duration: int,
        background_image: Image.Image,
        cutout_image: Image.Image,
        lyrics: List[LyricFrame] = None,
        cutout_animation: List[AnimationKeyframe] = None,
        fps: int = DEFAULT_FPS,
    ) -> Dict:
        """
        Create master wide-canvas video carousel and return render specs.

        Args:
            total_slides: Number of Instagram carousel panels
            duration: Total video duration in seconds
            background_image: Base background image/video
            cutout_image: Foreground subject cutout
            lyrics: List of timed text overlays
            cutout_animation: Animation keyframes for cutout movement
            fps: Frames per second

        Returns:
            {"status": "success", "canvas_width": X, "canvas_height": Y, "specs": {...}}
        """
        try:
            canvas_width = self.INSTAGRAM_SLIDE_WIDTH * total_slides
            canvas_height = self.INSTAGRAM_SLIDE_HEIGHT

            specs = {
                "canvas_width": canvas_width,
                "canvas_height": canvas_height,
                "total_slides": total_slides,
                "duration": duration,
                "fps": fps,
                "total_frames": duration * fps,
                "slide_width": self.INSTAGRAM_SLIDE_WIDTH,
                "slide_height": self.INSTAGRAM_SLIDE_HEIGHT,
                "background_size": background_image.size if isinstance(background_image, Image.Image) else "unknown",
                "cutout_size": cutout_image.size if isinstance(cutout_image, Image.Image) else "unknown",
                "lyric_count": len(lyrics) if lyrics else 0,
                "animation_keyframes": len(cutout_animation) if cutout_animation else 0,
            }

            logger.info(f"Created carousel timeline: {specs}")
            return {"status": "success", "specs": specs}
        except Exception as e:
            logger.error(f"Timeline creation failed: {e}")
            return {"status": "failed", "error": str(e)}

    def calculate_cutout_position(
        self,
        keyframes: List[AnimationKeyframe],
        total_frames: int,
        current_frame: int
    ) -> Tuple[int, int, float, float, float]:
        """
        Interpolate cutout position/scale/opacity at current frame using keyframes.

        Args:
            keyframes: List of animation keyframes
            total_frames: Total number of frames in video
            current_frame: Current frame number

        Returns:
            (x, y, scale, rotation, opacity)
        """
        if not keyframes:
            return (0, 0, 1.0, 0.0, 1.0)

        current_time = current_frame / 30.0  # Assuming 30fps

        if len(keyframes) == 1:
            kf = keyframes[0]
            return (kf.x, kf.y, kf.scale, kf.rotation, kf.opacity)

        for i in range(len(keyframes) - 1):
            kf1 = keyframes[i]
            kf2 = keyframes[i + 1]

            if kf1.time <= current_time <= kf2.time:
                t = (current_time - kf1.time) / (kf2.time - kf1.time)
                t = max(0, min(1, t))

                x = int(kf1.x + (kf2.x - kf1.x) * t)
                y = int(kf1.y + (kf2.y - kf1.y) * t)
                scale = kf1.scale + (kf2.scale - kf1.scale) * t
                rotation = kf1.rotation + (kf2.rotation - kf1.rotation) * t
                opacity = kf1.opacity + (kf2.opacity - kf1.opacity) * t

                return (x, y, scale, rotation, opacity)

        kf = keyframes[-1]
        return (kf.x, kf.y, kf.scale, kf.rotation, kf.opacity)

    def parse_srt_file(self, srt_path: str) -> List[LyricFrame]:
        """
        Parse SRT subtitle file into LyricFrame list.

        Args:
            srt_path: Path to .srt file

        Returns:
            List of LyricFrame objects
        """
        try:
            lyrics = []
            with open(srt_path, "r", encoding="utf-8") as f:
                lines = f.readlines()

            i = 0
            while i < len(lines):
                if "-->" in lines[i]:
                    time_line = lines[i].strip()
                    start_str, end_str = time_line.split(" --> ")

                    start = self._srt_time_to_seconds(start_str.strip())
                    end = self._srt_time_to_seconds(end_str.strip())

                    text = ""
                    i += 1
                    while i < len(lines) and lines[i].strip():
                        text += lines[i].strip() + " "
                        i += 1

                    lyric = LyricFrame(
                        start_time=start,
                        end_time=end,
                        text=text.strip(),
                        position=(100, 100)
                    )
                    lyrics.append(lyric)
                else:
                    i += 1

            logger.info(f"Parsed {len(lyrics)} lyrics from {srt_path}")
            return lyrics
        except Exception as e:
            logger.error(f"SRT parsing failed: {e}")
            return []

    def parse_lrc_file(self, lrc_path: str) -> List[LyricFrame]:
        """
        Parse LRC lyrics file into LyricFrame list.

        Args:
            lrc_path: Path to .lrc file

        Returns:
            List of LyricFrame objects
        """
        try:
            lyrics = []
            with open(lrc_path, "r", encoding="utf-8") as f:
                lines = f.readlines()

            for line in lines:
                if "[" in line and "]" in line:
                    time_str = line[line.find("[") + 1:line.find("]")]
                    text = line[line.find("]") + 1:].strip()

                    time_parts = time_str.split(":")
                    if len(time_parts) == 2:
                        minutes, seconds = map(float, time_parts)
                        start_time = minutes * 60 + seconds

                        lyric = LyricFrame(
                            start_time=start_time,
                            end_time=start_time + 3.0,
                            text=text,
                            position=(100, 100)
                        )
                        lyrics.append(lyric)

            logger.info(f"Parsed {len(lyrics)} lyrics from {lrc_path}")
            return lyrics
        except Exception as e:
            logger.error(f"LRC parsing failed: {e}")
            return []

    @staticmethod
    def _srt_time_to_seconds(time_str: str) -> float:
        """Convert SRT time format (HH:MM:SS,mmm) to seconds."""
        parts = time_str.replace(",", ".").split(":")
        hours = int(parts[0])
        minutes = int(parts[1])
        seconds = float(parts[2])
        return hours * 3600 + minutes * 60 + seconds

    def generate_ffmpeg_filter_graph(
        self,
        total_slides: int,
        lyrics: List[LyricFrame] = None
    ) -> str:
        """
        Generate FFmpeg complex filter graph for text overlays.

        Args:
            total_slides: Number of slides
            lyrics: List of lyric frames

        Returns:
            FFmpeg filter graph string
        """
        if not lyrics:
            return ""

        filters = []
        input_idx = 0

        for i, lyric in enumerate(lyrics):
            filter_str = (
                f"[{input_idx}]"
                f"drawtext=text='{lyric.text}':"
                f"fontsize={lyric.font_size}:"
                f"fontcolor=rgb({lyric.color[0]},{lyric.color[1]},{lyric.color[2]}):"
                f"x={lyric.position[0]}:"
                f"y={lyric.position[1]}:"
                f"enable='between(t,{lyric.start_time},{lyric.end_time})'[{input_idx + 1}]"
            )
            filters.append(filter_str)
            input_idx += 1

        return ";".join(filters)

    def slice_carousel_video(
        self,
        master_video_path: str,
        output_dir: str,
        total_slides: int,
        quality: str = "medium"
    ) -> Dict:
        """
        Slice wide master video into seamless Instagram carousel panels.

        Args:
            master_video_path: Path to master panoramic video
            output_dir: Output directory for panel videos
            total_slides: Number of carousel panels
            quality: "low", "medium", "high" for compression

        Returns:
            {"status": "success", "panels": [paths...]}
        """
        try:
            Path(output_dir).mkdir(parents=True, exist_ok=True)

            bitrates = {"low": "3000k", "medium": "5000k", "high": "8000k"}
            bitrate = bitrates.get(quality, "5000k")

            panel_paths = []
            for i in range(total_slides):
                left_offset = i * self.INSTAGRAM_SLIDE_WIDTH
                output_path = Path(output_dir) / f"slide_{i+1:02d}.mp4"

                cmd = [
                    "ffmpeg",
                    "-i", master_video_path,
                    "-vf", f"crop={self.INSTAGRAM_SLIDE_WIDTH}:{self.INSTAGRAM_SLIDE_HEIGHT}:{left_offset}:0",
                    "-c:v", "libx264",
                    "-b:v", bitrate,
                    "-c:a", "aac",
                    "-y",
                    str(output_path)
                ]

                subprocess.run(cmd, capture_output=True, check=True)
                panel_paths.append(str(output_path))
                logger.info(f"Generated panel {i+1}/{total_slides}: {output_path}")

            return {"status": "success", "panels": panel_paths, "count": total_slides}
        except Exception as e:
            logger.error(f"Video slicing failed: {e}")
            return {"status": "failed", "error": str(e)}

    def merge_carousel_videos(
        self,
        panel_paths: List[str],
        output_path: str,
        orientation: str = "horizontal"
    ) -> Dict:
        """
        Merge carousel panel videos back into single-view video.

        Args:
            panel_paths: List of panel video paths
            output_path: Output video path
            orientation: "horizontal" or "vertical"

        Returns:
            {"status": "success", "output": path}
        """
        try:
            cols = len(panel_paths) if orientation == "horizontal" else 1
            rows = 1 if orientation == "horizontal" else len(panel_paths)

            filter_str = ";".join([
                f"[{i}:v]scale={self.INSTAGRAM_SLIDE_WIDTH}:{self.INSTAGRAM_SLIDE_HEIGHT}[v{i}]"
                for i in range(len(panel_paths))
            ])

            if orientation == "horizontal":
                concat_str = "".join([f"[v{i}]" for i in range(len(panel_paths))])
                filter_str += f";{concat_str}hstack=inputs={len(panel_paths)}[v_out]"
            else:
                concat_str = "".join([f"[v{i}]" for i in range(len(panel_paths))])
                filter_str += f";{concat_str}vstack=inputs={len(panel_paths)}[v_out]"

            cmd = ["ffmpeg"]
            for panel in panel_paths:
                cmd.extend(["-i", panel])

            cmd.extend([
                "-filter_complex", filter_str,
                "-map", "[v_out]",
                "-c:v", "libx264",
                "-y",
                output_path
            ])

            subprocess.run(cmd, capture_output=True, check=True)
            logger.info(f"Merged carousel: {output_path}")
            return {"status": "success", "output": output_path}
        except Exception as e:
            logger.error(f"Video merge failed: {e}")
            return {"status": "failed", "error": str(e)}

    def add_audio_track(
        self,
        video_path: str,
        audio_path: str,
        output_path: str
    ) -> Dict:
        """
        Attach audio track to video file.

        Args:
            video_path: Path to video
            audio_path: Path to audio file
            output_path: Output path

        Returns:
            {"status": "success", "output": path}
        """
        try:
            cmd = [
                "ffmpeg",
                "-i", video_path,
                "-i", audio_path,
                "-c:v", "copy",
                "-c:a", "aac",
                "-shortest",
                "-y",
                output_path
            ]

            subprocess.run(cmd, capture_output=True, check=True)
            logger.info(f"Added audio track: {output_path}")
            return {"status": "success", "output": output_path}
        except Exception as e:
            logger.error(f"Audio attachment failed: {e}")
            return {"status": "failed", "error": str(e)}

    def generate_animation_json(
        self,
        keyframes: List[AnimationKeyframe],
        output_path: str
    ) -> bool:
        """
        Export animation keyframes as JSON for later reference/editing.

        Args:
            keyframes: List of animation keyframes
            output_path: Path to save JSON

        Returns:
            True if successful
        """
        try:
            data = [
                {
                    "time": kf.time,
                    "x": kf.x,
                    "y": kf.y,
                    "scale": kf.scale,
                    "rotation": kf.rotation,
                    "opacity": kf.opacity
                }
                for kf in keyframes
            ]

            with open(output_path, "w") as f:
                json.dump(data, f, indent=2)

            logger.info(f"Exported animation: {output_path}")
            return True
        except Exception as e:
            logger.error(f"Animation export failed: {e}")
            return False

    def load_animation_json(self, json_path: str) -> List[AnimationKeyframe]:
        """
        Load animation keyframes from JSON file.

        Args:
            json_path: Path to animation JSON

        Returns:
            List of AnimationKeyframe objects
        """
        try:
            with open(json_path, "r") as f:
                data = json.load(f)

            keyframes = [
                AnimationKeyframe(
                    time=item["time"],
                    x=item["x"],
                    y=item["y"],
                    scale=item.get("scale", 1.0),
                    rotation=item.get("rotation", 0.0),
                    opacity=item.get("opacity", 1.0)
                )
                for item in data
            ]

            logger.info(f"Loaded {len(keyframes)} animation keyframes")
            return keyframes
        except Exception as e:
            logger.error(f"Animation load failed: {e}")
            return []

    def validate_carousel_layout(
        self,
        panel_count: int,
        canvas_width: int,
        canvas_height: int
    ) -> Dict:
        """
        Validate carousel layout parameters.

        Args:
            panel_count: Number of carousel panels
            canvas_width: Master canvas width
            canvas_height: Master canvas height

        Returns:
            {"valid": bool, "issues": [...], "recommendations": [...]}
        """
        issues = []
        recommendations = []

        if canvas_width != self.INSTAGRAM_SLIDE_WIDTH * panel_count:
            issues.append(f"Canvas width mismatch: expected {self.INSTAGRAM_SLIDE_WIDTH * panel_count}, got {canvas_width}")

        if canvas_height != self.INSTAGRAM_SLIDE_HEIGHT:
            issues.append(f"Canvas height should be {self.INSTAGRAM_SLIDE_HEIGHT} for Instagram")

        if panel_count > 10:
            recommendations.append("Large carousel may be harder to navigate on mobile")

        if panel_count < 2:
            recommendations.append("Consider adding more panels for engagement")

        return {
            "valid": len(issues) == 0,
            "issues": issues,
            "recommendations": recommendations
        }
