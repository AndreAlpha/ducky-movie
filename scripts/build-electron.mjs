import { build } from 'esbuild';

await build({
  entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' },
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  bundle: true,
  external: ['electron', 'ffmpeg-static', 'ffprobe-static'],
  sourcemap: true,
});
