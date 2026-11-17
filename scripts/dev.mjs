import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
import './build-electron.mjs';

const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];
const env = { ...process.env, DUCKY_DEV_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env,
  windowsHide: true,
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.on('SIGINT', () => child.kill());
