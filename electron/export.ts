import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ffmpegPath, fontPath } from './binaries';
import { protectSourceFiles } from './files';
import { chooseExportAcceleration, videoEncoderArgs, withEncodingFallback } from './encoding';
import type {
  ExportAccelerationInfo,
  ExportProgress,
  ExportSettings,
  Project,
  VideoClip,
} from '../shared/types';

type Matrix = number[][];

function saturationMatrix(amount: number): Matrix {
  return [
    [0.213 + 0.787 * amount, 0.715 - 0.715 * amount, 0.072 - 0.072 * amount],
    [0.213 - 0.213 * amount, 0.715 + 0.285 * amount, 0.072 - 0.072 * amount],
    [0.213 - 0.213 * amount, 0.715 - 0.715 * amount, 0.072 + 0.928 * amount],
  ];
}

function sepiaMatrix(amount: number): Matrix {
  return [
    [1 - 0.607 * amount, 0.769 * amount, 0.189 * amount],
    [0.349 * amount, 1 - 0.314 * amount, 0.168 * amount],
    [0.272 * amount, 0.534 * amount, 1 - 0.869 * amount],
  ];
}

function hueMatrix(degrees: number): Matrix {
  const angle = (degrees * Math.PI) / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [
    [
      0.213 + 0.787 * cosine - 0.213 * sine,
      0.715 - 0.715 * cosine - 0.715 * sine,
      0.072 - 0.072 * cosine + 0.928 * sine,
    ],
    [
      0.213 - 0.213 * cosine + 0.143 * sine,
      0.715 + 0.285 * cosine + 0.14 * sine,
      0.072 - 0.072 * cosine - 0.283 * sine,
    ],
    [
      0.213 - 0.213 * cosine - 0.787 * sine,
      0.715 - 0.715 * cosine + 0.715 * sine,
      0.072 + 0.928 * cosine + 0.072 * sine,
    ],
  ];
}

function colorMatrix(matrix: Matrix): string {
  return `colorchannelmixer=${matrix
    .flatMap((row, rowIndex) =>
      row.map(
        (value, columnIndex) =>
          `${['r', 'g', 'b'][rowIndex]}${['r', 'g', 'b'][columnIndex]}=${value.toFixed(6)}`,
      ),
    )
    .join(':')}`;
}

function contrastFilter(brightness: number, contrast: number): string {
  const expression = `clip((val*${brightness.toFixed(6)}-127.5)*${contrast.toFixed(6)}+127.5,0,255)`;
  return `lutrgb=r='${expression}':g='${expression}':b='${expression}'`;
}

function colorFilters(clip: VideoClip): string[] {
  const filters = ['format=gbrp'];
  if (clip.filter === 'warm')
    filters.push(
      colorMatrix(sepiaMatrix(0.22)),
      colorMatrix(saturationMatrix(1.18)),
    );
  if (clip.filter === 'cool')
    filters.push(
      colorMatrix(sepiaMatrix(0.12)),
      colorMatrix(hueMatrix(170)),
      colorMatrix(saturationMatrix(0.8)),
    );
  if (clip.filter === 'mono') filters.push(colorMatrix(saturationMatrix(0)));
  if (clip.filter === 'vintage')
    filters.push(
      colorMatrix(sepiaMatrix(0.45)),
      colorMatrix(saturationMatrix(0.75)),
      contrastFilter(1, 1.08),
    );
  if (clip.brightness || clip.contrast !== 1)
    filters.push(contrastFilter(1 + clip.brightness, clip.contrast));
  if (clip.saturation !== 1)
    filters.push(colorMatrix(saturationMatrix(clip.saturation)));
  return filters;
}

