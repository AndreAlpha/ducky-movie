import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MediaAsset, Project, SubtitleWord, TimedOverlay, VideoClip } from '../shared/types';
import { canonicalMediaPath, createAudioTrack, createClip, createProject, createSubtitles, validateProject } from '../src/model';

type LegacyObject = Record<string, unknown>;

function record(value: unknown, label: string): LegacyObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} DuckyPlay non valido.`);
  return value as LegacyObject;
}

function entries(value: unknown, label: string): LegacyObject[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 200000) throw new Error(`${label} DuckyPlay non valido.`);
  return value.map((item) => record(item, label));
}

function numeric(value: unknown, fallback: number, label: string): number {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} DuckyPlay non valido.`);
  return value;
}

function legacyRoot(input: unknown): LegacyObject {
  const item = record(input, 'Progetto');
  if (item.kind !== 'duckyvm-template' && !Array.isArray(item.segments) && !Array.isArray(item.media) && !Array.isArray(item.audios) && typeof item.audio !== 'string') {
    throw new Error('Il file non contiene un progetto o un template Video Make di DuckyPlay.');
  }
  if (item.version !== undefined && ![1, 2, 3].includes(item.version as number)) throw new Error('Versione del progetto DuckyPlay non supportata.');
  return item;
}

function resolved(source: unknown, baseDir: string): string | null {
  if (source == null || source === '') return null;
  if (typeof source !== 'string' || source.includes('\0') || source.length > 32768) throw new Error('Percorso media DuckyPlay non valido.');
  return path.resolve(baseDir, source);
}

function capObject(value: unknown): LegacyObject | null {
  if (!value) return null;
  return typeof value === 'string' ? { path: value } : record(value, 'Intro/outro');
}

export function gatherLegacyPaths(input: unknown, baseDir: string): string[] {
  const item = legacyRoot(input);
  const paths: unknown[] = [item.audio, item.logo];
  for (const cap of [capObject(item.intro), capObject(item.outro)]) if (cap) paths.push(cap.path);
  for (const media of entries(item.media, 'Libreria')) paths.push(media.path ?? media.source);
  for (const segment of entries(item.segments, 'Scene')) paths.push(segment.source ?? segment.image);
  for (const audio of entries(item.audios, 'Narrazioni')) paths.push(audio.path);
  for (const overlay of entries(item.overlays, 'Comparse')) paths.push(overlay.path ?? overlay.source);
  if (item.music) paths.push(record(item.music, 'Musica').path);
  const unique = new Map<string, string>();
  for (const candidate of paths) {
    const file = resolved(candidate, baseDir);
    if (file) unique.set(canonicalMediaPath(file), file);
  }
  if (unique.size > 10000) throw new Error('Il progetto DuckyPlay contiene troppi file.');
  return [...unique.values()];
}

function legacyWords(value: unknown, offset = 0): SubtitleWord[] {
  return entries(value, 'Parole').flatMap((word) => {
    if (typeof word.text !== 'string') throw new Error('Testo del sottotitolo DuckyPlay non valido.');
    const text = word.text.trim();
    const start = numeric(word.start ?? word.t0, 0, 'Inizio parola') + offset;
    const end = numeric(word.end ?? word.t1, 0, 'Fine parola') + offset;
    return text && end > start && end > 0 ? [{ start: Math.max(0, start), end, text }] : [];
  });
}

