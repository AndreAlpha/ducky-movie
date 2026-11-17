import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaAsset, Project, SubtitleWord } from '../shared/types';
import {
  addAssets, appendAsset, createAudioTrack, createClip, createProject, createSubtitles,
  duplicateClip, moveClip, moveTimelineItem, removeClip, setProjectCap, removeProjectCap,
  duplicateAudioTrack, createProjectTemplate, applyProjectTemplate,
  splitClip, splitAudioTrack, updateClip, updateAudioTrack, validateProject, projectDuration,
  linkSubtitlesToTimeline, syncLinkedSubtitles, copyLinkedSubtitles, replaceSourceSubtitles,
  getSubtitleEvents, setSubtitleEventText, setSubtitleEventTiming, updateSubtitleWord,
  addSubtitleEvent, removeSubtitleEvent, splitSubtitleEvent, mergeSubtitleEvents,
  rebindSubtitleEvent, replaceSubtitleWords, extractProjectRange,
} from '../src/model';

function media(kind: 'video' | 'audio' = 'video', duration = 12): MediaAsset {
  return { id: crypto.randomUUID(), name: `${kind}.mp4`, path: `C:\\Media\\${crypto.randomUUID()}.mp4`, url: '',
    kind, duration, width: kind === 'video' ? 1920 : 0, height: kind === 'video' ? 1080 : 0, hasAudio: true };
}

function videoProject(words = [{ start: 1, end: 2, text: 'Ciao' }, { start: 4, end: 5, text: 'mondo.' }]): Project {
  const asset = media();
  const project = appendAsset(addAssets(createProject(), [asset]), asset.id);
  const ownerId = project.clips[0].id;
  project.subtitles = { ...createSubtitles(), words: words.map((word, index) => ({ ...word, id: `word-${index}`,
    source: { kind: 'clip' as const, id: ownerId, start: word.start, end: word.end } })) };
  return linkSubtitlesToTimeline(project);
}

function times(project: Project) { return project.subtitles!.words.map(({ start, end, text }) => ({ start, end, text })); }

test('legacy migration binds only a unique source and preserves intentionally free modern words', () => {
  const asset = media('audio');
  const project = appendAsset(addAssets(createProject(), [asset]), asset.id, 3);
  project.audioTracks[0].in = 2;
  project.subtitles = { ...createSubtitles(), words: [{ start: 4, end: 5, text: 'Legacy' }] };
  const migrated = validateProject(project);
  assert.deepEqual(migrated.subtitles!.words[0].source, { kind: 'audio', id: project.audioTracks[0].id, start: 3, end: 4 });
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(migrated))), migrated);
  const free: SubtitleWord = { id: 'deliberately-free', start: 4, end: 5, text: 'Manuale' };
  assert.equal(linkSubtitlesToTimeline({ ...project, subtitles: { ...createSubtitles(), words: [free] } }).subtitles!.words[0].source, undefined);
  const other = { ...createAudioTrack(asset, 3), id: 'overlapping', trackId: 'audio-other' };
  const ambiguous = { ...project, audioTracks: [...project.audioTracks, other] };
  assert.equal(linkSubtitlesToTimeline(ambiguous).subtitles!.words[0].source, undefined);
});

test('clip movements speed and lane reordering update captions from immutable source times', () => {
  let project = videoProject();
  const owner = project.clips[0].id;
  project = updateClip(project, owner, { start: 3, in: 1, out: 9, speed: 2 });
  assert.deepEqual(times(project), [{ start: 3, end: 3.5, text: 'Ciao' }, { start: 4.5, end: 5, text: 'mondo.' }]);
  assert.equal(project.subtitles!.linkedWords![0].sources[0].start, 1);
  const beforeMove = structuredClone(project);
  const moved = syncLinkedSubtitles(project, { ...project, clips: project.clips.map((clip) => ({ ...clip, start: 8 })) });
  assert.equal(moved.subtitles!.words[0].start, 8);
  assert.deepEqual(syncLinkedSubtitles(project, moved), moved);
  assert.deepEqual(project, beforeMove);
  const reordered = moveClip(duplicateClip(moved, owner), owner, 1);
  const ownWords = reordered.subtitles!.words.filter((word) => word.source?.id === owner);
  assert.equal(ownWords[0].start, reordered.clips.find((clip) => clip.id === owner)!.start);
});

