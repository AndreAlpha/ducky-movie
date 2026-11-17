import test from 'node:test';
import assert from 'node:assert/strict';
import type { MediaAsset } from '../shared/types';
import {
  activeClipAt,
  addAssets,
  appendAsset,
  clipDuration,
  createProject,
  duplicateClip,
  formatTimecode,
  moveClip,
  projectDuration,
  removeClip,
  splitClip,
  trimClip,
  updateClip,
  validateProject,
  buildAutomaticMontage,
  extractProjectRange,
  createSubtitles,
  createProjectTemplate,
  applyProjectTemplate,
  groupSubtitleWords,
  setSubtitleEventText,
  shiftClips,
  splitAudioTrack,
  addTimelineTrack,
  getProjectTracks,
  getAudioTrackId,
  moveTimelineItem,
  removeTimelineTrack,
  updateTimelineTrack,
  updateAudioTrack,
  activeClipsAt,
  timelinePositions,
  createAudioTrack,
  createClip,
  setProjectCap,
  removeProjectCap,
  linkSubtitlesToTimeline,
  syncLinkedSubtitles,
} from '../src/model';

function video(path = 'C:\\Media\\Vacanza.mp4'): MediaAsset {
  return {
    id: crypto.randomUUID(),
    name: 'Vacanza.mp4',
    path,
    url: '',
    kind: 'video',
    duration: 20,
    width: 1920,
    height: 1080,
    hasAudio: true,
  };
}

function projectWithVideo() {
  const asset = video();
  return appendAsset(addAssets(createProject(), [asset]), asset.id);
}

test('split uses source time after trimming and changing playback speed', () => {
  let project = projectWithVideo();
  const originalId = project.clips[0].id;
  project = updateClip(project, originalId, {
    in: 4,
    out: 16,
    speed: 2,
    fadeIn: 0.4,
    fadeOut: 0.6,
    title: { text: 'Ciao', style: 'lower', color: '#ffffff' },
  });
  const before = structuredClone(project);
  const result = splitClip(project, originalId, 2);
  assert.equal(projectDuration(result), 6);
  assert.deepEqual(
    result.clips.map((clip) => [clip.in, clip.out]),
    [
      [4, 8],
      [8, 16],
    ],
  );
  assert.deepEqual(
    result.clips.map((clip) => [clip.fadeIn, clip.fadeOut]),
    [
      [0.4, 0],
      [0, 0.6],
    ],
  );
  assert.equal(result.clips[0].id, originalId);
  assert.notEqual(result.clips[1].id, originalId);
  assert.deepEqual(result.clips[0].title, before.clips[0].title);
  assert.deepEqual(project, before);
});

test('split locates clip relative to previous clips and rejects edge cuts', () => {
  let project = projectWithVideo();
  project = duplicateClip(project, project.clips[0].id);
  const secondId = project.clips[1].id;
  assert.equal(splitClip(project, secondId, 20), project);
  assert.equal(splitClip(project, secondId, 40), project);
  const result = splitClip(project, secondId, 25);
  assert.deepEqual(result.clips.map(clipDuration), [20, 5, 15]);
  assert.equal(projectDuration(result), 40);
});

test('timeline selects the next clip at a cut and has no clip after the end', () => {
  let project = projectWithVideo();
  project = duplicateClip(project, project.clips[0].id);
  assert.equal(activeClipAt(project, 19.999)?.index, 0);
  assert.equal(activeClipAt(project, 20)?.index, 1);
  assert.equal(activeClipAt(project, 40), null);
  assert.equal(activeClipAt(project, -1), null);
  assert.equal(activeClipAt(project, Number.NaN), null);
});

test('reordering uses the final index and deleting closes the timeline gap', () => {
  let project = projectWithVideo();
  project = duplicateClip(project, project.clips[0].id);
  project = duplicateClip(project, project.clips[1].id);
  const ids = project.clips.map((clip) => clip.id);
  const moved = moveClip(project, ids[0], 2);
  assert.deepEqual(
    moved.clips.map((clip) => clip.id),
    [ids[1], ids[2], ids[0]],
  );
  const removed = removeClip(moved, ids[2]);
  assert.equal(activeClipAt(removed, 20)?.clip.id, ids[0]);
  assert.equal(projectDuration(removed), 40);
});

