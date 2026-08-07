"""
Command-line entry point for the CPU-only parts of the workspace.

Runs without torch, so it works on any laptop:

    python -m backend.cli fx in.png out.png --style torn_paper --width 30
    python -m backend.cli fx in.png out/ --style all
    python -m backend.cli cutout photo.jpg cut.png          # needs rembg
    python -m backend.cli slice master.mp4 panels/ --slides 4
"""

import argparse
import logging
import sys
from pathlib import Path

from PIL import Image

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("edit-app")


def cmd_fx(args) -> int:
    from backend.pipeline.edge_fx import EdgeFXEngine, EDGE_STYLES

    src = Image.open(args.input)
    engine = EdgeFXEngine()

    styles = [s for s in EDGE_STYLES if s != "none"] if args.style == "all" else [args.style]

    if len(styles) > 1:
        out_dir = Path(args.output)
        out_dir.mkdir(parents=True, exist_ok=True)
        targets = {s: out_dir / f"{Path(args.input).stem}_{s}.png" for s in styles}
    else:
        targets = {styles[0]: Path(args.output)}
        targets[styles[0]].parent.mkdir(parents=True, exist_ok=True)

    for style in styles:
        result = engine.apply(
            src, style=style, intensity=args.intensity, width=args.width, seed=args.seed
        )
        result.save(targets[style])
        logger.info("wrote %s (%dx%d)", targets[style], *result.size)

    return 0


def cmd_cutout(args) -> int:
    try:
        from rembg import remove
    except ImportError:
        logger.error("rembg is not installed. Run: pip install \"rembg[cpu]\"")
        return 1

    src = Image.open(args.input).convert("RGBA")
    cut = remove(src)

    if args.style != "none":
        from backend.pipeline.edge_fx import EdgeFXEngine
        cut = EdgeFXEngine().apply(
            cut, style=args.style, intensity=args.intensity, width=args.width, seed=args.seed
        )

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    cut.save(out)
    logger.info("wrote %s (%dx%d)", out, *cut.size)
    return 0


def cmd_slice(args) -> int:
    from backend.pipeline.video_engine import VideoCarouselEngine

    result = VideoCarouselEngine().slice_carousel_video(
        args.input, args.output, total_slides=args.slides, quality=args.quality
    )
    if result["status"] != "success":
        logger.error("slice failed: %s", result.get("error"))
        return 1

    for panel in result["panels"]:
        logger.info("wrote %s", panel)
    return 0


def build_parser() -> argparse.ArgumentParser:
    from backend.pipeline.edge_fx import EDGE_STYLES

    parser = argparse.ArgumentParser(prog="backend.cli", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    fx = sub.add_parser("fx", help="apply a procedural edge material to a cutout")
    fx.add_argument("input")
    fx.add_argument("output", help="output file, or a directory when --style all")
    fx.add_argument("--style", default="torn_paper", choices=[*EDGE_STYLES, "all"])
    fx.add_argument("--intensity", type=float, default=1.0, help="0.0-2.0 (default 1.0)")
    fx.add_argument("--width", type=int, default=24, help="edge size in px (default 24)")
    fx.add_argument("--seed", type=int, default=None, help="fix the noise for repeatable output")
    fx.set_defaults(func=cmd_fx)

    cut = sub.add_parser("cutout", help="remove background, optionally applying an edge style")
    cut.add_argument("input")
    cut.add_argument("output")
    cut.add_argument("--style", default="none", choices=EDGE_STYLES)
    cut.add_argument("--intensity", type=float, default=1.0)
    cut.add_argument("--width", type=int, default=24)
    cut.add_argument("--seed", type=int, default=None)
    cut.set_defaults(func=cmd_cutout)

    sl = sub.add_parser("slice", help="cut a wide master video into carousel panels")
    sl.add_argument("input")
    sl.add_argument("output", help="output directory")
    sl.add_argument("--slides", type=int, default=4)
    sl.add_argument("--quality", default="medium", choices=["low", "medium", "high"])
    sl.set_defaults(func=cmd_slice)

    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except FileNotFoundError as e:
        logger.error("file not found: %s", e.filename or e)
        return 1
    except Exception as e:
        logger.error("%s", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
