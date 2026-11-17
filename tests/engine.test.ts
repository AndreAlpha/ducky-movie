import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  setCacheDirectory,
  importFiles,
  decodeMediaURL,
  mediaURL,
} from '../electron/media';
import { ffmpegPath, ffprobePath } from '../electron/binaries';
import { runProcess } from '../electron/process';
import { ExportJob, dimensions } from '../electron/export';
import * as store from '../electron/store';
import { createProject, createClip, createAudioTrack } from '../src/model';
import type { ExportProgress } from '../shared/types';

async function audioRms(file: string, start: number): Promise<number> {
  const samples = await runProcess(ffmpegPath, [
    '-v',
    'error',
    '-ss',
    String(start),
    '-i',
    file,
    '-t',
    '0.1',
    '-vn',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-f',
    'f32le',
    'pipe:1',
  ]);
  let sum = 0;
  const count = Math.floor(samples.length / 4);
  for (let index = 0; index < count; index++)
    sum += samples.readFloatLE(index * 4) ** 2;
  return Math.sqrt(sum / count);
}

test(
  'FFmpeg importa, salva e riapre riferimenti relativi ed esporta clip, foto, titoli e musica',
  { timeout: 180000 },
  async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ducky-l'estate-è-"),
    );
    try {
      setCacheDirectory(path.join(directory, 'cache'));
      store.setDataDirectory(path.join(directory, 'data'));
      const video = path.join(directory, "video è l'estate.mp4");
      const image = path.join(directory, 'foto.png');
      const audio = path.join(directory, 'musica.wav');
      const albumAudio = path.join(directory, 'canzone-con-copertina.mp3');
      const legacyVideo = path.join(directory, 'vecchia-videocamera.avi');
      await runProcess(ffmpegPath, [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=30:duration=2',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        video,
      ]);
      await runProcess(ffmpegPath, [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=180x320',
        '-frames:v',
        '1',
        image,
      ]);
      await runProcess(ffmpegPath, [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=220:duration=4',
        audio,
      ]);
      await runProcess(ffmpegPath, [
        '-v',
        'error',
        '-y',
        '-i',
        audio,
        '-i',
        image,
        '-map',
        '0:a',
        '-map',
        '1:v',
        '-c:a',
        'libmp3lame',
        '-c:v',
        'png',
        '-disposition:v',
        'attached_pic',
        albumAudio,
      ]);
      await runProcess(ffmpegPath, [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=25:duration=0.4',
        '-c:v',
        'wmv2',
        legacyVideo,
      ]);
      const imported = await importFiles([video, image, audio]);
      assert.deepEqual(imported.errors, []);
      assert.equal(imported.assets.length, 3);
      assert.equal(decodeMediaURL(imported.assets[0].url), video);
      assert.equal(decodeMediaURL(mediaURL(video)), video);
      assert.equal(decodeMediaURL('ducky-media://local/L2V0Yy9wYXNzd2Q'), null);
      assert.equal(imported.assets[0].hasAudio, true);
      assert.ok(imported.assets[0].thumbnail);
      assert.ok(imported.assets[2].waveform!.length);
      const [variants, concurrentVariant, duplicateVariant] = await Promise.all(
        [
          importFiles([albumAudio, legacyVideo]),
          importFiles([legacyVideo]),
          importFiles([legacyVideo]),
        ],
      );
      assert.deepEqual(variants.errors, []);
      assert.deepEqual(concurrentVariant.errors, []);
      assert.deepEqual(duplicateVariant.errors, []);
      assert.equal(
        concurrentVariant.assets[0].url,
        duplicateVariant.assets[0].url,
      );
      assert.notEqual(
        concurrentVariant.assets[0].id,
        duplicateVariant.assets[0].id,
      );
      assert.equal(variants.assets[0].kind, 'audio');
      assert.equal(variants.assets[1].kind, 'video');
      assert.ok(
        decodeMediaURL(variants.assets[1].url)?.endsWith('-preview.mp4'),
      );
      const project = createProject('Un film di prova');
      project.assets = imported.assets;
      const clip = createClip(imported.assets[0]);
      Object.assign(clip, {
        in: 0.2,
        out: 1.7,
        speed: 1.5,
        filter: 'vintage',
        fadeIn: 0.1,
        fadeOut: 0.1,
        brightness: 0.1,
        contrast: 1.1,
        saturation: 0.8,
        title: {
          text: 'Estate è qui\n100%: "Ducky" \\ [2026]',
          style: 'center',
          color: '#ffe26a',
        },
      });
      const photo = createClip(imported.assets[1]);
      Object.assign(photo, {
        out: 1,
        rotation: 90,
        fit: 'cover',
        filter: 'cool',
        title: { text: 'Alla prossima', style: 'cinema', color: '#ffffff' },
      });
      project.clips = [clip, photo];
      const music = createAudioTrack(imported.assets[2]);
      Object.assign(music, {
        start: 0.25,
        in: 0.5,
        out: 3,
        volume: 0.2,
        fadeIn: 0.2,
        fadeOut: 0.2,
      });
      project.audioTracks = [music];
      const file = path.join(directory, 'Film.duckymovie');
      await store.saveProject(project, file);
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(raw.assets[0].path, path.basename(video));
      assert.equal(raw.assets[0].url, '');
      const restored = await store.openProject(file);
      assert.deepEqual(restored.missingAssets, []);
      assert.equal(restored.project.clips[0].id, clip.id);
      assert.equal(restored.project.assets[0].path, video);
      await store.autosave(project);
      assert.equal((await store.recoverAutosave())?.id, project.id);
      assert.deepEqual(dimensions('9:16', '720p'), [720, 1280]);
      const output = path.join(directory, 'Film.mp4');
      const events: ExportProgress[] = [];
      const job = new ExportJob(
        restored.project,
        { resolution: '720p', fps: 24, quality: 'standard' },
        output,
        (progress) => events.push(progress),
      );
      await job.start();
      assert.equal(events.at(-1)?.state, 'complete', events.at(-1)?.error);
      const probe = JSON.parse(
        (
          await runProcess(ffprobePath, [
            '-v',
            'error',
            '-show_format',
            '-show_streams',
            '-of',
            'json',
            output,
          ])
        ).toString(),
      );
      const resultVideo = probe.streams.find(
        (stream: any) => stream.codec_type === 'video',
      );
      assert.equal(resultVideo.codec_name, 'h264');
      assert.equal(resultVideo.width, 1280);
      assert.equal(resultVideo.height, 720);
      assert.ok(Math.abs(Number(probe.format.duration) - 2) < 0.15);
      assert.equal(
        probe.streams.find((stream: any) => stream.codec_type === 'audio')
          .codec_name,
        'aac',
      );
      const montage = {
        ...project,
        audioTracks: [],
        clips: Array.from({ length: 8 }, () => ({
          ...createClip(imported.assets[0]),
          in: 0.2,
          out: 0.3,
        })),
      };
      const montageFile = path.join(directory, 'montage.mp4');
      const montageEvents: ExportProgress[] = [];
      await new ExportJob(
        montage,
        { resolution: '720p', fps: 30, quality: 'standard' },
        montageFile,
        (progress) => montageEvents.push(progress),
      ).start();
      assert.equal(
        montageEvents.at(-1)?.state,
        'complete',
        montageEvents.at(-1)?.error,
      );
      const montageProbe = JSON.parse(
        (
          await runProcess(ffprobePath, [
            '-v',
            'error',
            '-show_format',
            '-show_streams',
            '-of',
            'json',
            montageFile,
          ])
        ).toString(),
      );
      assert.ok(
        Math.abs(Number(montageProbe.format.duration) - 0.8) < 0.06,
        `Durata montaggio ${montageProbe.format.duration}`,
      );
      const montageVideoDuration = Number(
        montageProbe.streams.find(
          (stream: any) => stream.codec_type === 'video',
        ).duration,
      );
      const montageAudioDuration = Number(
        montageProbe.streams.find(
          (stream: any) => stream.codec_type === 'audio',
        ).duration,
      );
      assert.ok(
        Math.abs(montageVideoDuration - montageAudioDuration) < 0.04,
        `Audio ${montageAudioDuration}, video ${montageVideoDuration}`,
      );
      for (const aspect of ['9:16', '1:1'] as const) {
        const frame = {
          ...photo,
          id: `frame-${aspect}`,
          in: 0,
          out: 0.2,
          filter: 'warm' as const,
          title: {
            text: 'Un nuovo formato',
            style: 'lower' as const,
            color: '#ffffff',
          },
        };
        const verticalProject = {
          ...project,
          aspectRatio: aspect,
          clips: [frame],
          audioTracks: [],
        };
        const verticalFile = path.join(
          directory,
          `formato-${aspect.replace(':', '-')}.mp4`,
        );
        const verticalEvents: ExportProgress[] = [];
        await new ExportJob(
          verticalProject,
          { resolution: '720p', fps: 25, quality: 'standard' },
          verticalFile,
          (progress) => verticalEvents.push(progress),
        ).start();
        assert.equal(
          verticalEvents.at(-1)?.state,
          'complete',
          verticalEvents.at(-1)?.error,
        );
        const verticalProbe = JSON.parse(
          (
            await runProcess(ffprobePath, [
              '-v',
              'error',
              '-show_streams',
              '-of',
              'json',
              verticalFile,
            ])
          ).toString(),
        );
        const verticalVideo = verticalProbe.streams.find(
          (stream: any) => stream.codec_type === 'video',
        );
        assert.equal(verticalVideo.width, 720);
        assert.equal(verticalVideo.height, aspect === '9:16' ? 1280 : 720);
      }
      for (const fade of ['in', 'out'] as const) {
        const longMusic = {
          ...music,
          in: 0,
          out: 4,
          start: 0,
          volume: 0.8,
          fadeIn: fade === 'in' ? 2 : 0,
          fadeOut: fade === 'out' ? 2 : 0,
        };
        const musicProject = {
          ...project,
          clips: [{ ...photo, in: 0, out: 2, title: null }],
          audioTracks: [longMusic],
        };
        const musicFile = path.join(directory, `musica-tagliata-${fade}.mp4`);
        const musicEvents: ExportProgress[] = [];
        await new ExportJob(
          musicProject,
          { resolution: '720p', fps: 25, quality: 'standard' },
          musicFile,
          (progress) => musicEvents.push(progress),
        ).start();
        assert.equal(
          musicEvents.at(-1)?.state,
          'complete',
          musicEvents.at(-1)?.error,
        );
        const beginning = await audioRms(musicFile, 0.4);
        const ending = await audioRms(musicFile, 1.5);
        const ratio = ending / beginning;
        if (fade === 'out')
          assert.ok(
            ratio > 0.9 && ratio < 1.1,
            `Dissolvenza finale anticipata. Rapporto ${ratio}`,
          );
        else
          assert.ok(
            ratio > 3 && ratio < 4,
            `Dissolvenza iniziale abbreviata. Rapporto ${ratio}`,
          );
      }
      const cancelledFile = path.join(directory, 'cancelled.mp4');
      const cancelled: ExportProgress[] = [];
      const cancellation = new ExportJob(
        project,
        { resolution: '720p', fps: 30, quality: 'standard' },
        cancelledFile,
        (progress) => {
          cancelled.push(progress);
          if (progress.state === 'running') cancellation.cancel();
        },
      );
      await cancellation.start();
      assert.equal(cancelled.at(-1)?.state, 'cancelled');
      await assert.rejects(fs.access(cancelledFile));
      const leftovers = (await fs.readdir(directory)).filter((item) =>
        item.startsWith('.duckymovie-render-'),
      );
      assert.deepEqual(leftovers, []);
      const before = await fs.readFile(video);
      const blocked: ExportProgress[] = [];
      await new ExportJob(
        project,
        { resolution: '720p', fps: 30, quality: 'standard' },
        video,
        (progress) => blocked.push(progress),
      ).start();
      assert.equal(blocked.at(-1)?.state, 'error');
      assert.deepEqual(await fs.readFile(video), before);
      await fs.rename(image, `${image}.moved`);
      assert.deepEqual((await store.openProject(file)).missingAssets, [
        'foto.png',
      ]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
