import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { ffmpegPath, ffprobePath } from './binaries';
import { protectSourceFiles } from './files';
import { accelerationInfo, chooseExportAcceleration, isVideoEncoder, videoEncoderArgs, withEncodingFallback } from './encoding';
import { projectDuration } from '../src/model';
import type { ExportAccelerationInfo, ExportProgress, ExportSettings, Project, VideoEncoder } from '../shared/types';

const moduleDirectory = typeof __dirname === 'string' ? __dirname : path.join(process.cwd(), 'electron');
let engineDirectory = path.resolve(moduleDirectory, '../engine-dist/DuckyMovieEngine');
let engineDataDirectory = path.resolve(moduleDirectory, '../.cache/engine');

export function configureEngine(dataDirectory: string, resourceDirectory?: string): void {
  engineDataDirectory = dataDirectory;
  if (resourceDirectory) engineDirectory = path.join(resourceDirectory, 'engine');
}

export function engineModelsDirectory(): string {
  return process.env.DUCKY_MODELS_DIR || path.join(engineDataDirectory, 'models');
}

interface WorkerMessage {
  type: 'progress' | 'result' | 'error';
  progress?: number;
  message?: string;
  result?: unknown;
  error?: string;
  encoder?: unknown;
  fallback?: unknown;
}

interface EngineEncodingProgress { encoder?: VideoEncoder; fallback?: string }

export class EngineTask {
  readonly id = randomUUID();
  private process: ChildProcess | null = null;
  private cancelled = false;
  private directory = '';

  constructor(
    private action: string,
    private payload: Record<string, unknown>,
    private onProgress: (progress: number, message: string, encoding?: EngineEncodingProgress) => void,
  ) {}