test('Windows path case and slash variants import once, keeping existing identity', () => {
  const first = video('C:\\Users\\Andre\\video.mp4');
  const second = video('c:/users/andre/VIDEO.mp4');
  const project = addAssets(createProject(), [first, second]);
  assert.equal(project.assets.length, 1);
  assert.equal(project.assets[0].id, first.id);
  assert.equal(addAssets(project, [second]), project);
});

test('reimporting a restored source repairs missing media while preserving timeline references', () => {
  const project = projectWithVideo();
  const originalAsset = project.assets[0];
  const missingProject = {
    ...project,
    assets: [{ ...originalAsset, missing: true, url: '' }],
  };
  const restored = {
    ...video(originalAsset.path.toLowerCase()),
    url: 'ducky-media://restored',
    duration: 25,
  };
  const result = addAssets(missingProject, [restored]);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].id, originalAsset.id);
  assert.equal(result.assets[0].missing, false);
  assert.equal(result.assets[0].url, restored.url);
  assert.equal(result.clips[0].assetId, originalAsset.id);
  assert.deepEqual(validateProject(result), result);
  assert.throws(
    () => addAssets(missingProject, [{ ...restored, duration: 3 }]),
    /più breve/,
  );
  assert.equal(missingProject.assets[0].missing, true);
});

test('trimming cannot exceed the source or create zero-duration clips', () => {
  const project = projectWithVideo();
  const id = project.clips[0].id;
  assert.throws(
    () => trimClip(project, id, 1, 21),
    /durata del file originale/,
  );
  assert.throws(() => trimClip(project, id, 10, 10), /troppo breve/);
  assert.throws(() => updateClip(project, id, { speed: 0 }), /Velocità/);
  const faded = updateClip(project, id, { fadeIn: 5 });
  assert.equal(trimClip(faded, id, 1, 3).clips[0].fadeIn, 1);
});

test('older version-one data receives current edit defaults', () => {
  const source = projectWithVideo();
  const legacy = {
    version: 1,
    id: source.id,
    name: 'Vecchio progetto',
    assets: source.assets.map(({ url, hasAudio, ...rest }) => rest),
    clips: [{ id: 'clip-old', assetId: source.assets[0].id, in: 2, out: 8 }],
  };
  const parsed = validateProject(legacy);
  assert.equal(parsed.aspectRatio, '16:9');
  assert.equal(parsed.clips[0].speed, 1);
  assert.equal(parsed.clips[0].filter, 'none');
  assert.equal(parsed.clips[0].title, null);
  assert.deepEqual(parsed.audioTracks, []);
});

test('a title can be emptied during editing without invalidating the project', () => {
  const project = projectWithVideo();
  const result = updateClip(project, project.clips[0].id, {
    title: { text: '', style: 'center', color: '#ffffff' },
  });
  assert.equal(validateProject(result).clips[0].title?.text, '');
});

test('invalid persisted state cannot introduce nonfinite values, missing references or duplicate ids', () => {
  const project = projectWithVideo();
  assert.throws(() => validateProject({ ...project, version: 2 }), /versione/);
  assert.throws(
    () =>
      validateProject({
        ...project,
        assets: [project.assets[0], project.assets[0]],
      }),
    /duplicati/,
  );
  assert.throws(
    () =>
      validateProject({
        ...project,
        clips: [{ ...project.clips[0], assetId: 'missing' }],
      }),
    /assente/,
  );
  assert.throws(
    () =>
      validateProject({
        ...project,
        clips: [project.clips[0], project.clips[0]],
      }),
    /duplicati/,
  );
  assert.throws(
    () =>
      validateProject({
        ...project,
        clips: [{ ...project.clips[0], out: Infinity }],
      }),
    /Fine clip/,
  );
  assert.throws(
    () =>
      validateProject({
        ...project,
        clips: [{ ...project.clips[0], volume: Number.NaN }],
      }),
    /Volume clip/,
  );
  assert.throws(
    () =>
      validateProject({
        ...project,
        clips: [{ ...project.clips[0], title: { text: 'Ciao', color: 'red' } }],
      }),
    /colore/,
  );
});

