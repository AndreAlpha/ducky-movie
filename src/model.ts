import type {
  AudioTrack,
  ColorFilter,
  MediaAsset,
  Project,
  VideoClip,
  ClipTransition,
  NormalizedRect,
  ProjectFrame,
  ProjectMusic,
  ProjectSubtitles,
  SubtitleStyle,
  SubtitleWord,
  TimedOverlay,
  TimelineTrack,
  SubtitleSource,
  LinkedSubtitleWord,
} from '../shared/types';

const MAX_DURATION = 24 * 60 * 60;
const MIN_CLIP_DURATION = 1 / 120;
const MAX_ITEMS = 10000;
const FILTERS: ColorFilter[] = ['none', 'warm', 'cool', 'mono', 'vintage', 'vivid', 'bright'];
export const VIDEO_TRACK_ID = 'video-main';
export const AUDIO_TRACK_ID = 'audio-main';
type TimelineProject = Pick<Project, 'clips'> & Partial<Pick<Project, 'audioTracks' | 'tracks' | 'duration' | 'overlays' | 'subtitles'>>;

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  font: 'Segoe UI', size_frac: 0.052, color: '#FFFFFF', active_color: '#F59E0B',
  outline: 0.006, outline_color: '#000000', shadow: 0.004, box: false,
  box_color: '#000000', box_opacity: 0.55, position: 'bottom', margin_frac: 0.10,
  uppercase: false, bold: true, anim: 'fade', width_frac: 0.86,
};

export const SUBTITLE_PRESETS: Record<string, { label: string; style: Partial<SubtitleStyle> }> = {
  clean: { label: 'Pulito', style: {} },
  tiktok: { label: 'TikTok', style: { uppercase: true, size_frac: 0.062, outline: 0.009, active_color: '#FACC15' } },
  box: { label: 'Box', style: { size_frac: 0.05, box: true, box_opacity: 0.6, outline: 0, shadow: 0 } },
  minimal: { label: 'Minimal', style: { bold: false, size_frac: 0.04, position: 'top', outline: 0.004, shadow: 0.003 } },
  news: { label: 'News', style: { size_frac: 0.045, box: true, box_color: '#0B2A4A', box_opacity: 0.85, active_color: '#38BDF8', outline: 0, shadow: 0 } },
  neon: { label: 'Neon', style: { size_frac: 0.055, active_color: '#22D3EE', outline: 0.008, outline_color: '#0E7490', shadow: 0.006 } },
  pop: { label: 'Pop', style: { uppercase: true, size_frac: 0.066, active_color: '#F43F5E', outline: 0.01 } },
  cinema: { label: 'Cinema', style: { font: 'Georgia', bold: false, size_frac: 0.042, color: '#F5F5F5', active_color: '#E5B567', outline: 0.003, shadow: 0.005 } },
};

export function createSubtitles(preset = 'clean'): ProjectSubtitles {
  return { enabled: true, words: [], maxWords: 5, maxLines: 2,
    style: { ...DEFAULT_SUBTITLE_STYLE, ...(SUBTITLE_PRESETS[preset]?.style ?? {}) } };
}

export interface TimelineEntry {
  clip: VideoClip;
  start: number;
  end: number;
  index: number;
  trackId: string;
}

function id(): string {
  return crypto.randomUUID();
}

function changed(project: Project, patch: Partial<Project>): Project {
  return syncLinkedSubtitles(project, { ...project, ...patch, updatedAt: new Date().toISOString() });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function createProject(name = 'Il mio film'): Project {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: id(),
    name: name.trim() || 'Il mio film',
    createdAt: now,
    updatedAt: now,
    aspectRatio: '16:9',
    assets: [],
    clips: [],
    audioTracks: [],
    tracks: [
      { id: VIDEO_TRACK_ID, kind: 'video', name: 'Video 1', muted: false, hidden: false },
      { id: AUDIO_TRACK_ID, kind: 'audio', name: 'Audio 1', muted: false },
    ],
  };
}

export function createClip(asset: MediaAsset, trackId = VIDEO_TRACK_ID): VideoClip {
  if (asset.kind === 'audio')
    throw new Error('Aggiungi questo file a una traccia audio.');
  return {
    id: id(),
    assetId: asset.id,
    trackId,
    in: 0,
    out: asset.kind === 'image' ? 5 : asset.duration,
    speed: 1,
    volume: 1,
    muted: false,
    filter: 'none',
    brightness: 0,
    contrast: 1,
    saturation: 1,
    fit: 'contain',
    rotation: 0,
    fadeIn: 0,
    fadeOut: 0,
    title: null,
  };
}

export function createAudioTrack(asset: MediaAsset, start = 0, trackId = AUDIO_TRACK_ID): AudioTrack {
  if (asset.kind !== 'audio' && !asset.hasAudio) {
    throw new Error('Questo file non contiene audio.');
  }
  return {
    id: id(),
    assetId: asset.id,
    trackId,
    start: Math.max(0, start),
    in: 0,
    out: asset.duration,
    volume: 0.7,
    fadeIn: 0,
    fadeOut: 0,
  };
}

export function clipDuration(
  clip: Pick<VideoClip, 'in' | 'out' | 'speed'>,
): number {
  return (clip.out - clip.in) / clip.speed;
}

export function projectDuration(project: TimelineProject): number {
  return Math.max(project.duration ?? 0, ...timelinePositions(project).map(({ end }) => end),
    ...(project.audioTracks ?? []).map((track) => track.start + track.out - track.in),
    ...(project.overlays ?? []).map((overlay) => overlay.end), ...(project.subtitles?.words ?? []).map((word) => word.end), 0);
}

export function timelinePositions(
  project: TimelineProject,
): TimelineEntry[] {
  const positions = new Map<string, number>();
  const defaultTrack = project.tracks?.find((track) => track.kind === 'video')?.id ?? VIDEO_TRACK_ID;
  return project.clips.map((clip, index) => {
    const trackId = clip.trackId ?? defaultTrack;
    const start = clip.start ?? positions.get(trackId) ?? 0;
    const end = start + clipDuration(clip);
    positions.set(trackId, Math.max(positions.get(trackId) ?? 0, end));
    return { clip, start, end, index, trackId };
  });
}

export function activeClipAt(
  project: TimelineProject,
  time: number,
): TimelineEntry | null {
  if (!Number.isFinite(time) || time < 0) return null;
  return activeClipsAt(project, time)[0] ?? null;
}

export function activeClipsAt(project: TimelineProject, time: number): TimelineEntry[] {
  if (!Number.isFinite(time) || time < 0) return [];
  const tracks = getProjectTracks(project).filter((track) => track.kind === 'video' && !track.hidden);
  return tracks.flatMap((track) => timelinePositions(project)
    .filter((entry) => entry.trackId === track.id && time >= entry.start && time < entry.end));
}

function inferredTracks(project: TimelineProject): { tracks: TimelineTrack[]; video: Map<string, string>; audio: Map<string, string> } {
  const tracks = (project.tracks ?? []).map((track) => ({ ...track }));
  function ensure(trackId: string, kind: TimelineTrack['kind']): string {
    if (!tracks.some((track) => track.id === trackId)) {
      const count = tracks.filter((track) => track.kind === kind).length + 1;
      const track: TimelineTrack = { id: trackId, kind, name: `${kind === 'video' ? 'Video' : 'Audio'} ${count}`, muted: false };
      if (kind === 'video') { track.hidden = false; tracks.splice(tracks.findIndex((item) => item.kind === 'audio') < 0 ? tracks.length : tracks.findIndex((item) => item.kind === 'audio'), 0, track); }
      else tracks.push(track);
    }
    return trackId;
  }
  if (!project.tracks) { ensure(VIDEO_TRACK_ID, 'video'); ensure(AUDIO_TRACK_ID, 'audio'); }
  const video = new Map<string, string>();
  const audio = new Map<string, string>();
  for (const clip of project.clips) video.set(clip.id, ensure(clip.trackId ?? tracks.find((track) => track.kind === 'video')?.id ?? VIDEO_TRACK_ID, 'video'));
  const intervals = new Map<string, { start: number; end: number }[]>();
  for (const item of project.audioTracks ?? []) {
    if (!item.trackId) continue;
    const trackId = ensure(item.trackId, 'audio');
    audio.set(item.id, trackId);
    const occupied = intervals.get(trackId) ?? [];
    occupied.push({ start: item.start, end: item.start + item.out - item.in });
    intervals.set(trackId, occupied);
  }
  for (const item of [...(project.audioTracks ?? [])].sort((a, b) => a.start - b.start)) {
    if (audio.has(item.id)) continue;
    const end = item.start + item.out - item.in;
    let lane = tracks.find((track) => track.kind === 'audio' && !(intervals.get(track.id) ?? [])
      .some((interval) => item.start < interval.end - 0.000001 && end > interval.start + 0.000001));
    if (!lane) {
      let ordinal = tracks.filter((track) => track.kind === 'audio').length + 1;
      let nextId = ordinal === 1 ? AUDIO_TRACK_ID : `audio-${ordinal}`;
      while (tracks.some((track) => track.id === nextId)) nextId = `audio-${++ordinal}`;
      ensure(nextId, 'audio');
      lane = tracks.find((track) => track.id === nextId)!;
    }
    audio.set(item.id, lane.id);
    const occupied = intervals.get(lane.id) ?? [];
    occupied.push({ start: item.start, end });
    intervals.set(lane.id, occupied);
  }
  return { tracks, video, audio };
}

export function getProjectTracks(project: TimelineProject): TimelineTrack[] {
  if (project.tracks && project.clips.every((clip) => clip.trackId) && (project.audioTracks ?? []).every((track) => track.trackId)) return project.tracks.map((track) => ({ ...track }));
  return inferredTracks(project).tracks;
}
export function getClipTrackId(project: TimelineProject, clipId: string): string {
  return project.clips.find((clip) => clip.id === clipId)?.trackId ?? project.tracks?.find((track) => track.kind === 'video')?.id ?? VIDEO_TRACK_ID;
}
export function getAudioTrackId(project: TimelineProject, audioId: string): string {
  return project.audioTracks?.find((track) => track.id === audioId)?.trackId ?? inferredTracks(project).audio.get(audioId) ?? AUDIO_TRACK_ID;
}

export function addTimelineTrack(project: Project, kind: TimelineTrack['kind']): Project {
  const tracks = getProjectTracks(project);
  const count = tracks.filter((track) => track.kind === kind).length + 1;
  const track: TimelineTrack = { id: id(), kind, name: `${kind === 'video' ? 'Video' : 'Audio'} ${count}`, muted: false };
  if (kind === 'video') { track.hidden = false; tracks.unshift(track); } else tracks.push(track);
  return changed(project, { tracks });
}

export function renameTimelineTrack(project: Project, trackId: string, name: string): Project {
  const label = name.trim();
  if (!label || label.length > 100) throw new Error('Inserisci un nome di traccia da 1 a 100 caratteri.');
  return changed(project, { tracks: getProjectTracks(project).map((track) => track.id === trackId ? { ...track, name: label } : track) });
}

export function updateTimelineTrack(project: Project, trackId: string, patch: Pick<Partial<TimelineTrack>, 'name' | 'muted' | 'hidden'>): Project {
  const tracks = getProjectTracks(project).map((track) => track.id === trackId ? parseTimelineTrack({ ...track, ...patch }) : track);
  return changed(project, { tracks });
}

export function removeTimelineTrack(project: Project, trackId: string): Project {
  const layout = inferredTracks(project);
  if ([...layout.video.values(), ...layout.audio.values()].includes(trackId)) throw new Error('Sposta o rimuovi gli elementi prima di eliminare la traccia.');
  return changed(project, { tracks: layout.tracks.filter((track) => track.id !== trackId) });
}

function availableStart(intervals: { start: number; end: number }[], requested: number, duration: number): number {
  const maximum = MAX_DURATION - duration;
  const target = clamp(requested, 0, maximum);
  const occupied = [...intervals].sort((a, b) => a.start - b.start);
  const candidates: number[] = [];
  let cursor = 0;
  for (const interval of [...occupied, { start: MAX_DURATION, end: MAX_DURATION }]) {
    const end = interval.start - duration;
    if (end + 0.000001 >= cursor) candidates.push(clamp(target, cursor, Math.min(end, maximum)));
    cursor = Math.max(cursor, interval.end);
  }
  if (!candidates.length) throw new Error('La traccia non ha spazio sufficiente per questo elemento.');
  return candidates.reduce((closest, candidate) => Math.abs(candidate - target) < Math.abs(closest - target) ? candidate : closest);
}

