import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpegPath, ffprobePath } from './binaries';
import type { ExportAccelerationInfo, ExportCapabilities, ExportEncoderCapability, ExportSettings, VideoEncoder } from '../shared/types';

export const VIDEO_ENCODERS: readonly VideoEncoder[] = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'];
const LABELS: Record<VideoEncoder, string> = { h264_nvenc: 'GPU NVIDIA · NVENC', h264_qsv: 'GPU Intel · Quick Sync', h264_amf: 'GPU AMD · AMF', libx264: 'CPU · H.264' };
const CACHE_MS = 5 * 60 * 1000;
let cached: ExportCapabilities | null = null;
let pending: Promise<ExportCapabilities> | null = null;

export function isVideoEncoder(value: unknown): value is VideoEncoder {
  return typeof value === 'string' && VIDEO_ENCODERS.includes(value as VideoEncoder);
}

/** All routes produce 8-bit H.264. Audio is encoded separately as AAC. */
export function videoEncoderArgs(encoder: VideoEncoder, quality: ExportSettings['quality']): string[] {
  const level = quality === 'high' ? '18' : '23';
  const profile = ['-profile:v', 'high'];
  if (encoder === 'h264_nvenc') return ['-c:v', encoder, '-preset', 'p4', '-rc', 'vbr', '-cq', level, '-b:v', '0', ...profile, '-pix_fmt', 'yuv420p'];
  if (encoder === 'h264_qsv') return ['-c:v', encoder, '-preset', 'medium', '-global_quality', level, '-look_ahead', '0', ...profile, '-pix_fmt', 'nv12'];
  if (encoder === 'h264_amf') return ['-c:v', encoder, '-quality', 'balanced', '-rc', 'cqp', '-qp_i', level, '-qp_p', level, ...profile, '-pix_fmt', 'nv12'];
  return ['-c:v', 'libx264', '-preset', 'fast', '-crf', level, ...profile, '-pix_fmt', 'yuv420p'];
}

export function accelerationInfo(encoder: VideoEncoder, requested: 'auto' | 'cpu' = 'auto', fallback?: string): ExportAccelerationInfo {
  return { encoder, requested, mode: encoder === 'libx264' ? 'cpu' : 'gpu', label: LABELS[encoder], ...(fallback ? { fallback } : {}) };
}

function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('cancelled'); }

/** Bounded and cancellable subprocess used by the actual encode/decode probe. */
function probeProcess(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, shell: false });
    let output = '', errors = '', timeout = false;
    const abort = () => child.kill();
    const timer = setTimeout(() => { timeout = true; child.kill(); }, 12000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-64000); });
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-12000); });
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.on('error', error => { clean(); reject(error); });
    child.on('close', code => {
      clean();
      if (signal?.aborted) reject(new Error('cancelled'));
      else if (timeout) reject(new Error('La prova dell’encoder ha superato il tempo disponibile.'));
      else if (code === 0) resolve(output);
      else reject(new Error(errors.trim().split(/\r?\n/).slice(-6).join('\n') || `Encoder non disponibile (${code}).`));
    });
  });
}

