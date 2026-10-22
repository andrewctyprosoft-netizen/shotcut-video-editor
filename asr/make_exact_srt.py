"""Align clean subtitle text to ASR word timings and write an .srt.

The transcript controls the text, the audio (via ASR word timestamps) controls the timing.
Usage: py -3.11 -I scripts/make_exact_srt.py <clean_text.txt> <words.json> <out.srt>
  clean_text.txt: one subtitle cue per non-empty line (a leading [HH:MM:SS.s] is ignored).
  words.json:     [{"word","start","end"}, ...] from faster-whisper.
"""
import difflib
import json
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")

START_PAD, END_PAD = -0.03, 0.05
MIN_DUR, MIN_GAP, MAX_WORD = 0.45, 0.02, 1.0
LONG, SHORT = 8.0, 0.7
TS_PREFIX = re.compile(r"^\[\d\d:\d\d:\d\d(?:\.\d)?\]\s?")
# Alignment-only normalisation (never used in the output text).
DOMAIN_MAP = {"flora": "flaura"}


def norm(tok: str) -> str:
    t = re.sub(r"[^0-9a-z]", "", tok.lower().replace("\u2019", "'"))
    return DOMAIN_MAP.get(t, t)


def read_lines(path: str) -> list[str]:
    with open(path, encoding="utf-8") as f:
        return [TS_PREFIX.sub("", ln.rstrip("\n")).strip() for ln in f if ln.strip()]


def align(lines: list[str], words: list[dict]) -> tuple[list[tuple[int, int]], list[tuple[float, float]]]:
    """Return per-line (first_token, last_token+1) spans and per-token (start, end) times."""
    toks = [t for ln in lines for t in ln.split()]
    spans, k = [], 0
    for ln in lines:
        n = len(ln.split())
        spans.append((k, k + n))
        k += n
    a = [norm(t) for t in toks]
    b = [norm(w["word"]) for w in words]
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    times: list[tuple[float, float] | None] = [None] * len(toks)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal" or (tag == "replace" and i2 - i1 == j2 - j1 and i2 - i1 <= 3):
            for d in range(i2 - i1):
                times[i1 + d] = (words[j1 + d]["start"], words[j1 + d]["end"])
    matched = sum(t is not None for t in times)
    # Interpolate unmatched tokens between matched neighbours.
    i = 0
    while i < len(toks):
        if times[i] is not None:
            i += 1
            continue
        j = i
        while j < len(toks) and times[j] is None:
            j += 1
        a0 = times[i - 1][1] if i > 0 else 0.0
        b0 = times[j][0] if j < len(toks) else a0 + 0.35 * (j - i)
        step = (b0 - a0) / (j - i) if b0 > a0 else 0.2
        for q in range(i, j):
            s = a0 + step * (q - i)
            times[q] = (s, s + step)
        i = j
    print(f"tokens matched to ASR words: {matched}/{len(toks)} ({100 * matched / len(toks):.1f}%)")
    return spans, times  # type: ignore[return-value]


def line_times(spans, times) -> list[list[float]]:
    cues = []
    for s, e in spans:
        st = times[s][0]
        ls, le = times[e - 1]
        en = ls + min(le - ls, MAX_WORD) if le > ls else ls + 0.3
        cues.append([st, max(en, st + 0.1)])
    return cues


def polish(cues: list[list[float]]) -> list[list[float]]:
    for c in cues:
        c[0] = max(0.0, c[0] + START_PAD)
        c[1] += END_PAD
    for i in range(1, len(cues)):  # strictly increasing starts
        if cues[i][0] < cues[i - 1][0] + 0.05:
            cues[i][0] = cues[i - 1][0] + 0.05
    for i, c in enumerate(cues):
        nxt = cues[i + 1][0] - MIN_GAP if i + 1 < len(cues) else float("inf")
        if c[1] - c[0] < MIN_DUR:
            c[1] = c[0] + MIN_DUR
        c[1] = min(c[1], nxt)
        if c[1] - c[0] < MIN_DUR and i > 0:  # overlapping interjection: borrow the silent gap before it
            c[0] = max(cues[i - 1][1] + MIN_GAP, c[1] - MIN_DUR, 0.0)
        if c[1] <= c[0]:
            c[1] = c[0] + 0.1
    return cues


def redistribute(cues: list[list[float]], lines: list[str]) -> int:
    """Spread time by word count across LONG<->SHORT neighbour runs (skill step 14)."""
    fixed, i = 0, 0
    while i < len(cues) - 1:
        d = [c[1] - c[0] for c in cues[i:i + 3]]
        run = None
        if d[0] > LONG and all(x < SHORT for x in d[1:2]):
            run = i
        elif d[0] < SHORT and len(d) > 1 and d[1] > LONG:
            run = i
        if run is None:
            i += 1
            continue
        j = run + 1
        while j + 1 < len(cues) and (cues[j + 1][1] - cues[j + 1][0] < SHORT or cues[j][1] - cues[j][0] > LONG):
            j += 1
            if j - run >= 4:
                break
        words = [len(lines[q].split()) for q in range(run, j + 1)]
        start, end = cues[run][0], cues[j][1]
        pos = start
        for q, w in zip(range(run, j + 1), words):
            share = max(MIN_DUR, (end - start) * w / sum(words))
            cues[q][0], cues[q][1] = pos, min(end, pos + share - MIN_GAP)
            pos += share
        fixed += 1
        i = j + 1
    return fixed


def srt_time(sec: float) -> str:
    ms = int(round(sec * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def main() -> None:
    clean, words_path, out = sys.argv[1:4]
    lines = read_lines(clean)
    with open(words_path, encoding="utf-8") as f:
        words = json.load(f)
    spans, times = align(lines, words)
    cues = polish(line_times(spans, times))
    print("LONG<->SHORT runs redistributed:", redistribute(cues, lines))
    cues = polish_overlaps(cues)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        for n, (c, text) in enumerate(zip(cues, lines), start=1):
            f.write(f"{n}\n{srt_time(c[0])} --> {srt_time(c[1])}\n{text}\n\n")
    d = [c[1] - c[0] for c in cues]
    print(f"{len(cues)} cues; duration min {min(d):.2f}s, max {max(d):.2f}s, mean {sum(d) / len(d):.2f}s -> {out}")


def polish_overlaps(cues: list[list[float]]) -> list[list[float]]:
    for i in range(len(cues) - 1):
        if cues[i][1] > cues[i + 1][0] - MIN_GAP:
            cues[i][1] = cues[i + 1][0] - MIN_GAP
        if cues[i][1] <= cues[i][0]:
            cues[i][1] = cues[i][0] + 0.05
            cues[i + 1][0] = max(cues[i + 1][0], cues[i][1] + MIN_GAP)
    return cues


if __name__ == "__main__":
    main()