function tempoFilters(speed: number): string[] {
  let remaining = speed;
  const filters = [];
  while (remaining > 2) {
    filters.push('atempo=2');
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining}`);
  return filters;
}

function wrappedTitle(text: string, length: number): string {
  return text
    .split('\n')
    .flatMap((line) => {
      if (line.length <= length) return [line];
      const lines: string[] = [];
      let current = '';
      for (const word of line.split(/\s+/)) {
        if (current && current.length + word.length + 1 > length) {
          lines.push(current);
          current = '';
        }
        let remainder = word;
        while (remainder.length > length) {
          if (current) {
            lines.push(current);
            current = '';
          }
          lines.push(remainder.slice(0, length));
          remainder = remainder.slice(length);
        }
        current += `${current ? ' ' : ''}${remainder}`;
      }
      if (current) lines.push(current);
      return lines;
    })
    .join('\n');
}

export function dimensions(
  aspect: Project['aspectRatio'],
  resolution: ExportSettings['resolution'],
): [number, number] {
  const shortSide = { '720p': 720, '1080p': 1080, '1440p': 1440, '2160p': 2160 }[resolution];
  if (aspect === '1:1') return [shortSide, shortSide];
  const longSide = Math.round((shortSide * 16) / 9 / 2) * 2;
  return aspect === '9:16' ? [shortSide, longSide] : [longSide, shortSide];
}

export function projectDuration(project: Project): number {
  return project.clips.reduce(
    (total, clip) => total + (clip.out - clip.in) / clip.speed,
    0,
  );
}

export class ExportJob {
  readonly id = randomUUID();
  private process: ChildProcess | null = null;
  private cancelled = false;
  private abort = new AbortController();
  private acceleration: ExportAccelerationInfo | undefined;
  private workDirectory = '';

  constructor(
    private project: Project,
    private settings: ExportSettings,
    readonly output: string,
    private onProgress: (progress: ExportProgress) => void,
  ) {}

  cancel(): void {
    this.cancelled = true;
    this.abort.abort();
    this.process?.kill();
  }

  private report(progress: number): void {
    this.onProgress({
      jobId: this.id,
      progress: Math.max(0, Math.min(1, progress)),
      state: 'running',
      acceleration: this.acceleration,
      message: this.acceleration?.fallback ?? (this.acceleration ? `${this.acceleration.label} · filtri e composizione sulla CPU` : 'Verifica degli encoder GPU…'),
    });
  }

  private async run(
    args: string[],
    duration: number,
    start: number,
    weight: number,
  ): Promise<void> {
    if (this.cancelled) throw new Error('cancelled');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-progress',
          'pipe:1',
          '-nostats',
          ...args,
        ],
        {
          windowsHide: true,
          shell: false,
          cwd: this.workDirectory,
        },
      );
      this.process = child;
      let errors = '';
      let progressBuffer = '';
      child.stderr.on('data', (chunk) => {
        errors = (errors + chunk.toString()).slice(-16000);
      });
      child.stdout.on('data', (chunk) => {
        progressBuffer += chunk.toString();
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('out_time_us=')) {
            const elapsed = Number(line.slice(12)) / 1e6;
            if (Number.isFinite(elapsed))
              this.report(start + Math.min(1, elapsed / duration) * weight);
          }
        }
      });
      child.on('error', (error) =>
        reject(new Error(`Impossibile avviare FFmpeg. ${error.message}`)),
      );
      child.on('close', (code) => {
        this.process = null;
        if (this.cancelled) reject(new Error('cancelled'));
        else if (code === 0) resolve();
        else
          reject(
            new Error(
              errors.trim().split('\n').slice(-6).join('\n') ||
                `Esportazione interrotta (${code}).`,
            ),
          );
      });
    });
    this.report(start + weight);
  }

  private async renderClip(
    clip: VideoClip,
    index: number,
    elapsed: number,
    duration: number,
  ): Promise<string> {
    const asset = this.project.assets.find((item) => item.id === clip.assetId)!;
    const sourceDuration = clip.out - clip.in;
    const clipDuration = sourceDuration / clip.speed;
    const [width, height] = dimensions(
      this.project.aspectRatio,
      this.settings.resolution,
    );
    const clipFile = path.join(this.workDirectory, `clip-${index}.mp4`);
    const input =
      asset.kind === 'image'
        ? [
            '-loop',
            '1',
            '-framerate',
            String(this.settings.fps),
            '-i',
            asset.path,
          ]
        : [
            '-ss',
            String(clip.in),
            '-t',
            String(sourceDuration),
            '-i',
            asset.path,
          ];
    const videoFilters = [
      `trim=duration=${sourceDuration}`,
      `setpts=(PTS-STARTPTS)/${clip.speed}`,
    ];
    if (clip.rotation === 90) videoFilters.push('transpose=clock');
    if (clip.rotation === 180) videoFilters.push('hflip', 'vflip');
    if (clip.rotation === 270) videoFilters.push('transpose=cclock');
    if (clip.fit === 'cover')
      videoFilters.push(
        `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
      );
    else
      videoFilters.push(
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
      );
    videoFilters.push(
      'setsar=1',
      `fps=${this.settings.fps}`,
      ...colorFilters(clip),
    );
    if (clip.title?.text.trim()) {
      const titleFile = path.join(this.workDirectory, `title-${index}.txt`);
      const style = clip.title.style;
      await fs.writeFile(
        titleFile,
        wrappedTitle(clip.title.text, style === 'lower' ? 38 : 26),
        'utf8',
      );
      const titleSize = Math.round(
        width *
          (style === 'lower' ? 0.042 : style === 'cinema' ? 0.062 : 0.058),
      );
      const x = style === 'lower' ? 'w*0.06' : '(w-tw)/2';
      const y =
        style === 'lower'
          ? 'h-th-h*0.10'
          : style === 'cinema'
            ? '(h-th)/2'
            : '(h-th)/2';
      const color = /^#[0-9a-f]{6}$/i.test(clip.title.color)
        ? clip.title.color
        : '#ffffff';
      if (style === 'cinema') {
        videoFilters.push(
          'drawbox=x=0:y=0:w=iw:h=ih*0.10:color=black:t=fill',
          'drawbox=x=0:y=ih*0.90:w=iw:h=ih*0.10:color=black:t=fill',
        );
      }
      videoFilters.push(
        `drawtext=fontfile=title-font.ttf:textfile=title-${index}.txt:expansion=none:fontcolor=${color}:fontsize=${titleSize}:x=${x}:y=${y}:line_spacing=${Math.round(titleSize * 0.2)}:shadowcolor=black@0.7:shadowx=2:shadowy=2`,
      );
    }
    const fadeIn = Math.min(clip.fadeIn, clipDuration / 2);
    const fadeOut = Math.min(clip.fadeOut, clipDuration / 2);
    if (fadeIn > 0) videoFilters.push(`fade=t=in:st=0:d=${fadeIn}`);
    if (fadeOut > 0)
      videoFilters.push(`fade=t=out:st=${clipDuration - fadeOut}:d=${fadeOut}`);
    videoFilters.push('format=yuv420p');
    const audioFilters =
      asset.hasAudio && asset.kind === 'video'
        ? [
            `[0:a:0]atrim=duration=${sourceDuration}`,
            'asetpts=PTS-STARTPTS',
            ...tempoFilters(clip.speed),
            'aresample=48000',
            'aformat=sample_fmts=fltp:channel_layouts=stereo',
            `volume=${clip.muted ? 0 : clip.volume}`,
            'apad',
            `atrim=duration=${clipDuration}`,
          ]
        : ['anullsrc=r=48000:cl=stereo', `atrim=duration=${clipDuration}`];
    if (fadeIn > 0) audioFilters.push(`afade=t=in:st=0:d=${fadeIn}`);
    if (fadeOut > 0)
      audioFilters.push(
        `afade=t=out:st=${clipDuration - fadeOut}:d=${fadeOut}`,
      );
    const graph = `[0:V:0]${videoFilters.join(',')}[v];${audioFilters.join(',')}[a]`;
    const script = path.join(this.workDirectory, `filter-${index}.txt`);
    await fs.writeFile(script, graph, 'utf8');
    await this.run(
      [
        ...input,
        '-filter_complex_script',
        script,
        '-map',
        '[v]',
        '-map',
        '[a]',
        '-t',
        String(clipDuration),
        ...videoEncoderArgs(this.acceleration?.encoder??'libx264',this.settings.quality),
        '-c:a',
        'aac',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-b:a',
        '192k',
        '-video_track_timescale',
        '90000',
        clipFile,
      ],
      clipDuration,
      (elapsed / duration) * 0.86,
      (clipDuration / duration) * 0.86,
    );
    return clipFile;
  }

  async start(): Promise<void> {
    try {
      if (!this.project.clips.length)
        throw new Error('Aggiungi almeno una clip alla timeline.');
      const duration = projectDuration(this.project);
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error('La durata del filmato non è valida.');
      await protectSourceFiles(
        this.output,
        this.project.assets.map((asset) => asset.path),
      );
      const used = new Set(
        [...this.project.clips, ...this.project.audioTracks].map(
          (item) => item.assetId,
        ),
      );
      for (const asset of this.project.assets.filter((item) =>
        used.has(item.id),
      )) {
        if (asset.missing)
          throw new Error(`File mancante o modificato. ${asset.name}`);
        await fs.access(asset.path).catch(() => {
          throw new Error(`File mancante. ${asset.name}`);
        });
      }
      this.workDirectory = await fs.mkdtemp(
        path.join(path.dirname(this.output), '.duckymovie-render-'),
      );
      if (this.project.clips.some((clip) => clip.title?.text.trim()))
        await fs.copyFile(
          fontPath(),
          path.join(this.workDirectory, 'title-font.ttf'),
        );
      this.report(0);
      this.acceleration=await chooseExportAcceleration(this.settings.acceleration??'auto',this.abort.signal);
      this.report(0);
      const clips = await withEncodingFallback(this.acceleration,async info=>{
        this.acceleration=info;
        const files:string[]=[];
        let elapsed=0;
        for (const [index, clip] of this.project.clips.entries()) {
          files.push(await this.renderClip(clip,index,elapsed,duration));
          elapsed+=(clip.out-clip.in)/clip.speed;
        }
        return files;
      },{signal:this.abort.signal,onFallback:info=>{this.acceleration=info;this.report(0);}});
      const concatFile = path.join(this.workDirectory, 'concat.txt');
      await fs.writeFile(
        concatFile,
        clips.map((file) => `file '${path.basename(file)}'`).join('\n'),
      );
      const joinedFile = path.join(this.workDirectory, 'joined.mp4');
      await this.run(
        [
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          concatFile,
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          joinedFile,
        ],
        duration,
        0.86,
        0.04,
      );
      const finalFile = path.join(this.workDirectory, 'final.mp4');
      const tracks = this.project.audioTracks.filter(
        (track) => track.start < duration && track.out > track.in,
      );
      if (tracks.length) {
        const inputs = ['-i', joinedFile];
        const filters = ['[0:a:0]asetpts=PTS-STARTPTS[original]'];
        const labels = ['[original]'];
        tracks.forEach((track, index) => {
          const asset = this.project.assets.find(
            (item) => item.id === track.assetId,
          )!;
          const trackDuration = track.out - track.in;
          const audibleDuration = Math.min(
            trackDuration,
            duration - track.start,
          );
          inputs.push(
            '-ss',
            String(track.in),
            '-t',
            String(audibleDuration),
            '-i',
            asset.path,
          );
          const chain = [
            `[${index + 1}:a:0]asetpts=PTS-STARTPTS`,
            'aresample=48000',
            'aformat=sample_fmts=fltp:channel_layouts=stereo',
            `volume=${track.volume}`,
          ];
          if (track.fadeIn > 0)
            chain.push(
              `afade=t=in:st=0:d=${Math.min(track.fadeIn, trackDuration / 2)}`,
            );
          if (track.fadeOut > 0) {
            const fade = Math.min(track.fadeOut, trackDuration / 2);
            chain.push(`afade=t=out:st=${trackDuration - fade}:d=${fade}`);
          }
          chain.push(`adelay=${Math.round(track.start * 1000)}:all=1`);
          filters.push(`${chain.join(',')}[music${index}]`);
          labels.push(`[music${index}]`);
        });
        filters.push(
          `${labels.join('')}amix=inputs=${labels.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0[audio]`,
        );
        const script = path.join(this.workDirectory, 'mix.txt');
        await fs.writeFile(script, filters.join(';'), 'utf8');
        await this.run(
          [
            ...inputs,
            '-filter_complex_script',
            script,
            '-map',
            '0:v:0',
            '-map',
            '[audio]',
            '-c:v',
            'copy',
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            '-t',
            String(duration),
            '-movflags',
            '+faststart',
            finalFile,
          ],
          duration,
          0.9,
          0.1,
        );
      } else {
        await fs.rename(joinedFile, finalFile);
      }
      if (this.cancelled) throw new Error('cancelled');
      await fs.rename(finalFile, this.output);
      this.onProgress({
        jobId: this.id,
        progress: 1,
        state: 'complete',
        path: this.output,
        acceleration:this.acceleration,
        message:this.acceleration?.fallback??`${this.acceleration?.label??'CPU'} · esportazione completata`,
      });
    } catch (error) {
      this.onProgress({
        jobId: this.id,
        progress: 0,
        state: this.cancelled ? 'cancelled' : 'error',
        error: this.cancelled
          ? undefined
          : error instanceof Error
            ? error.message
            : String(error),
        acceleration:this.acceleration,
      });
    } finally {
      this.process = null;
      if (this.workDirectory)
        await fs
          .rm(this.workDirectory, { recursive: true, force: true })
          .catch(() => undefined);
    }
  }
}
