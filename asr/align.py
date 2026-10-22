"""Align a clean transcript to ASR word timings; the transcript controls the text, the audio the timing.

Uses the Transcript QC aligner (make_exact_srt.py, copied unchanged) and returns editor words
instead of an .srt: every token of the clean text gets a time, and the last token of each line
carries "br": true so the editor keeps the line as one caption.

Usage: python align.py <clean.txt> <words.json> <out.json>
  clean.txt: one caption per non-empty line (a leading [HH:MM:SS.s] is ignored).
  words.json: [{"word","start","end"}, ...] from transcribe.py.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(encoding="utf-8")

from make_exact_srt import align, line_times, polish, polish_overlaps, read_lines, redistribute  # noqa: E402


def aligned_words(lines: list[str], asr_words: list[dict]) -> list[dict]:
    """Return [{"word","start","end","br"?}] for every token of the clean lines."""
    spans, times = align(lines, asr_words)
    cues = polish(line_times(spans, times))
    redistribute(cues, lines)
    cues = polish_overlaps(cues)
    tokens = [t for ln in lines for t in ln.split()]
    out = []
    for (s, e), (c0, c1) in zip(spans, cues):
        for k in range(s, e):
            ws, we = times[k]
            start = min(max(ws, c0), c1)
            end = min(max(we, start + 0.02), c1)
            word = {"word": tokens[k], "start": round(start, 3), "end": round(end, 3)}
            if k == e - 1:
                word["br"] = True
            out.append(word)
    return out


def main() -> None:
    clean, words_path, out = sys.argv[1:4]
    lines = read_lines(clean)
    with open(words_path, encoding="utf-8") as f:
        asr_words = json.load(f)
    if not lines or not asr_words:
        raise SystemExit("Nothing to align: the transcript or the ASR words are empty.")
    words = aligned_words(lines, asr_words)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(words, f, indent=1, ensure_ascii=False)
    print(json.dumps({"type": "done", "words": len(words), "lines": len(lines)}), flush=True)


if __name__ == "__main__":
    main()
