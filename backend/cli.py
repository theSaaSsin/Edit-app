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


def cmd_collage(args) -> int:
    """Scatter cutouts onto a canvas via the tiled renderer."""
    import random

    from backend.pipeline.tiles import TiledCanvas

    sources = []
    for pattern in args.inputs:
        path = Path(pattern)
        sources.extend(sorted(path.glob("*.png")) if path.is_dir() else [path])
    if not sources:
        logger.error("no input images found")
        return 1

    rng = random.Random(args.seed)
    canvas = TiledCanvas(background=(1.0, 1.0, 1.0, 1.0) if args.opaque else (0, 0, 0, 0),
                         tile_size=args.tile)

    for i in range(args.count):
        src = sources[i % len(sources)]
        canvas.add_layer(
            Image.open(src),
            name=f"{src.stem}_{i}",
            position=(rng.uniform(0, args.width), rng.uniform(0, args.height)),
            scale=rng.uniform(args.min_scale, args.max_scale),
            rotation=rng.uniform(-args.max_rotation, args.max_rotation),
        )

    box = (0, 0, args.width, args.height)
    logger.info(
        "canvas %dx%d, %d layers, flatten needs ~%.2f GB",
        args.width, args.height, len(canvas.layers),
        canvas.estimate_flatten_bytes(box) / 1e9,
    )

    out = Path(args.output)
    if args.tiles:
        paths = canvas.export_tiles(out, box=box)
        logger.info("wrote %d tiles to %s", len(paths), out)
    else:
        out.parent.mkdir(parents=True, exist_ok=True)
        canvas.flatten(box).save(out)
        logger.info("wrote %s", out)
    return 0


def cmd_relight(args) -> int:
    """Relight a cutout on a remote GPU Space, falling back to a local adjustment."""
    from backend.services.remote_relight import relight_or_local

    cutout = Image.open(args.input).convert("RGBA")
    relit, backend = relight_or_local(
        cutout,
        space_id=args.space,
        direction=args.direction,
        intensity=args.intensity,
        prompt=args.prompt,
        steps=args.steps,
        seed=args.seed,
    )

    if backend == "local" and args.require_remote:
        logger.error("remote relight unavailable and --require-remote was set")
        return 1

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    relit.save(out)

    if backend == "local":
        logger.warning(
            "used the LOCAL fallback (brightness/contrast only, not a neural relight). "
            "Pass --space <user>/<space> or set RELIGHT_SPACE for real relighting."
        )
    logger.info("wrote %s via %s backend", out, backend)
    return 0


def cmd_doctor(args) -> int:
    """Report what is installed and what each missing piece would unlock."""
    import importlib.util
    import shutil

    def has(module: str) -> bool:
        try:
            return importlib.util.find_spec(module) is not None
        except (ImportError, ValueError):
            return False

    core = [
        ("numpy", has("numpy")),
        ("PIL (pillow)", has("PIL")),
        ("cv2 (opencv)", has("cv2")),
    ]
    optional = [
        ("PyQt6", has("PyQt6"), "desktop studio", "pip install PyQt6"),
        ("rembg", has("rembg"), "automatic background removal", 'pip install "rembg[cpu]"'),
        ("gmic", shutil.which("gmic") is not None, "texture and style filters",
         "sudo apt install gmic  (or brew install gmic)"),
        ("ffmpeg", shutil.which("ffmpeg") is not None, "video carousel slicing",
         "sudo apt install ffmpeg"),
        ("gradio_client", has("gradio_client"), "remote GPU relighting",
         "pip install gradio_client"),
        ("torch", has("torch"), "local GPU relighting (needs CUDA)",
         "pip install -r backend/requirements.txt"),
    ]

    print("\nCore (required)")
    core_ok = True
    for name, ok in core:
        print(f"  {'✓' if ok else '✗'} {name}")
        core_ok &= ok
    if not core_ok:
        print("\n  Install with:  pip install -r backend/requirements-cpu.txt")

    print("\nOptional")
    for name, ok, unlocks, how in optional:
        print(f"  {'✓' if ok else '·'} {name:15s} {unlocks}")
        if not ok:
            print(f"      → {how}")

    if shutil.which("gmic"):
        from backend.pipeline import gmic_fx
        presets = gmic_fx.available_presets()
        print(f"\nG'MIC: {gmic_fx.version()}")
        print(f"  {len(presets)}/{len(gmic_fx.PRESETS)} presets usable on this build")
        if len(presets) < len(gmic_fx.PRESETS):
            missing = sorted(set(gmic_fx.PRESETS) - set(presets))
            print(f"  unavailable here: {', '.join(missing)}")

    print("\nWhat you can run now")
    if core_ok:
        print("  python -m backend.cli fx cutout.png out.png --style torn_paper")
        print("  python -m backend.cli collage cutouts/ collage.png")
    if has("PyQt6"):
        print("  python -m backend.cli studio            ← the main app")
    if shutil.which("gmic"):
        print("  python -m backend.cli gmic in.png out.png --preset oil_paint")
    if shutil.which("ffmpeg"):
        print("  python -m backend.cli slice master.mp4 panels/")
    print()
    return 0 if core_ok else 1