export function moveTimelineItem(project: Project, itemId: string, kind: 'clip' | 'audio', targetTrackId: string, requestedStart: number): Project {
  if (!Number.isFinite(requestedStart)) throw new Error('La posizione sulla timeline non è valida.');
  const layout = inferredTracks(project);
  const track = layout.tracks.find((item) => item.id === targetTrackId);
  if (!track || track.kind !== (kind === 'clip' ? 'video' : 'audio')) throw new Error('Scegli una traccia compatibile con questo elemento.');
  if (kind === 'audio') {
    const existing = project.audioTracks.find((item) => item.id === itemId);
    if (!existing) return project;
    const intervals = project.audioTracks.filter((item) => item.id !== itemId && layout.audio.get(item.id) === targetTrackId)
      .map((item) => ({ start: item.start, end: item.start + item.out - item.in }));
    const start = availableStart(intervals, requestedStart, existing.out - existing.in);
    return validateProject(changed(project, { tracks: layout.tracks, audioTracks: project.audioTracks.map((item) => ({ ...item,
      trackId: item.id === itemId ? targetTrackId : layout.audio.get(item.id), start: item.id === itemId ? start : item.start })) }));
  }
  const entries = timelinePositions(project);
  const existing = entries.find((entry) => entry.clip.id === itemId);
  if (!existing) return project;
  const intervals = entries.filter((entry) => entry.clip.id !== itemId && entry.trackId === targetTrackId);
  const start = availableStart(intervals, requestedStart, clipDuration(existing.clip));
  const clips = entries.map((entry) => ({ ...entry.clip, trackId: entry.clip.id === itemId ? targetTrackId : entry.trackId,
    start: entry.clip.id === itemId ? start : entry.start }));
  const order = new Map(layout.tracks.map((lane, index) => [lane.id, index]));
  clips.sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0) || a.start - b.start);
  return validateProject(changed(project, { tracks: layout.tracks, clips }));
}

function reflowClips(project: TimelineProject, clips: VideoClip[]): VideoClip[] {
  const gaps = new Map<string, number>();
  const previousEnds = new Map<string, number>();
  for (const entry of timelinePositions(project).sort((a, b) => a.start - b.start)) {
    gaps.set(entry.clip.id, Math.max(0, entry.start - (previousEnds.get(entry.trackId) ?? 0)));
    previousEnds.set(entry.trackId, entry.end);
  }
  const ends = new Map<string, number>();
  return clips.map((clip) => {
    const trackId = clip.trackId ?? project.tracks?.find((track) => track.kind === 'video')?.id ?? VIDEO_TRACK_ID;
    const gap = gaps.get(clip.id) ?? 0;
    const start = (ends.get(trackId) ?? 0) + gap;
    ends.set(trackId, start + clipDuration(clip));
    return clip.start !== undefined || gap > 0 ? { ...clip, start } : clip;
  });
}

export function canonicalMediaPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  // Drive letters and UNC shares have Windows' case-insensitive identity.
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

export function addAssets(project: Project, incoming: MediaAsset[]): Project {
  const assets = [...project.assets];
  const knownPaths = new Map(
    assets.map((asset, index) => [canonicalMediaPath(asset.path), index]),
  );
  const knownIds = new Set(project.assets.map((asset) => asset.id));
  let modified = false;
  for (const asset of incoming) {
    const path = canonicalMediaPath(asset.path);
    const existingIndex = knownPaths.get(path);
    if (existingIndex !== undefined) {
      const existing = assets[existingIndex];
      if (!existing.missing) continue;
      if (existing.kind !== asset.kind)
        throw new Error(
          'Il file ripristinato ha un tipo diverso dall’originale.',
        );
      const sourceEnds = [
        ...project.clips
          .filter((clip) => clip.assetId === existing.id)
          .map((clip) => clip.out),
        ...project.audioTracks
          .filter((track) => track.assetId === existing.id)
          .map((track) => track.out),
        ...(project.music?.assetId === existing.id ? [project.music.out] : []),
      ];
      if (
        asset.kind !== 'image' &&
        sourceEnds.some((end) => end > asset.duration + 0.001)
      ) {
        throw new Error(
          'Il file ripristinato è più breve delle clip presenti nel film. Ripristina il file originale.',
        );
      }
      if (
        !asset.hasAudio &&
        (project.audioTracks.some((track) => track.assetId === existing.id) || project.music?.assetId === existing.id)
      ) {
        throw new Error(
          'Il file ripristinato non contiene l’audio usato nel film.',
        );
      }
      assets[existingIndex] = { ...asset, id: existing.id, missing: false };
      modified = true;
      continue;
    }
    if (knownIds.has(asset.id))
      throw new Error('Un file importato ha un identificativo duplicato.');
    knownPaths.set(path, assets.length);
    knownIds.add(asset.id);
    assets.push(asset);
    modified = true;
  }
  return modified ? changed(project, { assets }) : project;
}

export function appendAsset(
  project: Project,
  assetId: string,
  start = 0,
  targetTrackId?: string,
): Project {
  const asset = project.assets.find((entry) => entry.id === assetId);
  if (!asset)
    throw new Error('Il file selezionato non è presente nella libreria.');
  if (asset.missing)
    throw new Error('Il file originale non è disponibile. Importalo di nuovo.');
  if (!Number.isFinite(start)) throw new Error('La posizione sulla timeline non è valida.');
  let next = project;
  let tracks = getProjectTracks(project);
  const target = targetTrackId ? tracks.find((track) => track.id === targetTrackId) : undefined;
  const extractAudio = target?.kind === 'audio' && asset.kind === 'video' && asset.hasAudio;
  const kind = asset.kind === 'audio' || extractAudio ? 'audio' : 'video';
  if (targetTrackId && (!target || target.kind !== kind)) throw new Error('La traccia selezionata non è compatibile con questo file.');
  if (kind === 'audio') {
    const layout = inferredTracks(project);
    if (target) {
      const intervals = project.audioTracks.filter((track) => layout.audio.get(track.id) === target.id)
        .map((track) => ({ start: track.start, end: track.start + track.out - track.in }));
      const position = availableStart(intervals, start, asset.duration);
      return changed(project, { tracks, audioTracks: [...project.audioTracks, createAudioTrack(asset, position, target.id)] });
    }
    const occupied = (trackId: string) => project.audioTracks.some((track) => layout.audio.get(track.id) === trackId
      && start < track.start + track.out - track.in - 0.000001 && start + asset.duration > track.start + 0.000001);
    const preferred = tracks.find((track) => track.id === (targetTrackId ?? AUDIO_TRACK_ID));
    let lane = preferred && !occupied(preferred.id) ? preferred : tracks.find((track) => track.kind === 'audio' && !occupied(track.id));
    if (!lane) { next = addTimelineTrack(next, 'audio'); tracks = next.tracks!; lane = tracks[tracks.length - 1]; }
    return changed(next, { tracks, audioTracks: [...project.audioTracks, createAudioTrack(asset, start, lane.id)] });
  }
  let lane = tracks.find((track) => track.id === (targetTrackId ?? VIDEO_TRACK_ID)) ?? tracks.find((track) => track.kind === 'video');
  if (!lane) { next = addTimelineTrack(next, 'video'); tracks = next.tracks!; lane = tracks[0]; }
  const clip = createClip(asset, lane.id);
  if (targetTrackId) {
    const intervals = timelinePositions(project).filter((entry) => entry.trackId === lane.id);
    clip.start = availableStart(intervals, start, clipDuration(clip));
  }
  return changed(next, { tracks, clips: [...project.clips, clip] });
}

export function splitClip(
  project: Project,
  clipId: string,
  timelineTime: number,
): Project {
  const entry = timelinePositions(project).find(
    ({ clip }) => clip.id === clipId,
  );
  if (!entry || !Number.isFinite(timelineTime)) return project;
  const before = timelineTime - entry.start;
  const after = entry.end - timelineTime;
  if (before < MIN_CLIP_DURATION || after < MIN_CLIP_DURATION) return project;
  const sourceSplit = entry.clip.in + before * entry.clip.speed;
  const left: VideoClip = {
    ...entry.clip,
    out: sourceSplit,
    fadeIn: Math.min(entry.clip.fadeIn, before / 2),
    fadeOut: 0,
    title: entry.clip.title ? { ...entry.clip.title } : null,
  };
  const right: VideoClip = {
    ...entry.clip,
    id: id(),
    in: sourceSplit,
    fadeIn: 0,
    fadeOut: Math.min(entry.clip.fadeOut, after / 2),
    title: entry.clip.title ? { ...entry.clip.title } : null,
  };
  if (entry.clip.start !== undefined) right.start = timelineTime;
  if (entry.clip.transition !== undefined) right.transition = 'none';
  if (entry.clip.transitionDuration !== undefined) {
    left.transitionDuration = Math.min(entry.clip.transitionDuration, before / 2);
    right.transitionDuration = 0;
  }
  const clips = [...project.clips];
  clips.splice(entry.index, 1, left, right);
  const subtitles = splitLinkedSubtitleSource(project, 'clip', clipId, right.id, sourceSplit);
  return changed(project, { clips, ...(subtitles ? { subtitles } : {}) });
}

export function duplicateClip(project: Project, clipId: string): Project {
  const index = project.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) return project;
  const original = project.clips[index];
  const copy = {
    ...original,
    id: id(),
    title: original.title ? { ...original.title } : null,
  };
  if (original.crop) copy.crop = { ...original.crop };
  if (original.placement) copy.placement = { ...original.placement };
  const position = timelinePositions(project).find((entry) => entry.clip.id === clipId)!;
  copy.start = position.end;
  const duration = clipDuration(original);
  const clips = timelinePositions(project).map((entry) => entry.trackId === position.trackId && entry.start >= position.end - 0.000001
    ? { ...entry.clip, start: entry.start + duration } : entry.clip);
  clips.splice(index + 1, 0, copy);
  return copyLinkedSubtitles(project, changed(project, { clips }), [{ kind: 'clip', id: clipId, newId: copy.id }]);
}

export function removeClip(project: Project, clipId: string): Project {
  return removeClips(project, [clipId]);
}

/** Assets referenced anywhere in the film, including logos and background music. */
export function getUsedAssetIds(project: Project, assetIds: readonly string[]): string[] {
  const used = new Set([
    ...project.clips.map((clip) => clip.assetId),
    ...project.audioTracks.map((audio) => audio.assetId),
    ...(project.overlays ?? []).flatMap((overlay) => overlay.assetId ? [overlay.assetId] : []),
    ...(project.music ? [project.music.assetId] : []),
  ]);
  return [...new Set(assetIds)].filter((assetId) => used.has(assetId));
}

/** Remove library references and their usages without moving surviving timeline items. */
export function removeAssets(project: Project, assetIds: readonly string[]): Project {
  const selected = new Set(assetIds);
  const assets = project.assets.filter((asset) => !selected.has(asset.id));
  if (assets.length === project.assets.length) return project;
  const used = getUsedAssetIds(project, assetIds).length > 0;
  // Materialize implicit sequential starts before removing clips, preserving all gaps.
  const clips = project.clips.some((clip) => selected.has(clip.assetId))
    ? timelinePositions(project).filter(({ clip }) => !selected.has(clip.assetId))
      .map(({ clip, start }) => ({ ...clip, start }))
    : project.clips;
  return changed(project, {
    assets,
    clips,
    audioTracks: project.audioTracks.filter((audio) => !selected.has(audio.assetId)),
    ...(project.overlays ? { overlays: project.overlays.filter((overlay) => !overlay.assetId || !selected.has(overlay.assetId)) } : {}),
    ...(project.music && selected.has(project.music.assetId) ? { music: null } : {}),
    // Keep a hole even when removing the final (or the only) item in the film.
    ...(used ? { duration: projectDuration(project) } : {}),
  });
}

/** targetIndex is the clip's final array index after moving. */
export function moveClip(
  project: Project,
  clipIdOrIndex: string | number,
  targetIndex: number,
): Project {
  const fromIndex =
    typeof clipIdOrIndex === 'number'
      ? clipIdOrIndex
      : project.clips.findIndex((clip) => clip.id === clipIdOrIndex);
  if (
    !Number.isInteger(fromIndex) ||
    fromIndex < 0 ||
    fromIndex >= project.clips.length
  )
    return project;
  if (!Number.isFinite(targetIndex)) return project;
  const trackId = getClipTrackId(project, project.clips[fromIndex].id);
  const lane = timelinePositions(project).filter((entry) => entry.trackId === trackId).sort((a, b) => a.start - b.start).map((entry) => entry.clip);
  const localIndex = lane.findIndex((clip) => clip.id === project.clips[fromIndex].id);
  const toIndex = clamp(Math.trunc(targetIndex), 0, lane.length - 1);
  if (localIndex === toIndex) return project;
  const [clip] = lane.splice(localIndex, 1);
  lane.splice(toIndex, 0, clip);
  let cursor = 0;
  const clips = project.clips.map((item) => getClipTrackId(project, item.id) === trackId ? lane[cursor++] : item);
  const reflowed = reflowClips(project, clips);
  return changed(project, { clips: clips.map((item, index) => getClipTrackId(project, item.id) === trackId ? reflowed[index] : item) });
}

