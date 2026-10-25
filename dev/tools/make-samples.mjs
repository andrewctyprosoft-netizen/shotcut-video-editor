// Make sample media in dev/samples/ (gitignored): a spoken WAV from the Windows voice, a talking
// "video" (test pattern + that speech), a second clip, and a sample project for the smoke test.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, resolveFfmpeg } from '../../electron/tools.js';

export const SPEECH = [
  'Hello and welcome to ShotCut.',
  'Um, this is a short test of automatic captions.',
  'We cut the pauses and keep the words that matter.',
];

const here = fileURLToPath(new URL('.', import.meta.url));
const dir = join(here, '..', 'samples');
mkdirSync(dir, { recursive: true });
const { ffmpeg } = resolveFfmpeg(DEFAULT_SETTINGS, join(here, '..', '..')); // FFMPEG_PATH, the launcher's runtime/ffmpeg, or PATH
const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

const textFile = join(dir, 'speech.txt');
writeFileSync(textFile, SPEECH.join('\n'), 'utf8');
writeFileSync(join(dir, 'clean.txt'), SPEECH.join('\n'), 'utf8');
const wav = join(dir, 'speech.wav');
execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'tts.ps1'), textFile, wav], { stdio: 'inherit' });

const talk = join(dir, 'talk.mp4');
ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30', '-i', wav, '-shortest',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', talk]);
const bars = join(dir, 'bars.mp4');
ff(['-f', 'lavfi', '-i', 'smptehdbars=s=1280x720:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=330:d=3',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', bars]);
console.log(`samples in ${dir}`);