def cmd_gmic(args) -> int:
    from backend.pipeline import gmic_fx

    if args.list:
        if not gmic_fx.is_available():
            logger.error("G'MIC is not installed. Try: sudo apt install gmic")
            return 1
        for name, description, ok in gmic_fx.describe_presets():
            print(f"  {'✓' if ok else '·'} {name:16s} {description}")
        return 0

    if not args.input or not args.output:
        logger.error("input and output are required unless --list is given")
        return 1

    src = Image.open(args.input)
    styles = gmic_fx.available_presets() if args.preset == "all" else [args.preset]

    if len(styles) > 1:
        out_dir = Path(args.output)
        out_dir.mkdir(parents=True, exist_ok=True)
        targets = {s: out_dir / f"{Path(args.input).stem}_{s}.png" for s in styles}
    else:
        targets = {styles[0]: Path(args.output)}
        targets[styles[0]].parent.mkdir(parents=True, exist_ok=True)

    for style in styles:
        result = gmic_fx.apply_preset(src, style, strength=args.strength)
        result.save(targets[style])
        logger.info("wrote %s", targets[style])
    return 0


def cmd_studio(args) -> int:
    from backend.ui.studio import main as studio_main

    argv = ["studio"] + ([args.image] if args.image else [])
    return studio_main(argv)


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

    co = sub.add_parser("collage", help="scatter cutouts onto a tiled canvas")
    co.add_argument("inputs", nargs="+", help="cutout PNGs, or directories of them")
    co.add_argument("output", help="output PNG, or a directory when --tiles")
    co.add_argument("--count", type=int, default=30, help="how many pieces to place")
    co.add_argument("--width", type=int, default=4000)
    co.add_argument("--height", type=int, default=4000)
    co.add_argument("--min-scale", type=float, default=0.3)
    co.add_argument("--max-scale", type=float, default=1.0)
    co.add_argument("--max-rotation", type=float, default=25.0)
    co.add_argument("--tile", type=int, default=512, help="tile size in px")
    co.add_argument("--tiles", action="store_true", help="write tiles instead of one image")
    co.add_argument("--opaque", action="store_true", help="white background instead of transparent")
    co.add_argument("--seed", type=int, default=None)
    co.set_defaults(func=cmd_collage)

    dr = sub.add_parser("doctor", help="check what is installed and what it unlocks")
    dr.set_defaults(func=cmd_doctor)

    st = sub.add_parser("studio", help="launch the desktop studio")
    st.add_argument("image", nargs="?", default=None)
    st.set_defaults(func=cmd_studio)

    gm = sub.add_parser("gmic", help="apply a G'MIC texture or style preset")
    gm.add_argument("input", nargs="?")
    gm.add_argument("output", nargs="?", help="file, or a directory when --preset all")
    gm.add_argument("--preset", default="oil_paint", help="preset name, or 'all'")
    gm.add_argument("--strength", type=float, default=1.0, help="0.0-1.0 blend back to original")
    gm.add_argument("--list", action="store_true", help="list presets and exit")
    gm.set_defaults(func=cmd_gmic)

    rl = sub.add_parser("relight", help="relight a cutout on a remote GPU Space")
    rl.add_argument("input")
    rl.add_argument("output")
    rl.add_argument("--space", default=None,
                    help="Space id like user/relight-endpoint (or set RELIGHT_SPACE)")
    rl.add_argument("--direction", default="front",
                    choices=["front", "side", "back", "rim", "fill", "top", "bottom"])
    rl.add_argument("--intensity", type=float, default=1.0, help="0.5-2.0")
    rl.add_argument("--prompt", default="", help="extra prompt, e.g. 'golden hour'")
    rl.add_argument("--steps", type=int, default=24)
    rl.add_argument("--seed", type=int, default=0, help="0 = random")
    rl.add_argument("--require-remote", action="store_true",
                    help="fail instead of silently using the local fallback")
    rl.set_defaults(func=cmd_relight)

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