test('audio-only assets enter an independent music track at the requested time', () => {
  const asset: MediaAsset = { ...video(), kind: 'audio', width: 0, height: 0 };
  const project = appendAsset(addAssets(createProject(), [asset]), asset.id, 3);
  assert.equal(project.clips.length, 0);
  assert.equal(project.audioTracks[0].start, 3);
  assert.equal(project.audioTracks[0].out, 20);
  assert.deepEqual(validateProject(project), project);
});

test('timecode carries frame boundaries without rounding into an extra second', () => {
  assert.equal(formatTimecode(59.999, 30), '00:00:59:29');
  assert.equal(formatTimecode(60, 30), '00:01:00:00');
  assert.equal(formatTimecode(-1), '00:00:00:00');
  assert.equal(formatTimecode(3601 + 1 / 24, 24), '01:00:01:01');
});

test('explicit gaps extend the film and group shifts clamp against fixed neighbours', () => {
  let project = projectWithVideo();
  project = updateClip(project, project.clips[0].id, { out: 2, start: 2 });
  project = duplicateClip(project, project.clips[0].id);
  project.clips[1] = { ...project.clips[1], start: 8 };
  project.duration = 13;
  assert.equal(projectDuration(project), 13);
  assert.equal(activeClipAt(project, 5), null);
  const moved = shiftClips(project, [project.clips[0].id], 100);
  assert.equal(moved.clips[0].start, 6);
  assert.equal(moved.clips[1].start, 8);
  const left = shiftClips(project, project.clips.map((clip) => clip.id), -100);
  assert.deepEqual(left.clips.map((clip) => clip.start), [0, 6]);
  assert.throws(() => validateProject({ ...project, clips: [{ ...project.clips[0], start: 7 }, project.clips[1]] }), /sovrappongono/);
});

test('new creative fields roundtrip and split keeps placement and source transforms', () => {
  let project = projectWithVideo();
  project = updateClip(project, project.clips[0].id, {
    start: 3, in: 2, out: 10, speed: 2, crop: { x: 0.1, y: 0.2, w: 0.7, h: 0.6 },
    mirror: true, zoom: 'in', zoomAmount: 1.2, transition: 'white', transitionDuration: 0.4,
    warmth: 0.3, background: 'blur', role: 'normal', volume: 2.8,
  });
  assert.deepEqual(validateProject(project), project);
  const split = splitClip(project, project.clips[0].id, 5);
  assert.deepEqual(split.clips.map((clip) => [clip.start, clip.in, clip.out]), [[3, 2, 6], [5, 6, 10]]);
  assert.equal(split.clips[1].transition, 'none');
  assert.deepEqual(split.clips[1].crop, project.clips[0].crop);
  assert.throws(() => updateClip(project, project.clips[0].id, { crop: { x: 0.8, y: 0, w: 0.5, h: 1 } }), /bordi/);
});

test('editing explicit clip placement clamps collisions and disabling it closes the gap', () => {
  let project = projectWithVideo();
  project = updateClip(project, project.clips[0].id, { out: 2 });
  project = duplicateClip(project, project.clips[0].id);
  project = duplicateClip(project, project.clips[1].id);
  const secondId = project.clips[1].id;
  const clamped = updateClip(project, secondId, { start: 0, mirror: true });
  assert.equal(clamped.clips[1].start, 2);
  assert.equal(clamped.clips[1].mirror, true);
  assert.deepEqual(validateProject(clamped), clamped);
  project.clips[1] = { ...project.clips[1], start: 5 };
  project.clips[2] = { ...project.clips[2], start: 10 };
  const moved = updateClip(project, secondId, { start: 50 });
  assert.equal(moved.clips[1].start, 8);
  assert.equal(moved.clips[2].start, 10);
  const compacted = updateClip(project, secondId, { start: undefined });
  assert.equal(compacted.clips[1].start, undefined);
  assert.equal(compacted.clips[2].start, 7);
  assert.deepEqual(validateProject(compacted).clips.map((clip) => clip.start), [undefined, undefined, 7]);
});