test('audio movement and trim are reversible and hidden words survive save/reopen', () => {
  const asset = media('audio', 10);
  let project = appendAsset(addAssets(createProject(), [asset]), asset.id, 2);
  const owner = project.audioTracks[0].id;
  project.subtitles = { ...createSubtitles(), words: [
    { id: 'before-trim', start: 2.5, end: 3.5, text: 'Prima', source: { kind: 'audio', id: owner, start: .5, end: 1.5 } },
    { id: 'inside-trim', start: 5, end: 6, text: 'Dentro', source: { kind: 'audio', id: owner, start: 3, end: 4 } },
  ] };
  project = linkSubtitlesToTimeline(project);
  const original = times(project);
  let trimmed = updateAudioTrack(project, owner, { in: 2, out: 6 });
  assert.deepEqual(times(trimmed), [{ start: 3, end: 4, text: 'Dentro' }]);
  assert.equal(trimmed.subtitles!.linkedWords!.length, 2);
  trimmed = validateProject(JSON.parse(JSON.stringify(trimmed)));
  const restored = updateAudioTrack(trimmed, owner, { in: 0, out: 10 });
  assert.deepEqual(times(restored), original);
  const moved = updateAudioTrack(restored, owner, { start: 7 });
  assert.deepEqual(times(moved), [{ start: 7.5, end: 8.5, text: 'Prima' }, { start: 10, end: 11, text: 'Dentro' }]);
});

test('partially trimmed words regain full timings when the clip is expanded', () => {
  let project = videoProject([{ start: 1, end: 3, text: 'Parziale' }]);
  const owner = project.clips[0].id;
  project = updateClip(project, owner, { in: 2, out: 4 });
  assert.deepEqual(times(project), [{ start: 0, end: 1, text: 'Parziale' }]);
  assert.equal(projectDuration(project), 2);
  const restored = updateClip(project, owner, { in: 0, out: 8 });
  assert.deepEqual(times(restored), [{ start: 1, end: 3, text: 'Parziale' }]);
});

test('clip splitting preserves a word that crosses the cut and each separated fragment follows its clip', () => {
  let project = videoProject([{ start: 3.5, end: 4.5, text: 'Attraversa' }, { start: 6, end: 7, text: 'Dopo' }]);
  const leftId = project.clips[0].id;
  project = splitClip(project, leftId, 4);
  const rightId = project.clips[1].id;
  assert.deepEqual(times(project), [{ start: 3.5, end: 4.5, text: 'Attraversa' }, { start: 6, end: 7, text: 'Dopo' }]);
  assert.equal(project.subtitles!.linkedWords![0].sources.length, 2);
  project = moveTimelineItem(project, rightId, 'clip', 'video-main', 10);
  assert.deepEqual(times(project), [{ start: 3.5, end: 4, text: 'Attraversa' }, { start: 10, end: 10.5, text: 'Attraversa' }, { start: 12, end: 13, text: 'Dopo' }]);
  const removed = removeClip(project, leftId);
  assert.equal(removed.subtitles!.linkedWords![0].sources.length, 1);
  assert.equal(removed.subtitles!.words[0].source!.id, rightId);
  assert.doesNotThrow(() => validateProject(removed));
});

