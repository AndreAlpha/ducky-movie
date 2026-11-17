import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureEngine, EngineExportJob, needsAdvancedExport } from '../electron/engine';
import { setCacheDirectory, importFiles } from '../electron/media';
import { ffmpegPath, ffprobePath } from '../electron/binaries';
import { runProcess } from '../electron/process';
import { formatTranscript, validateTranscript } from '../electron/transcript';
import { createProject, createClip, createAudioTrack, splitAudioTrack, DEFAULT_SUBTITLE_STYLE } from '../src/model';
import type { ExportProgress, Project } from '../shared/types';

const settings = { resolution: '720p' as const, fps: 24 as const, quality: 'standard' as const };

async function render(project: Project, output: string): Promise<void> {
  const events: ExportProgress[] = [];
  assert.equal(needsAdvancedExport(project, settings), true);
  await new EngineExportJob(project, settings, output, event => events.push(event)).start();
  assert.equal(events.at(-1)?.state, 'complete', events.at(-1)?.error);
}

async function pixel(file: string, x: number, y: number): Promise<Buffer> {
  return runProcess(ffmpegPath, ['-v', 'error', '-ss', '0.4', '-i', file, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
}

async function audioSamples(file: string, start: number): Promise<Buffer> {
  return runProcess(ffmpegPath, ['-v', 'error', '-ss', String(start), '-i', file, '-t', '0.1', '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
}

function amplitude(samples: Buffer, frequency: number): number {
  const count = samples.length / 4;
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < count; index++) {
    const sample = samples.readFloatLE(index * 4);
    const phase = 2 * Math.PI * frequency * index / 48000;
    real += sample * Math.cos(phase);
    imaginary += sample * Math.sin(phase);
  }
  return 2 * Math.hypot(real, imaginary) / count;
}

test('Esportazione sovrappone corsie video, conserva trasparenza e posizione e mixa corsie audio indipendenti', { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ducky-multitrack-'));
  try {
    configureEngine(directory);
    setCacheDirectory(path.join(directory, 'cache'));
    const bottom = path.join(directory, 'rosso.mp4');
    const top = path.join(directory, 'blu.mp4');
    const speech = path.join(directory, 'voce.wav');
    const mutedAudio = path.join(directory, 'audio-disattivato.wav');
    await runProcess(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', bottom]);
    await runProcess(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=90x180:r=24:d=0.75', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.75', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', top]);
    await runProcess(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1.3', speech]);
    await runProcess(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=1760:duration=1.3', mutedAudio]);
    const imported = await importFiles([bottom, top, speech, mutedAudio]);
    assert.deepEqual(imported.errors, []);
    let project = createProject('Due livelli');
    project.assets = imported.assets;
    project.tracks = [
      { id: 'video-top', kind: 'video', name: 'Sovrapposizione', muted: true },
      { id: 'video-main', kind: 'video', name: 'Video principale', muted: false },
      { id: 'audio-main', kind: 'audio', name: 'Voce', muted: false },
      { id: 'audio-muted', kind: 'audio', name: 'Audio disattivato', muted: true },
    ];
    project.clips = [
      { ...createClip(imported.assets[0]), trackId: 'video-main', in: 0, out: 1, start: 0, volume: .2 },
      { ...createClip(imported.assets[1]), trackId: 'video-top', in: 0, out: .75, start: .25, placement: { x: .75, y: .5, scale: .5, opacity: .5 } },
    ];
    const voice = { ...createAudioTrack(imported.assets[2]), trackId: 'audio-main', out: 1.3, volume: .5 };
    project.audioTracks = [voice, { ...createAudioTrack(imported.assets[3]), trackId: 'audio-muted' }];
    project = splitAudioTrack(project, voice.id, .6);
    assert.equal(project.audioTracks.filter(track => track.trackId === 'audio-main').length, 2);
    const output = path.join(directory, 'livelli.mp4');
    await render(project, output);
    const info = JSON.parse((await runProcess(ffprobePath, ['-v', 'error', '-show_format', '-of', 'json', output])).toString());
    assert.ok(Math.abs(Number(info.format.duration) - 1.3) < .06, `Durata ${info.format.duration}`);
    const blended = await pixel(output, 960, 360);
    assert.ok(blended[0] > 95 && blended[2] > 95 && blended[1] < 25, `Centro sovrapposto ${[...blended]}`);
    const underneath = await pixel(output, 640, 360);
    assert.ok(underneath[0] > 220 && underneath[2] < 25, `Trasparenza esterna ${[...underneath]}`);
    const sound = await audioSamples(output, .35);
    assert.ok(amplitude(sound, 220) > .03);
    assert.ok(amplitude(sound, 440) > .01);
    assert.ok(amplitude(sound, 880) < .003, 'La corsia video disattivata deve mantenere il video e silenziare il proprio audio.');
    assert.ok(amplitude(sound, 1760) < .003, 'La corsia audio disattivata deve essere silenziosa.');
    assert.ok(amplitude(await audioSamples(output, 1.05), 220) > .03, 'La narrazione deve continuare oltre la fine delle clip video.');
    const hidden = { ...project, tracks: project.tracks!.map(track => track.id === 'video-top' ? { ...track, hidden: true } : track) };
    const hiddenFile = path.join(directory, 'livello-nascosto.mp4');
    await render(hidden, hiddenFile);
    const visible = await pixel(hiddenFile, 960, 360);
    assert.ok(visible[0] > 220 && visible[2] < 25, 'Nascondere il livello superiore deve mostrare quello inferiore.');
    const audioOnly = { ...project, clips: [], audioTracks: project.audioTracks.filter(track => track.trackId === 'audio-main'), subtitles: { enabled: true, words: [{ start: .1, end: .8, text: 'Solo audio.' }], style: { ...DEFAULT_SUBTITLE_STYLE }, maxWords: 5, maxLines: 2 } };
    const audioFile = path.join(directory, 'solo-audio.mp4');
    await render(audioOnly, audioFile);
    const black = await pixel(audioFile, 10, 10);
    assert.ok([...black].every(channel => channel < 8));
    assert.ok(amplitude(await audioSamples(audioFile, 1.05), 220) > .03);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('La trascrizione audio si esporta in testo e SRT con tempi delle parole', () => {
  const subtitles = { enabled: true, words: [{ start: .125, end: .375, text: 'Ciao' }, { start: .5, end: 1.25, text: 'mondo!' }, { start: 2, end: 2.5, text: 'Ancora.' }], style: { ...DEFAULT_SUBTITLE_STYLE }, maxWords: 5, maxLines: 2 };
  assert.equal(formatTranscript(subtitles, 'txt'), 'Ciao mondo!\r\nAncora.\r\n');
  assert.equal(formatTranscript(subtitles, 'srt'), '1\r\n00:00:00,125 --> 00:00:01,250\r\nCiao mondo!\r\n\r\n2\r\n00:00:02,000 --> 00:00:02,500\r\nAncora.\r\n');
  const linked = { ...subtitles, words: subtitles.words.map((word, index) => ({ ...word, id: `word-${index}`, linkedId: `canonical-${index}`, source: { kind: 'audio' as const, id: 'owner-assente', start: word.start, end: word.end } })), linkedWords: [{ id: 'canonical-0', text: 'Ciao', sources: [{ kind: 'audio' as const, id: 'owner-assente', start: .125, end: .375 }] }] };
  const standalone = validateTranscript(linked);
  assert.ok(standalone.words.every(word => !word.source && !word.linkedId));
  assert.equal(formatTranscript(standalone, 'srt'), formatTranscript(subtitles, 'srt'));
  const clips = { ...subtitles, words: [
    { start: 0, end: .2, text: 'Una', source: { kind: 'clip' as const, id: 'prima', start: 0, end: .2 } },
    { start: .3, end: .6, text: 'frase', source: { kind: 'clip' as const, id: 'seconda', start: .3, end: .6 } },
  ] };
  assert.equal(formatTranscript(validateTranscript(clips), 'txt'), 'Una\r\nfrase\r\n');
  const merged = { ...clips, maxWords: 1, words: clips.words.map(word => ({ ...word, segmentId: 'unite' })) };
  assert.equal(formatTranscript(validateTranscript(merged), 'txt'), 'Una frase\r\n');
});