  cancel(): void {
    this.cancelled = true;
    const processId = this.process?.pid;
    if (!processId) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(processId), '/T', '/F'], { windowsHide: true, shell: false });
      killer.on('error', () => this.process?.kill());
    } else this.process?.kill('SIGKILL');
  }

  async run(): Promise<unknown> {
    const executable = process.env.DUCKY_ENGINE_EXECUTABLE || path.join(engineDirectory, `DuckyMovieEngine${process.platform === 'win32' ? '.exe' : ''}`);
    await fs.access(executable).catch(() => { throw new Error('Il motore di montaggio avanzato non è disponibile. Ricrea il pacchetto con il motore incluso.'); });
    await fs.mkdir(path.join(engineDataDirectory, 'engine-work'), { recursive: true });
    this.directory = await fs.mkdtemp(path.join(engineDataDirectory, 'engine-work', 'job-'));
    const request = path.join(this.directory, 'request.json');
    await fs.writeFile(request, JSON.stringify({ action: this.action, payload: this.payload }), 'utf8');
    try {
      if (this.cancelled) throw new Error('cancelled');
      return await new Promise((resolve, reject) => {
        const child = spawn(executable, ['--request', request], {
          windowsHide: true, shell: false,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1',
            DUCKY_FFMPEG_PATH: ffmpegPath, DUCKY_FFPROBE_PATH: ffprobePath,
            DUCKY_MODELS_DIR: engineModelsDirectory(), DUCKY_CACHE_DIR: path.join(engineDataDirectory, 'media-cache') },
        });
        this.process = child;
        let buffer = '';
        let errors = '';
        let result: unknown;
        let hasResult = false;
        let workerError = '';
        child.stdout.on('data', chunk => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) {
            try {
              const message = JSON.parse(line) as WorkerMessage;
              if (message.type === 'progress') this.onProgress(message.progress || 0, message.message || 'Elaborazione in corso', {
                ...(isVideoEncoder(message.encoder)?{encoder:message.encoder}:{}),
                ...(typeof message.fallback==='string'?{fallback:message.fallback}:{})
              });
              if (message.type === 'result') { result = message.result; hasResult = true; }
              if (message.type === 'error') workerError = message.error || 'Elaborazione non riuscita.';
            } catch { /* Native library output is retained in stderr, protocol lines are JSON. */ }
          }
        });
        child.stderr.on('data', chunk => { errors = (errors + chunk.toString('utf8')).slice(-18000); });
        child.on('error', error => reject(new Error(`Impossibile avviare il motore. ${error.message}`)));
        child.on('close', code => {
          this.process = null;
          if (this.cancelled) reject(new Error('cancelled'));
          else if (code === 0 && hasResult) resolve(result);
          else reject(new Error(workerError || errors.trim().split('\n').slice(-6).join('\n') || `Il motore si è fermato (${code}).`));
        });
      });
    } finally {
      if (this.directory) await fs.rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function needsAdvancedExport(project: Project, settings: ExportSettings): boolean {
  const defaultVideo = project.tracks?.find(track => track.kind === 'video')?.id ?? 'video-main';
  const videoLanes = new Set(project.clips.map(clip => clip.trackId ?? defaultVideo));
  if (!project.clips.length || videoLanes.size > 1 || (project.tracks?.filter(track => track.kind === 'video').length ?? 0) > 1 || project.tracks?.some(track => track.muted || track.hidden)) return true;
  if (project.mirror || project.music || project.overlays?.length || project.subtitles?.enabled && project.subtitles.words.length || project.frame?.style && project.frame.style !== 'none' || settings.framePng) return true;
  let cursor = 0;
  for (const clip of project.clips) {
    const placement = clip.placement;
    if (clip.crop || clip.mirror || clip.zoom && clip.zoom !== 'none' || clip.transition && clip.transition !== 'none' || clip.background === 'blur' || clip.start !== undefined && Math.abs(clip.start - cursor) > .001 || clip.filter === 'vivid' || clip.filter === 'bright' || clip.warmth || placement && (placement.x !== .5 || placement.y !== .5 || placement.scale !== 1 || placement.opacity !== 1)) return true;
    cursor += (clip.out - clip.in) / clip.speed;
  }
  return projectDuration(project) > cursor + .001;
}

export class EngineExportJob {
  readonly id = randomUUID();
  private task: EngineTask | null = null;
  private cancelled = false;
  private abort = new AbortController();
  private acceleration:ExportAccelerationInfo|undefined;

  constructor(
    private project: Project,
    private settings: ExportSettings,
    readonly output: string,
    private onProgress: (event: ExportProgress) => void,
  ) {}

  cancel(): void { this.cancelled = true; this.abort.abort(); this.task?.cancel(); }

  async start(): Promise<void> {
    let temporary = '';
    try {
      await protectSourceFiles(this.output, this.project.assets.map(asset => asset.path));
      const tracks = new Map((this.project.tracks ?? []).map(track => [track.id, track]));
      const defaultVideo = this.project.tracks?.find(track => track.kind === 'video')?.id ?? 'video-main';
      const defaultAudio = this.project.tracks?.find(track => track.kind === 'audio')?.id ?? 'audio-main';
      const used = new Set([
        ...this.project.clips.filter(clip => {
          const track = tracks.get(clip.trackId ?? defaultVideo);
          const asset = this.project.assets.find(asset => asset.id === clip.assetId);
          return !track?.hidden || asset?.hasAudio && !track?.muted && !clip.muted;
        }).map(clip => clip.assetId),
        ...this.project.audioTracks.filter(track => !tracks.get(track.trackId ?? defaultAudio)?.muted).map(track => track.assetId),
        ...(this.project.music ? [this.project.music.assetId] : []),
        ...(this.project.overlays ?? []).flatMap(overlay => overlay.assetId ? [overlay.assetId] : []),
      ]);
      for (const asset of this.project.assets.filter(asset => used.has(asset.id))) {
        if (asset.missing) throw new Error(`File mancante o modificato. ${asset.name}`);
        await fs.access(asset.path).catch(() => { throw new Error(`File mancante. ${asset.name}`); });
      }
      temporary = await fs.mkdtemp(path.join(path.dirname(this.output), '.duckymovie-render-'));
      const file = path.join(temporary, 'movie.mp4');
      this.onProgress({jobId:this.id,progress:0,state:'running',message:'Verifica degli encoder GPU…'});
      this.acceleration=await chooseExportAcceleration(this.settings.acceleration??'auto',this.abort.signal);
      await withEncodingFallback(this.acceleration,async info=>{
        this.acceleration=info;
        let confirmedEncoder=false;
        this.onProgress({jobId:this.id,progress:0,state:'running',acceleration:info,message:info.fallback??`${info.label} · composizione sulla CPU`});
        this.task = new EngineTask('render', { project: this.project, settings: this.settings, output: file, encoding:{encoder:info.encoder,args:videoEncoderArgs(info.encoder,this.settings.quality)} }, (progress,message,encoding) => {
          if(encoding?.encoder){confirmedEncoder=true;this.acceleration=accelerationInfo(encoding.encoder,this.settings.acceleration??'auto',encoding.fallback??this.acceleration?.fallback);}
          else if(encoding?.fallback&&this.acceleration)this.acceleration={...this.acceleration,fallback:encoding.fallback};
          this.onProgress({ jobId: this.id, progress, state: 'running',message,acceleration:this.acceleration });
        });
        if (this.cancelled) this.task.cancel();
        const result=await this.task.run() as {encoding?:{encoder?:unknown;fallback?:unknown}}|null;
        if(isVideoEncoder(result?.encoding?.encoder)){
          confirmedEncoder=true;
          this.acceleration=accelerationInfo(result.encoding.encoder,this.settings.acceleration??'auto',typeof result.encoding.fallback==='string'?result.encoding.fallback:this.acceleration?.fallback);
        }
        // Older bundled renderers always encoded with libx264 and did not
        // report encoding metadata. Never label their output as GPU encoded.
        if(!confirmedEncoder)this.acceleration=accelerationInfo('libx264',this.settings.acceleration??'auto',info.encoder==='libx264'?info.fallback:undefined);
      },{signal:this.abort.signal,onFallback:info=>{
        this.acceleration=info;
        this.onProgress({jobId:this.id,progress:0,state:'running',message:info.fallback,acceleration:info});
      }});
      if (this.cancelled) throw new Error('cancelled');
      await fs.rename(file, this.output);
      this.onProgress({ jobId: this.id, progress: 1, state: 'complete', path: this.output,acceleration:this.acceleration,message:this.acceleration?.fallback??`${this.acceleration?.label??'CPU'} · esportazione completata` });
    } catch (error) {
      this.onProgress({ jobId: this.id, progress: 0, state: this.cancelled ? 'cancelled' : 'error', acceleration:this.acceleration,error: this.cancelled ? undefined : error instanceof Error ? error.message : String(error) });
    } finally {
      if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      this.task = null;
    }
  }
}
