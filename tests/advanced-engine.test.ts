import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { configureEngine, EngineTask, EngineExportJob, needsAdvancedExport } from '../electron/engine';
import { setCacheDirectory, importFiles } from '../electron/media';
import { ffmpegPath, ffprobePath } from '../electron/binaries';
import { runProcess } from '../electron/process';
import { createProject, createClip, DEFAULT_SUBTITLE_STYLE } from '../src/model';
import type { ExportProgress } from '../shared/types';

test('Motore autonomo genera short e compone timeline con spazi, animazioni, karaoke e musica ripetuta', { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ducky-advanced-l'estate-"));
  try {
    configureEngine(directory);
    setCacheDirectory(path.join(directory, 'cache'));
    const health = await new EngineTask('health', {}, () => undefined).run() as { ready: boolean };
    assert.equal(health.ready, true);
    const video = path.join(directory, 'origine.mp4');
    const audio = path.join(directory, 'musica.wav');
    await runProcess(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
    await runProcess(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=0.4', audio]);
    const highlights = await new EngineTask('highlights', { path: video, count: 3, duration: 30 }, () => undefined).run() as { candidates: { start: number; end: number }[] };
    assert.equal(highlights.candidates.length, 1);
    assert.equal(highlights.candidates[0].start, 0);
    assert.ok(highlights.candidates[0].end > 2.9);
    const short = await new EngineTask('short-base', { path: video, start: .5, end: 1, style: 'blur', outputDir: path.join(directory, 'short') }, () => undefined).run() as { path: string };
    const shortInfo = JSON.parse((await runProcess(ffprobePath, ['-v', 'error', '-show_streams', '-of', 'json', short.path])).toString());
    assert.equal(shortInfo.streams[0].width, 1080);
    assert.equal(shortInfo.streams[0].height, 1920);
    const moving = path.join(directory, 'movimento.mp4');
    await runProcess(ffmpegPath, ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24:d=1',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=2',
      '-f', 'lavfi', '-i', 'color=c=white:s=24x24:r=24:d=3',
      '-filter_complex', "[0:v][1:v]concat=n=2:v=1:a=0[base];[base][2:v]overlay=x='mod(t*120,296)':y=78:shortest=1[v]",
      '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', moving]);
    const tracked = await new EngineTask('short-base', { path: moving, start: 1.2, end: 1.7, style: 'crop', outputDir: path.join(directory, 'tracked') }, () => undefined).run() as { path: string };
    const trackedInfo = JSON.parse((await runProcess(ffprobePath, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', tracked.path])).toString());
    assert.equal(trackedInfo.streams[0].width, 1080);
    assert.equal(trackedInfo.streams[0].height, 1920);
    assert.ok(Number(trackedInfo.streams[0].nb_frames) >= 10);
    assert.ok(Math.abs(Number(trackedInfo.format.duration) - .5) < .06);
    const firstFrame = await runProcess(ffmpegPath, ['-v', 'error', '-i', tracked.path, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    assert.ok(firstFrame[2] > firstFrame[0] + 100 && firstFrame[2] > firstFrame[1] + 100, 'Lo short deve iniziare nella sezione blu selezionata, successiva al primo secondo rosso.');
    const failedDirectory = path.join(directory, 'failed-short');
    await assert.rejects(new EngineTask('short-base', { path: path.join(directory, 'mancante.mp4'), start: 0, end: 1, style: 'crop', outputDir: failedDirectory }, () => undefined).run(), /non trovato/i);
    assert.deepEqual(await fs.readdir(failedDirectory).catch(() => []), []);
    const imported = await importFiles([video, audio]);
    assert.deepEqual(imported.errors, []);
    const project = createProject('Montaggio avanzato');
    project.assets = imported.assets;
    const clip = { ...createClip(imported.assets[0]), in: 0, out: .6, start: .2, crop: { x: .1, y: 0, w: .8, h: 1 }, mirror: true, zoom: 'in' as const, zoomAmount: 1.12, background: 'blur' as const };
    const second = { ...createClip(imported.assets[0]), in: 1, out: 1.6, start: .8, transition: 'zoom' as const, transitionDuration: .2, filter: 'vivid' as const, warmth: .2 };
    project.clips = [clip, second];
    project.duration = 1.6;
    project.music = { assetId: imported.assets[1].id, in: 0, out: .4, start: 0, volume: .1, loop: true, duck: true, phase: .1 };
    project.subtitles = { enabled: true, words: [{ start: .25, end: .6, text: 'Ciao' }, { start: .6, end: 1.2, text: 'DuckyMovie!' }], style: { ...DEFAULT_SUBTITLE_STYLE }, maxWords: 5, maxLines: 2 };
    project.overlays = [{ id: 'subscribe', kind: 'subscribe', text: 'ISCRIVITI', start: .3, end: 1.3, x: .5, y: .2, width: .35, opacity: .9, animation: 'pop', sound: true }];
    const output = path.join(directory, 'finale.mp4');
    const settings = { resolution: '720p' as const, fps: 24 as const, quality: 'standard' as const };
    assert.equal(needsAdvancedExport(project, settings), true);
    const events: ExportProgress[] = [];
    await new EngineExportJob(project, settings, output, progress => events.push(progress)).start();
    assert.equal(events.at(-1)?.state, 'complete', events.at(-1)?.error);
    const info = JSON.parse((await runProcess(ffprobePath, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', output])).toString());
    assert.equal(info.streams[0].width, 1280);
    assert.equal(info.streams[0].height, 720);
    assert.equal(info.streams.find((stream: any) => stream.codec_type === 'audio').codec_name, 'aac');
    assert.ok(Math.abs(Number(info.format.duration) - 1.6) < .08);
    const captionProject = createProject('Frase unita');
    captionProject.duration = 1.5;
    captionProject.subtitles = { enabled: true, maxWords: 1, maxLines: 2,
      style: { ...DEFAULT_SUBTITLE_STYLE, font: 'Arial', active_color: '#ffffff' },
      words: [{ start: .1, end: .7, text: 'AAAA', segmentId: 'frase-unita' }, { start: .8, end: 1.4, text: 'BBBB', segmentId: 'frase-unita' }] };
    const captionFile = path.join(directory, 'frase-unita.mp4');
    const captionEvents: ExportProgress[] = [];
    await new EngineExportJob(captionProject, settings, captionFile, event => captionEvents.push(event)).start();
    assert.equal(captionEvents.at(-1)?.state, 'complete', captionEvents.at(-1)?.error);
    const captionPixels = await runProcess(ffmpegPath, ['-v', 'error', '-ss', '0.4', '-i', captionFile, '-frames:v', '1', '-vf', 'crop=640:220:320:500', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    let left = 640;
    let right = 0;
    for (let offset = 0; offset < captionPixels.length; offset += 3) {
      if (captionPixels[offset] > 100 && captionPixels[offset + 1] > 100 && captionPixels[offset + 2] > 100) {
        const x = (offset / 3) % 640;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    assert.ok(right - left > 180, `La frase unita deve mostrare entrambe le parole anche con massimo una parola automatica. Larghezza ${right - left}`);
    const cancelled = new EngineTask('render', { project, settings, output: path.join(directory, 'cancelled.mp4') }, () => undefined);
    const completion = cancelled.run();
    setTimeout(() => cancelled.cancel(), 100);
    await assert.rejects(completion, /cancelled/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
