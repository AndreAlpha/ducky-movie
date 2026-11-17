import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { ffmpegPath, ffprobePath } from './binaries';
import { runProcess } from './process';
import type { MediaAsset } from '../shared/types';

const imageExtensions = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.heic',
  '.avif',
]);
const grants = new Set<string>();
const importedSourcePaths = new Set<string>();
const pendingImports = new Map<string, Promise<MediaAsset>>();
let cacheDirectory = '';

export function setCacheDirectory(directory: string): void {
  cacheDirectory = directory;
}

function normalized(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function grantFile(file: string): void {
  grants.add(normalized(file));
}

export function isFileGranted(file: string): boolean {
  return grants.has(normalized(file));
}

export function getImportedSourcePaths(): string[] {
  return [...importedSourcePaths];
}

export function mediaURL(file: string): string {
  grantFile(file);
  return `ducky-media://local/${Buffer.from(path.resolve(file)).toString('base64url')}`;
}

export function decodeMediaURL(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'local') return null;
    const file = Buffer.from(parsed.pathname.slice(1), 'base64url').toString(
      'utf8',
    );
    return isFileGranted(file) ? file : null;
  } catch {
    return null;
  }
}

interface ProbeResult {
  format?: { duration?: string };
  streams?: {
    codec_type: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
    disposition?: { attached_pic?: number };
    tags?: { rotate?: string };
    side_data_list?: { rotation?: number }[];
  }[];
}

async function waveform(file: string, duration: number): Promise<number[]> {
  const data = await runProcess(
    ffmpegPath,
    [
      '-v',
      'error',
      '-i',
      file,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '120',
      '-t',
      String(Math.min(duration, 60 * 60 * 4)),
      '-f',
      's16le',
      'pipe:1',
    ],
    120 * 2 * 60 * 60 * 4 + 1024,
  );
  const samples = Math.floor(data.length / 2);
  if (!samples) return [];
  const buckets = Math.min(180, samples);
  const values = Array.from({ length: buckets }, (_, bucket) => {
    let peak = 0;
    const start = Math.floor((bucket * samples) / buckets);
    const end = Math.floor(((bucket + 1) * samples) / buckets);
    for (let index = start; index < end; index++)
      peak = Math.max(peak, Math.abs(data.readInt16LE(index * 2)) / 32768);
    return peak;
  });
  const highest = Math.max(...values, 0.01);
  return values.map((value) => Math.max(0.04, value / highest));
}