export function updateClip(
  project: Project,
  clipId: string,
  patch: Partial<VideoClip>,
): Project {
  const existing = project.clips.find((clip) => clip.id === clipId);
  if (!existing) return project;
  const asset = project.assets.find((item) => item.id === existing.assetId);
  if (!asset) return project;
  const existingTrackId = getClipTrackId(project, existing.id);
  const next = parseClip(
    { ...existing, ...patch, id: existing.id, assetId: existing.assetId, trackId: existingTrackId },
    asset,
  );
  const halfDuration = clipDuration(next) / 2;
  next.fadeIn = Math.min(next.fadeIn, halfDuration);
  next.fadeOut = Math.min(next.fadeOut, halfDuration);
  const changesPlacement = Object.hasOwn(patch, 'start');
  const entries = timelinePositions(project);
  const originalPosition = entries.find((entry) => entry.clip.id === clipId)!;
  const durationDelta = clipDuration(next) - clipDuration(existing);
  const previousEnd = Math.max(0, ...entries.filter((entry) => entry.trackId === existingTrackId && entry.end <= originalPosition.start + 0.000001)
    .map((entry) => entry.end));
  const gapDelta = changesPlacement && patch.start === undefined ? previousEnd - originalPosition.start : 0;
  if (changesPlacement) {
    if (patch.start === undefined) delete next.start;
    else next.start = originalPosition.start;
  }
  const clips = entries.map((entry) => {
    if (entry.clip.id === clipId) return next;
    if (entry.trackId === existingTrackId && entry.start >= originalPosition.end - 0.000001 && (durationDelta || gapDelta)) {
      return { ...entry.clip, start: entry.start + durationDelta + gapDelta };
    }
    return entry.clip;
  });
  const edited = changed(project, { clips });
  if (patch.trackId !== undefined && patch.trackId !== existingTrackId) {
    const entry = timelinePositions(edited).find((position) => position.clip.id === clipId)!;
    return moveTimelineItem(edited, clipId, 'clip', patch.trackId, patch.start ?? entry.start);
  }
  if (changesPlacement && patch.start !== undefined) {
    const entry = timelinePositions(edited).find((position) => position.clip.id === clipId)!;
    return shiftClips(edited, [clipId], patch.start - entry.start);
  }
  return edited;
}

export function trimClip(
  project: Project,
  clipId: string,
  inPoint: number,
  outPoint: number,
): Project {
  return updateClip(project, clipId, { in: inPoint, out: outPoint });
}

export function removeClips(project: Project, clipIds: readonly string[]): Project {
  const selected = new Set(clipIds);
  const entries = timelinePositions(project);
  const removed = entries.filter((entry) => selected.has(entry.clip.id));
  if (!removed.length) return project;
  const clips = entries.filter((entry) => !selected.has(entry.clip.id)).map((entry) => {
    const amount = removed.filter((item) => item.trackId === entry.trackId && item.end <= entry.start + 0.000001)
      .reduce((sum, item) => sum + clipDuration(item.clip), 0);
    return amount ? { ...entry.clip, start: entry.start - amount } : entry.clip;
  });
  return changed(project, { clips });
}

/** Move a selection as a stable block. targetIndex is its final first index. */
export function moveClips(project: Project, clipIds: readonly string[], targetIndex: number): Project {
  if (!Number.isFinite(targetIndex)) return project;
  const selected = new Set(clipIds);
  if (!project.clips.some((clip) => selected.has(clip.id))) return project;
  const lanes = new Map<string, VideoClip[]>();
  for (const track of getProjectTracks(project).filter((lane) => lane.kind === 'video')) {
    const lane = timelinePositions(project).filter((entry) => entry.trackId === track.id).sort((a, b) => a.start - b.start).map((entry) => entry.clip);
    const moving = lane.filter((clip) => selected.has(clip.id));
    const remaining = lane.filter((clip) => !selected.has(clip.id));
    const index = clamp(Math.trunc(targetIndex), 0, remaining.length);
    lanes.set(track.id, [...remaining.slice(0, index), ...moving, ...remaining.slice(index)]);
  }
  const clips = project.clips.map((clip) => lanes.get(getClipTrackId(project, clip.id))!.shift()!);
  return changed(project, { clips: reflowClips(project, clips) });
}

export function shiftClips(project: Project, clipIds: readonly string[], deltaSeconds: number): Project {
  if (!Number.isFinite(deltaSeconds)) return project;
  const selected = new Set(clipIds);
  const positions = timelinePositions(project);
  if (!positions.some((entry) => selected.has(entry.clip.id))) return project;
  let minimum = -MAX_DURATION;
  let maximum = MAX_DURATION;
  for (let index = 0; index < positions.length; index++) {
    const entry = positions[index];
    if (!selected.has(entry.clip.id)) continue;
    const previous = positions.filter((candidate) => candidate.trackId === entry.trackId && candidate.end <= entry.start + 0.000001 && !selected.has(candidate.clip.id))
      .sort((a, b) => b.end - a.end)[0];
    const next = positions.filter((candidate) => candidate.trackId === entry.trackId && candidate.start >= entry.end - 0.000001 && !selected.has(candidate.clip.id))
      .sort((a, b) => a.start - b.start)[0];
    minimum = Math.max(minimum, (previous?.end ?? 0) - entry.start);
    maximum = Math.min(maximum, (next?.start ?? MAX_DURATION) - entry.end);
  }
  const delta = clamp(deltaSeconds, minimum, maximum);
  if (Math.abs(delta) < 0.000001) return project;
  const clips = positions.map((entry) => ({ ...entry.clip, start: entry.start + (selected.has(entry.clip.id) ? delta : 0) }));
  return validateProject(changed(project, { clips }));
}

export function updateClips(project: Project, clipIds: readonly string[], patch: Partial<VideoClip>): Project {
  return [...new Set(clipIds)].reduce((next, clipId) => updateClip(next, clipId, patch), project);
}

export function splitAudioTrack(project: Project, trackId: string, timelineTime: number): Project {
  const index = project.audioTracks.findIndex((track) => track.id === trackId);
  if (index < 0 || !Number.isFinite(timelineTime)) return project;
  const track = project.audioTracks[index];
  const before = timelineTime - track.start;
  const after = track.out - track.in - before;
  if (before < MIN_CLIP_DURATION || after < MIN_CLIP_DURATION) return project;
  const split = track.in + before;
  const rightId = id();
  const audioTracks = [...project.audioTracks];
  audioTracks.splice(index, 1,
    { ...track, out: split, fadeIn: Math.min(track.fadeIn, before / 2), fadeOut: 0 },
    { ...track, id: rightId, start: timelineTime, in: split, fadeIn: 0, fadeOut: Math.min(track.fadeOut, after / 2) });
  const subtitles = splitLinkedSubtitleSource(project, 'audio', trackId, rightId, split);
  return changed(project, { audioTracks, ...(subtitles ? { subtitles } : {}) });
}

export function duplicateAudioTrack(project: Project, itemId: string): Project {
  const index = project.audioTracks.findIndex((track) => track.id === itemId);
  if (index < 0) return project;
  const original = project.audioTracks[index];
  const lane = getAudioTrackId(project, itemId);
  const duration = original.out - original.in;
  const end = original.start + duration;
  const copy = { ...original, id: id(), start: end, trackId: lane };
  const audioTracks = project.audioTracks.map((track) => getAudioTrackId(project, track.id) === lane && track.start >= end - 0.000001
    ? { ...track, start: track.start + duration } : track);
  audioTracks.splice(index + 1, 0, copy);
  return copyLinkedSubtitles(project, changed(project, { audioTracks }), [{ kind: 'audio', id: itemId, newId: copy.id }]);
}

export function updateAudioTrack(project: Project, itemId: string, patch: Partial<AudioTrack>): Project {
  const existing = project.audioTracks.find((track) => track.id === itemId);
  if (!existing) return project;
  const asset = project.assets.find((item) => item.id === existing.assetId);
  if (!asset) throw new Error('Il file audio non è presente nella libreria.');
  const trackId = getAudioTrackId(project, itemId);
  const targetTrackId = patch.trackId ?? trackId;
  const updated = parseAudioTrack({ ...existing, ...patch, id: existing.id, assetId: existing.assetId, trackId }, asset);
  const edited = changed(project, { tracks: getProjectTracks(project), audioTracks: project.audioTracks.map((track) => track.id === itemId ? updated : track) });
  if (Object.hasOwn(patch, 'start') || targetTrackId !== trackId) {
    return moveTimelineItem(edited, itemId, 'audio', targetTrackId, updated.start);
  }
  const collision = project.audioTracks.some((track) => track.id !== itemId && getAudioTrackId(project, track.id) === trackId
    && updated.start < track.start + track.out - track.in - 0.000001 && updated.start + updated.out - updated.in > track.start + 0.000001);
  if (collision) throw new Error('Il ritaglio sovrappone un altro elemento della stessa traccia audio.');
  return validateProject(edited);
}

function shiftBody(project: Project, delta: number): Project {
  const clips = timelinePositions(project).flatMap((entry) => {
    const start = entry.start + delta;
    if (entry.end + delta <= MIN_CLIP_DURATION) return [];
    return [{ ...entry.clip, start: Math.max(0, start),
      in: entry.clip.in + Math.max(0, -start) * entry.clip.speed,
      fadeIn: start < 0 ? 0 : entry.clip.fadeIn }];
  });
  const audioTracks = project.audioTracks.flatMap((track) => {
    const start = track.start + delta;
    if (start + track.out - track.in <= MIN_CLIP_DURATION) return [];
    return [{ ...track, start: Math.max(0, start), in: track.in + Math.max(0, -start), fadeIn: start < 0 ? 0 : track.fadeIn }];
  });
  const next = changed(project, { clips, audioTracks });
  if (next.subtitles) next.subtitles = { ...next.subtitles, words: next.subtitles.words
    .filter((word) => word.source || word.linkedId || word.end + delta > 0)
    .map((word) => word.source || word.linkedId ? word : { ...word, start: Math.max(0, word.start + delta), end: word.end + delta }) };
  if (project.overlays) next.overlays = project.overlays.filter((overlay) => overlay.end + delta > MIN_CLIP_DURATION)
    .map((overlay) => ({ ...overlay, start: Math.max(0, overlay.start + delta), end: overlay.end + delta }));
  if (project.music) {
    const music = project.music;
    const start = music.start + delta;
    const offset = Math.max(0, -start);
    next.music = music.loop ? { ...music, start: Math.max(0, start), phase: ((music.phase ?? 0) + offset) % (music.out - music.in) }
      : music.out - music.in > offset ? { ...music, start: Math.max(0, start), in: music.in + offset } : null;
  }
  if (project.duration !== undefined) next.duration = Math.max(0, project.duration + delta);
  return next;
}

function bodyContentEnd(project: Project): number {
  return Math.max(0,
    ...timelinePositions(project).filter((entry) => entry.clip.role !== 'outro').map((entry) => entry.end),
    ...project.audioTracks.map((track) => track.start + track.out - track.in),
    ...(project.overlays ?? []).filter((overlay) => !overlay.persistent).map((overlay) => overlay.end),
    ...(project.subtitles?.words ?? []).map((word) => word.end));
}

function fitPersistentLogos(project: Project): Project {
  const introEnd = Math.max(0, ...timelinePositions(project).filter((entry) => entry.clip.role === 'intro').map((entry) => entry.end));
  const bodyEnd = bodyContentEnd(project);
  return { ...project, overlays: project.overlays?.map((overlay) => overlay.persistent
    ? { ...overlay, start: introEnd, end: Math.max(introEnd + MIN_CLIP_DURATION, bodyEnd) } : overlay) };
}

export function setProjectCap(project: Project, assetId: string, role: 'intro' | 'outro'): Project {
  const asset = project.assets.find((item) => item.id === assetId);
  if (!asset || asset.missing || asset.kind === 'audio') throw new Error('Scegli un video o una foto disponibile per questa parte del film.');
  let tracks = getProjectTracks(project);
  let lane = tracks.find((track) => track.id === VIDEO_TRACK_ID && track.kind === 'video') ?? tracks.filter((track) => track.kind === 'video').at(-1);
  if (!lane) { project = addTimelineTrack(project, 'video'); tracks = project.tracks!; lane = tracks[0]; }
  const cap = { ...createClip(asset, lane.id), role, fit: 'cover' as const, start: 0 };
  let next: Project;
  if (role === 'intro') {
    const oldIntroEnd = Math.max(0, ...timelinePositions(project).filter((entry) => entry.clip.role === 'intro').map((entry) => entry.end));
    const without = { ...project, tracks, clips: timelinePositions(project).filter((entry) => entry.clip.role !== 'intro')
      .map((entry) => ({ ...entry.clip, start: entry.start })) };
    next = shiftBody(without, clipDuration(cap) - oldIntroEnd);
    next.clips = [cap, ...next.clips];
  } else {
    const without = { ...project, tracks, clips: project.clips.filter((clip) => clip.role !== 'outro') };
    cap.start = bodyContentEnd(without);
    next = changed(without, { clips: [...without.clips, cap], duration: cap.start + clipDuration(cap) });
  }
  next = fitPersistentLogos(next);
  return validateProject(changed(next, {}));
}