test('range extraction keeps trimmed speed, aligned narration, words, overlays and music cycle', () => {
  let project = projectWithVideo();
  const audio = { ...video('C:\\Media\\voice.wav'), kind: 'audio' as const, duration: 20 };
  const music = { ...audio, id: crypto.randomUUID(), path: 'C:\\Media\\music.wav', duration: 7 };
  project = addAssets(project, [audio, music]);
  project = updateClip(project, project.clips[0].id, { in: 2, out: 18, speed: 2 });
  project = appendAsset(project, audio.id, 1);
  project.audioTracks[0] = { ...project.audioTracks[0], in: 3, out: 10 };
  project.subtitles = { ...createSubtitles(), words: [{ start: 2, end: 4, text: 'Ciao' }, { start: 5, end: 7, text: 'mondo' }] };
  project.overlays = [{ id: 'overlay', kind: 'text', text: 'Titolo', start: 1, end: 6, x: 0.5, y: 0.5, width: 0.6, opacity: 1, animation: 'fade' }];
  project.music = { assetId: music.id, start: 0, in: 1, out: 6, volume: 0.2, loop: true, duck: true, phase: 1 };
  const extracted = extractProjectRange(project, 3, 6, { aspectRatio: '9:16' });
  assert.equal(extracted.aspectRatio, '9:16');
  assert.equal(projectDuration(extracted), 3);
  assert.deepEqual([extracted.clips[0].in, extracted.clips[0].out, extracted.clips[0].start], [8, 14, 0]);
  assert.deepEqual([extracted.audioTracks[0].start, extracted.audioTracks[0].in, extracted.audioTracks[0].out], [0, 5, 8]);
  assert.deepEqual(extracted.subtitles?.words.map((word) => [word.start, word.end]), [[0, 1], [2, 3]]);
  assert.deepEqual(extracted.overlays?.map((overlay) => [overlay.start, overlay.end]), [[0, 3]]);
  assert.equal(extracted.music?.phase, 4);
});

test('automatic montage repeats source imagery to cover narration and splits audio in source time', () => {
  const image = { ...video('C:\\Media\\photo.jpg'), kind: 'image' as const, duration: 0, hasAudio: false };
  const voice = { ...video('C:\\Media\\voice.wav'), kind: 'audio' as const, duration: 9 };
  const project = addAssets(createProject(), [image, voice]);
  const montage = buildAutomaticMontage(project, { assetIds: [image.id], narrationAssetId: voice.id, imageDuration: 3.5, zoom: true });
  assert.deepEqual(montage.clips.map(clipDuration), [3.5, 3.5, 2]);
  assert.equal(projectDuration(montage), 9);
  assert.equal(montage.audioTracks[0].volume, 1);
  const split = splitAudioTrack(montage, montage.audioTracks[0].id, 4);
  assert.deepEqual(split.audioTracks.map((track) => [track.start, track.in, track.out]), [[0, 0, 4], [4, 4, 9]]);
});

test('templates retain only referenced media and shift narration and captions with the intro', () => {
  let project = projectWithVideo();
  const voice = { ...video('C:\\Media\\voice.wav'), kind: 'audio' as const, duration: 20 };
  project = appendAsset(addAssets(project, [voice]), voice.id);
  project.subtitles = { ...createSubtitles(), words: [{ start: 1, end: 2, text: 'Ciao' }] };
  const intro = video('C:\\Brand\\intro.mp4');
  let branding = appendAsset(addAssets(createProject(), [intro]), intro.id);
  branding = updateClip(branding, branding.clips[0].id, { role: 'intro', out: 3 });
  branding.assets.push(video('C:\\Unused\\old.mp4'));
  const template = createProjectTemplate(branding);
  assert.equal(template.assets.length, 1);
  const applied = applyProjectTemplate(project, template);
  assert.equal(applied.clips[0].role, 'intro');
  assert.equal(applied.audioTracks[0].start, 3);
  assert.equal(applied.subtitles?.words[0].start, 4);
  assert.equal(projectDuration(applied), 23);
});

