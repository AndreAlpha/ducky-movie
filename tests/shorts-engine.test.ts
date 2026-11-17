import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { configureEngine, EngineTask } from '../electron/engine';
import { ffmpegPath, ffprobePath } from '../electron/binaries';
import { runProcess } from '../electron/process';

test('Short crop segue un target scelto nel video codificato e conserva intervallo, formato e audio', { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ducky-tracking-'));
  try {
    configureEngine(directory);
    const source = path.join(directory, 'target.mp4');
    await runProcess(ffmpegPath, ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=24:d=4',
      '-f', 'lavfi', '-i', 'color=c=blue:s=40x48:r=24:d=4,drawgrid=w=10:h=12:t=1:c=white',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-filter_complex', "[0:v]drawbox=x=250:y=35:w=55:h=100:c=red:t=fill[base];[base][1:v]overlay=x='30+t*45':y=60:shortest=1[v]",
      '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
    const suggestions = await new EngineTask('highlights', { path: source, count: 2, duration: 1.2 }, () => undefined).run() as { candidates: { start: number; end: number }[]; analysis: { speechDetection: string } };
    assert.equal(suggestions.analysis.speechDetection, 'silero', 'Il modello VAD deve funzionare dal pacchetto, senza download');
    assert.equal(suggestions.candidates.length, 2);
    const ordered = [...suggestions.candidates].sort((a, b) => a.start - b.start);
    assert.ok(ordered[0].end <= ordered[1].start);
    const tracked = await new EngineTask('short-base', { path: source, start: .25, end: 3.75, style: 'crop',
      tracking: { focusX: .19, focusY: .47, mode: 'person', sensitivity: 'steady' }, outputDir: path.join(directory, 'out') }, () => undefined).run() as { path: string; tracking: Record<string, number> };
    const info = JSON.parse((await runProcess(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', tracked.path])).toString());
    assert.equal(info.streams[0].width, 1080);
    assert.equal(info.streams[0].height, 1920);
    assert.equal(info.streams.find((stream: any) => stream.codec_type === 'audio')?.codec_name, 'aac');
    assert.ok(Math.abs(Number(info.format.duration) - 3.5) < .06);
    assert.ok(tracked.tracking.flowSamples + tracked.tracking.motionSamples > 15, JSON.stringify(tracked.tracking));
    const frames = await runProcess(ffmpegPath, ['-v', 'error', '-i', tracked.path, '-vf', 'fps=8,scale=90:160', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    const bytesPerFrame = 90 * 160 * 3;
    let visible = 0;
    const frameCount = Math.floor(frames.length / bytesPerFrame);
    for (let frame = 0; frame < frameCount; frame++) {
      let blue = 0;
      for (let offset = frame * bytesPerFrame; offset < (frame + 1) * bytesPerFrame; offset += 3) {
        if (frames[offset + 2] > frames[offset] + 60 && frames[offset + 2] > frames[offset + 1] + 60) blue++;
      }
      if (blue > 100) visible++;
    }
    assert.ok(visible / frameCount >= .95, `Target visibile in ${visible}/${frameCount} frame campionati`);
    console.log(`Tracking reale: target visibile ${visible}/${frameCount}; ${JSON.stringify(tracked.tracking)}`);
    const cancelled = new EngineTask('short-base', { path: source, start: 0, end: 4, style: 'crop', outputDir: path.join(directory, 'cancelled') }, () => undefined);
    const completion = cancelled.run();
    setTimeout(() => cancelled.cancel(), 400);
    await assert.rejects(completion, /cancelled/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
