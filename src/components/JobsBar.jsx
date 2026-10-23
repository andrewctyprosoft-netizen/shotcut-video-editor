import { useEffect } from 'react';
import { api } from '../api.js';

/** Background jobs (preview copies, transcription, alignment, background removal, export) with progress and cancel. */
export function JobsBar({ jobs, dispatch, commands }) {
  const list = Object.values(jobs);

  // Finished jobs fade out after a few seconds; transcriptions stay longer (they offer the captions file),
  // exports stay (they offer "Show in folder").
  useEffect(() => {
    const timers = list
      .filter((j) => j.status === 'done' && j.kind !== 'export')
      .map((j) => setTimeout(() => dispatch({ type: 'dismissJob', id: j.id }), j.kind === 'transcribe' || j.kind === 'align' ? 15000 : 4000));
    return () => timers.forEach(clearTimeout);
  }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!list.length) return null;
  return (
    <div className="jobs">
      {list.map((j) => (
        <div key={j.id} className={`job ${j.status}`}>
          <div className="job-head">
            <span className="job-label">{j.label}</span>
            {j.status === 'running' ? (
              <button onClick={() => api.cancelJob(j.id)}>Cancel</button>
            ) : (
              <button onClick={() => dispatch({ type: 'dismissJob', id: j.id })} title="Dismiss">✕</button>
            )}
          </div>
          {j.status === 'running' && <progress value={j.progress ?? 0} max={1} />}
          {j.status === 'running' && j.detail && <div className="job-detail">{j.detail}</div>}
          {j.status === 'error' && <pre className="job-error">{j.error}</pre>}
          {j.status === 'cancelled' && <div className="job-detail">Cancelled</div>}
          {j.status === 'done' && j.kind === 'export' && (
            <button className="link" onClick={() => api.showItem(j.result.output)}>Show in folder</button>
          )}
          {j.status === 'done' && (j.kind === 'transcribe' || j.kind === 'align') && (
            <button className="link" onClick={() => commands.exportMediaCaptions(j.result.mediaId)}>Download captions (.srt)</button>
          )}
        </div>
      ))}
    </div>
  );
}