export async function probeVideoEncoder(encoder: VideoEncoder, options: { signal?: AbortSignal; binary?: string; probeBinary?: string } = {}): Promise<ExportEncoderCapability> {
  cancelled(options.signal);
  const result: ExportEncoderCapability = { encoder, label: LABELS[encoder], hardware: encoder !== 'libx264', available: false };
  let directory = '';
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'duckymovie-encoder-'));
    const output = path.join(directory, 'probe.mp4');
    await probeProcess(options.binary ?? ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=0.125', '-frames:v', '3', '-an', ...videoEncoderArgs(encoder, 'standard'), '-movflags', '+faststart', output], options.signal);
    const info = JSON.parse(await probeProcess(options.probeBinary ?? ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt,nb_frames', '-of', 'json', output], options.signal));
    const video = info.streams?.[0];
    if (video?.codec_name !== 'h264' || video.width !== 320 || video.height !== 180 || video.pix_fmt !== 'yuv420p' || Number(video.nb_frames) !== 3) throw new Error('L’encoder non ha prodotto un video H.264 compatibile.');
    // Read the encoded packets back through FFmpeg so a successful init alone
    // cannot advertise a device that produces unusable output.
    await probeProcess(options.binary ?? ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', output, '-frames:v', '3', '-f', 'null', '-'], options.signal);
    result.available = true;
  } catch (error) {
    cancelled(options.signal);
    result.reason = error instanceof Error ? error.message : String(error);
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
  return result;
}

export function preferredEncoder(capabilities: ExportCapabilities, requested: 'auto' | 'cpu' = 'auto'): VideoEncoder {
  return requested === 'cpu' ? 'libx264' : VIDEO_ENCODERS.find(encoder => capabilities.encoders.some(candidate => candidate.encoder === encoder && candidate.available)) ?? 'libx264';
}

export async function getExportCapabilities(options: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<ExportCapabilities> {
  cancelled(options.signal);
  if (!options.refresh && cached && Date.now() - Date.parse(cached.checkedAt) < CACHE_MS) return structuredClone(cached);
  if (!options.refresh && pending) {
    if(!options.signal)return structuredClone(await pending);
    // An export can reuse the modal's discovery without taking ownership of
    // its probe processes. Cancelling that export stops its wait immediately.
    const discovery=pending;
    return new Promise((resolve,reject)=>{
      const abort=()=>{options.signal?.removeEventListener('abort',abort);reject(new Error('cancelled'));};
      options.signal!.addEventListener('abort',abort,{once:true});
      discovery.then(value=>{options.signal?.removeEventListener('abort',abort);if(options.signal?.aborted)reject(new Error('cancelled'));else resolve(structuredClone(value));},error=>{options.signal?.removeEventListener('abort',abort);reject(error);});
    });
  }
  const work = async () => {
    const encoders = await Promise.all(VIDEO_ENCODERS.map(encoder => probeVideoEncoder(encoder, { signal: options.signal })));
    const capabilities: ExportCapabilities = { encoders, preferred: 'libx264', checkedAt: new Date().toISOString() };
    capabilities.preferred = preferredEncoder(capabilities);
    cached = capabilities;
    return structuredClone(capabilities);
  };
  if (options.signal || options.refresh) return work();
  pending = work();
  try { return await pending; } finally { pending = null; }
}

export async function chooseExportAcceleration(requested: 'auto' | 'cpu' = 'auto', signal?: AbortSignal): Promise<ExportAccelerationInfo> {
  cancelled(signal);
  if (requested === 'cpu') return accelerationInfo('libx264', requested);
  const capabilities = await getExportCapabilities({ signal });
  const encoder = preferredEncoder(capabilities);
  return accelerationInfo(encoder, requested, encoder === 'libx264' ? 'Nessun encoder GPU utilizzabile. La codifica continua sulla CPU.' : undefined);
}

export function isHardwareEncoderFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if(/no such filter|error initializing (?:complex )?filters?|error processing filtergraph|error opening input|invalid data found when processing input|no such file or directory|permission denied|access (?:is )?denied|no space left on device|disk (?:is )?full|not enough (?:free )?space|read-only file system/i.test(message))return false;
  // Output paths may themselves contain "cuda", "device", etc. Remove those
  // path-bearing diagnostics while retaining genuine encoder initialization
  // failures that FFmpeg also summarizes as an error opening the output.
  const diagnostics=message.replace(/error opening output (?:file|url)\s+[^\r\n]*/gi,'');
  return /(?:h264_(?:nvenc|qsv|amf)|nvenc|qsv|amf|cuda|mfx|onevpl|device)[^\n]*(?:error|fail|unsupported|cannot|unable|not available|not found)|(?:error|fail|unsupported|cannot|unable)[^\n]*(?:nvenc|qsv|amf|cuda|mfx|onevpl|device)|error (?:while )?opening (?:video )?encoder|unknown encoder ['"]?h264_(?:nvenc|qsv|amf)|no capable devices|cannot load (?:nvcuda|nvencode|amfrt)/i.test(diagnostics);
}

/** Retry only encoder/device failures; media/filter errors keep their cause. */
export async function withEncodingFallback<T>(initial: ExportAccelerationInfo, work: (info: ExportAccelerationInfo) => Promise<T>, options: { signal?: AbortSignal; onFallback?: (info: ExportAccelerationInfo) => void } = {}): Promise<T> {
  cancelled(options.signal);
  try { return await work(initial); }
  catch (error) {
    cancelled(options.signal);
    if (initial.mode !== 'gpu' || !isHardwareEncoderFailure(error)) throw error;
    const reason = `${initial.label} non disponibile durante la codifica. Esportazione riavviata sulla CPU.`;
    if (cached) {
      const entry = cached.encoders.find(item => item.encoder === initial.encoder);
      if (entry) { entry.available = false; entry.reason = error instanceof Error ? error.message : String(error); }
      cached.preferred = preferredEncoder(cached);
    }
    const fallback = accelerationInfo('libx264', initial.requested, reason);
    options.onFallback?.(fallback);
    return work(fallback);
  }
}
