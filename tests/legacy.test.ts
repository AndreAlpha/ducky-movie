import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { MediaAsset } from '../shared/types';
import { convertLegacyProject, gatherLegacyPaths } from '../electron/legacy';
import { applyProjectTemplate, createProject, projectDuration } from '../src/model';

const base = path.resolve('tests/legacy-fixtures');
function asset(file: string, kind: MediaAsset['kind'], duration: number, width = 1920, height = 1080): MediaAsset {
  return { id: file, name: file, path: path.join(base, file), url: '', kind, duration, width, height, hasAudio: kind !== 'image' };
}
const media = [asset('intro.mp4', 'video', 2), asset('outro.mp4', 'video', 5), asset('photo.jpg', 'image', 0),
  asset('scene.mp4', 'video', 20), asset('voice.wav', 'audio', 20), asset('music.mp3', 'audio', 7), asset('logo.png', 'image', 0, 200, 100)];

test('DuckyPlay project import preserves scenes, gaps, narrated words, logo and outro tail', () => {
  const source = { version: 3, width: 1920, height: 1080, mirror_global: true,
    intro: { path: 'intro.mp4', duration: 2 }, outro: { path: 'outro.mp4', duration: 5 },
    logo: 'logo.png', logo_layout: { x: 0.8, y: 0.8, w: 0.1 },
    media: [{ path: 'photo.jpg' }, { path: 'scene.mp4' }],
    segments: [{ type: 'image', source: 'photo.jpg', start: 0, end: 4, zoom_in: false, transition: 'white' },
      { type: 'clip', source: 'scene.mp4', start: 8, end: 14, in: 3, out: 15, speed: 2, mirror: true, use_audio: false, crop: { x: 0.2, y: 0, w: 0.7, h: 1 } }],
    audios: [{ path: 'voice.wav', start: 0, in: 0, out: 20, volume: 2.4 }],
    words: [{ start: 0.5, end: 1, text: 'Vecchio' }],
    subtitles: { enabled: true, max_words: 5, max_lines: 2, events: [{ start: 0.5, end: 1, words: [{ t0: 0.5, t1: 1, text: 'Corretto' }] }], style: { font: 'Georgia', wrap_frac: 0.75 } },
    overlays: [{ type: 'subscribe', start: 4, duration: 8, text: 'Seguici', size: 0.065, anim: 'pop', box: true, box_color: '#E11D2A' }],
    music: { path: 'music.mp3', volume: 0.12, duck: true } };
  assert.equal(gatherLegacyPaths(source, base).length, 7);
  const project = convertLegacyProject(source, media, base);
  assert.equal(projectDuration(project), 25);
  assert.deepEqual(project.clips.map((clip) => [clip.role, clip.start ?? 0, clip.in, clip.out]), [
    ['intro', 0, 0, 2], ['normal', 2, 0, 4], ['normal', 10, 3, 15], ['outro', 20, 0, 5] ]);
  assert.equal(project.clips[1].zoom, 'out');
  assert.equal(project.clips[2].muted, true);
  assert.equal(project.audioTracks[0].start, 2);
  assert.equal(project.audioTracks[0].volume, 2.4);
  assert.deepEqual(project.subtitles?.words.map(({start,end,text})=>({start,end,text})), [{ start: 2.5, end: 3, text: 'Corretto' }]);
  assert.deepEqual(project.subtitles?.words[0].source, {kind:'audio',id:project.audioTracks[0].id,start:.5,end:1});
  assert.equal(project.subtitles?.style.width_frac, 0.75);
  assert.equal(project.overlays?.[0].x, 0.8500000000000001);
  assert.equal(project.overlays?.[0].persistent, true);
  assert.equal(project.overlays?.[1].start, 6);
  assert.equal(project.overlays?.[1].fontSize, 0.065);
  assert.equal(project.overlays?.[1].boxColor, '#E11D2A');
  assert.equal(project.music?.duck, true);
  assert.equal(project.mirror, true);
});

test('DuckyPlay template uses only branding media and global logo expands over the new film', () => {
  const template = convertLegacyProject({ kind: 'duckyvm-template', version: 1,
    intro: { path: 'intro.mp4', duration: 2 }, outro: { path: 'outro.mp4', duration: 5 }, logo: 'logo.png', overlays: [] },
  media.filter((item) => ['intro.mp4', 'outro.mp4', 'logo.png'].includes(item.id)), base);
  const target = createProject();
  target.duration = 12;
  const applied = applyProjectTemplate(target, template);
  assert.equal(projectDuration(applied), 19);
  assert.equal(applied.overlays?.[0].start, 2);
  assert.equal(applied.overlays?.[0].end, 14);
});

test('old single audio migrates with source trim-aware word timing', () => {
  const source = { version: 2, segments: [], audios: [{ path: 'voice.wav', start: 3, in: 5, out: 10,
    words: [{ start: 4, end: 5, text: 'Scarta' }, { start: 6, end: 7, text: 'Ciao' }] }] };
  const project = convertLegacyProject(source, [media[4]], base);
  assert.deepEqual(project.subtitles?.words.map(({start,end,text})=>({start,end,text})), [{ start: 4, end: 5, text: 'Ciao' }]);
  assert.deepEqual(project.subtitles?.words[0].source, {kind:'audio',id:project.audioTracks[0].id,start:6,end:7});
  assert.equal(projectDuration(project), 8);
  const old = convertLegacyProject({ version: 1, audio: 'voice.wav', audio_duration: 10, segments: [], words: [{ start: 1, end: 2, text: 'Ciao' }] }, [media[4]], base);
  assert.equal(old.audioTracks.length, 1);
  assert.equal(old.audioTracks[0].out, 10);
});

test('legacy import rejects unrecognized schemas and unavailable media without discarding them', () => {
  assert.throws(() => gatherLegacyPaths({ hello: 'world' }, base), /non contiene/);
  assert.throws(() => convertLegacyProject({ version: 3, media: [{ path: 'missing.jpg' }], segments: [] }, media, base), /non disponibile/);
  assert.throws(() => convertLegacyProject({ version: 8, segments: [] }, [], base), /Versione/);
});

test('overlapping DuckyPlay narration migrates to separate reusable audio lanes', () => {
  const source = { version: 3, segments: [], audios: [
    { path: 'voice.wav', start: 0, in: 0, out: 4 },
    { path: 'voice.wav', start: 2, in: 0, out: 4 },
    { path: 'voice.wav', start: 4, in: 0, out: 2 },
  ] };
  const project = convertLegacyProject(source, [media[4]], base);
  assert.deepEqual(project.audioTracks.map((track) => track.trackId), ['audio-main', 'audio-2', 'audio-main']);
  assert.equal(project.tracks?.filter((track) => track.kind === 'audio').length, 2);
});