test('subtitle grouping respects sentence and pause boundaries while edits preserve timings', () => {
  const project = createProject();
  project.subtitles = { ...createSubtitles(), maxWords: 5, words: [
    { start: 0, end: 0.2, text: 'Una' }, { start: 0.2, end: 0.4, text: 'bella' },
    { start: 0.4, end: 0.6, text: 'storia,' }, { start: 1.2, end: 1.4, text: 'continua.' },
  ] };
  assert.deepEqual(groupSubtitleWords(project.subtitles.words, 5).map((event) => event.words.length), [3, 1]);
  const edited = setSubtitleEventText(project, 0, 'Una nuova storia,');
  assert.deepEqual(edited.subtitles?.words.slice(0, 3).map((word) => [word.start, word.end]), [[0, 0.2], [0.2, 0.4], [0.4, 0.6]]);
});

test('video lanes overlap independently and visible composition follows top-first track order', () => {
  let project = projectWithVideo();
  project = updateClip(project, project.clips[0].id, { out: 4 });
  project = addTimelineTrack(project, 'video');
  const upper = project.tracks![0].id;
  const overlay = { ...createClip(project.assets[0], upper), start: 1, out: 2,
    placement: { x: 0.8, y: 0.2, scale: 0.3, opacity: 0.8 } };
  project.clips.push(overlay);
  assert.deepEqual(timelinePositions(project).map((entry) => [entry.trackId, entry.start, entry.end]), [['video-main', 0, 4], [upper, 1, 3]]);
  assert.deepEqual(activeClipsAt(project, 1.5).map((entry) => entry.clip.id), [overlay.id, project.clips[0].id]);
  assert.deepEqual(validateProject(project), project);
  const hidden = updateTimelineTrack(project, upper, { hidden: true, muted: true });
  assert.equal(activeClipAt(hidden, 1.5)?.clip.id, project.clips[0].id);
  assert.equal(projectDuration(hidden), 4);
  const duplicated = duplicateClip(project, project.clips[0].id);
  assert.equal(timelinePositions(duplicated).find((entry) => entry.clip.id === overlay.id)?.start, 1);
  assert.equal(projectDuration(duplicated), 8);
  const split = splitClip(project, overlay.id, 2);
  assert.deepEqual(split.clips.filter((clip) => clip.trackId === upper).map((clip) => [clip.start, clip.in, clip.out]), [[1, 0, 1], [2, 1, 2]]);
  assert.throws(() => validateProject({ ...project, clips: [...project.clips, { ...overlay, id: 'collision', start: 2 }] }), /sovrappongono/);
});

test('legacy overlapping narration is packed into deterministic persistent audio lanes', () => {
  const asset = { ...video('C:\\Media\\voice.wav'), kind: 'audio' as const, duration: 8 };
  const project = addAssets(createProject(), [asset]);
  delete project.tracks;
  const first = { ...createAudioTrack(asset, 0), out: 4 };
  const second = { ...createAudioTrack(asset, 2), out: 4 };
  const third = { ...createAudioTrack(asset, 4), out: 2 };
  delete first.trackId; delete second.trackId; delete third.trackId;
  project.audioTracks = [first, second, third];
  assert.equal(getAudioTrackId(project, first.id), 'audio-main');
  assert.equal(getAudioTrackId(project, second.id), 'audio-2');
  assert.equal(getAudioTrackId(project, third.id), 'audio-main');
  const migrated = validateProject(project);
  assert.deepEqual(migrated.audioTracks.map((track) => track.trackId), ['audio-main', 'audio-2', 'audio-main']);
  assert.equal(getProjectTracks(migrated).filter((track) => track.kind === 'audio').length, 2);
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(migrated))), migrated);
  assert.equal(projectDuration(migrated), 6);
});

