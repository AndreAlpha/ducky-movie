import test from 'node:test';
import assert from 'node:assert/strict';
import type { MediaAsset, Project } from '../shared/types';
import { insertLibraryAssets } from '../src/library';
import {
  addAssets, createAudioTrack, createClip, createProject, createSubtitles,
  projectDuration, timelinePositions, validateProject,
} from '../src/model';

function media(id: string, kind: MediaAsset['kind'], duration = 10): MediaAsset {
  return { id, name: id, path: 'C:/fixtures/' + id, url: '', kind, duration: kind === 'image' ? 0 : duration,
    width: 640, height: 360, hasAudio: kind !== 'image' };
}
const photo = media('photo.png', 'image'), film = media('video.mp4', 'video'), sound = media('voice.wav', 'audio');
const fixture = () => addAssets(createProject(), [photo, film, sound]);
const positions = (project: Project) => timelinePositions(project).map(({ clip, start, end }) => [clip.assetId, start, end]);

test('insert between sequential clips ripples the whole suffix and keeps trailing blank time', () => {
  const project = fixture();
  project.clips = [createClip(film), createClip(film), { ...createClip(film), start: 24 }];
  project.duration = 40;
  project.audioTracks = [createAudioTrack(sound, 12)];
  const inserted = insertLibraryAssets(project, [photo.id], 10, 'video-main');
  assert.deepEqual(positions(inserted.project), [[film.id, 0, 10], [photo.id, 10, 15], [film.id, 15, 25], [film.id, 29, 39]]);
  assert.equal(inserted.project.audioTracks[0].start, 12);
  assert.equal(inserted.project.duration, 45);
  assert.equal(inserted.clipIds[0], inserted.project.clips[1].id);
  assert.equal(projectDuration(project), 40);
  validateProject(inserted.project);
});

test('an existing gap is filled first and only the missing space is added to the suffix', () => {
  const project = fixture();
  project.clips = [createClip(film), { ...createClip(film), start: 20 }, { ...createClip(film), start: 40 }];
  const fits = insertLibraryAssets(project, [photo.id], 12);
  assert.deepEqual(positions(fits.project), [[film.id, 0, 10], [photo.id, 12, 17], [film.id, 20, 30], [film.id, 40, 50]]);
  const overlaps = insertLibraryAssets(project, [photo.id, film.id], 12);
  assert.deepEqual(positions(overlaps.project), [[film.id, 0, 10], [photo.id, 12, 17], [film.id, 17, 27], [film.id, 27, 37], [film.id, 47, 57]]);
  validateProject(overlaps.project);
});

test('a cut into a sped-up legacy video retains source ranges, aligned words and safe minimum duration at edges', () => {
  const project = fixture();
  project.clips = [{ ...createClip(film), in: 2, out: 8, speed: 1.5 }];
  const original = project.clips[0];
  project.subtitles = { ...createSubtitles(), words: [
    { id: 'one', text: 'Prima', start: 0, end: .5, source: { kind: 'clip', id: original.id, start: 2, end: 2.75 } },
    { id: 'two', text: 'Dopo', start: 2, end: 3, source: { kind: 'clip', id: original.id, start: 5, end: 6.5 } },
  ] };
  const { project: edited, clipIds } = insertLibraryAssets(project, [photo.id], 1.25);
  assert.deepEqual(positions(edited), [[film.id, 0, 1.25], [photo.id, 1.25, 6.25], [film.id, 6.25, 9]]);
  assert.deepEqual(edited.clips.map(item => [item.in, item.out]), [[2, 3.875], [0, 5], [3.875, 8]]);
  assert.deepEqual(edited.subtitles?.words.map(word => [word.text, word.start]), [['Prima', 0], ['Dopo', 7]]);
  assert.deepEqual(clipIds, [edited.clips[1].id]);
  validateProject(edited);
  assert.deepEqual(positions(insertLibraryAssets(project, [photo.id], 4 - .001).project), [[film.id, 0, 4], [photo.id, 4, 9]]);
  assert.deepEqual(positions(insertLibraryAssets(project, [photo.id], .001).project), [[photo.id, 0, 5], [film.id, 5, 9]]);
});

test('bulk mixed drop extracts sound and splits its owner while preserving unrelated video and free words', () => {
  const project = fixture();
  const original = createAudioTrack(sound, 0);
  project.audioTracks = [original, { ...createAudioTrack(sound, 20), trackId: undefined }];
  project.clips = [{ ...createClip(film), start: 14 }];
  project.subtitles = { ...createSubtitles(), words: [
    { id: 'voice', text: 'Voce', start: 6, end: 7, source: { kind: 'audio', id: original.id, start: 6, end: 7 } },
    { id: 'free', detached: true, text: 'Libero', start: 9, end: 10 },
  ] };
  const result = insertLibraryAssets(project, [film.id, photo.id], 4, 'audio-main');
  assert.deepEqual(positions(result.project), [[photo.id, 4, 9], [film.id, 14, 24]]);
  assert.deepEqual(result.project.audioTracks.map(item => [item.assetId, item.start, item.in, item.out]),
    [[sound.id, 0, 0, 4], [film.id, 4, 0, 10], [sound.id, 14, 4, 10], [sound.id, 30, 0, 10]]);
  assert.deepEqual(result.project.subtitles?.words.map(word => [word.text, word.start]), [['Libero', 9], ['Voce', 16]]);
  assert.equal(result.audioIds[0], result.project.audioTracks[1].id);
  validateProject(result.project);
});

test('an insertion that would ripple content past the project limit fails atomically', () => {
  const project = fixture();
  project.clips = [{ ...createClip(photo), start: 86394 }];
  const before = structuredClone(project);
  assert.throws(() => insertLibraryAssets(project, [photo.id], 86394), /24 ore/);
  assert.deepEqual(project, before);
});

test('adjacent fractional timestamps share an insertion edge', () => {
  const project = fixture();
  project.clips = [{ ...createClip(film), out: .1 + .2 }, { ...createClip(photo), start: .3 }];
  const result = insertLibraryAssets(project, [film.id], .3);
  assert.deepEqual(result.project.clips.map(item => item.assetId), [film.id, film.id, photo.id]);
  assert.equal(result.project.clips[2].start, 10.3);
  validateProject(result.project);
});

test('a split plus insertion cannot exceed the saved project item limit', () => {
  const project = fixture();
  project.clips = Array.from({ length: 9999 }, () => createClip(photo));
  assert.throws(() => insertLibraryAssets(project, [photo.id], 2.5), /Clip/);
  assert.equal(project.clips.length, 9999);
  assert.equal(project.clips[0].out, 5);
});
