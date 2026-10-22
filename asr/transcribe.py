"""Transcribe a media file with faster-whisper and write word timings.

Adapted from Transcript QC (05_Review_QC/Transcript QC, scripts/run_asr.py): same model settings
(beam 5, VAD, no conditioning on previous text) and the same words.json format.

Usage: python transcribe.py <media> <words.json> [--model PATH_OR_NAME] [--language en] [--threads 8]
Prints JSON lines on stdout: {"type": "info"|"progress"|"done", ...}.
"""
import argparse
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")  # python -I ignores PYTHONIOENCODING (lesson L-python-008)


def emit(**msg: object) -> None:
    """Write one JSON progress line for the Electron main process."""
    print(json.dumps(msg, ensure_ascii=False), flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("out")
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default="en")
    ap.add_argument("--threads", type=int, default=max(1, min(8, os.cpu_count() or 4)))
    args = ap.parse_args()

    if os.path.isdir(args.model):
        # A local model folder: never touch the network (a stalled HF download hangs silently, lesson L-python-007).
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_XET"] = "1"
    from faster_whisper import WhisperModel

    emit(type="info", stage="loading model", model=args.model)
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=args.threads)
    segments, info = model.transcribe(
        args.media,
        language=args.language or None,
        word_timestamps=True,
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    emit(type="info", stage="transcribing", duration=round(info.duration, 2), language=info.language)

    words = []
    for seg in segments:
        for w in seg.words or []:
            words.append({"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)})
        emit(type="progress", seconds=round(seg.end, 2), duration=round(info.duration, 2), text=seg.text.strip())

    tmp = args.out + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(words, f, indent=1, ensure_ascii=False)
    os.replace(tmp, args.out)
    emit(type="done", words=len(words))


if __name__ == "__main__":
    main()
