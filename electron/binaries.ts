import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const requireModule = createRequire(
  typeof __filename === 'string'
    ? __filename
    : path.join(process.cwd(), 'package.json'),
);

function unpacked(binary: string): string {
  return binary.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function resolveBinary(name: 'ffmpeg' | 'ffprobe'): string {
  const override =
    process.env[name === 'ffmpeg' ? 'DUCKY_FFMPEG_PATH' : 'DUCKY_FFPROBE_PATH'];
  if (override && fs.existsSync(override)) return override;
  try {
    const source =
      name === 'ffmpeg'
        ? requireModule('ffmpeg-static')
        : requireModule('ffprobe-static').path;
    const binary = unpacked(source);
    if (fs.existsSync(binary)) return binary;
  } catch {
    // Development machines can use their installed FFmpeg build.
  }
  return name + (process.platform === 'win32' ? '.exe' : '');
}

export const ffmpegPath = resolveBinary('ffmpeg');
export const ffprobePath = resolveBinary('ffprobe');

export function fontPath(): string {
  const candidates = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arialbd.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  ];
  const available = candidates.find((candidate) => fs.existsSync(candidate));
  if (!available)
    throw new Error(
      'Il carattere Arial necessario ai titoli non è disponibile.',
    );
  return available;
}
