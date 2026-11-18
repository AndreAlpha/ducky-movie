import type { MediaAsset, Project, TimelineTrack } from '../shared/types';
import {
  addTimelineTrack, clipDuration, createAudioTrack, createClip, getAudioTrackId,
  getProjectTracks, MIN_CLIP_DURATION, projectDuration,
  splitAudioTrack, splitClip, syncLinkedSubtitles, timelinePositions, validateProject,
} from './model';

interface Interval { id: string; start: number; end: number }

/** Keep both halves editable when a pointer lands within a fraction of a frame of a cut. */
export function resolveLibraryInsertionTime(requested: number, crossing?: { start: number; end: number }) {
  if (!crossing || requested <= crossing.start || requested >= crossing.end) return requested;
  const before = requested - crossing.start;
  const after = crossing.end - requested;
  if (Math.min(before, after) >= MIN_CLIP_DURATION + 1e-9) return requested;
  return before <= after ? crossing.start : crossing.end;
}

function laneIntervals(project: Project, lane: TimelineTrack): Interval[] {
  if (lane.kind === 'video') {
    return timelinePositions(project).filter(entry => entry.trackId === lane.id)
      .map(({ clip, start, end }) => ({ id: clip.id, start, end }));
  }
  return project.audioTracks.filter(item => item.trackId === lane.id)
    .map(item => ({ id: item.id, start: item.start, end: item.start + item.out - item.in }));
}

/** Split at the requested time, unless doing so would leave an uneditable sliver. */
function openInsertionPoint(project: Project, lane: TimelineTrack, requested: number) {
  const crossing = laneIntervals(project, lane).find(item => item.start < requested && requested < item.end);
  const start = resolveLibraryInsertionTime(requested, crossing);
  if (!crossing || start !== requested) return { project, start };
  if (lane.kind === 'audio') return { project: splitAudioTrack(project, crossing.id, requested), start: requested };
  // The split helper keeps explicit timeline times on both halves. Set the
  // start even for sequential legacy clips so a fractional speed cannot
  // round the right half to just before this insertion point.
  const positioned = { ...project, clips: project.clips.map(clip => clip.id === crossing.id ? { ...clip, start: crossing.start } : clip) };
  return { project: splitClip(positioned, crossing.id, requested), start: requested };
}

function insertOnLane(project: Project, lane: TimelineTrack, media: readonly MediaAsset[], requested: number) {
  const { project: base, start } = openInsertionPoint(project, lane, requested);
  let cursor = start;
  const newClips = [];
  const newAudio = [];
  for (const asset of media) {
    if (lane.kind === 'video') {
      const clip = { ...createClip(asset, lane.id), start: cursor };
      newClips.push(clip);
      cursor += clipDuration(clip);
    } else {
      const audio = createAudioTrack(asset, cursor, lane.id);
      newAudio.push(audio);
      cursor += audio.out - audio.in;
    }
  }

  // Use the existing gap first. If it is too small, move the whole suffix
  // together to preserve the relative spacing of all following items.
  // Adjacent decimal trims can differ by less than the project validator's
  // one-microsecond tolerance, even when they form the same visible edit.
  const suffix = laneIntervals(base, lane).filter(item => item.start >= start - .000001);
  const firstStart = Math.min(...suffix.map(item => item.start));
  const shift = Math.max(0, cursor - firstStart);
  const shifted = new Set(suffix.map(item => item.id));
  const firstRight = suffix.find(item => item.start === firstStart);
  const clips = timelinePositions(base).map(({ clip, trackId, start: existingStart }) => {
    if (trackId !== lane.id) return clip;
    return { ...clip, start: existingStart + (shifted.has(clip.id) ? shift : 0) };
  });
  const audioTracks = base.audioTracks.map(item => item.trackId === lane.id && shifted.has(item.id)
    ? { ...item, start: item.start + shift } : item);
  if (lane.kind === 'video') {
    const index = firstRight ? clips.findIndex(clip => clip.id === firstRight.id) : clips.length;
    clips.splice(index, 0, ...newClips);
  } else {
    const index = firstRight ? audioTracks.findIndex(item => item.id === firstRight.id) : audioTracks.length;
    audioTracks.splice(index, 0, ...newAudio);
  }
  const next = syncLinkedSubtitles(base, { ...base, clips, audioTracks, updatedAt: new Date().toISOString() });
  return {
    project: next, clipIds: newClips.map(clip => clip.id), audioIds: newAudio.map(item => item.id),
    movedEnd: shift > 0 ? Math.max(...suffix.map(item => item.end)) + shift : 0,
  };
}

/** Insert the complete library selection as one edit, with one shared cut per lane. */
export function insertLibraryAssets(project: Project, assetIds: readonly string[], start: number, targetTrackId?: string) {
  if (!Number.isFinite(start) || start < 0) throw new Error('La posizione nella timeline non è valida.');
  const clipIds: string[] = [], audioIds: string[] = [];
  if (!assetIds.length) return { project, clipIds, audioIds };

  const available = new Map(project.assets.map(asset => [asset.id, asset]));
  const requested = getProjectTracks(project).find(track => track.id === targetTrackId);
  const byKind = new Map<TimelineTrack['kind'], MediaAsset[]>();
  for (const id of new Set(assetIds)) {
    const asset = available.get(id);
    if (!asset || asset.missing) throw new Error('Uno dei media selezionati non è disponibile. Ricollegalo prima di aggiungerlo.');
    const extractAudio = requested?.kind === 'audio' && asset.kind === 'video' && asset.hasAudio;
    const kind = asset.kind === 'audio' || extractAudio ? 'audio' : 'video';
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push(asset);
  }

  // Materialize legacy audio lane assignments before a split or a ripple can
  // change the inferred layout. Timeline positions on other lanes stay fixed.
  let next: Project = { ...project, tracks: getProjectTracks(project),
    audioTracks: project.audioTracks.map(item => item.trackId ? item : { ...item, trackId: getAudioTrackId(project, item.id) }) };
  let movedEnd = 0;
  for (const [kind, assets] of byKind) {
    let lane = requested?.kind === kind ? requested : next.tracks!.find(item => item.kind === kind);
    if (!lane) {
      next = addTimelineTrack(next, kind);
      lane = next.tracks!.find(item => item.kind === kind)!;
    }
    const result = insertOnLane(next, lane, assets, start);
    next = result.project;
    movedEnd = Math.max(movedEnd, result.movedEnd);
    clipIds.push(...result.clipIds);
    audioIds.push(...result.audioIds);
  }
  if (project.duration !== undefined && movedEnd > 0) {
    const oldEnd = projectDuration({ ...project, duration: undefined });
    if (project.duration > oldEnd && movedEnd > oldEnd) next.duration = project.duration + movedEnd - oldEnd;
  }
  // Validate the whole edit once, including new split halves and caption
  // fragments, before handing it to the undo history.
  return { project: validateProject(next), clipIds, audioIds };
}