test('audio splitting transfers source bindings and duplication via clipboard copies only selected sources', () => {
  const asset = media('audio', 8);
  let project = appendAsset(addAssets(createProject(), [asset]), asset.id, 2);
  const originalId = project.audioTracks[0].id;
  project.subtitles = { ...createSubtitles(), words: [{ id: 'spoken', start: 5.5, end: 6.5, text: 'Voce', source: { kind: 'audio', id: originalId, start: 3.5, end: 4.5 } }] };
  project = splitAudioTrack(linkSubtitlesToTimeline(project), originalId, 6);
  assert.deepEqual(times(project), [{ start: 5.5, end: 6.5, text: 'Voce' }]);
  const copyId = 'copied-audio';
  const copiedAudio = { ...project.audioTracks[1], id: copyId, start: 12 };
  let copied = copyLinkedSubtitles(project, { ...project, audioTracks: [...project.audioTracks, copiedAudio] }, [{ kind: 'audio', id: project.audioTracks[1].id, newId: copyId }]);
  assert.deepEqual(times(copied), [{ start: 5.5, end: 6.5, text: 'Voce' }, { start: 12, end: 12.5, text: 'Voce' }]);
  assert.deepEqual(copyLinkedSubtitles(project, copied, [{ kind: 'audio', id: project.audioTracks[1].id, newId: copyId }]), copied);
  copied = syncLinkedSubtitles(copied, { ...copied, audioTracks: copied.audioTracks.filter((track) => track.id !== originalId) });
  assert.ok(copied.subtitles!.words.some((word) => word.source?.id === copyId));
});

test('duplicating and deleting a clip copies its edited captions without moving another lane source', () => {
  let project = videoProject();
  project = setSubtitleEventText(project, 0, 'Saluto mondo.');
  const owner = project.clips[0].id;
  const duplicated = duplicateClip(project, owner);
  const copy = duplicated.clips[1];
  const copyWords = duplicated.subtitles!.words.filter((word) => word.source?.id === copy.id);
  assert.equal(copyWords[0].text, 'Saluto');
  assert.equal(copyWords[0].start, 13);
  assert.notEqual(copyWords[0].id, duplicated.subtitles!.words[0].id);
  const removed = removeClip(duplicated, owner);
  assert.deepEqual(times(removed), [{ start: 1, end: 2, text: 'Saluto' }, { start: 4, end: 5, text: 'mondo.' }]);
});

test('intro insertion and removal shift linked captions once and preserve intentional free timing offsets', () => {
  let project = videoProject();
  project.subtitles!.words.push({ id: 'free', detached: true, start: 2, end: 3, text: 'Libero' });
  const cap = media('video', 2);
  project = addAssets(project, [cap]);
  const added = setProjectCap(project, cap.id, 'intro');
  assert.deepEqual(times(added), [{ start: 3, end: 4, text: 'Ciao' }, { start: 4, end: 5, text: 'Libero' }, { start: 6, end: 7, text: 'mondo.' }]);
  assert.deepEqual(syncLinkedSubtitles(project, added), added);
  assert.deepEqual(times(removeProjectCap(added, 'intro')), times(project));
});

test('phrase and word edits preserve source links through retiming split merge and trim', () => {
  let project = videoProject([{ start: 1, end: 1.5, text: 'Una' }, { start: 1.5, end: 2, text: 'storia' }]);
  project = setSubtitleEventText(project, 0, 'Una nuova storia');
  assert.equal(getSubtitleEvents(project).length, 1);
  assert.ok(project.subtitles!.words.every((word) => word.source?.id === project.clips[0].id));
  project = setSubtitleEventTiming(project, 0, { start: 3, end: 5 });
  assert.equal(project.subtitles!.words[0].source!.start, 3);
  project = splitSubtitleEvent(project, 0, 4);
  assert.equal(getSubtitleEvents(project).length, 2);
  project = mergeSubtitleEvents(project, 0);
  assert.equal(getSubtitleEvents(project).length, 1);
  const wordId = project.subtitles!.words[0].id!;
  project = updateSubtitleWord(project, wordId, { text: 'Questa', start: 3.1 });
  assert.equal(project.subtitles!.words[0].text, 'Questa');
  const moved = updateClip(project, project.clips[0].id, { start: 5, speed: 2 });
  assert.equal(moved.subtitles!.words[0].start, 6.55);
  assert.doesNotThrow(() => validateProject(moved));
});

