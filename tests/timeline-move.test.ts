import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaAsset } from '../shared/types';
import { addTimelineTrack, applyTimelineMove, createAudioTrack, createClip, createProject, createSubtitles,
  linkSubtitlesToTimeline, planTimelineMove, timelinePositions, validateProject } from '../src/model';

const asset: MediaAsset = { id: 'media', kind: 'video', name: 'Scena', path: 'C:/Scena.mp4',
  duration: 10, width: 1920, height: 1080, hasAudio: true, url: '' };

function film(starts: number[]) {
  const project = createProject('Montaggio');
  project.assets = [asset];
  project.clips = starts.map((start, i) => ({ ...createClip(asset), id: String(i), out: 4, start }));
  return project;
}

test('dragging into a neighbour from either side attaches the near edge, then crosses its midpoint', () => {
  for (const [starts, requested, expected] of [
    [[10, 24], 13.8, 14], [[10, 24], 11.9, 6],
    [[10, 0], 6.2, 6], [[10, 0], 8.1, 14],
  ] as const) {
    const project = film([...starts]);
    const args = ['1', 'clip', ['1'], 'video-main', requested] as const;
    const plan = planTimelineMove(project, ...args);
    assert.equal(plan.start, expected);
    assert.equal(plan.displaced, false);
    const result = applyTimelineMove(project, ...args);
    assert.equal(result.clips.find(clip => clip.id === '1')?.start, expected);
    assert.equal(result.clips.find(clip => clip.id === '0')?.start, 10);
    assert.equal(project.clips[1].start, starts[1]);
  }
});

test('a touching block swaps without growing the lane or moving later gaps, and captions travel with each owner', () => {
  const project = film([0, 4, 8, 12, 25]);
  project.subtitles = { ...createSubtitles(), words: project.clips.map(clip => ({
    id: 'word-' + clip.id, text: clip.id, start: clip.start! + .25, end: clip.start! + 1,
    source: { id: clip.id, kind: 'clip', start: .25, end: 1 },
  })) };
  const linked = linkSubtitlesToTimeline(project);
  const result = applyTimelineMove(linked, '0', 'clip', ['0','1'], 'video-main', 12, 15);
  assert.deepEqual(result.clips.map(clip => [clip.id, clip.start]), [['2',0],['3',4],['0',8],['1',12],['4',25]]);
  for (const word of result.subtitles!.words)
    assert.equal(word.start, result.clips.find(clip => clip.id === word.source?.id)!.start! + .25);
});

test('cross-lane drop on a full boundary makes room, keeping unrelated lanes and distant items in place', () => {
  const project = addTimelineTrack(film([12, 19]), 'video');
  const target = project.tracks![0].id;
  project.clips.push(...[0, 4, 8, 30].map(start => ({ ...createClip(asset, target), start, out: 4, id: 't' + start })));
  const result = applyTimelineMove(project, '0', 'clip', ['0'], target, 3.9, 4.15);
  const positions = Object.fromEntries(timelinePositions(result).map(entry => [entry.clip.id, entry.start]));
  assert.deepEqual(positions, { '0':4, '1':19, t0:0, t4:8, t8:12, t30:30 });
  assert.doesNotThrow(() => validateProject(result));
});

test('legacy audio placements attach from both sides and move linked subtitles with the narration', () => {
  const project = film([]);
  project.audioTracks = [0, 10].map((start, i) => ({...createAudioTrack(asset, start), id:'a'+i, out: 4, trackId: undefined}));
  project.subtitles = { ...createSubtitles(), words: [{id:'word', text:'Ciao', start:11, end:12,
    source:{id:'a1', kind:'audio', start:1, end:2} }] };
  const joined = applyTimelineMove(linkSubtitlesToTimeline(project), 'a1', 'audio', ['a1'], 'audio-main', 3.8);
  assert.equal(joined.audioTracks[1].start, 4);
  assert.equal(joined.subtitles!.words[0].start, 5);
  const swapped = applyTimelineMove(joined, 'a1', 'audio', ['a1'], 'audio-main', .3);
  assert.deepEqual(swapped.audioTracks.map(audio => audio.start), [4,0]);
  assert.equal(swapped.subtitles!.words[0].start, 1);
});

test('groups spanning lanes keep relative spacing and reject a vertical shift beyond the available lanes', () => {
  const project = addTimelineTrack(film([0, 10, 16]), 'video');
  const upper = project.tracks![0].id;
  project.clips[2].trackId = upper;
  const result = applyTimelineMove(project,'1','clip',['1','2'],'video-main',3.8);
  assert.deepEqual(result.clips.map(clip => clip.start), [0,4,10]);
  assert.throws(() => applyTimelineMove(project, '1','clip',['1','2'],upper,7), /tracce disponibili/);
});
