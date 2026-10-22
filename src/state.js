// Editor state: the project with undo/redo history, plus UI state (time, selection, jobs).

import { createProject } from '../core/project.js';

const HISTORY = 100;
const COALESCE_MS = 1000;

export const initialState = {
  project: createProject(),
  past: [],
  future: [],
  lastEdit: null,
  filePath: null,
  dirty: false,
  time: 0,
  playing: false,
  selectedClipId: null,
  jobs: {},
};

/**
 * @param {typeof initialState} state
 * @param {{type: string, [key: string]: any}} action
 * @returns {typeof initialState}
 */
export function reducer(state, action) {
  switch (action.type) {
    case 'edit': {
      // fn(project) => project. Edits with the same `coalesce` key within a second share one undo step (sliders).
      let next;
      try {
        next = action.fn(state.project);
      } catch (err) {
        console.error(err);
        return state;
      }
      if (next === state.project) return state;
      const now = Date.now();
      const merge = action.coalesce && state.lastEdit?.key === action.coalesce && now - state.lastEdit.at < COALESCE_MS;
      return {
        ...state,
        project: next,
        past: merge ? state.past : [...state.past.slice(-HISTORY + 1), state.project],
        future: [],
        lastEdit: { key: action.coalesce ?? null, at: now },
        dirty: true,
      };
    }
    case 'patchAll':
      // Facts that are true in every history state (e.g. a proxy file now exists).
      return {
        ...state,
        project: action.fn(state.project),
        past: state.past.map(action.fn),
        future: state.future.map(action.fn),
      };
    case 'undo': {
      if (!state.past.length) return state;
      const project = state.past[state.past.length - 1];
      return { ...state, project, past: state.past.slice(0, -1), future: [state.project, ...state.future], lastEdit: null, dirty: true };
    }
    case 'redo': {
      if (!state.future.length) return state;
      const [project, ...future] = state.future;
      return { ...state, project, past: [...state.past, state.project], future, lastEdit: null, dirty: true };
    }
    case 'load':
      return { ...initialState, jobs: state.jobs, project: action.project, filePath: action.filePath ?? null, time: action.time ?? 0 };
    case 'saved':
      return { ...state, filePath: action.filePath, dirty: false };
    case 'time':
      return { ...state, time: Math.max(0, action.time) };
    case 'play':
      return { ...state, playing: action.playing };
    case 'select':
      return { ...state, selectedClipId: action.clipId };
    case 'job': {
      const prev = state.jobs[action.job.id] ?? {};
      return { ...state, jobs: { ...state.jobs, [action.job.id]: { ...prev, ...action.job } } };
    }
    case 'dismissJob': {
      const { [action.id]: _gone, ...jobs } = state.jobs;
      return { ...state, jobs };
    }
    default:
      throw new Error(`unknown action ${action.type}`);
  }
}