export function removeProjectCap(project: Project, role: 'intro' | 'outro'): Project {
  const capEntries = timelinePositions(project).filter((entry) => entry.clip.role === role);
  if (!capEntries.length) return project;
  const clips = timelinePositions(project).filter((entry) => entry.clip.role !== role).map((entry) => ({ ...entry.clip, start: entry.start }));
  let next = changed(project, { clips });
  if (role === 'intro') next = shiftBody(next, -Math.max(...capEntries.map((entry) => entry.end)));
  else next.duration = bodyContentEnd(next);
  return validateProject(fitPersistentLogos(next));
}

export interface SubtitleEvent { id: string; start: number; end: number; text: string; words: SubtitleWord[] }

interface SubtitleOwner { kind: 'clip' | 'audio'; id: string; start: number; in: number; out: number; speed: number; assetId: string }

function subtitleOwnerKey(source: Pick<SubtitleSource, 'kind' | 'id'>): string { return `${source.kind}:${source.id}`; }

function subtitleOwners(project: Project): Map<string, SubtitleOwner> {
  const owners = new Map<string, SubtitleOwner>();
  for (const entry of timelinePositions(project)) owners.set(`clip:${entry.clip.id}`, {
    kind: 'clip', id: entry.clip.id, start: entry.start, in: entry.clip.in, out: entry.clip.out,
    speed: entry.clip.speed, assetId: entry.clip.assetId,
  });
  for (const track of project.audioTracks) owners.set(`audio:${track.id}`, {
    kind: 'audio', id: track.id, start: track.start, in: track.in, out: track.out, speed: 1, assetId: track.assetId,
  });
  return owners;
}

function inferSubtitleSource(project: Project, word: SubtitleWord): SubtitleSource | undefined {
  const candidates = [...subtitleOwners(project).values()].filter((owner) => {
    const asset = project.assets.find((item) => item.id === owner.assetId);
    return asset?.hasAudio && word.start >= owner.start - 0.000001
      && word.end <= owner.start + (owner.out - owner.in) / owner.speed + 0.000001;
  });
  if (candidates.length !== 1) return undefined;
  const owner = candidates[0];
  return { kind: owner.kind, id: owner.id,
    start: owner.in + (word.start - owner.start) * owner.speed,
    end: owner.in + (word.end - owner.start) * owner.speed };
}

function subtitleBacking(project: Project): { linked: LinkedSubtitleWord[]; free: SubtitleWord[] } {
  const subtitles = project.subtitles;
  if (!subtitles) return { linked: [], free: [] };
  const linked = (subtitles.linkedWords ?? []).map((word) => ({ ...word, sources: word.sources.map((source) => ({ ...source })) }));
  const known = new Set(linked.map((word) => word.id));
  const free: SubtitleWord[] = [];
  for (const [index, word] of subtitles.words.entries()) {
    const identity = word.id ?? subtitleWordIdentity(project.id, word, index);
    const source = word.source ?? (!word.id && !word.detached ? inferSubtitleSource(project, word) : undefined);
    if (!source) {
      if (!word.linkedId) free.push(word.id ? word : { ...word, id: identity });
      continue;
    }
    const wordId = word.linkedId ?? identity;
    if (known.has(wordId)) continue;
    known.add(wordId);
    linked.push({ id: wordId, text: word.text, ...(word.segmentId ? { segmentId: word.segmentId } : {}), sources: [{ ...source }] });
  }
  return { linked, free };
}

function subtitleWordIdentity(projectId: string, word: SubtitleWord, index: number): string {
  const value = `${projectId}|${index}|${word.start}|${word.end}|${word.text}`;
  let hash = 2166136261;
  for (let cursor = 0; cursor < value.length; cursor++) hash = Math.imul(hash ^ value.charCodeAt(cursor), 16777619);
  return `subtitle-${(hash >>> 0).toString(36)}-${index}`;
}

function visibleLinkedWords(project: Project, linked: LinkedSubtitleWord[]): SubtitleWord[] {
  const owners = subtitleOwners(project);
  return linked.flatMap((word) => {
    const fragments = word.sources.flatMap((source) => {
      const owner = owners.get(subtitleOwnerKey(source));
      if (!owner) return [];
      const first = Math.max(source.start, owner.in);
      const last = Math.min(source.end, owner.out);
      if (last - first <= 0.000001) return [];
      return [{ start: owner.start + (first - owner.in) / owner.speed,
        end: owner.start + (last - owner.in) / owner.speed, source }];
    }).sort((a, b) => a.start - b.start);
    const groups: typeof fragments = [];
    for (const fragment of fragments) {
      const previous = groups[groups.length - 1];
      if (previous && fragment.start <= previous.end + 0.000001) previous.end = Math.max(previous.end, fragment.end);
      else groups.push({ ...fragment });
    }
    return groups.map((fragment, index) => ({
      id: groups.length === 1 ? word.id : subtitleWordIdentity(project.id, { start: index, end: index + 1,
        text: `fragment:${word.id}:${subtitleOwnerKey(fragment.source)}` }, index),
      linkedId: word.id, text: word.text, start: fragment.start, end: fragment.end,
      source: { ...fragment.source }, ...(word.segmentId ? { segmentId: word.segmentId } : {}),
    }));
  });
}

function withSubtitleBacking(project: Project, linked: LinkedSubtitleWord[], free: SubtitleWord[]): Project {
  if (!project.subtitles) return project;
  const owners = subtitleOwners(project);
  const existing = linked.map((word) => ({ ...word, sources: word.sources.filter((source) => owners.has(subtitleOwnerKey(source))) }))
    .filter((word) => word.sources.length && word.text.trim());
  const words = [...free.filter((word) => word.text.trim() && word.end > word.start), ...visibleLinkedWords(project, existing)]
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const subtitles: ProjectSubtitles = { ...project.subtitles, words };
  if (existing.length || project.subtitles.linkedWords !== undefined) subtitles.linkedWords = existing;
  if (JSON.stringify(subtitles) === JSON.stringify(project.subtitles)) return project;
  return { ...project, subtitles };
}

/** Associate only unambiguous legacy words. New words with an id remain intentionally free. */
export function linkSubtitlesToTimeline(project: Project): Project {
  const backing = subtitleBacking(project);
  return withSubtitleBacking(project, backing.linked, backing.free);
}

function retimeLinkedWord(project: Project, word: LinkedSubtitleWord, start: number, end: number): LinkedSubtitleWord {
  const owners = subtitleOwners(project);
  const sources = sourcesForSubtitleInterval(project, start, end, word.sources);
  if (!sources.length) throw new Error('La parola deve rimanere entro i tempi della sorgente collegata.');
  for (const source of sources) {
    const owner = owners.get(subtitleOwnerKey(source));
    const asset = project.assets.find((item) => item.id === owner?.assetId);
    if (asset && asset.kind !== 'image' && source.end > asset.duration + 0.000001) throw new Error('I tempi della parola superano la durata della sorgente collegata.');
  }
  return { ...word, sources };
}

/** Refresh render times after timeline edits while retaining trimmed-out source words. */
export function syncLinkedSubtitles(before: Project, after: Project): Project {
  if (!after.subtitles) return after;
  const baseline = linkSubtitlesToTimeline(before);
  const beforeSubtitles = baseline.subtitles;
  const sameWords = after.subtitles.words === before.subtitles?.words;
  const raw = sameWords && beforeSubtitles
    ? { ...after, subtitles: { ...after.subtitles, words: beforeSubtitles.words,
      ...(after.subtitles.linkedWords ? {} : beforeSubtitles.linkedWords ? { linkedWords: beforeSubtitles.linkedWords } : {}) } } : after;
  const backing = subtitleBacking(raw);
  const explicitBacking = after.subtitles.linkedWords !== before.subtitles?.linkedWords && after.subtitles.linkedWords !== undefined;
  if (!sameWords && !explicitBacking && beforeSubtitles) {
    const oldWords = new Map(beforeSubtitles.words.map((word) => [word.id, word]));
    const idsAfter = new Set(after.subtitles.words.map((word) => word.linkedId ?? word.id));
    const previouslyVisible = new Set(beforeSubtitles.words.map((word) => word.linkedId).filter(Boolean));
    backing.linked = backing.linked.filter((word) => !previouslyVisible.has(word.id) || idsAfter.has(word.id));
    const autoWords = visibleLinkedWords(after, backing.linked);
    for (const word of after.subtitles.words) {
      const linkedId = word.linkedId ?? word.id;
      const index = backing.linked.findIndex((item) => item.id === linkedId);
      if (index < 0) continue;
      const old = oldWords.get(word.id);
      let linked = { ...backing.linked[index], text: word.text };
      const expected = autoWords.find((item) => item.id === word.id) ?? autoWords.find((item) => item.linkedId === linkedId);
      const manuallyTimed = old && (Math.abs(word.start - old.start) > 0.000001 || Math.abs(word.end - old.end) > 0.000001)
        && expected && (Math.abs(word.start - expected.start) > 0.000001 || Math.abs(word.end - expected.end) > 0.000001);
      if (manuallyTimed) linked = retimeLinkedWord(after, linked, word.start, word.end);
      if (word.segmentId) linked.segmentId = word.segmentId;
      backing.linked[index] = linked;
    }
  }
  return withSubtitleBacking(after, backing.linked, backing.free);
}

export function copyLinkedSubtitles(before: Project, after: Project, copies: { kind: 'clip' | 'audio'; id: string; newId: string }[]): Project {
  if (!before.subtitles || !after.subtitles) return after;
  const source = subtitleBacking(linkSubtitlesToTimeline(before));
  const destination = subtitleBacking(after);
  const segments = new Map<string, string>();
  for (const [wordIndex, word] of source.linked.entries()) {
    const sources = word.sources.flatMap((part) => {
      const copied = copies.find((item) => item.kind === part.kind && item.id === part.id);
      return copied ? [{ ...part, id: copied.newId }] : [];
    });
    if (!sources.length) continue;
    const wordId = subtitleWordIdentity(after.id, { start: wordIndex, end: wordIndex + 1,
      text: `copy:${word.id}:${sources.map((part) => subtitleOwnerKey(part)).join('|')}` }, wordIndex);
    if (destination.linked.some((item) => item.id === wordId)) continue;
    let segmentId: string | undefined;
    if (word.segmentId) {
      segmentId = segments.get(word.segmentId) ?? id();
      segments.set(word.segmentId, segmentId);
    }
    destination.linked.push({ ...word, id: wordId, sources, ...(segmentId ? { segmentId } : {}) });
  }
  return withSubtitleBacking(after, destination.linked, destination.free);
}

function splitLinkedSubtitleSource(project: Project, kind: 'clip' | 'audio', sourceId: string, newId: string, split: number): ProjectSubtitles | undefined {
  if (!project.subtitles) return undefined;
  const normalized = linkSubtitlesToTimeline(project);
  const backing = subtitleBacking(normalized);
  const linkedWords = backing.linked.map((word) => ({ ...word, sources: word.sources.flatMap((source) => {
    if (source.kind !== kind || source.id !== sourceId) return [source];
    if (source.end <= split) return [source];
    if (source.start >= split) return [{ ...source, id: newId }];
    return [{ ...source, end: split }, { ...source, id: newId, start: split }];
  }) }));
  return { ...normalized.subtitles!, linkedWords };
}

export function replaceSourceSubtitles(project: Project, words: SubtitleWord[], sources: Pick<SubtitleSource, 'kind' | 'id'>[]): Project {
  const base = linkSubtitlesToTimeline(project);
  if (!base.subtitles) return linkSubtitlesToTimeline({ ...base, subtitles: { ...createSubtitles(), words } });
  const backing = subtitleBacking(base);
  const selected = new Set(sources.map(subtitleOwnerKey));
  const linked = backing.linked.map((word) => ({ ...word, sources: word.sources.filter((source) => !selected.has(subtitleOwnerKey(source))) }))
    .filter((word) => word.sources.length);
  const incoming = subtitleBacking({ ...project, subtitles: { ...base.subtitles, linkedWords: [], words } });
  return withSubtitleBacking({ ...base, updatedAt: new Date().toISOString() }, [...linked, ...incoming.linked], [...backing.free, ...incoming.free]);
}