test('audio insertion reuses free lanes and audio-only and text-only films retain their duration', () => {
  const voice = { ...video('C:\\Media\\voice.wav'), kind: 'audio' as const, duration: 4 };
  let project = addAssets(createProject(), [voice]);
  project = appendAsset(project, voice.id, 0);
  project = appendAsset(project, voice.id, 1);
  project = appendAsset(project, voice.id, 4);
  assert.equal(project.audioTracks[0].trackId, 'audio-main');
  assert.notEqual(project.audioTracks[1].trackId, 'audio-main');
  assert.equal(project.audioTracks[2].trackId, 'audio-main');
  assert.equal(projectDuration(project), 8);
  assert.throws(() => removeTimelineTrack(project, 'audio-main'), /Sposta o rimuovi/);
  project = addTimelineTrack(project, 'video');
  const empty = project.tracks![0].id;
  assert.ok(!removeTimelineTrack(project, empty).tracks!.some((track) => track.id === empty));
  const text = createProject();
  text.overlays = [{ id: 'card', kind: 'text', text: 'Una storia', start: 0, end: 7, x: .5, y: .5, width: .8, opacity: 1, animation: 'none' }];
  assert.equal(projectDuration(validateProject(text)), 7);
});

test('cross-lane moves clamp collisions without rippling other lanes and audio trims are validated', () => {
  let project = projectWithVideo();
  project = updateClip(project, project.clips[0].id, { out: 2 });
  project = duplicateClip(project, project.clips[0].id);
  project = updateClip(project, project.clips[1].id, { start: 5 });
  project = addTimelineTrack(project, 'video');
  const upper = project.tracks![0].id;
  project.clips.push({ ...createClip(project.assets[0], upper), out: 1, start: 0 });
  const moved = moveTimelineItem(project, project.clips[0].id, 'clip', upper, .2);
  assert.equal(moved.clips.find((clip) => clip.id === project.clips[0].id)?.start, 1);
  assert.equal(moved.clips.find((clip) => clip.id === project.clips[1].id)?.start, 5);
  const audio = { ...video('C:\\Media\\voice.wav'), kind: 'audio' as const, duration: 8 };
  project = addAssets(project, [audio]);
  project.audioTracks = [{ ...createAudioTrack(audio), out: 2 }, { ...createAudioTrack(audio, 4), out: 2 }];
  assert.throws(() => updateAudioTrack(project, project.audioTracks[0].id, { out: 5 }), /sovrappone/);
  const shifted = updateAudioTrack(project, project.audioTracks[0].id, { start: 3, volume: 2.5, fadeIn: 5 });
  assert.equal(shifted.audioTracks[0].start, 2);
  assert.equal(shifted.audioTracks[0].volume, 2.5);
  assert.equal(shifted.audioTracks[0].fadeIn, 1);
  assert.throws(() => moveTimelineItem(project, project.audioTracks[0].id, 'audio', upper, 0), /compatibile/);
});

