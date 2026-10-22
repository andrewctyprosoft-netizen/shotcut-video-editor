// window.api comes from electron/preload.cjs. In a plain browser (vite dev without Electron) a stub keeps the UI usable.

const unavailable = async () => {
  throw new Error('Run the app in Electron (npm run dev) to use files and jobs.');
};

const stub = {
  getSettings: async () => ({}),
  setSettings: async (s) => s,
  toolStatus: unavailable,
  pickMedia: unavailable,
  openProject: unavailable,
  saveProject: unavailable,
  pickTranscript: unavailable,
  saveSrt: unavailable,
  pickExportPath: unavailable,
  exportEncoder: async () => 'libx264',
  showItem: unavailable,
  startJob: unavailable,
  cancelJob: async () => {},
  onJob: () => () => {},
  onProjectLoaded: () => () => {},
};

export const api = window.api ?? stub;

/**
 * URL the preview uses for a local file (served by the media:// protocol in the main process).
 * @param {string} path
 * @returns {string}
 */
export function mediaUrl(path) {
  return `media://file/${encodeURIComponent(path)}`;
}