export function groupSubtitleWords(words: readonly SubtitleWord[], maxWords = 5, _maxLines = 2): SubtitleEvent[] {
  const count = clamp(Math.trunc(maxWords) || 5, 1, 20);
  const sorted = words.filter((word) => word.text.trim() && word.end > word.start).slice().sort((a, b) => a.start - b.start);
  const events: SubtitleEvent[] = [];
  const eventIds = new Set<string>();
  let group: SubtitleWord[] = [];
  const flush = () => {
    if (!group.length) return;
    const first = group[0];
    const baseId = first.segmentId ?? first.id ?? `caption-${first.start}-${first.text}`;
    const eventId = eventIds.has(baseId) ? `${baseId}@${subtitleWordIdentity('event', { start: 0, end: 1, text: first.id ?? first.text }, 0)}` : baseId;
    eventIds.add(eventId);
    events.push({ id: eventId,
      start: first.start, end: Math.max(...group.map((word) => word.end)), text: group.map((word) => word.text).join(' '), words: group });
    group = [];
  };
  for (let index = 0; index < sorted.length; index++) {
    const word = sorted[index];
    const previous = group[group.length - 1];
    if (previous) {
      const sameSegment = !!word.segmentId && word.segmentId === previous.segmentId;
      const segmentChanged = word.segmentId !== previous.segmentId && (!!word.segmentId || !!previous.segmentId);
      const sourceChanged = (word.source ? subtitleOwnerKey(word.source) : '') !== (previous.source ? subtitleOwnerKey(previous.source) : '');
      if (segmentChanged || sourceChanged && !sameSegment) flush();
    }
    group.push(word);
    const punctuation = word.text.trim().slice(-1);
    const gap = index === sorted.length - 1 ? Infinity : sorted[index + 1].start - word.end;
    const hard = '.!?…'.includes(punctuation);
    const soft = ',;:'.includes(punctuation) || gap > 0.45;
    const half = Math.max(2, Math.ceil((count + 1) / 2));
    if (index === sorted.length - 1 || !word.segmentId && (group.length >= count || hard || (group.length >= half && soft))) flush();
  }
  return events;
}

export function getSubtitleEvents(project: Project): SubtitleEvent[] {
  const subtitles = linkSubtitlesToTimeline(project).subtitles;
  return subtitles ? groupSubtitleWords(subtitles.words, subtitles.maxWords, subtitles.maxLines) : [];
}

function sourcesForSubtitleInterval(project: Project, start: number, end: number, preferred?: SubtitleSource[]): SubtitleSource[] {
  const owners = subtitleOwners(project);
  const keys = new Set(preferred?.map(subtitleOwnerKey));
  const relevant = [...owners.values()].filter((owner) => keys.has(subtitleOwnerKey(owner)));
  if (relevant.length === 1) {
    const owner = relevant[0];
    return [{ kind: owner.kind, id: owner.id, start: Math.max(0, owner.in + (start - owner.start) * owner.speed),
      end: Math.max(0, owner.in + (end - owner.start) * owner.speed) }].filter((source) => source.end > source.start);
  }
  if (relevant.length > 1) return relevant.flatMap((owner) => {
    const first = Math.max(start, owner.start);
    const last = Math.min(end, owner.start + (owner.out - owner.in) / owner.speed);
    return last > first ? [{ kind: owner.kind, id: owner.id, start: owner.in + (first - owner.start) * owner.speed,
      end: owner.in + (last - owner.start) * owner.speed }] : [];
  });
  const source = inferSubtitleSource(project, { start, end, text: '' });
  return source ? [source] : [];
}

function originalSubtitleSources(project: Project, word: SubtitleWord): SubtitleSource[] {
  const linked = project.subtitles?.linkedWords?.find((item) => item.id === (word.linkedId ?? word.id));
  return linked?.sources.map((source) => ({ ...source })) ?? (word.source ? [{ ...word.source }] : []);
}

function commitSubtitleWords(project: Project, removed: SubtitleWord[], replacements: { word: SubtitleWord; sources: SubtitleSource[] }[]): Project {
  const base = linkSubtitlesToTimeline(project);
  if (!base.subtitles) return base;
  const backing = subtitleBacking(base);
  const removedIds = new Set(removed.map((word) => word.linkedId ?? word.id));
  const linked = backing.linked.filter((word) => !removedIds.has(word.id));
  const free = backing.free.filter((word) => !removedIds.has(word.id));
  for (const { word, sources } of replacements) {
    if (!word.text.trim()) continue;
    if (word.text.length > 500 || word.text.includes('\0')) throw new Error('Una parola del sottotitolo supera il limite di 500 caratteri.');
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end <= word.start || word.end > MAX_DURATION) throw new Error('I tempi del sottotitolo non sono validi.');
    for (const source of sources) parseSubtitleSource(source);
    const wordId = word.linkedId ?? word.id ?? id();
    if (sources.length) {
      const existing = linked.find((item) => item.id === wordId);
      if (existing) {
        const parts = new Map([...existing.sources, ...sources].map((source) => [`${subtitleOwnerKey(source)}:${source.start}:${source.end}`, source]));
        existing.sources = [...parts.values()];
        if (word.segmentId) existing.segmentId = word.segmentId;
      } else linked.push({ id: wordId, text: word.text, sources,
        ...(word.segmentId ? { segmentId: word.segmentId } : {}) });
    }
    else {
      const detached = { ...word, id: wordId, detached: true };
      delete detached.source; delete detached.linkedId;
      free.push(detached);
    }
  }
  return withSubtitleBacking({ ...base, updatedAt: new Date().toISOString() }, linked, free);
}

export function setSubtitleEventText(project: Project, eventIndex: number, text: string): Project {
  project = linkSubtitlesToTimeline(project);
  if (!project.subtitles) return project;
  const events = getSubtitleEvents(project);
  const event = events[eventIndex];
  if (!event) return project;
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const segmentId = event.words[0].segmentId ?? id();
  const preferred = event.words.flatMap((word) => originalSubtitleSources(project, word));
  const replacements = tokens.map((token, index) => {
    const sameCount = tokens.length === event.words.length;
    const old = event.words[index];
    const word: SubtitleWord = { ...(sameCount ? old : {}), id: sameCount ? old.id : id(), segmentId, text: token,
      start: sameCount ? old.start : event.start + (event.end - event.start) * index / tokens.length,
      end: sameCount ? old.end : event.start + (event.end - event.start) * (index + 1) / tokens.length };
    return { word, sources: sameCount ? originalSubtitleSources(project, old) : sourcesForSubtitleInterval(project, word.start, word.end, preferred) };
  });
  return commitSubtitleWords(project, event.words, replacements);
}

export function replaceSubtitleWords(project: Project, find: string, replacement: string): Project {
  project = linkSubtitlesToTimeline(project);
  if (!project.subtitles || !find.trim()) return project;
  const expected = find.trim().toLocaleLowerCase();
  const replace = (text: string) => {
    const match = text.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}'’]+)([^\p{L}\p{N}]*)$/u);
    if (!match || match[2].toLocaleLowerCase() !== expected) return text;
    const replaced = replacement.trim() ? `${match[1]}${replacement.trim()}${match[3]}` : '';
    if (replaced.length > 500 || replaced.includes('\0')) throw new Error('Una parola del sottotitolo supera il limite di 500 caratteri.');
    return replaced;
  };
  const backing = subtitleBacking(project);
  return withSubtitleBacking({ ...project, updatedAt: new Date().toISOString() },
    backing.linked.map((word) => ({ ...word, text: replace(word.text) })).filter((word) => word.text),
    backing.free.map((word) => ({ ...word, text: replace(word.text) })).filter((word) => word.text));
}

export function setSubtitleEventTiming(project: Project, eventIndex: number, timing: { start: number; end: number }): Project {
  project = linkSubtitlesToTimeline(project);
  const event = getSubtitleEvents(project)[eventIndex];
  if (!event) return project;
  const start = number(timing.start, 'Inizio frase', 0, MAX_DURATION);
  const end = number(timing.end, 'Fine frase', 0, MAX_DURATION);
  if (end - start < MIN_CLIP_DURATION) throw new Error('La frase deve avere una durata positiva.');
  const ratio = (end - start) / (event.end - event.start);
  const segmentId = event.words[0].segmentId ?? id();
  const replacements = event.words.map((word) => {
    const first = start + (word.start - event.start) * ratio;
    const last = start + (word.end - event.start) * ratio;
    const linked = project.subtitles?.linkedWords?.find((entry) => entry.id === word.linkedId);
    return { word: { ...word, segmentId, start: first, end: last },
      sources: linked ? retimeLinkedWord(project, linked, first, last).sources : originalSubtitleSources(project, word) };
  });
  return commitSubtitleWords(project, event.words, replacements);
}

export function addSubtitleEvent(project: Project, start: number, text = 'Nuovo sottotitolo', duration = 2): Project {
  const first = number(start, 'Inizio frase', 0, MAX_DURATION);
  const last = number(start + duration, 'Fine frase', 0, MAX_DURATION);
  if (last - first < MIN_CLIP_DURATION) throw new Error('La frase deve avere una durata positiva.');
  const base = linkSubtitlesToTimeline({ ...project, subtitles: project.subtitles ?? createSubtitles() });
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const segmentId = id();
  const replacements = tokens.map((token, index) => {
    const word = { id: id(), segmentId, text: token, start: first + duration * index / tokens.length,
      end: first + duration * (index + 1) / tokens.length };
    return { word, sources: sourcesForSubtitleInterval(base, word.start, word.end) };
  });
  return commitSubtitleWords(base, [], replacements);
}

export function removeSubtitleEvent(project: Project, eventIndex: number): Project {
  project = linkSubtitlesToTimeline(project);
  const event = getSubtitleEvents(project)[eventIndex];
  if (!event) return project;
  const segmentIds = new Set(event.words.map((word) => word.segmentId).filter(Boolean));
  const hidden = (project.subtitles?.linkedWords ?? []).filter((word) => word.segmentId && segmentIds.has(word.segmentId))
    .map((word) => ({ id: word.id, linkedId: word.id, start: 0, end: 0, text: word.text }));
  return commitSubtitleWords(project, [...event.words, ...hidden], []);
}

export function splitSubtitleEvent(project: Project, eventIndex: number, atTime?: number): Project {
  project = linkSubtitlesToTimeline(project);
  const event = getSubtitleEvents(project)[eventIndex];
  if (!event) return project;
  const at = atTime !== undefined && atTime > event.start && atTime < event.end ? atTime : (event.start + event.end) / 2;
  const leftId = id(); const rightId = id();
  if (event.words.length === 1) {
    const original = event.words[0];
    const preferred = originalSubtitleSources(project, original);
    return commitSubtitleWords(project, event.words, [
      { word: { id: id(), segmentId: leftId, text: original.text, start: original.start, end: at }, sources: sourcesForSubtitleInterval(project, original.start, at, preferred) },
      { word: { id: id(), segmentId: rightId, text: original.text, start: at, end: original.end }, sources: sourcesForSubtitleInterval(project, at, original.end, preferred) },
    ]);
  }
  const boundary = event.words.slice(1).reduce((closest, word) => Math.abs(word.start - at) < Math.abs(closest - at) ? word.start : closest, event.words[1].start);
  return commitSubtitleWords(project, event.words, event.words.map((word) => ({
    word: { ...word, segmentId: word.start < boundary ? leftId : rightId }, sources: originalSubtitleSources(project, word),
  })));
}

export function mergeSubtitleEvents(project: Project, eventIndex: number, nextIndex = eventIndex + 1): Project {
  project = linkSubtitlesToTimeline(project);
  const events = getSubtitleEvents(project);
  const first = events[eventIndex]; const second = events[nextIndex];
  if (!first || !second || first === second) return project;
  const words = [...first.words, ...second.words].sort((a, b) => a.start - b.start);
  const segmentId = first.words[0].segmentId ?? id();
  return commitSubtitleWords(project, words, words.map((word) => ({ word: { ...word, segmentId }, sources: originalSubtitleSources(project, word) })));
}

export function updateSubtitleWord(project: Project, wordId: string, patch: { text?: string; start?: number; end?: number }): Project {
  project = linkSubtitlesToTimeline(project);
  const word = project.subtitles?.words.find((item) => item.id === wordId);
  if (!word) return project;
  const updated = { ...word, ...patch };
  if (!Number.isFinite(updated.start) || !Number.isFinite(updated.end) || updated.start < 0 || updated.end <= updated.start || updated.end > MAX_DURATION) throw new Error('La parola deve avere tempi validi e durata positiva.');
  const linked = project.subtitles?.linkedWords?.find((item) => item.id === word.linkedId);
  const sources = linked && (patch.start !== undefined || patch.end !== undefined)
    ? retimeLinkedWord(project, linked, updated.start, updated.end).sources : originalSubtitleSources(project, word);
  return commitSubtitleWords(project, [word], [{ word: updated, sources }]);
}

export function rebindSubtitleEvent(project: Project, eventIndex: number, source: Pick<SubtitleSource, 'kind' | 'id'> | null): Project {
  project = linkSubtitlesToTimeline(project);
  const event = getSubtitleEvents(project)[eventIndex];
  if (!event) return project;
  const owner = source ? subtitleOwners(project).get(subtitleOwnerKey(source)) : undefined;
  if (source && !owner) throw new Error('La sorgente selezionata non è disponibile nella timeline.');
  return commitSubtitleWords(project, event.words, event.words.map((word) => ({ word,
    sources: owner ? sourcesForSubtitleInterval(project, word.start, word.end, [{ ...source!, start: owner.in, end: owner.out }]) : [] })));
}

export interface AutomaticMontageOptions {
  assetIds: string[];
  narrationAssetId?: string;
  imageDuration?: number;
  totalDuration?: number;
  zoom?: boolean;
  transition?: ClipTransition;
}