test('intro insertion replacement and removal keep every lane and timed element synchronized', () => {
  let project = projectWithVideo();
  project = updateClip(project, project.clips[0].id, { out: 4 });
  project = addTimelineTrack(project, 'video');
  const upper = project.tracks![0].id;
  const pip = { ...createClip(project.assets[0], upper), start: 1, out: 2 };
  project.clips.push(pip);
  const voice = { ...video('C:\\Media\\voice.wav'), kind: 'audio' as const, duration: 6 };
  const photo = { ...video('C:\\Brand\\intro.png'), kind: 'image' as const, duration: 0, hasAudio: false };
  const intro = { ...video('C:\\Brand\\intro.mp4'), duration: 2 };
  project = appendAsset(addAssets(project, [voice, photo, intro]), voice.id);
  project.duration = 8;
  project.subtitles = { ...createSubtitles(), words: [{ start: .5, end: 1, text: 'Ciao' }] };
  project.overlays = [{ id: 'text', kind: 'text', text: 'Logo', start: 1, end: 3, x: .5, y: .5, width: .3, opacity: 1, animation: 'none' }];
  project.music = { assetId: voice.id, start: 0, in: 0, out: 6, volume: .1, loop: true, duck: true, phase: 1 };
  const photoIntro = setProjectCap(project, photo.id, 'intro');
  assert.equal(photoIntro.clips.find((clip) => clip.id === pip.id)?.start, 6);
  assert.equal(photoIntro.audioTracks[0].start, 5);
  assert.equal(photoIntro.subtitles?.words[0].start, 5.5);
  assert.equal(photoIntro.overlays?.[0].start, 6);
  assert.equal(photoIntro.music?.start, 5);
  assert.equal(projectDuration(photoIntro), 13);
  const replaced = setProjectCap(photoIntro, intro.id, 'intro');
  assert.equal(replaced.clips.find((clip) => clip.id === pip.id)?.start, 3);
  assert.equal(replaced.audioTracks[0].start, 2);
  assert.equal(replaced.subtitles?.words[0].start, 2.5);
  const removed = removeProjectCap(replaced, 'intro');
  assert.equal(removed.clips.find((clip) => clip.id === pip.id)?.start, 1);
  assert.equal(removed.audioTracks[0].start, 0);
  assert.equal(removed.subtitles?.words[0].start, .5);
  assert.equal(removed.music?.phase, 1);
  const withOutro = setProjectCap(removed, photo.id, 'outro');
  assert.equal(withOutro.clips.find((clip) => clip.role === 'outro')?.start, 6);
  assert.equal(projectDuration(withOutro), 11);
  const shorterOutro = setProjectCap(withOutro, intro.id, 'outro');
  assert.equal(projectDuration(shorterOutro), 8);
  assert.equal(projectDuration(removeProjectCap(shorterOutro, 'outro')), 6);
});

test('multitrack extraction and templates retain lane references and picture placement', () => {
  let project = projectWithVideo();
  project = updateClip(project, project.clips[0].id, { out: 6 });
  project = addTimelineTrack(project, 'video');
  const upper = project.tracks![0].id;
  project.clips.push({ ...createClip(project.assets[0], upper), out: 3, start: 1, placement: { x: .8, y: .2, scale: .25, opacity: 1 } });
  const extracted = extractProjectRange(project, 2, 4);
  assert.equal(extracted.clips.length, 2);
  assert.ok(extracted.tracks?.some((track) => track.id === upper));
  assert.equal(extracted.clips.find((clip) => clip.trackId === upper)?.placement?.scale, .25);
  let branding = addAssets(addTimelineTrack(createProject(), 'video'), [project.assets[0]]);
  const brandLane = branding.tracks![0].id;
  branding.clips = [{ ...createClip(branding.assets[0], brandLane), role: 'intro', out: 2 }];
  const template = createProjectTemplate(branding);
  const applied = applyProjectTemplate(project, template);
  assert.ok(applied.tracks?.some((track) => track.id === brandLane));
  assert.equal(applied.clips.find((clip) => clip.role === 'intro')?.trackId, brandLane);
  assert.equal(applied.clips.find((clip) => clip.id === project.clips[1].id)?.start, 3);
});

test('out-of-order explicit placements stay intact during edits and ripple only chronological followers', () => {
  const project = projectWithVideo();
  const later = { ...project.clips[0], start: 10, out: 2 };
  const earlier = { ...createClip(project.assets[0]), start: 2, out: 2 };
  project.clips = [later, earlier];
  assert.doesNotThrow(() => validateProject(project));
  const colored = updateClip(project, later.id, { mirror: true });
  assert.equal(colored.clips.find((clip) => clip.id === earlier.id)?.start, 2);
  const longer = updateClip(project, earlier.id, { out: 3 });
  assert.equal(longer.clips.find((clip) => clip.id === later.id)?.start, 11);
  const duplicated = duplicateClip(project, later.id);
  assert.equal(duplicated.clips.find((clip) => clip.id === earlier.id)?.start, 2);
  assert.equal(duplicated.clips.find((clip) => clip.id !== later.id && clip.id !== earlier.id)?.start, 12);
  const removed = removeClip(project, earlier.id);
  assert.equal(removed.clips[0].start, 8);
});

