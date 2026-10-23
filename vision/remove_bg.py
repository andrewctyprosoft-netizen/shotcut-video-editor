"""Remove the background of an image, GIF or video with a U2-Net family ONNX model (the models rembg uses).

Frames are decoded by FFmpeg, masked here, and encoded by FFmpeg again with an alpha channel:
PNG for an image, APNG for a GIF, VP9 WebM for a video (its audio copied as Opus).
Progress is printed as JSON lines: {"type": "progress", "fraction": 0.42}.

Usage:
    python remove_bg.py INPUT OUTPUT --kind video --width 1920 --height 1080 --fps 30 --duration 12.5
        --model silueta.onnx --size 320 [--ffmpeg ffmpeg] [--mean 0.485 0.456 0.406] [--std 0.229 0.224 0.225]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image

SMOOTH = 0.35  # weight of the previous frame's mask in a video (less flicker)


def log(msg: dict) -> None:
    """Print one JSON line for the Electron side."""
    print(json.dumps(msg), flush=True)


class Matte:
    """Foreground mask from a U2-Net style model: input 1x3xSxS normalised RGB, output 1x1xSxS."""

    def __init__(self, model: str, size: int, mean: list[float], std: list[float]) -> None:
        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(model, opts, providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name
        self.size = size
        self.mean = np.array(mean, np.float32)
        self.std = np.array(std, np.float32)

    def mask(self, rgb: np.ndarray) -> np.ndarray:
        """Alpha in 0..1 at the frame's size for an HxWx3 uint8 frame."""
        h, w = rgb.shape[:2]
        im = Image.fromarray(rgb).resize((self.size, self.size), Image.BILINEAR)
        x = np.asarray(im, np.float32)
        x = x / max(float(x.max()), 1e-6)
        x = (x - self.mean) / self.std
        x = x.transpose(2, 0, 1)[None].astype(np.float32)
        pred = self.session.run(None, {self.input: x})[0][0, 0]
        lo, hi = float(pred.min()), float(pred.max())
        pred = (pred - lo) / max(hi - lo, 1e-6)
        m = Image.fromarray((pred * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)
        return np.asarray(m, np.float32) / 255.0


def run_image(args: argparse.Namespace, matte: Matte) -> None:
    """Single still: PIL in, PNG with alpha out."""
    rgb = np.asarray(Image.open(args.input).convert("RGB"))
    alpha = matte.mask(rgb)
    rgba = np.dstack([rgb, (alpha * 255).astype(np.uint8)])
    Image.fromarray(rgba, "RGBA").save(args.output)
    log({"type": "progress", "fraction": 1})


def run_frames(args: argparse.Namespace, matte: Matte) -> None:
    """Video or GIF: FFmpeg decodes RGB frames, we add alpha, FFmpeg encodes them."""
    w, h, fps = args.width, args.height, args.fps
    decode = [args.ffmpeg, "-v", "error", "-i", args.input, "-map", "0:v:0", "-fps_mode", "cfr", "-r", str(fps),
              "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw_in = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-"]
    if args.kind == "gif":
        encode = [args.ffmpeg, "-v", "error", "-y", *raw_in, "-plays", "0", "-f", "apng", args.output]
    else:
        encode = [args.ffmpeg, "-v", "error", "-y", *raw_in, "-i", args.input, "-map", "0:v", "-map", "1:a:0?",
                  "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-b:v", "0", "-crf", "30",
                  "-row-mt", "1", "-deadline", "good", "-cpu-used", "5", "-c:a", "libopus", "-b:a", "128k", "-shortest",
                  args.output]
    total = max(1, round(args.duration * fps))
    frame_bytes = w * h * 3
    dec = subprocess.Popen(decode, stdout=subprocess.PIPE)
    enc = subprocess.Popen(encode, stdin=subprocess.PIPE)
    prev = None
    n = 0
    try:
        while True:
            buf = dec.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            rgb = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            alpha = matte.mask(rgb)
            if prev is not None:
                alpha = (1 - SMOOTH) * alpha + SMOOTH * prev
            prev = alpha
            enc.stdin.write(np.dstack([rgb, (alpha * 255).astype(np.uint8)]).tobytes())
            n += 1
            if n % 5 == 0:
                log({"type": "progress", "fraction": min(1.0, n / total)})
    finally:
        enc.stdin.close()
        dec.stdout.close()
        dec.wait()
        code = enc.wait()
    if code != 0:
        sys.exit(f"FFmpeg encoder failed with exit code {code}")
    if n == 0:
        sys.exit("No frames decoded")
    log({"type": "progress", "fraction": 1})


def main() -> None:
    """Parse arguments and remove the background."""
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # python -I ignores PYTHONIOENCODING (lesson L-python-008)
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--kind", choices=["image", "gif", "video"], required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--size", type=int, default=320)
    p.add_argument("--mean", type=float, nargs=3, default=[0.485, 0.456, 0.406])
    p.add_argument("--std", type=float, nargs=3, default=[0.229, 0.224, 0.225])
    p.add_argument("--width", type=int, default=0)
    p.add_argument("--height", type=int, default=0)
    p.add_argument("--fps", type=float, default=30)
    p.add_argument("--duration", type=float, default=0)
    p.add_argument("--ffmpeg", default="ffmpeg")
    args = p.parse_args()
    matte = Matte(args.model, args.size, args.mean, args.std)
    if args.kind == "image":
        run_image(args, matte)
    else:
        run_frames(args, matte)


if __name__ == "__main__":
    main()