export function convertLegacyProject(input: unknown, assets: MediaAsset[], baseDir: string): Project {
  const item = legacyRoot(input);
  const imported = new Map(assets.map((asset) => [canonicalMediaPath(asset.path), asset]));
  function assetFor(source: unknown): MediaAsset {
    const file = resolved(source, baseDir);
    const asset = file ? imported.get(canonicalMediaPath(file)) : undefined;
    if (!asset || asset.missing) throw new Error(`File del progetto DuckyPlay non disponibile. ${file ?? 'Percorso mancante'}`);
    return asset;
  }
  // The importer must retain every library source, including unused items.
  for (const file of gatherLegacyPaths(item, baseDir)) assetFor(file);
  const project = createProject(typeof item.name === 'string' && item.name.trim() ? item.name.slice(0, 200) : item.kind === 'duckyvm-template' ? 'Template DuckyPlay' : 'Progetto DuckyPlay');
  project.assets = assets;
  const width = numeric(item.width, 1920, 'Larghezza');
  const height = numeric(item.height, 1080, 'Altezza');
  project.aspectRatio = Math.abs(width - height) < 2 ? '1:1' : width < height ? '9:16' : '16:9';
  const introObject = capObject(item.intro);
  const outroObject = capObject(item.outro);
  function makeCap(source: LegacyObject | null, role: 'intro' | 'outro'): VideoClip | null {
    if (!source) return null;
    const asset = assetFor(source.path);
    if (asset.kind !== 'video') throw new Error(`L’${role} DuckyPlay deve essere un video.`);
    const clip = createClip(asset);
    clip.out = numeric(source.duration, asset.duration, 'Durata intro/outro');
    clip.role = role;
    clip.fit = 'cover';
    clip.transition = 'fade';
    clip.transitionDuration = Math.min(0.5, clip.out / 2);
    return clip;
  }
  const intro = makeCap(introObject, 'intro');
  const outro = makeCap(outroObject, 'outro');
  const introDuration = intro?.out ?? 0;
  const outroDuration = outro?.out ?? 0;
  const isTemplate = item.kind === 'duckyvm-template';
  const segments = entries(item.segments, 'Scene').filter((segment) => segment.type !== 'gap')
    .sort((a, b) => numeric(a.start, 0, 'Inizio scena') - numeric(b.start, 0, 'Inizio scena'));
  const sourceAudios = entries(item.audios, 'Narrazioni');
  if (!sourceAudios.length && item.audio) sourceAudios.push({ path: item.audio, start: 0, in: 0, out: item.audio_duration, words: item.words });
  project.audioTracks = sourceAudios.map((audio) => {
    const asset = assetFor(audio.path);
    const track = createAudioTrack(asset, introDuration + numeric(audio.start, 0, 'Posizione narrazione'));
    track.in = numeric(audio.in, 0, 'Entrata narrazione');
    track.out = numeric(audio.out, asset.duration, 'Uscita narrazione');
    track.volume = numeric(audio.volume, 1, 'Volume narrazione');
    // Legacy narration blocks could overlap before lanes were represented.
    delete track.trackId;
    return track;
  });
  const audioEnd = Math.max(0, ...project.audioTracks.map((track) => track.start - introDuration + track.out - track.in));
  const sceneEnd = Math.max(0, ...segments.map((segment) => numeric(segment.end, 0, 'Fine scena')));
  const masterDuration = isTemplate ? 0 : Math.max(0.6, audioEnd, sceneEnd);
  const visibleDuration = isTemplate ? 0 : outro ? Math.max(0.6, masterDuration - outroDuration + 3) : masterDuration;
  const clips: VideoClip[] = intro ? [intro] : [];
  let previousEnd = 0;
  for (const segment of segments) {
    const start = Math.max(previousEnd, numeric(segment.start, 0, 'Inizio scena'));
    const end = Math.min(visibleDuration, numeric(segment.end, start, 'Fine scena'));
    if (end - start < 1 / 120) continue;
    const asset = assetFor(segment.source ?? segment.image);
    const clip = createClip(asset);
    clip.start = introDuration + start;
    clip.fit = 'cover';
    clip.role = 'normal';
    clip.mirror = !!segment.mirror;
    clip.transition = (segment.transition ?? 'fade') as VideoClip['transition'];
    clip.transitionDuration = Math.min(0.5, (end - start) / 2);
    if (asset.kind === 'image') {
      clip.out = end - start;
      clip.zoom = segment.no_zoom ? 'none' : segment.zoom_in === false ? 'out' : 'in';
      clip.zoomAmount = 1.12;
    } else {
      clip.in = numeric(segment.in, 0, 'Entrata clip');
      clip.speed = numeric(segment.speed, 1, 'Velocità clip');
      const sourceOut = numeric(segment.out, asset.duration, 'Uscita clip');
      clip.out = Math.min(sourceOut, clip.in + (end - start) * clip.speed);
      clip.muted = !segment.use_audio;
      if (segment.crop) clip.crop = record(segment.crop, 'Ritaglio') as unknown as VideoClip['crop'];
    }
    previousEnd = start + (clip.out - clip.in) / clip.speed;
    clips.push(clip);
  }
  if (outro) { outro.start = introDuration + visibleDuration; clips.push(outro); }
  project.clips = clips;
  project.duration = introDuration + visibleDuration + outroDuration;
  project.mirror = !!item.mirror_global;
  const subtitleSource = item.subtitles ? record(item.subtitles, 'Sottotitoli') : {};
  const subtitles = createSubtitles(typeof subtitleSource.preset === 'string' ? subtitleSource.preset : 'clean');
  subtitles.enabled = subtitleSource.enabled !== false;
  subtitles.maxWords = numeric(subtitleSource.max_words ?? subtitleSource.chunk_size, 5, 'Parole per blocco');
  subtitles.maxLines = numeric(subtitleSource.max_lines, 2, 'Righe sottotitoli');
  const events = entries(subtitleSource.events, 'Blocchi sottotitoli');
  if (events.length) subtitles.words = events.flatMap((event) => legacyWords(event.words, introDuration));
  else if (Array.isArray(item.words) && item.words.length) subtitles.words = legacyWords(item.words, introDuration);
  else subtitles.words = sourceAudios.flatMap((audio, index) => {
    const track = project.audioTracks[index];
    return legacyWords(audio.words).filter((word) => word.end > track.in && word.start < track.out)
      .map((word) => ({ ...word, start: track.start + Math.max(track.in, word.start) - track.in, end: track.start + Math.min(track.out, word.end) - track.in }));
  });
  if (subtitleSource.style) {
    const style = record(subtitleSource.style, 'Stile sottotitoli');
    subtitles.style = { ...subtitles.style, ...style, width_frac: numeric(style.wrap_frac ?? style.width_frac, 0.86, 'Larghezza sottotitoli') };
    if (style.pos) {
      const position = record(style.pos, 'Posizione sottotitoli');
      const dx = numeric(position.dx, 0, 'Posizione X sottotitoli');
      const dy = numeric(position.dy, 0, 'Posizione Y sottotitoli');
      if (dx) subtitles.style.x = Math.min(1, Math.max(0, 0.5 + dx));
      if (dy) {
        const base = subtitles.style.position === 'top' ? subtitles.style.margin_frac : subtitles.style.position === 'center' ? 0.5 : 1 - subtitles.style.margin_frac;
        subtitles.style.y = Math.min(1, Math.max(0, base + dy));
      }
    }
  }
  project.subtitles = subtitles;
  project.overlays = [];
  const logo = item.logo ? assetFor(item.logo) : undefined;
  if (logo) {
    const layout = item.logo_layout ? record(item.logo_layout, 'Posizione logo') : {};
    const logoWidth = numeric(layout.w, 0.12, 'Larghezza logo');
    const logoHeight = logo.width > 0 && logo.height > 0 ? logoWidth * width / height * logo.height / logo.width : logoWidth;
    const x = numeric(layout.x, 1 - logoWidth - 0.045, 'Posizione logo X');
    const y = numeric(layout.y, 1 - logoHeight - 0.045 * width / height, 'Posizione logo Y');
    project.overlays.push({ id: randomUUID(), kind: 'image', assetId: logo.id,
      start: introDuration, end: introDuration + Math.max(0.01, visibleDuration),
      x: Math.min(1 - logoWidth / 2, Math.max(logoWidth / 2, x + logoWidth / 2)),
      y: Math.min(1 - logoHeight / 2, Math.max(logoHeight / 2, y + logoHeight / 2)),
      width: logoWidth, opacity: 1, animation: 'none', persistent: true });
  }
  const positions: Record<string, [number, number]> = { center: [0.5, 0.5], top: [0.5, 0.2], bottom: [0.5, 0.82], 'top-left': [0.22, 0.2], 'top-right': [0.78, 0.2], 'bottom-left': [0.22, 0.82], 'bottom-right': [0.78, 0.82] };
  for (const source of entries(item.overlays, 'Comparse')) {
    const kind = source.type === 'logo' || source.type === 'image' ? 'image' : source.type === 'subscribe' ? 'subscribe' : 'text';
    const position = positions[String(source.pos)] ?? positions.center;
    const start = introDuration + numeric(source.start, 0, 'Inizio comparsa');
    const overlay: TimedOverlay = { id: randomUUID(), kind, start,
      end: start + numeric(source.duration, 8, 'Durata comparsa'),
      x: numeric(source.x, position[0], 'Posizione X comparsa'), y: numeric(source.y, position[1], 'Posizione Y comparsa'),
      width: kind === 'image' ? numeric(source.size, 0.26, 'Dimensione comparsa') : 0.9,
      opacity: numeric(source.opacity, 0.85, 'Opacità comparsa'), animation: (source.anim ?? 'fade') as TimedOverlay['animation'] };
    if (kind === 'image') overlay.assetId = source.path || source.source ? assetFor(source.path ?? source.source).id : logo?.id;
    else {
      overlay.text = typeof source.text === 'string' ? source.text : kind === 'subscribe' ? 'Iscriviti al canale!' : '';
      overlay.fontSize = numeric(source.size, 0.075, 'Dimensione testo comparsa');
      overlay.color = typeof source.color === 'string' ? source.color : '#FFFFFF';
      overlay.box = !!source.box;
      overlay.boxColor = typeof source.box_color === 'string' ? source.box_color : '#000000';
      overlay.boxOpacity = numeric(source.box_opacity, 1, 'Opacità sfondo comparsa');
      overlay.sound = kind === 'subscribe';
    }
    project.overlays.push(overlay);
  }
  if (item.music) {
    const music = record(item.music, 'Musica');
    if (music.path) {
      const asset = assetFor(music.path);
      project.music = { assetId: asset.id, start: 0, in: 0, out: asset.duration,
        volume: numeric(music.volume, 0.15, 'Volume musica'), loop: true, duck: music.duck !== false };
    }
  }
  return validateProject(project);
}