test('free captions can be linked and unlinked explicitly and raw legacy ids stay usable in the editor', () => {
  let project = videoProject();
  project = addSubtitleEvent(project, 8, 'Testo manuale', 2);
  const index = getSubtitleEvents(project).findIndex((event) => event.text === 'Testo manuale');
  project = rebindSubtitleEvent(project, index, null);
  const detached = project.subtitles!.words.find((word) => word.text === 'Testo')!;
  assert.equal(detached.source, undefined);
  assert.equal(detached.detached, true);
  project = updateClip(project, project.clips[0].id, { start: 3 });
  assert.equal(project.subtitles!.words.find((word) => word.id === detached.id)!.start, 8);
  const nextIndex = getSubtitleEvents(project).findIndex((event) => event.text === 'Testo manuale');
  project = rebindSubtitleEvent(project, nextIndex, { kind: 'clip', id: project.clips[0].id });
  assert.ok(project.subtitles!.words.find((word) => word.text === 'Testo')!.source);
  const raw = createProject();
  raw.subtitles = { ...createSubtitles(), words: [{ start: 0, end: 1, text: 'Legacy' }] };
  const rawId = getSubtitleEvents(raw)[0].words[0].id!;
  assert.equal(updateSubtitleWord(raw, rawId, { text: 'Corretto' }).subtitles!.words[0].text, 'Corretto');
});

test('retranscription replaces hidden words only for selected owners and deletion/search do not restore removed text', () => {
  let project = videoProject([{ start: 1, end: 2, text: 'Vecchio' }, { start: 5, end: 6, text: 'Nascosto' }]);
  const owner = project.clips[0].id;
  project = updateClip(project, owner, { out: 3 });
  project = replaceSourceSubtitles(project, [{ id: 'new-word', start: .5, end: 1, text: 'Nuovo', source: { kind: 'clip', id: owner, start: .5, end: 1 } }], [{ kind: 'clip', id: owner }]);
  assert.equal(project.subtitles!.linkedWords!.length, 1);
  project = updateClip(project, owner, { out: 10 });
  assert.deepEqual(times(project), [{ start: .5, end: 1, text: 'Nuovo' }]);
  project = replaceSubtitleWords(project, 'Nuovo', '');
  assert.equal(project.subtitles!.words.length, 0);
  project = addSubtitleEvent(project, 1, 'Cancella questa frase', 2);
  project = removeSubtitleEvent(project, 0);
  assert.equal(project.subtitles!.linkedWords!.length, 0);
  assert.equal(updateClip(project, owner, { in: 0, out: 12 }).subtitles!.words.length, 0);
});

test('extraction rebinds canonical words to new item ids and caption-only projects have a visible duration', () => {
  const project = videoProject();
  const extracted = extractProjectRange(project, .5, 6);
  assert.equal(extracted.subtitles!.words[0].source!.id, extracted.clips[0].id);
  assert.equal(extracted.subtitles!.words[0].start, .5);
  assert.doesNotThrow(() => validateProject(extracted));
  const onlyCaptions = addSubtitleEvent(createProject(), 2, 'Solo parole', 3);
  assert.equal(projectDuration(onlyCaptions), 5);
  assert.equal(onlyCaptions.subtitles!.words[0].source, undefined);
});

test('templates remove canonical narration while applying branding keeps hidden source words reversible', () => {
  let project = videoProject();
  const owner = project.clips[0].id;
  project = updateClip(project, owner, { out: 3 });
  const template = createProjectTemplate(project);
  assert.deepEqual(template.subtitles!.words, []);
  assert.deepEqual(template.subtitles!.linkedWords, []);
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(template))));
  const cap = media('video', 2);
  const branding = createProjectTemplate(setProjectCap(addAssets(createProject(), [cap]), cap.id, 'intro'));
  const applied = applyProjectTemplate(project, branding);
  assert.equal(applied.subtitles!.linkedWords!.length, 2);
  assert.deepEqual(times(applied), [{ start: 3, end: 4, text: 'Ciao' }]);
  const restored = updateClip(applied, owner, { out: 8 });
  assert.deepEqual(times(restored), [{ start: 3, end: 4, text: 'Ciao' }, { start: 6, end: 7, text: 'mondo.' }]);
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(restored))));
});

