import { formatClock } from '../../core/time.js';

/** Imported files with their preview and transcript status. */
export function MediaBin({ project, jobs, commands }) {
  const media = Object.values(project.media);
  const running = (mediaId) => Object.values(jobs).find((j) => j.mediaId === mediaId && j.status === 'running');

  if (!media.length) {
    return (
      <div className="empty">
        <p>No media yet.</p>
        <button className="primary" onClick={commands.importMedia}>Import video or audio</button>
        <p className="hint">Files are added to the end of the timeline. Then press Transcribe for captions.</p>
      </div>
    );
  }
  return (
    <ul className="media-list">
      {media.map((m) => {
        const job = running(m.id);
        const used = project.clips.some((c) => c.mediaId === m.id);
        return (
          <li key={m.id} className="media-item">
            <div className="media-name" title={m.path}>{m.name}</div>
            <div className="media-meta">
              {formatClock(m.duration)}
              {m.hasVideo ? ` · ${m.width}×${m.height}` : ' · audio'}
              {m.words ? ` · ${m.words.length} words` : ''}
              {m.proxyPath ? ' · preview copy' : ''}
            </div>
            {job && (
              <div className="media-job">
                {job.label} <progress value={job.progress ?? 0} max={1} />
              </div>
            )}
            <div className="media-actions">
              <button onClick={() => commands.addToTimeline(m.id)} title="Append to the timeline">+ Timeline</button>
              <button onClick={() => commands.transcribe(m.id)} disabled={Boolean(job)}>
                {m.words ? 'Re-transcribe' : 'Transcribe'}
              </button>
              <button onClick={() => commands.importTranscript(m.id)} disabled={!m.words || Boolean(job)} title="Time a QC-cleaned transcript (one caption per line) against this file">
                Clean transcript…
              </button>
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
