// Smoke test of the real app: open the sample project in Electron, seek, save a screenshot to
// dev/out/smoke.png and quit. Usage: npm run smoke [-- <seconds>]   (run `npm run samples` once first)
// VCE_SMOKE_CLICK="Transcript,Captions" clicks those buttons first.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import electronPath from 'electron';
import { outDir, root, writeSampleProject } from './sampleProject.mjs';

const projectFile = await writeSampleProject('smoke');
const shot = join(outDir, 'smoke.png');
const child = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VCE_SMOKE: projectFile, VCE_SMOKE_SHOT: shot, VCE_SMOKE_TIME: process.argv[2] ?? '2.2' },
});
child.on('exit', (code) => {
  console.log(existsSync(shot) ? `ok: ${shot}` : 'no screenshot written');
  process.exit(code ?? 1);
});
