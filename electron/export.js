// Export runner: write captions.ass and graph.txt into a job folder, then run FFmpeg from there
// so no Windows path ever needs escaping inside the filter graph. No Electron imports.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectCues, toAss } from '../core/captions.js';
import { buildExportPlan, exportArgs, parseProgressLine } from '../core/exportPlan.js';
import { frameSize } from '../core/project.js';
import { timelineWords } from '../core/transcript.js';
import { runOk } from './proc.js';

/**
 * Render a project to an MP4.
 * @param {{ffmpeg: string, project: object, output: string, workDir: string, encoder?: string,
 *   signal?: AbortSignal, onProgress?: (fraction: number) => void}} opts
 * @returns {Promise<{output: string, duration: number}>}
 */
export async function runExport(opts) {
  const { project } = opts;
  mkdirSync(opts.workDir, { recursive: true });
  const cues = project.captions.enabled ? projectCues(timelineWords(project), project) : [];
  let captionsFile = null;
  if (cues.length) {
    captionsFile = 'captions.ass';
    writeFileSync(join(opts.workDir, captionsFile), toAss(cues, project.captions.style, frameSize(project)), 'utf8');
  }
  const plan = buildExportPlan(project, { captionsFile, encoder: opts.encoder });
  writeFileSync(join(opts.workDir, 'graph.txt'), plan.graph, 'utf8');
  await runOk(opts.ffmpeg, exportArgs(plan, 'graph.txt', opts.output), {
    cwd: opts.workDir,
    signal: opts.signal,
    onStdout: (line) => {
      const p = parseProgressLine(line);
      if (p?.seconds !== undefined) opts.onProgress?.(Math.min(1, p.seconds / plan.duration));
    },
  });
  return { output: opts.output, duration: plan.duration };
}