export function buildAutomaticMontage(project: Project, options: AutomaticMontageOptions): Project {
  if (!getProjectTracks(project).some((track) => track.kind === 'video')) project = addTimelineTrack(project, 'video');
  if (options.narrationAssetId && !getProjectTracks(project).some((track) => track.kind === 'audio')) project = addTimelineTrack(project, 'audio');
  const videoLane = getProjectTracks(project).find((track) => track.kind === 'video')!.id;
  const audioLane = getProjectTracks(project).find((track) => track.kind === 'audio')?.id ?? AUDIO_TRACK_ID;
  const sources = options.assetIds.map((assetId) => project.assets.find((asset) => asset.id === assetId))
    .filter((asset): asset is MediaAsset => !!asset && asset.kind !== 'audio' && !asset.missing);
  if (!sources.length) throw new Error('Scegli almeno un’immagine o un video per il montaggio.');
  const narration = options.narrationAssetId ? project.assets.find((asset) => asset.id === options.narrationAssetId) : undefined;
  if (options.narrationAssetId && (!narration || !narration.hasAudio || narration.missing)) throw new Error('La narrazione selezionata non è disponibile.');
  const target = options.totalDuration ?? narration?.duration;
  if (target !== undefined && (!Number.isFinite(target) || target < MIN_CLIP_DURATION || target > MAX_DURATION)) throw new Error('La durata richiesta per il montaggio non è valida.');
  const imageDuration = options.imageDuration ?? (target ? target / sources.length : 3.5);
  if (!Number.isFinite(imageDuration) || imageDuration < MIN_CLIP_DURATION) throw new Error('La durata delle immagini non è valida.');
  const clips: VideoClip[] = [];
  let elapsed = 0;
  let sourceIndex = 0;
  while (target === undefined ? sourceIndex < sources.length : elapsed < target - MIN_CLIP_DURATION / 2) {
    if (clips.length >= MAX_ITEMS) throw new Error('Il montaggio richiede troppe clip. Aumenta la durata delle immagini.');
    const asset = sources[sourceIndex % sources.length];
    const clip = createClip(asset, videoLane);
    const available = asset.kind === 'image' ? imageDuration : asset.duration;
    const duration = target === undefined ? available : Math.min(available, target - elapsed);
    if (duration < MIN_CLIP_DURATION) break;
    clip.out = duration;
    clip.fit = 'cover';
    if (asset.kind === 'image' && options.zoom) { clip.zoom = sourceIndex % 2 ? 'out' : 'in'; clip.zoomAmount = 1.12; }
    clip.transition = options.transition ?? 'fade';
    clip.transitionDuration = Math.min(0.5, duration / 2);
    clips.push(clip);
    elapsed += duration;
    sourceIndex++;
  }
  const audioTracks = narration ? [{ ...createAudioTrack(narration, 0, audioLane), volume: 1 }] : project.audioTracks;
  const next = changed(project, { clips, audioTracks });
  delete next.duration;
  return validateProject(next);
}

export function extractProjectRange(project: Project, start: number, end: number, options: { name?: string; aspectRatio?: Project['aspectRatio'] } = {}): Project {
  project = linkSubtitlesToTimeline(project);
  const rangeStart = number(start, 'Inizio estratto', 0, projectDuration(project));
  const rangeEnd = number(end, 'Fine estratto', 0, projectDuration(project));
  if (rangeEnd - rangeStart < MIN_CLIP_DURATION) throw new Error('Seleziona un intervallo di durata positiva.');
  const clips: VideoClip[] = [];
  const clipIds = new Map<string, string>();
  const audioIds = new Map<string, string>();
  for (const entry of timelinePositions(project)) {
    const first = Math.max(rangeStart, entry.start);
    const last = Math.min(rangeEnd, entry.end);
    if (last - first < MIN_CLIP_DURATION) continue;
    const localIn = first - entry.start;
    const localOut = last - entry.start;
    const newId = id();
    clipIds.set(entry.clip.id, newId);
    clips.push({ ...entry.clip, id: newId, start: first - rangeStart,
      in: entry.clip.in + localIn * entry.clip.speed,
      out: entry.clip.in + localOut * entry.clip.speed,
      fadeIn: first > entry.start ? 0 : Math.min(entry.clip.fadeIn, (last - first) / 2),
      fadeOut: last < entry.end ? 0 : Math.min(entry.clip.fadeOut, (last - first) / 2),
      transition: first > entry.start ? 'none' : entry.clip.transition,
      title: entry.clip.title ? { ...entry.clip.title } : null,
      crop: entry.clip.crop ? { ...entry.clip.crop } : entry.clip.crop,
    });
  }
  const audioTracks = project.audioTracks.flatMap((track) => {
    const first = Math.max(rangeStart, track.start);
    const last = Math.min(rangeEnd, track.start + track.out - track.in);
    if (last - first < MIN_CLIP_DURATION) return [];
    const newId = id();
    audioIds.set(track.id, newId);
    return [{ ...track, id: newId, start: first - rangeStart,
      in: track.in + first - track.start, out: track.in + last - track.start,
      fadeIn: first > track.start ? 0 : Math.min(track.fadeIn, (last - first) / 2),
      fadeOut: last < track.start + track.out - track.in ? 0 : Math.min(track.fadeOut, (last - first) / 2) }];
  });
  const next: Project = { ...project, ...createProject(options.name ?? `${project.name} · Estratto`), assets: project.assets,
    tracks: getProjectTracks(project), aspectRatio: options.aspectRatio ?? project.aspectRatio, clips, audioTracks, duration: rangeEnd - rangeStart };
  if (project.subtitles) next.subtitles = { ...project.subtitles, style: { ...project.subtitles.style },
    words: project.subtitles.words.filter((word) => word.end > rangeStart && word.start < rangeEnd)
      .map((word) => ({ ...word, start: Math.max(word.start, rangeStart) - rangeStart, end: Math.min(word.end, rangeEnd) - rangeStart })) };
  if (next.subtitles?.linkedWords) {
    next.subtitles.linkedWords = next.subtitles.linkedWords.map((word) => ({ ...word, sources: word.sources.flatMap((source) => {
      const newId = (source.kind === 'clip' ? clipIds : audioIds).get(source.id);
      return newId ? [{ ...source, id: newId }] : [];
    }) })).filter((word) => word.sources.length);
    const refreshed = withSubtitleBacking(next, next.subtitles.linkedWords,
      next.subtitles.words.filter((word) => !word.source && !word.linkedId));
    next.subtitles = refreshed.subtitles;
  }
  if (project.overlays) next.overlays = project.overlays.filter((overlay) => overlay.end > rangeStart && overlay.start < rangeEnd)
    .map((overlay) => ({ ...overlay, id: id(), start: Math.max(overlay.start, rangeStart) - rangeStart, end: Math.min(overlay.end, rangeEnd) - rangeStart }));
  if (project.music) {
    const music = project.music;
    if (!music.loop) {
      const first = Math.max(rangeStart, music.start);
      const last = Math.min(rangeEnd, music.start + music.out - music.in);
      next.music = last > first ? { ...music, start: first - rangeStart, in: music.in + first - music.start, out: music.in + last - music.start } : null;
    } else next.music = { ...music, start: Math.max(0, music.start - rangeStart),
      phase: ((music.phase ?? 0) + Math.max(0, rangeStart - music.start)) % (music.out - music.in) };
  }
  return validateProject(next);
}

export function createProjectTemplate(project: Project): Project {
  const template = { ...project, ...createProject(project.name), assets: project.assets,
    tracks: getProjectTracks(project), aspectRatio: project.aspectRatio, clips: project.clips.filter((clip) => clip.role === 'intro' || clip.role === 'outro')
      .map((clip) => { const copy = { ...clip, id: id() }; delete copy.start; return copy; }), audioTracks: [] };
  if (project.subtitles) template.subtitles = { ...project.subtitles, words: [], linkedWords: [], style: { ...project.subtitles.style } };
  const referenced = new Set(template.clips.map((clip) => clip.assetId));
  for (const overlay of template.overlays ?? []) if (overlay.assetId) referenced.add(overlay.assetId);
  if (template.music) referenced.add(template.music.assetId);
  template.assets = project.assets.filter((asset) => referenced.has(asset.id));
  delete template.duration;
  return validateProject(template);
}

export function applyProjectTemplate(project: Project, template: Project): Project {
  const merged = addAssets(project, template.assets);
  const assetIds = new Map(template.assets.map((source) => [source.id,
    merged.assets.find((asset) => canonicalMediaPath(asset.path) === canonicalMediaPath(source.path))!.id]));
  const tracks = getProjectTracks(project);
  const trackIds = new Map<string, string>();
  for (const source of getProjectTracks(template)) {
    const existing = tracks.find((track) => track.id === source.id);
    if (existing?.kind === source.kind) trackIds.set(source.id, existing.id);
    else {
      const copy = { ...source, id: existing ? id() : source.id };
      trackIds.set(source.id, copy.id);
      if (copy.kind === 'video') tracks.unshift(copy); else tracks.push(copy);
    }
  }
  const templateEntries = timelinePositions(template);
  const intro = templateEntries.filter((entry) => entry.clip.role === 'intro');
  const outro = templateEntries.filter((entry) => entry.clip.role === 'outro');
  const introStart = Math.min(0, ...intro.map((entry) => entry.start));
  const introDuration = Math.max(0, ...intro.map((entry) => entry.end - introStart));
  const originalEntries = timelinePositions(project);
  const oldIntroDuration = Math.max(0, ...originalEntries.filter((entry) => entry.clip.role === 'intro').map((entry) => entry.end));
  const oldOutroDuration = Math.max(0, ...originalEntries.filter((entry) => entry.clip.role === 'outro').map((entry) => clipDuration(entry.clip)));
  const body = originalEntries.filter((entry) => entry.clip.role !== 'intro' && entry.clip.role !== 'outro')
    .map((entry) => ({ ...entry.clip, start: entry.start, trackId: entry.trackId }));
  const shifted = shiftBody({ ...merged, tracks, clips: body,
    duration: project.duration === undefined ? undefined : Math.max(0, project.duration - oldOutroDuration) }, introDuration - oldIntroDuration);
  const cap = (entry: TimelineEntry, start: number) => ({ ...structuredClone(entry.clip), id: id(), start,
    assetId: assetIds.get(entry.clip.assetId)!, trackId: trackIds.get(entry.trackId)! });
  const next = changed(shifted, { tracks, clips: [...intro.map((entry) => cap(entry, entry.start - introStart)), ...shifted.clips],
    overlays: template.overlays?.map((overlay) => ({ ...overlay, id: id(), assetId: overlay.assetId ? assetIds.get(overlay.assetId) : undefined })),
    music: template.music ? { ...template.music, assetId: assetIds.get(template.music.assetId)! } : shifted.music,
    mirror: template.mirror, frame: template.frame ? { ...template.frame } : template.frame,
    protectedArea: template.protectedArea ? { ...template.protectedArea } : template.protectedArea,
    subtitles: template.subtitles ? { ...template.subtitles, style: { ...template.subtitles.style }, words: shifted.subtitles?.words ?? [],
      linkedWords: shifted.subtitles?.linkedWords ?? [] } : shifted.subtitles,
  });
  const endOfBody = Math.max(bodyContentEnd(next), shifted.duration ?? 0);
  const outroStart = Math.min(...outro.map((entry) => entry.start));
  next.clips.push(...outro.map((entry) => cap(entry, endOfBody + entry.start - outroStart)));
  next.duration = Math.max(endOfBody, ...timelinePositions(next).map((entry) => entry.end));
  next.overlays = next.overlays?.map((overlay) => overlay.persistent
    ? { ...overlay, start: introDuration, end: Math.max(introDuration + MIN_CLIP_DURATION, endOfBody) }
    : overlay);
  return validateProject(next);
}

const CSS_FILTERS: Record<ColorFilter, string> = {
  none: '',
  warm: 'sepia(0.22) saturate(1.18)',
  cool: 'sepia(0.12) hue-rotate(170deg) saturate(0.8)',
  mono: 'grayscale(1)',
  vintage: 'sepia(0.45) saturate(0.75) contrast(1.08)',
  vivid: 'brightness(1.03) contrast(1.12) saturate(1.35)',
  bright: 'brightness(1.15) saturate(1.05)',
};

export function filterCss(
  clip: Pick<VideoClip, 'filter' | 'brightness' | 'contrast' | 'saturation'>,
): string {
  return [
    CSS_FILTERS[clip.filter],
    `brightness(${1 + clip.brightness})`,
    `contrast(${clip.contrast})`,
    `saturate(${clip.saturation})`,
  ]
    .filter(Boolean)
    .join(' ');
}

export function formatTimecode(seconds: number, fps = 30): string {
  const rate = Number.isFinite(fps) && fps > 0 ? Math.round(fps) : 30;
  const frames = Math.floor(
    Math.max(0, Number.isFinite(seconds) ? seconds : 0) * rate + 0.000001,
  );
  const wholeSeconds = Math.floor(frames / rate);
  const values = [
    Math.floor(wholeSeconds / 3600),
    Math.floor(wholeSeconds / 60) % 60,
    wholeSeconds % 60,
    frames % rate,
  ];
  return values.map((value) => String(value).padStart(2, '0')).join(':');
}