test('audio duplication clones captions and direct editor timing updates keep source binding idempotently', () => {
  const asset = media('audio', 6);
  let project = appendAsset(addAssets(createProject(), [asset]), asset.id, 1);
  const owner = project.audioTracks[0].id;
  project.subtitles = { ...createSubtitles(), words: [{ id: 'voice-word', start: 2, end: 3, text: 'Voce', source: { kind: 'audio', id: owner, start: 1, end: 2 } }] };
  project = linkSubtitlesToTimeline(project);
  const duplicated = duplicateAudioTrack(project, owner);
  assert.deepEqual(times(duplicated), [{ start: 2, end: 3, text: 'Voce' }, { start: 8, end: 9, text: 'Voce' }]);
  const direct = { ...project, subtitles: { ...project.subtitles!, words: project.subtitles!.words.map((word) => ({ ...word, start: 3, end: 4 })) } };
  const synced = syncLinkedSubtitles(project, direct);
  assert.deepEqual(synced.subtitles!.linkedWords![0].sources[0], { kind: 'audio', id: owner, start: 2, end: 3 });
  assert.deepEqual(syncLinkedSubtitles(project, synced), synced);
});

test('timing a partially trimmed word edits its real source interval and retiming across a cut preserves a full word', () => {
  let project = videoProject([{ start: 1, end: 3, text: 'Modifica' }]);
  const owner = project.clips[0].id;
  project = updateClip(project, owner, { in: 2, out: 6 });
  project = updateSubtitleWord(project, project.subtitles!.words[0].id!, { start: .2, end: .8 });
  assert.deepEqual(times(project), [{ start: .20000000000000018, end: .7999999999999998, text: 'Modifica' }]);
  const expanded = updateClip(project, owner, { in: 0, out: 12 });
  assert.equal(expanded.subtitles!.words[0].start, 2.2);
  let split = videoProject([{ start: 3.5, end: 4.5, text: 'Divisa' }]);
  split = splitClip(split, split.clips[0].id, 4);
  split = updateSubtitleWord(split, split.subtitles!.words[0].id!, { start: 2, end: 3 });
  assert.deepEqual(times(split), [{ start: 2, end: 3, text: 'Divisa' }]);
  assert.equal(split.subtitles!.linkedWords![0].sources.length, 1);
  assert.throws(() => updateSubtitleWord(expanded, expanded.subtitles!.words[0].id!, { start: 20, end: 21 }), /durata della sorgente/);
});

test('automatic groups stay separate across owners and an explicit manual merge retains both bindings', () => {
  const asset = media('audio', 2);
  let project = appendAsset(addAssets(createProject(), [asset]), asset.id, 0);
  project = appendAsset(project, asset.id, 2);
  project.subtitles = { ...createSubtitles(), words: project.audioTracks.map((track, index) => ({
    id: `source-${index}`, start: track.start, end: track.start + 1, text: `Voce${index}`,
    source: { kind: 'audio' as const, id: track.id, start: 0, end: 1 },
  })) };
  project = linkSubtitlesToTimeline(project);
  assert.equal(getSubtitleEvents(project).length, 2);
  project = mergeSubtitleEvents(project, 0);
  assert.equal(getSubtitleEvents(project).length, 1);
  assert.equal(new Set(project.subtitles!.words.map((word) => word.source!.id)).size, 2);
  const moved = updateAudioTrack(project, project.audioTracks[1].id, { start: 5 });
  assert.equal(moved.subtitles!.words[1].start, 5);
});
