import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaAsset, Project } from '../shared/types';
import {
  addAssets, createAudioTrack, createClip, createProject, createSubtitles,
  getUsedAssetIds, linkSubtitlesToTimeline, projectDuration, removeAssets,
  syncLinkedSubtitles, timelinePositions, validateProject,
} from '../src/model';

function media(id: string, kind: MediaAsset['kind'] = 'image'): MediaAsset {
  return { id, name: id, path: `C:/fixture/${id}`, url: '', kind,
    duration: kind === 'image' ? 0 : 20, width: 640, height: 360, hasAudio: kind !== 'image' };
}

test('unused library deletion changes no timeline timing and unknown IDs do nothing', () => {
  const [one, unused] = [media('one.png'), media('unused.png')];
  const project = addAssets(createProject(), [one, unused]);
  project.clips = [createClip(one)];
  const result = removeAssets(project, [unused.id, unused.id]);
  assert.deepEqual(result.assets, [one]);
  assert.deepEqual(result.clips, project.clips);
  assert.equal(result.duration, undefined);
  assert.equal(removeAssets(project, ['unknown']), project);
  assert.deepEqual(getUsedAssetIds(project, [unused.id]), []);
  assert.deepEqual(project.assets, [one, unused]);
});

test('removing repeated media preserves leading, interior and trailing holes on every video lane', () => {
  const [deleted, kept] = [media('deleted.png'), media('kept.png')];
  const project = addAssets(createProject(), [deleted, kept]);
  project.tracks!.splice(1, 0, { id: 'upper', kind: 'video', name: 'Video 2', muted: false });
  project.clips = [createClip(deleted), createClip(kept), createClip(deleted), createClip(kept), createClip(deleted),
    createClip(deleted, 'upper'), createClip(kept, 'upper')];
  const original = structuredClone(project);
  const result = removeAssets(project, [deleted.id]);
  assert.deepEqual(timelinePositions(result).map(({ start, trackId }) => [start, trackId]), [[5, 'video-main'], [15, 'video-main'], [5, 'upper']]);
  assert.equal(projectDuration(result), 25);
  assert.equal(result.duration, 25);
  assert.deepEqual(project, original);
  assert.doesNotThrow(() => validateProject(result));
  const emptied = removeAssets(result, [kept.id]);
  assert.equal(emptied.clips.length, 0);
  assert.equal(projectDuration(emptied), 25);
});

test('bulk removal cleans audio, logos, music and source captions without moving unrelated content', () => {
  const [video, voice, logo, kept] = [media('video.mp4', 'video'), media('voice.wav', 'audio'), media('logo.png'), media('kept.png')];
  let project: Project = addAssets(createProject(), [video, voice, logo, kept]);
  const clip = { ...createClip(video), start: 2, out: 4, role: 'intro' as const };
  const audio = { ...createAudioTrack(voice, 10), out: 5 };
  project.clips = [clip, { ...createClip(kept), start: 20, role: 'outro' }];
  project.audioTracks = [audio, { ...createAudioTrack(video, 3), out: 3 }];
  project.overlays = [
    { id: 'logo', kind: 'image', assetId: logo.id, start: 0, end: 30, x: .5, y: .5, width: .2, opacity: 1, animation: 'none' },
    { id: 'title', kind: 'text', text: 'Keep', start: 12, end: 14, x: .5, y: .5, width: .2, opacity: 1, animation: 'none' },
  ];
  project.music = { assetId: voice.id, start: 0, in: 0, out: 5, loop: true, volume: .2, duck: true };
  project.subtitles = { ...createSubtitles(), words: [
    { id: 'video-word', text: 'Video', start: 2, end: 3, source: { kind: 'clip', id: clip.id, start: 0, end: 1 } },
    { id: 'audio-word', text: 'Audio', start: 10, end: 11, source: { kind: 'audio', id: audio.id, start: 0, end: 1 } },
    { id: 'free-word', detached: true, text: 'Free', start: 16, end: 17 },
  ] };
  project = linkSubtitlesToTimeline(project);
  assert.deepEqual(getUsedAssetIds(project, [video.id, voice.id, logo.id, logo.id]), [video.id, voice.id, logo.id]);
  const result = removeAssets(project, [video.id, voice.id, logo.id]);
  assert.deepEqual(result.assets.map(asset => asset.id), [kept.id]);
  assert.equal(result.clips[0].start, 20);
  assert.equal(result.audioTracks.length, 0);
  assert.equal(result.music, null);
  assert.deepEqual(result.overlays?.map(overlay => overlay.id), ['title']);
  assert.deepEqual(result.subtitles?.words.map(({ text, start }) => [text, start]), [['Free', 16]]);
  assert.equal(result.subtitles?.linkedWords?.length, 0);
  assert.equal(projectDuration(result), 30);
  assert.deepEqual(syncLinkedSubtitles(project, result), result);
  assert.doesNotThrow(() => validateProject(result));
});

test('audio-only deletion preserves silent duration and unrelated linked captions', () => {
  const [one, two] = [media('one.wav', 'audio'), media('two.wav', 'audio')];
  const project = addAssets(createProject(), [one, two]);
  const audio = { ...createAudioTrack(one, 0), out: 4 };
  const other = { ...createAudioTrack(two, 10), out: 4 };
  project.audioTracks = [audio, other];
  project.subtitles = { ...createSubtitles(), words: [
    { text: 'Legacy', start: 1, end: 2 },
    { id: 'kept', text: 'Keep', start: 11, end: 12, source: { kind: 'audio', id: other.id, start: 1, end: 2 } },
  ] };
  const result = removeAssets(project, [one.id]);
  assert.equal(result.audioTracks[0].start, 10);
  assert.deepEqual(result.subtitles!.words.map(word => word.text), ['Keep']);
  assert.equal(projectDuration(removeAssets(result, [two.id])), 14);
});