export function formatDuration(seconds: number): string {
  const wholeSeconds = Math.floor(
    Math.max(0, Number.isFinite(seconds) ? seconds : 0),
  );
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds % 60).padStart(2, '0')}`;
}

function invalid(message: string): never {
  throw new Error(`Progetto non valido. ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(`${label} non è un oggetto.`);
  return value as Record<string, unknown>;
}

function string(
  value: unknown,
  label: string,
  max = 512,
  fallback?: string,
): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    value.includes('\0')
  ) {
    invalid(`${label} non è una stringa valida.`);
  }
  return value;
}

function number(
  value: unknown,
  label: string,
  min: number,
  max: number,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    invalid(`${label} deve essere compreso tra ${min} e ${max}.`);
  }
  return value;
}

function boolean(value: unknown, label: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean')
    invalid(`${label} deve essere un valore booleano.`);
  return value;
}

function choice<T extends string | number>(
  value: unknown,
  values: readonly T[],
  label: string,
  fallback?: T,
): T {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!values.includes(value as T)) invalid(`${label} non è supportato.`);
  return value as T;
}

function list(value: unknown, label: string, fallback = false, limit = MAX_ITEMS): unknown[] {
  if (value === undefined && fallback) return [];
  if (!Array.isArray(value) || value.length > limit)
    invalid(`${label} non è un elenco valido.`);
  return value;
}

function date(value: unknown, label: string, fallback?: string): string {
  const result = string(value, label, 64, fallback);
  if (!Number.isFinite(Date.parse(result)))
    invalid(`${label} non è una data valida.`);
  return result;
}

