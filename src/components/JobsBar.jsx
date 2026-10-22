import { useEffect } from 'react';
import { api } from '../api.js';

/** Background jobs (preview copies, transcription, alignment, export) with progress and cancel. */
export function JobsBar({ jobs, dispatch }) {
  const list = Object.values(jobs);

  // Finished jobs (except exports, which offer "Show in folder") fade out after a few seconds.
  useEffect(() => {
    const timers = list
      .filter((j) => j.status === 'done' && j.kind !== 'export')
      .map((j) => setTimeout(() => dispatch({ type: 'dismissJob', id: j.id }), 4000));
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
        </div>
      ))}
    </div>
  );
}
