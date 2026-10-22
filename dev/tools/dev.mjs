// Dev loop: Vite dev server with HMR, then Electron pointed at it. Closing the window stops both.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const server = await createServer({ configFile: `${root}vite.config.js` });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`vite ready at ${url}`);

const child = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VCE_DEV_URL: url },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