test('dropping a video on an explicit audio lane extracts its audio and stays in the requested lane', () => {
  const asset = { ...video(), duration: 4 };
  let project = addAssets(createProject(), [asset]);
  project = appendAsset(project, asset.id, 0, 'audio-main');
  assert.equal(project.clips.length, 0);
  assert.equal(project.audioTracks[0].assetId, asset.id);
  assert.equal(project.audioTracks[0].trackId, 'audio-main');
  project = addTimelineTrack(project, 'audio');
  const requested = appendAsset(project, asset.id, 1, 'audio-main');
  assert.equal(requested.tracks?.length, project.tracks?.length);
  assert.equal(requested.audioTracks[1].trackId, 'audio-main');
  assert.equal(requested.audioTracks[1].start, 4);
  assert.deepEqual(validateProject(requested), requested);
  const visual = appendAsset(project, asset.id);
  assert.equal(visual.clips.length, 1, 'L’inserimento video normale conserva la clip video');
});

test('explicit audio-lane insertion rejects images and silent video while automatic audio placement still allocates lanes', () => {
  const silent = { ...video('C:\\Media\\silent.mp4'), hasAudio: false };
  const image = { ...video('C:\\Media\\image.png'), kind: 'image' as const, duration: 0, hasAudio: false };
  const audio = { ...video('C:\\Media\\voice.wav'), kind: 'audio' as const, duration: 4 };
  const project = addAssets(createProject(), [silent, image, audio]);
  assert.throws(() => appendAsset(project, silent.id, 0, 'audio-main'), /compatibile/);
  assert.throws(() => appendAsset(project, image.id, 0, 'audio-main'), /compatibile/);
  const first = appendAsset(project, audio.id, 0);
  const automatic = appendAsset(first, audio.id, 1);
  assert.notEqual(automatic.audioTracks[1].trackId, 'audio-main');
  const explicit = appendAsset(first, audio.id, 1, 'audio-main');
  assert.equal(explicit.audioTracks[1].trackId, 'audio-main');
  assert.equal(explicit.audioTracks[1].start, 4);
});

test('reordering one lane preserves explicit out-of-order placement and linked captions on other lanes', () => {
  const asset = { ...video(), duration: 5 };
  let project = addTimelineTrack(addAssets(createProject(), [asset]), 'video');
  const upper = project.tracks!.find((track) => track.kind === 'video' && track.id !== 'video-main')!.id;
  const late = { ...createClip(asset, upper), start: 20 };
  const early = { ...createClip(asset, upper), start: 0 };
  const first = { ...createClip(asset), start: 0 };
  const second = { ...createClip(asset), start: 5 };
  project.clips = [late, early, first, second];
  project.subtitles = { ...createSubtitles(), words: [
    { id: 'early-word', text: 'Prima.', start: .5, end: 1, source: { kind: 'clip', id: early.id, start: .5, end: 1 } },
    { id: 'late-word', text: 'Dopo.', start: 20.5, end: 21, source: { kind: 'clip', id: late.id, start: .5, end: 1 } },
  ] };
  project = linkSubtitlesToTimeline(project);
  const before = timelinePositions(project).filter((entry) => entry.trackId === upper).map((entry) => [entry.clip.id, entry.start]);
  const moved = syncLinkedSubtitles(project, moveClip(project, first.id, 1));
  assert.deepEqual(timelinePositions(moved).filter((entry) => entry.trackId === upper).map((entry) => [entry.clip.id, entry.start]), before);
  assert.deepEqual(moved.subtitles, project.subtitles);
  assert.deepEqual(timelinePositions(moved).filter((entry) => entry.trackId === 'video-main').map((entry) => [entry.clip.id, entry.start]), [[second.id, 0], [first.id, 5]]);
});
