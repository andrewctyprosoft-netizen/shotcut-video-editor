import { useMemo, useState } from 'react';
import { removeSourceRanges } from '../../core/project.js';
import { fillerRanges, pauseRanges, rangesForWords, setWordText } from '../../core/transcript.js';

const key = (w) => `${w.mediaId}:${w.index}`;

/**
 * Text-based editing: click a word to jump there, Shift+click to select a run, then cut it.
 * Double-click a word to fix its spelling. Fillers and long pauses can be removed in one go.
 */
export function TranscriptPanel({ project, words, time, edit, onSeek }) {
  const [sel, setSel] = useState({ anchor: null, keys: new Set() });
  const [editing, setEditing] = useState(null);
  const [minGap, setMinGap] = useState(0.8);
  const order = useMemo(() => words.map(key), [words]);

  if (!words.length) {
    return <p className="hint pad">No transcript on the timeline yet. In Media, press Transcribe on a file.</p>;
  }

  const click = (w, e) => {
    const k = key(w);
    if (e.shiftKey && sel.anchor) {
      const [a, b] = [order.indexOf(sel.anchor), order.indexOf(k)].sort((x, y) => x - y);
      setSel({ anchor: sel.anchor, keys: new Set(order.slice(a, b + 1)) });
    } else {
      setSel({ anchor: k, keys: new Set([k]) });
      onSeek(w.start + 0.001);
    }
  };

  const cutSelection = () => {
    const chosen = words.filter((w) => sel.keys.has(key(w)));
    const byMedia = Map.groupBy(chosen, (w) => w.mediaId);
    // Cut by the words' source times, so every clip of that media loses them.
    edit((p) => [...byMedia].reduce(
      (acc, [mediaId, ws]) => removeSourceRanges(acc, mediaId, rangesForWords(ws.map((w) => acc.media[mediaId].words[w.index]))),
      p,
    ));
    setSel({ anchor: null, keys: new Set() });
  };

  const usedMedia = [...new Set(words.map((w) => w.mediaId))].map((id) => project.media[id]);
  const removeAll = (rangesOf) => edit((p) => usedMedia.reduce((acc, m) => removeSourceRanges(acc, m.id, rangesOf(m)), p));
  const fillerCount = fillerRanges(words).length; // fillers still on the timeline

  return (
    <div className="transcript">
      <div className="transcript-tools">
        <button onClick={cutSelection} disabled={!sel.keys.size} title="Remove the selected words from the video">
          Cut {sel.keys.size || ''} word{sel.keys.size === 1 ? '' : 's'}
        </button>
        <button onClick={() => removeAll((m) => fillerRanges(m.words))} disabled={!fillerCount} title="um, uh, erm, ah, hmm">
          Remove fillers ({fillerCount})
        </button>
        <span className="gap-tool">
          <button onClick={() => removeAll((m) => pauseRanges(m.words, m.duration, minGap))}>Remove pauses</button>
          over
          <input type="number" min={0.3} max={5} step={0.1} value={minGap} onChange={(e) => setMinGap(Number(e.target.value))} />s
        </span>
      </div>
      <div className="words">
        {words.map((w) => {
          const k = key(w);
          const now = time >= w.start && time < w.end;
          if (editing === k) {
            return (
              <input
                key={k}
                className="word-edit"
                autoFocus
                defaultValue={w.text}
                onBlur={(e) => {
                  edit((p) => setWordText(p, w.mediaId, w.index, e.target.value || w.text));
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setEditing(null);
                }}
              />
            );
          }
          return (
            <span
              key={k}
              className={`word${now ? ' now' : ''}${sel.keys.has(k) ? ' sel' : ''}`}
              onClick={(e) => click(w, e)}
              onDoubleClick={() => setEditing(k)}
            >
              {w.text}
              {w.br ? <br /> : ' '}
            </span>
          );
        })}
      </div>
    </div>
  );
}