async function buildAsset(file: string, stat: Stats): Promise<MediaAsset> {
  const probe = JSON.parse(
    (
      await runProcess(ffprobePath, [
        '-v',
        'error',
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        file,
      ])
    ).toString(),
  ) as ProbeResult;
  const video = probe.streams?.find(
    (stream) =>
      stream.codec_type === 'video' && !stream.disposition?.attached_pic,
  );
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  const isImage = imageExtensions.has(path.extname(file).toLowerCase());
  if (!video && !audio)
    throw new Error('Formato multimediale non riconosciuto.');
  const duration = Number(
    probe.format?.duration ||
      video?.duration ||
      audio?.duration ||
      (isImage ? 5 : 0),
  );
  if (!isImage && (!Number.isFinite(duration) || duration <= 0))
    throw new Error('La durata del file non è valida.');
  const key = createHash('sha256')
    .update(`${file}:${stat.size}:${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 28);
  await fs.mkdir(cacheDirectory, { recursive: true });
  const asset: MediaAsset = {
    id: randomUUID(),
    name: path.basename(file),
    path: file,
    url: mediaURL(file),
    kind: isImage ? 'image' : video ? 'video' : 'audio',
    duration: isImage ? 5 : duration,
    width: video?.width || 0,
    height: video?.height || 0,
    hasAudio: Boolean(audio) && !isImage,
  };
  const rotation = Math.abs(
    Number(
      video?.tags?.rotate ||
        video?.side_data_list?.find((data) => data.rotation !== undefined)
          ?.rotation ||
        0,
    ),
  );
  if (rotation % 180 === 90)
    [asset.width, asset.height] = [asset.height, asset.width];
  if (video) {
    const thumbnail = path.join(cacheDirectory, `${key}.jpg`);
    try {
      await fs.access(thumbnail);
    } catch {
      await runProcess(ffmpegPath, [
        '-v',
        'error',
        '-y',
        '-ss',
        isImage ? '0' : String(Math.min(1, duration / 3)),
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        'scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2',
        thumbnail,
      ]);
    }
    asset.thumbnail = mediaURL(thumbnail);
    // Chromium handles H.264, VP8/9 and AV1 natively. A cached H.264 proxy also
    // gives HEVC, ProRes, WMV and older camera formats a reliable preview.
    const compatibleVideo = ['h264', 'vp8', 'vp9', 'av1', 'theora'].includes(
      video.codec_name || '',
    );
    const compatibleAudio =
      !audio ||
      [
        'aac',
        'mp3',
        'opus',
        'vorbis',
        'flac',
        'pcm_s16le',
        'pcm_s24le',
        'pcm_f32le',
      ].includes(audio.codec_name || '');
    const nativeContainer = ['.mp4', '.m4v', '.webm', '.mov', '.ogv'].includes(
      path.extname(file).toLowerCase(),
    );
    if (
      !isImage &&
      (!compatibleVideo || !compatibleAudio || !nativeContainer)
    ) {
      const proxy = path.join(cacheDirectory, `${key}-preview.mp4`);
      try {
        await fs.access(proxy);
      } catch {
        const temporaryProxy = `${proxy}.partial.mp4`;
        try {
          await runProcess(ffmpegPath, [
            '-v',
            'error',
            '-y',
            '-i',
            file,
            '-map',
            '0:V:0',
            '-map',
            '0:a:0?',
            '-vf',
            'scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-crf',
            '25',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-movflags',
            '+faststart',
            temporaryProxy,
          ]);
          await fs.rename(temporaryProxy, proxy);
        } catch (error) {
          await fs.rm(temporaryProxy, { force: true });
          throw error;
        }
      }
      asset.url = mediaURL(proxy);
    }
    if (
      isImage &&
      !['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.avif'].includes(
        path.extname(file).toLowerCase(),
      )
    ) {
      const preview = path.join(cacheDirectory, `${key}-image.png`);
      try {
        await fs.access(preview);
      } catch {
        await runProcess(ffmpegPath, [
          '-v',
          'error',
          '-y',
          '-i',
          file,
          '-frames:v',
          '1',
          preview,
        ]);
      }
      asset.url = mediaURL(preview);
    }
  }
  if (audio && !isImage) {
    try {
      const waveformPath = path.join(cacheDirectory, `${key}.json`);
      try {
        asset.waveform = JSON.parse(await fs.readFile(waveformPath, 'utf8'));
      } catch {
        asset.waveform = await waveform(file, duration);
        await fs.writeFile(waveformPath, JSON.stringify(asset.waveform));
      }
    } catch {
      asset.waveform = [];
    }
  }
  if (
    asset.kind === 'audio' &&
    ![
      'aac',
      'mp3',
      'opus',
      'vorbis',
      'flac',
      'pcm_s16le',
      'pcm_s24le',
      'pcm_f32le',
    ].includes(audio?.codec_name || '')
  ) {
    const preview = path.join(cacheDirectory, `${key}-audio.m4a`);
    try {
      await fs.access(preview);
    } catch {
      await runProcess(ffmpegPath, [
        '-v',
        'error',
        '-y',
        '-i',
        file,
        '-vn',
        '-c:a',
        'aac',
        preview,
      ]);
    }
    asset.url = mediaURL(preview);
  }
  return asset;
}

export async function importFile(input: string): Promise<MediaAsset> {
  if (!cacheDirectory)
    throw new Error('La cartella delle anteprime non è pronta.');
  const file = await fs.realpath(path.resolve(input));
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('Seleziona un file multimediale.');
  const key = `${normalized(cacheDirectory)}:${normalized(file)}:${stat.size}:${stat.mtimeMs}`;
  let pending = pendingImports.get(key);
  if (!pending) {
    pending = buildAsset(file, stat);
    pendingImports.set(key, pending);
  }
  try {
    const asset = await pending;
    importedSourcePaths.add(asset.path);
    return { ...asset, id: randomUUID(), waveform: asset.waveform?.slice() };
  } finally {
    if (pendingImports.get(key) === pending) pendingImports.delete(key);
  }
}

export async function importFiles(
  paths: string[],
): Promise<{ assets: MediaAsset[]; errors: string[] }> {
  const assets: MediaAsset[] = [];
  const errors: string[] = [];
  for (const file of [...new Set(paths)]) {
    try {
      assets.push(await importFile(file));
    } catch (error) {
      errors.push(
        `${path.basename(file)} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { assets, errors };
}
