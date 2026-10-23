import { isVisual, mediaKind } from '../../core/project.js';
import { formatClock } from '../../core/time.js';
import { mediaUrl } from '../api.js';

const KIND_LABEL = { video: 'video', audio: 'audio', image: 'image', gif: 'GIF' };

/** Imported files with their preview, transcript and background-removal status. */
export function MediaBin({ project, jobs, commands }) {
  const media = Object.values(project.media);
  const running = (mediaId) => Object.values(jobs).find((j) => j.mediaId === mediaId && j.status === 'running');

  if (!media.length) {
    return (
      <div className="empty">
        <p>No media yet.</p>
        <button className="primary" onClick={commands.importMedia}>Import media</button>
        <p className="hint">Video, audio, images, GIFs and subtitles (.srt, .vtt). Videos go on the main track, images and GIFs on a layer, audio on an audio track. Then press Transcribe for captions.</p>
      </div>
    );
  }
  return (
    <ul className="media-list">
      {media.map((m) => {
        const job = running(m.id);
        const kind = mediaKind(m);
        const used = project.clips.some((c) => c.mediaId === m.id) || (project.tracks ?? []).some((t) => t.items.some((i) => i.mediaId === m.id));
        return (
          <li key={m.id} className="media-item">
            <div className="media-row">
              {(kind === 'image' || kind === 'gif') && <img className="thumb" src={mediaUrl(m.path)} alt="" draggable={false} />}
              <div className="media-text">
                <div className="media-name" title={m.path}>{m.name}</div>
                <div className="media-meta">
                  {KIND_LABEL[kind]}
                  {kind === 'image' ? '' : ` · ${formatClock(m.duration)}`}
                  {isVisual(m) && m.width ? ` · ${m.width}×${m.height}` : ''}
                  {m.words ? ` · ${m.words.length} words` : ''}
                  {m.proxyPath ? ' · preview copy' : ''}
                  {m.cutoutOf ? ' · background removed' : ''}
                </div>
              </div>
            </div>
            {job && (
              <div className="media-job">
                {job.label} <progress value={job.progress ?? 0} max={1} />
              </div>
            )}
            <div className="media-actions">
              {isVisual(m) ? (
                <>
                  <button onClick={() => commands.addToTimeline(m.id)} title="Append to the main track">+ Main</button>
                  <button onClick={() => commands.addAsLayer(m.id)} title="Put on a layer at the playhead (over the main track)">+ Layer</button>
                </>
              ) : (
                <button onClick={() => commands.addAsLayer(m.id)} title="Put on an audio track at the playhead">+ Audio</button>
              )}
              {m.hasAudio && (
                <button onClick={() => commands.transcribe(m.id)} disabled={Boolean(job)}>
                  {m.words ? 'Re-transcribe' : 'Transcribe'}
                </button>
              )}
              {m.hasAudio && (
                <button onClick={() => commands.importTranscript(m.id)} disabled={!m.words || Boolean(job)} title="Time a QC-cleaned transcript (one caption per line) against this file">
                  Clean transcript…
                </button>
              )}
              {m.words?.length > 0 && (
                <button onClick={() => commands.exportMediaCaptions(m.id)} title="Download this file's captions (.srt, in the file's own timing)">⤓ Captions</button>
              )}
              <button
                className="danger"
                onClick={() => (!used || confirm(`Remove ${m.name} and its clips?`)) && commands.removeMedia(m.id)}
                title="Remove from project"
              >
                ✕
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
