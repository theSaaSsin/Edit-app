"""
Object tracking across video frames, with a reusable motion log.

Follows a subject (a bird, a face, a flame) through a clip and records where it
was on every frame. The log is the point: once motion is on disk, overlays,
lyrics and FX can be synced to it repeatedly without re-running the tracker,
which is by far the expensive step.

CSRT lives in opencv-contrib, not the base opencv-python wheel — `cv2.TrackerCSRT`
raises AttributeError on a plain install. `available_trackers()` reports what
this build actually has and `Tracker` falls back in order of quality, so a
missing contrib package degrades instead of crashing.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)

Bbox = Tuple[int, int, int, int]  # x, y, w, h

#: Best first. CSRT is the most accurate and slowest; MIL ships with base opencv.
TRACKER_PREFERENCE = ("csrt", "kcf", "mil")


def available_trackers() -> List[str]:
    """Tracker names this OpenCV build can actually create."""
    found = []
    for name in TRACKER_PREFERENCE:
        attr = f"Tracker{name.upper()}" if name != "mil" else "TrackerMIL"
        if hasattr(cv2, attr) or hasattr(cv2, f"legacy_Tracker{name.upper()}"):
            found.append(name)
    return found


def _create_tracker(kind: str):
    """Instantiate a tracker, tuned where the build exposes parameters."""
    kind = kind.lower()

    if kind == "csrt":
        if not hasattr(cv2, "TrackerCSRT"):
            raise RuntimeError(
                "CSRT is unavailable in this OpenCV build.\n"
                "  pip install opencv-contrib-python\n"
                "(or use tracker='kcf' / 'mil')"
            )
        try:
            params = cv2.TrackerCSRT.Params()
            params.use_hog = True
            params.use_color_names = True
            params.use_channel_weights = True
            params.use_spatial_reliability = True
            return cv2.TrackerCSRT.create(params)
        except Exception:
            # Parameter names differ across OpenCV versions; defaults are fine.
            return cv2.TrackerCSRT.create()

    if kind == "kcf":
        if not hasattr(cv2, "TrackerKCF"):
            raise RuntimeError("KCF is unavailable in this OpenCV build")
        return cv2.TrackerKCF.create()

    if kind == "mil":
        return cv2.TrackerMIL.create()

    raise ValueError(f"unknown tracker {kind!r}; known: {TRACKER_PREFERENCE}")


@dataclass
class TrackPoint:
    """Where the subject was on one frame."""

    frame: int
    time: float
    bbox: Bbox
    found: bool
    centre: Tuple[int, int] = field(default=(0, 0))

    def __post_init__(self):
        x, y, w, h = self.bbox
        self.centre = (int(x + w / 2), int(y + h / 2))


@dataclass
class MotionLog:
    """A full track, serialisable to JSON."""

    video: str
    fps: float
    width: int
    height: int
    frame_count: int
    tracker: str
    points: List[TrackPoint]

    def to_json(self, path: str) -> str:
        payload = {
            "video": self.video,
            "fps": self.fps,
            "width": self.width,
            "height": self.height,
            "frame_count": self.frame_count,
            "tracker": self.tracker,
            "points": [asdict(p) for p in self.points],
        }
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps(payload, indent=2))
        logger.info("wrote motion log to %s", path)
        return path

    @classmethod
    def from_json(cls, path: str) -> "MotionLog":
        data = json.loads(Path(path).read_text())
        points = [
            TrackPoint(frame=p["frame"], time=p["time"], bbox=tuple(p["bbox"]), found=p["found"])
            for p in data["points"]
        ]
        return cls(
            video=data["video"], fps=data["fps"], width=data["width"], height=data["height"],
            frame_count=data["frame_count"], tracker=data["tracker"], points=points,
        )

    def at_frame(self, frame: int) -> Optional[TrackPoint]:
        if 0 <= frame < len(self.points):
            return self.points[frame]
        return None

    def found_ratio(self) -> float:
        """Fraction of frames where the subject was held. Below ~0.8 means re-seed."""
        if not self.points:
            return 0.0
        return sum(1 for p in self.points if p.found) / len(self.points)

    def smoothed(self, window: int = 7) -> "MotionLog":
        """
        Rolling-average the box path to remove tracker jitter.

        Only frames where the subject was found contribute — averaging in the
        zeros from lost frames would drag the path toward the origin. A centred
        window is used so the smoothed path stays aligned in time rather than
        lagging behind the subject.
        """
        if window < 2 or not self.points:
            return self

        half = window // 2
        smoothed_points = []
        for i, point in enumerate(self.points):
            if not point.found:
                smoothed_points.append(point)
                continue

            neighbours = [
                p.bbox for p in self.points[max(0, i - half): i + half + 1] if p.found
            ]
            mean = np.mean(neighbours, axis=0).astype(int)
            smoothed_points.append(
                TrackPoint(frame=point.frame, time=point.time,
                           bbox=tuple(int(v) for v in mean), found=True)
            )

        return MotionLog(
            video=self.video, fps=self.fps, width=self.width, height=self.height,
            frame_count=self.frame_count, tracker=self.tracker, points=smoothed_points,
        )


def track(
    video_path: str,
    initial_bbox: Bbox,
    tracker: str = "csrt",
    max_frames: Optional[int] = None,
    smooth: int = 7,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> MotionLog:
    """
    Track `initial_bbox` from the first frame onward.

    Args:
        video_path: source clip
        initial_bbox: (x, y, w, h) of the subject on frame 0
        tracker: "csrt" (accurate), "kcf" (faster), "mil" (base opencv)
        max_frames: stop early, useful for previewing a long clip
        smooth: rolling window for jitter removal; 0 disables
        on_progress: called with (frame, total) — for a UI progress bar

    Returns:
        MotionLog with one entry per frame processed.
    """
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        raise RuntimeError(f"could not open video: {video_path}")

    try:
        fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        # CAP_PROP_FRAME_COUNT is an estimate for many containers, so it is used
        # only for progress reporting — never to size the output arrays.
        reported = int(capture.get(cv2.CAP_PROP_FRAME_COUNT)) or 0

        ok, frame = capture.read()
        if not ok:
            raise RuntimeError(f"could not read the first frame of {video_path}")

        x, y, w, h = (int(v) for v in initial_bbox)
        if w <= 0 or h <= 0:
            raise ValueError(f"initial_bbox has non-positive size: {initial_bbox}")
        if x < 0 or y < 0 or x + w > width or y + h > height:
            raise ValueError(
                f"initial_bbox {initial_bbox} falls outside the {width}x{height} frame"
            )

        engine = _create_tracker(tracker)
        engine.init(frame, (x, y, w, h))

        points = [TrackPoint(frame=0, time=0.0, bbox=(x, y, w, h), found=True)]
        index = 1

        while True:
            if max_frames is not None and index >= max_frames:
                break
            ok, frame = capture.read()
            if not ok:
                break

            found, box = engine.update(frame)
            if found:
                bbox = tuple(int(v) for v in box)
            else:
                # Hold the last known box rather than emitting zeros, so anything
                # driven off the log stays put instead of snapping to the corner.
                bbox = points[-1].bbox

            points.append(
                TrackPoint(frame=index, time=index / fps, bbox=bbox, found=bool(found))
            )

            if on_progress and index % 10 == 0:
                on_progress(index, reported or index)
            index += 1

    finally:
        capture.release()

    log = MotionLog(
        video=video_path, fps=fps, width=width, height=height,
        frame_count=len(points), tracker=tracker, points=points,
    )

    ratio = log.found_ratio()
    if ratio < 0.8:
        logger.warning(
            "subject held on only %.0f%% of frames — try a tighter initial box, "
            "a different tracker, or re-seeding mid-clip", ratio * 100
        )

    return log.smoothed(smooth) if smooth > 1 else log


def detect_initial_bbox(video_path: str, method: str = "centre", scale: float = 0.4) -> Bbox:
    """
    Suggest a starting box when there is no UI to draw one.

    "centre" takes a fraction of the frame; "motion" diffs the first two frames
    and boxes the largest moving region, which suits a bird or a person against
    a mostly static background.
    """
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        raise RuntimeError(f"could not open video: {video_path}")

    try:
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))

        if method == "centre":
            w, h = int(width * scale), int(height * scale)
            return ((width - w) // 2, (height - h) // 2, w, h)

        if method == "motion":
            ok, first = capture.read()
            ok2, second = capture.read()
            if not (ok and ok2):
                raise RuntimeError("need at least two frames for motion detection")

            diff = cv2.absdiff(
                cv2.cvtColor(first, cv2.COLOR_BGR2GRAY),
                cv2.cvtColor(second, cv2.COLOR_BGR2GRAY),
            )
            _, mask = cv2.threshold(diff, 25, 255, cv2.THRESH_BINARY)
            mask = cv2.dilate(mask, np.ones((9, 9), np.uint8), iterations=2)

            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                logger.warning("no motion detected; falling back to the centre box")
                return detect_initial_bbox(video_path, "centre", scale)

            x, y, w, h = cv2.boundingRect(max(contours, key=cv2.contourArea))
            if w < 12 or h < 12:
                logger.warning("largest moving region is tiny; falling back to the centre box")
                return detect_initial_bbox(video_path, "centre", scale)
            return (x, y, w, h)

        raise ValueError(f"unknown method {method!r}; expected 'centre' or 'motion'")
    finally:
        capture.release()