function color(value: unknown, label: string, fallback = '#FFFFFF'): string {
  const result = string(value, label, 7, fallback);
  if (!/^#[a-f\d]{6}$/i.test(result)) invalid(`${label} non è un colore valido.`);
  return result;
}

function parseRect(value: unknown, label: string): NormalizedRect {
  const item = object(value, label);
  const rect = {
    x: number(item.x, `${label} X`, 0, 1, 0),
    y: number(item.y, `${label} Y`, 0, 1, 0),
    w: number(item.w, `${label} larghezza`, 0.001, 1, 1),
    h: number(item.h, `${label} altezza`, 0.001, 1, 1),
  };
  if (rect.x + rect.w > 1.000001 || rect.y + rect.h > 1.000001) invalid(`${label} supera i bordi dell’immagine.`);
  return rect;
}

function parseSubtitleWord(value: unknown): SubtitleWord {
  const item = object(value, 'Parola sottotitolo');
  const start = number(item.start, 'Inizio parola', 0, MAX_DURATION);
  const end = number(item.end, 'Fine parola', 0, MAX_DURATION);
  if (end <= start) invalid('Una parola ha una durata non valida.');
  const word: SubtitleWord = { start, end, text: string(item.text, 'Testo parola', 500) };
  if (item.id !== undefined) word.id = string(item.id, 'Identificativo parola', 200);
  if (item.segmentId !== undefined) word.segmentId = string(item.segmentId, 'Identificativo frase', 200);
  if (item.linkedId !== undefined) word.linkedId = string(item.linkedId, 'Riferimento parola originale', 200);
  if (item.detached !== undefined) word.detached = boolean(item.detached, 'Parola non collegata');
  if (item.source !== undefined) word.source = parseSubtitleSource(item.source);
  return word;
}

function parseSubtitleSource(value: unknown): SubtitleSource {
  const item = object(value, 'Collegamento sottotitolo');
  const start = number(item.start, 'Entrata parola nella sorgente', 0, MAX_DURATION);
  const end = number(item.end, 'Uscita parola nella sorgente', 0, MAX_DURATION);
  if (end <= start) invalid('Un collegamento sottotitolo ha una durata non valida.');
  return { kind: choice(item.kind, ['clip', 'audio'] as const, 'Tipo sorgente sottotitolo'),
    id: string(item.id, 'Elemento sorgente sottotitolo', 200), start, end };
}

function parseSubtitleStyle(value: unknown): SubtitleStyle {
  const item = value === undefined ? {} : object(value, 'Stile sottotitoli');
  const defaults = DEFAULT_SUBTITLE_STYLE;
  const result: SubtitleStyle = {
    font: string(item.font, 'Carattere sottotitoli', 128, defaults.font),
    size_frac: number(item.size_frac, 'Dimensione sottotitoli', 0.01, 0.25, defaults.size_frac),
    color: color(item.color, 'Colore sottotitoli', defaults.color),
    active_color: color(item.active_color, 'Colore parola attiva', defaults.active_color),
    outline: number(item.outline, 'Contorno sottotitoli', 0, 0.05, defaults.outline),
    outline_color: color(item.outline_color, 'Colore contorno sottotitoli', defaults.outline_color),
    shadow: number(item.shadow, 'Ombra sottotitoli', 0, 0.05, defaults.shadow),
    box: boolean(item.box, 'Sfondo sottotitoli', defaults.box),
    box_color: color(item.box_color, 'Colore sfondo sottotitoli', defaults.box_color),
    box_opacity: number(item.box_opacity, 'Opacità sfondo sottotitoli', 0, 1, defaults.box_opacity),
    position: choice(item.position, ['bottom', 'center', 'top'] as const, 'Posizione sottotitoli', defaults.position),
    margin_frac: number(item.margin_frac, 'Margine sottotitoli', 0, 0.45, defaults.margin_frac),
    uppercase: boolean(item.uppercase, 'Sottotitoli maiuscoli', defaults.uppercase),
    bold: boolean(item.bold, 'Sottotitoli grassetto', defaults.bold),
    anim: choice(item.anim, ['none', 'fade'] as const, 'Animazione sottotitoli', defaults.anim),
    width_frac: number(item.width_frac, 'Larghezza sottotitoli', 0.15, 1, defaults.width_frac),
  };
  if (item.x !== undefined) result.x = number(item.x, 'Posizione X sottotitoli', 0, 1);
  if (item.y !== undefined) result.y = number(item.y, 'Posizione Y sottotitoli', 0, 1);
  return result;
}

function parseSubtitles(value: unknown): ProjectSubtitles {
  const item = object(value, 'Sottotitoli');
  const maxWords = number(item.maxWords, 'Parole per blocco', 1, 20, 5);
  const maxLines = number(item.maxLines, 'Righe sottotitoli', 1, 3, 2);
  if (!Number.isInteger(maxWords) || !Number.isInteger(maxLines)) invalid('I limiti dei sottotitoli devono essere interi.');
  const subtitles: ProjectSubtitles = { enabled: boolean(item.enabled, 'Sottotitoli attivi', true),
    words: list(item.words, 'Parole sottotitoli', true, 200000).map(parseSubtitleWord).sort((a, b) => a.start - b.start),
    style: parseSubtitleStyle(item.style), maxWords, maxLines };
  if (item.linkedWords !== undefined) {
    const ids = new Set<string>();
    subtitles.linkedWords = list(item.linkedWords, 'Parole sorgente', false, 200000).map((value) => {
      const entry = object(value, 'Parola sorgente');
      const wordId = string(entry.id, 'Identificativo parola sorgente', 200);
      if (ids.has(wordId)) invalid('I sottotitoli contengono identificativi sorgente duplicati.');
      ids.add(wordId);
      const sources = list(entry.sources, 'Parti della parola', false, 1000).map(parseSubtitleSource);
      if (!sources.length) invalid('Una parola sorgente è priva di collegamenti.');
      const word: LinkedSubtitleWord = { id: wordId, text: string(entry.text, 'Testo parola sorgente', 500), sources };
      if (entry.segmentId !== undefined) word.segmentId = string(entry.segmentId, 'Identificativo frase', 200);
      return word;
    });
  }
  return subtitles;
}

function parseOverlay(value: unknown, assets: Map<string, MediaAsset>): TimedOverlay {
  const item = object(value, 'Comparsa');
  const start = number(item.start, 'Inizio comparsa', 0, MAX_DURATION, 0);
  const end = number(item.end, 'Fine comparsa', 0, MAX_DURATION);
  if (end - start < MIN_CLIP_DURATION) invalid('Una comparsa ha una durata non valida.');
  const overlay: TimedOverlay = {
    id: string(item.id, 'Identificativo comparsa', 200),
    kind: choice(item.kind, ['image', 'text', 'subscribe'] as const, 'Tipo comparsa'),
    start, end, x: number(item.x, 'Posizione X comparsa', 0, 1, 0.5),
    y: number(item.y, 'Posizione Y comparsa', 0, 1, 0.5),
    width: number(item.width, 'Larghezza comparsa', 0.01, 1, 0.25),
    opacity: number(item.opacity, 'Opacità comparsa', 0, 1, 1),
    animation: choice(item.animation, ['none', 'fade', 'fade-grow', 'pop', 'zoom-out', 'slide-up', 'slide-right', 'breathe'] as const, 'Animazione comparsa', 'fade'),
  };
  if (item.assetId !== undefined) overlay.assetId = string(item.assetId, 'File comparsa', 200);
  if (overlay.kind === 'image' && (!overlay.assetId || assets.get(overlay.assetId)?.kind !== 'image')) invalid('Una comparsa immagine fa riferimento a un file assente o non valido.');
  if (item.text !== undefined) {
    if (typeof item.text !== 'string' || item.text.length > 2000 || item.text.includes('\0')) invalid('Il testo della comparsa non è valido.');
    overlay.text = item.text;
  }
  if (item.color !== undefined) overlay.color = color(item.color, 'Colore comparsa');
  if (item.sound !== undefined) overlay.sound = boolean(item.sound, 'Suono comparsa');
  if (item.fontSize !== undefined) overlay.fontSize = number(item.fontSize, 'Dimensione testo comparsa', 0.01, 0.3);
  if (item.box !== undefined) overlay.box = boolean(item.box, 'Sfondo comparsa');
  if (item.boxColor !== undefined) overlay.boxColor = color(item.boxColor, 'Colore sfondo comparsa');
  if (item.boxOpacity !== undefined) overlay.boxOpacity = number(item.boxOpacity, 'Opacità sfondo comparsa', 0, 1);
  if (item.persistent !== undefined) overlay.persistent = boolean(item.persistent, 'Logo permanente');
  return overlay;
}

function parseMusic(value: unknown, assets: Map<string, MediaAsset>): ProjectMusic {
  const item = object(value, 'Musica di sottofondo');
  const assetId = string(item.assetId, 'File musica', 200);
  const asset = assets.get(assetId);
  if (!asset || !asset.hasAudio || asset.kind === 'image') invalid('La musica fa riferimento a un file audio assente.');
  const inPoint = number(item.in, 'Inizio musica', 0, asset.duration, 0);
  const outPoint = number(item.out, 'Fine musica', 0, asset.duration, asset.duration);
  if (outPoint - inPoint < MIN_CLIP_DURATION) invalid('La durata della musica non è valida.');
  const music: ProjectMusic = { assetId, start: number(item.start, 'Posizione musica', 0, MAX_DURATION, 0), in: inPoint, out: outPoint,
    volume: number(item.volume, 'Volume musica', 0, 3, 0.15), loop: boolean(item.loop, 'Musica in ripetizione', true), duck: boolean(item.duck, 'Attenuazione musica', true) };
  if (item.phase !== undefined) music.phase = number(item.phase, 'Fase musica', 0, outPoint - inPoint);
  return music;
}

function parseFrame(value: unknown): ProjectFrame {
  const item = object(value, 'Cornice');
  return {
    style: choice(item.style, ['none', 'solid', 'double', 'inset', 'corners', 'rounded', 'vignette', 'edgeFade', 'cinema', 'bottomBar', 'neon', 'gradient', 'sideBars', 'stripe', 'film', 'polaroid', 'dashed', 'dotted', 'tape', 'ornate', 'glow'] as const, 'Stile cornice', 'none'),
    color: color(item.color, 'Colore cornice'), accent: color(item.accent, 'Accento cornice', '#111111'),
    thickness: number(item.thickness, 'Spessore cornice', 0, 0.2, 0.02), opacity: number(item.opacity, 'Opacità cornice', 0, 1, 1),
  };
}

function parseAsset(value: unknown): MediaAsset {
  const item = object(value, 'File');
  const path = string(item.path, 'Percorso del file', 32768);
  const kind = choice(
    item.kind,
    ['video', 'image', 'audio'] as const,
    'Tipo di file',
  );
  const asset: MediaAsset = {
    id: string(item.id, 'Identificativo del file', 200),
    name: string(
      item.name,
      'Nome del file',
      1024,
      path.split(/[\\/]/).pop() || 'File',
    ),
    path,
    url: item.url === '' ? '' : string(item.url, 'URL del file', 65536, ''),
    kind,
    duration: number(
      item.duration,
      'Durata del file',
      kind === 'image' ? 0 : MIN_CLIP_DURATION,
      MAX_DURATION,
      kind === 'image' ? 5 : undefined,
    ),
    width: number(item.width, 'Larghezza del file', 0, 65536, 0),
    height: number(item.height, 'Altezza del file', 0, 65536, 0),
    hasAudio: boolean(item.hasAudio, 'Presenza audio', kind === 'audio'),
  };
  if (item.thumbnail !== undefined)
    asset.thumbnail =
      item.thumbnail === '' ? '' : string(item.thumbnail, 'Miniatura', 65536);
  if (item.missing !== undefined)
    asset.missing = boolean(item.missing, 'File mancante');
  if (item.waveform !== undefined) {
    if (!Array.isArray(item.waveform) || item.waveform.length > 4096)
      invalid('La forma d’onda non è valida.');
    asset.waveform = item.waveform.map((amplitude) =>
      number(amplitude, 'Ampiezza audio', 0, 1),
    );
  }
  return asset;
}

function parseClip(value: unknown, asset: MediaAsset): VideoClip {
  if (asset.kind === 'audio')
    invalid('Una clip video fa riferimento a un file audio.');
  const item = object(value, 'Clip');
  const inPoint = number(item.in, 'Inizio clip', 0, MAX_DURATION, 0);
  const outPoint = number(
    item.out,
    'Fine clip',
    0,
    MAX_DURATION,
    asset.kind === 'image' ? 5 : asset.duration,
  );
  const speed = number(item.speed, 'Velocità clip', 0.25, 4, 1);
  if (outPoint - inPoint < MIN_CLIP_DURATION * speed)
    invalid('La durata della clip è troppo breve.');
  if (asset.kind !== 'image' && outPoint > asset.duration + 0.001)
    invalid('La clip supera la durata del file originale.');
  const clip: VideoClip = {
    id: string(item.id, 'Identificativo clip', 200),
    assetId: asset.id,
    in: inPoint,
    out: outPoint,
    speed,
    volume: number(item.volume, 'Volume clip', 0, 3, 1),
    muted: boolean(item.muted, 'Audio disattivato'),
    filter: choice(item.filter, FILTERS, 'Filtro', 'none'),
    brightness: number(item.brightness, 'Luminosità', -1, 1, 0),
    contrast: number(item.contrast, 'Contrasto', 0, 4, 1),
    saturation: number(item.saturation, 'Saturazione', 0, 4, 1),
    fit: choice(
      item.fit,
      ['contain', 'cover'] as const,
      'Inquadratura',
      'contain',
    ),
    rotation: choice(item.rotation, [0, 90, 180, 270] as const, 'Rotazione', 0),
    fadeIn: number(item.fadeIn, 'Dissolvenza iniziale', 0, MAX_DURATION, 0),
    fadeOut: number(item.fadeOut, 'Dissolvenza finale', 0, MAX_DURATION, 0),
    title: null,
  };
  if (item.title !== undefined && item.title !== null) {
    const title = object(item.title, 'Titolo');
    if (
      typeof title.text !== 'string' ||
      title.text.length > 2000 ||
      title.text.includes('\0')
    )
      invalid('Il testo del titolo non è valido.');
    const color = string(title.color, 'Colore titolo', 9, '#ffffff');
    if (!/^#[a-f\d]{6}$/i.test(color))
      invalid('Il colore del titolo non è valido.');
    clip.title = {
      text: title.text,
      style: choice(
        title.style,
        ['center', 'lower', 'cinema'] as const,
        'Stile del titolo',
        'center',
      ),
      color,
    };
  }
  clip.fadeIn = Math.min(clip.fadeIn, clipDuration(clip) / 2);
  clip.fadeOut = Math.min(clip.fadeOut, clipDuration(clip) / 2);
  if (item.crop !== undefined) clip.crop = item.crop === null ? null : parseRect(item.crop, 'Ritaglio');
  if (item.mirror !== undefined) clip.mirror = boolean(item.mirror, 'Specchiatura clip');
  if (item.zoom !== undefined) clip.zoom = choice(item.zoom, ['none', 'in', 'out'] as const, 'Movimento zoom');
  if (item.zoomAmount !== undefined) clip.zoomAmount = number(item.zoomAmount, 'Ampiezza zoom', 1, 1.5);
  if (item.warmth !== undefined) clip.warmth = number(item.warmth, 'Temperatura colore', -1, 1);
  if (item.transition !== undefined) clip.transition = choice(item.transition, ['none', 'fade', 'black', 'white', 'zoom', 'blur'] as const, 'Transizione');
  if (item.transitionDuration !== undefined) clip.transitionDuration = Math.min(number(item.transitionDuration, 'Durata transizione', 0, 5), clipDuration(clip) / 2);
  if (item.start !== undefined) clip.start = number(item.start, 'Posizione clip', 0, MAX_DURATION);
  if (item.background !== undefined) clip.background = choice(item.background, ['black', 'blur'] as const, 'Sfondo clip');
  if (item.role !== undefined) clip.role = choice(item.role, ['normal', 'intro', 'outro'] as const, 'Ruolo clip');
  if (item.trackId !== undefined) clip.trackId = string(item.trackId, 'Traccia video', 200);
  if (item.placement !== undefined) {
    const placement = object(item.placement, 'Posizionamento video');
    clip.placement = {
      x: number(placement.x, 'Posizione X video', 0, 1, 0.5),
      y: number(placement.y, 'Posizione Y video', 0, 1, 0.5),
      scale: number(placement.scale, 'Scala video', 0.05, 2, 1),
      opacity: number(placement.opacity, 'Opacità video', 0, 1, 1),
    };
  }
  return clip;
}

function parseAudioTrack(value: unknown, asset: MediaAsset): AudioTrack {
  if (asset.kind === 'image' || !asset.hasAudio)
    invalid('Una traccia audio fa riferimento a un file senza audio.');
  const item = object(value, 'Traccia audio');
  const inPoint = number(item.in, 'Inizio audio', 0, MAX_DURATION, 0);
  const outPoint = number(
    item.out,
    'Fine audio',
    0,
    MAX_DURATION,
    asset.duration,
  );
  if (outPoint - inPoint < MIN_CLIP_DURATION)
    invalid('La durata della traccia audio è troppo breve.');
  if (outPoint > asset.duration + 0.001)
    invalid('La traccia audio supera la durata del file originale.');
  const halfDuration = (outPoint - inPoint) / 2;
  const track: AudioTrack = {
    id: string(item.id, 'Identificativo traccia audio', 200),
    assetId: asset.id,
    start: number(item.start, 'Posizione audio', 0, MAX_DURATION, 0),
    in: inPoint,
    out: outPoint,
    volume: number(item.volume, 'Volume audio', 0, 3, 0.7),
    fadeIn: Math.min(
      number(item.fadeIn, 'Dissolvenza audio iniziale', 0, MAX_DURATION, 0),
      halfDuration,
    ),
    fadeOut: Math.min(
      number(item.fadeOut, 'Dissolvenza audio finale', 0, MAX_DURATION, 0),
      halfDuration,
    ),
  };
  if (item.trackId !== undefined) track.trackId = string(item.trackId, 'Traccia audio', 200);
  return track;
}

function parseTimelineTrack(value: unknown): TimelineTrack {
  const item = object(value, 'Traccia della timeline');
  const track: TimelineTrack = {
    id: string(item.id, 'Identificativo traccia', 200),
    kind: choice(item.kind, ['video', 'audio'] as const, 'Tipo di traccia'),
    name: string(item.name, 'Nome traccia', 100),
    muted: boolean(item.muted, 'Traccia silenziata'),
  };
  if (item.hidden !== undefined) track.hidden = boolean(item.hidden, 'Traccia nascosta');
  return track;
}

/** Parse disk/IPC data and supply defaults for version-one projects. */
export function validateProject(value: unknown): Project {
  const item = object(value, 'Progetto');
  if (item.version !== 1)
    invalid('Questa versione del progetto non è supportata.');
  const assets = list(item.assets, 'Libreria').map(parseAsset);
  const assetsById = new Map<string, MediaAsset>();
  for (const asset of assets) {
    if (assetsById.has(asset.id))
      invalid('La libreria contiene identificativi duplicati.');
    assetsById.set(asset.id, asset);
  }
  const usedIds = new Set<string>();
  function assetFor(entry: unknown): MediaAsset {
    const source = object(entry, 'Elemento della timeline');
    const assetId = string(source.assetId, 'Riferimento al file', 200);
    const asset = assetsById.get(assetId);
    if (!asset)
      invalid('La timeline fa riferimento a un file assente dalla libreria.');
    const entryId = string(source.id, 'Identificativo della timeline', 200);
    if (usedIds.has(entryId))
      invalid('La timeline contiene identificativi duplicati.');
    usedIds.add(entryId);
    return asset;
  }
  const clips = list(item.clips, 'Clip').map((clip) =>
    parseClip(clip, assetFor(clip)),
  );
  const audioTracks = list(item.audioTracks, 'Tracce audio', true).map(
    (track) => parseAudioTrack(track, assetFor(track)),
  );
  const duration = item.duration === undefined ? undefined : number(item.duration, 'Durata del film', 0, MAX_DURATION);
  const declaredTracks = item.tracks === undefined ? undefined : list(item.tracks, 'Tracce della timeline').map(parseTimelineTrack);
  if (declaredTracks) {
    const ids = new Set<string>();
    for (const track of declaredTracks) {
      if (ids.has(track.id)) invalid('La timeline contiene tracce duplicate.');
      ids.add(track.id);
    }
    for (const entry of [...clips, ...audioTracks]) {
      if (!entry.trackId) continue;
      const lane = declaredTracks.find((track) => track.id === entry.trackId);
      const kind = clips.some((clip) => clip.id === entry.id) ? 'video' : 'audio';
      if (!lane || lane.kind !== kind) invalid('Un elemento fa riferimento a una traccia assente o incompatibile.');
    }
  }
  const layout = inferredTracks({ clips, audioTracks, tracks: declaredTracks });
  for (const clip of clips) clip.trackId = layout.video.get(clip.id)!;
  for (const track of audioTracks) track.trackId = layout.audio.get(track.id)!;
  for (const lane of layout.tracks) {
    const intervals = lane.kind === 'video'
      ? timelinePositions({ clips }).filter((entry) => entry.trackId === lane.id)
      : audioTracks.filter((track) => track.trackId === lane.id).map((track) => ({ start: track.start, end: track.start + track.out - track.in }));
    intervals.sort((a, b) => a.start - b.start);
    let previousEnd = 0;
    for (const interval of intervals) {
      if (interval.start + 0.000001 < previousEnd) invalid(`Gli elementi della traccia ${lane.name} si sovrappongono.`);
      previousEnd = interval.end;
    }
  }
  const createdAt = date(
    item.createdAt,
    'Data di creazione',
    new Date().toISOString(),
  );
  const project: Project = {
    version: 1,
    id: string(item.id, 'Identificativo progetto', 200),
    name: string(item.name, 'Nome progetto', 200, 'Il mio film'),
    createdAt,
    updatedAt: date(item.updatedAt, 'Data di modifica', createdAt),
    aspectRatio: choice(
      item.aspectRatio,
      ['16:9', '9:16', '1:1'] as const,
      'Formato',
      '16:9',
    ),
    assets,
    clips,
    audioTracks,
    tracks: layout.tracks,
  };
  if (duration !== undefined) project.duration = duration;
  if (item.subtitles !== undefined) project.subtitles = parseSubtitles(item.subtitles);
  if (item.overlays !== undefined) {
    project.overlays = list(item.overlays, 'Comparse').map((overlay) => parseOverlay(overlay, assetsById));
    for (const overlay of project.overlays) {
      if (usedIds.has(overlay.id)) invalid('La timeline contiene identificativi duplicati.');
      usedIds.add(overlay.id);
    }
  }
  if (item.music !== undefined) project.music = item.music === null ? null : parseMusic(item.music, assetsById);
  if (item.mirror !== undefined) project.mirror = boolean(item.mirror, 'Specchiatura globale');
  if (item.frame !== undefined) project.frame = item.frame === null ? null : parseFrame(item.frame);
  if (item.protectedArea !== undefined) project.protectedArea = item.protectedArea === null ? null : parseRect(item.protectedArea, 'Area protetta');
  if (projectDuration(project) > MAX_DURATION) invalid('Il film supera la durata massima di 24 ore.');
  if (project.subtitles) {
    const owners = subtitleOwners(project);
    const wordIds = new Set<string>();
    for (const word of project.subtitles.words) {
      if (word.id && wordIds.has(word.id)) invalid('I sottotitoli contengono identificativi parola duplicati.');
      if (word.id) wordIds.add(word.id);
      if (word.source && !owners.has(subtitleOwnerKey(word.source))) invalid('Un sottotitolo fa riferimento a un elemento della timeline assente.');
    }
    for (const word of project.subtitles.linkedWords ?? []) {
      if (word.sources.some((source) => !owners.has(subtitleOwnerKey(source)))) invalid('Una parola sorgente fa riferimento a un elemento della timeline assente.');
    }
  }
  return linkSubtitlesToTimeline(project);
}
