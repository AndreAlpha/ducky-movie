import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { Eye, EyeOff, Film, GripVertical, Music2, Plus, Trash2, Type, Volume2, VolumeX } from 'lucide-react';
import type { AudioTrack, Project, TimelineTrack, TimedOverlay } from '../../shared/types';
import { clipDuration, formatDuration, getAudioTrackId, getClipTrackId, getProjectTracks, projectDuration, timelinePositions } from '../model';
import { captionBlocks } from '../render-effects';
import { snapTimelineDelta, type TimelineSnapResult, type TimelineSnapTarget } from '../timeline-snapping';
import '../tracks.css';

export interface TimelineProps {
  project: Project;
  time: number;
  selectedId: string | null;
  selectedIds?: string[];
  zoom: number;
  onTimeChange: (time: number) => void;
  onSelect: (id: string, kind: 'clip' | 'audio') => void;
  onReorder: (id: string, targetIndex: number) => void;
  onDropAsset: (assetId: string, index?: number, trackId?: string, time?: number) => void;
  onTrim: (id: string, inTime: number, outTime: number) => void;
  onSelectionChange?: (ids: string[]) => void;
  onMoveGroup?: (ids: string[], deltaSeconds: number) => void;
  onDeleteSelection?: (ids: string[]) => void;
  onAudioChange?: (id: string, patch: Partial<AudioTrack>) => void;
  onAudioSplit?: (id: string, time: number) => void;
  onSelectOverlay?: (id: string) => void;
  onSelectSubtitle?: (index: number) => void;
  onAddTrack?: (kind: TimelineTrack['kind']) => void;
  onTrackChange?: (id: string, patch: Partial<TimelineTrack>) => void;
  onRemoveTrack?: (id: string) => void;
  onMoveItem?: (id: string, kind: 'clip' | 'audio', trackId: string, start: number) => void;
  selectedTrackId?: string;
  onSelectTrack?: (id: string) => void;
  selectedEffectId?: string;
  onOverlayChange?: (id: string, patch: Partial<TimedOverlay>) => void;
  onSubtitleChange?: (index: number, timing: { start: number; end: number }) => void;
  onDeleteEffect?: (id: string) => void;
  onDropAssets?: (assetIds: string[], trackId?: string, time?: number) => void;
  onDropError?: (message: string) => void;
  onZoomChange?: (zoom: number) => void;
  onReorderGroup?: (ids: string[], targetIndex: number) => void;
  snappingEnabled?: boolean;
}

interface DraggedItem { id: string; ids: string[]; kind: 'clip' | 'audio'; trackId: string; start: number; x: number; grabOffset?: number }
interface TrimGesture { id: string; kind: 'clip' | 'audio'; side: 'in' | 'out'; x: number; grabTime: number; in: number; out: number; start: number; speed: number; sourceDuration: number; nextIn: number; nextOut: number; nextStart: number }
interface EffectItem { id: string; kind: 'overlay' | 'subtitle' | 'music'; index?: number; start: number; end: number; text: string; row?: number }
interface EffectGesture { item: EffectItem; mode: 'move' | 'start' | 'end'; source: 'pointer' | 'keyboard'; x: number; scroll: number; grabTime?: number; start: number; end: number; snap?: number; project: Project }
export const TIMELINE_GUTTER = 186;
export const MIN_TIMELINE_ZOOM = .001;
export const MAX_TIMELINE_ZOOM = 240;
const GUTTER = TIMELINE_GUTTER;

function Waveform({ samples }: { samples?: number[] }) {
  if (!samples?.length) return <div className="clip-waveform waveform-empty" aria-hidden="true" />;
  return <div className="clip-waveform" aria-hidden="true">{samples.map((sample, index) => <i key={index} style={{ height: `${Math.max(6, Math.min(1, Math.abs(sample)) * 100)}%` }} />)}</div>;
}

function dragLeftContainer(event: DragEvent<HTMLElement>) {
  const related = event.relatedTarget;
  if (related instanceof Node) return !event.currentTarget.contains(related);
  // Chromium may omit relatedTarget while scrolling replaces the hovered clip.
  // Keep the native drag alive until the pointer actually leaves the container.
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom;
}

export function Timeline(props: TimelineProps) {
  const { project, time, selectedId, selectedIds, zoom, onTimeChange, onSelect, onDropAsset, onTrim, onSelectionChange, onMoveGroup, onDeleteSelection, onAudioChange, onAudioSplit, onSelectOverlay, onSelectSubtitle, onAddTrack, onTrackChange, onRemoveTrack, onMoveItem, selectedTrackId, onSelectTrack, selectedEffectId, onOverlayChange, onSubtitleChange, onDeleteEffect, onDropAssets, onDropError, onZoomChange, onReorderGroup, snappingEnabled = true } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<string | null>(null);
  const trimRef = useRef<TrimGesture | null>(null);
  const followRef = useRef({ time, zoom, width: 0 });
  const scrubRef = useRef(false);
  const autoScrollRef = useRef<{ x: number; y: number; vertical: boolean; extend: boolean; update?: () => void } | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const pendingZoomRef = useRef<{ time: number; x: number } | null>(null);
  const nativeDragRef = useRef<DraggedItem | null>(null);
  const magnetRef = useRef(snappingEnabled);
  const altRef = useRef(false);
  magnetRef.current = snappingEnabled;
  const effectRevealRef = useRef<{ id?: string | null; start?: number; end?: number }>({});
  const zoomCallbackRef = useRef(onZoomChange);
  zoomCallbackRef.current = onZoomChange;
  const effectGestureRef = useRef<EffectGesture | null>(null);
  const effectCaptureRef = useRef<{ element: HTMLElement; pointerId: number } | null>(null);
  const [trim, setTrim] = useState<TrimGesture | null>(null);
  const [dropTrack, setDropTrack] = useState<string | null>(null);
  const [editingTrack, setEditingTrack] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ left: 0, top: 0, width: 1200, height: 400 });
  const [effectGesture, setEffectGesture] = useState<EffectGesture | null>(null);
  const [localEffectId, setLocalEffectId] = useState<string | null>(null);
  const [dragExtent, setDragExtent] = useState(0);
  const [dropFailure, setDropFailure] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ trackId: string; time: number; insert: boolean } | null>(null);
  const [snapGuide, setSnapGuide] = useState<TimelineSnapTarget | null>(null);
  const pixelsPerSecond = Math.max(MIN_TIMELINE_ZOOM, Math.min(MAX_TIMELINE_ZOOM, Number.isFinite(zoom) ? zoom : 26));
  const scaleRef = useRef(pixelsPerSecond);
  const requestedZoomRef = useRef(pixelsPerSecond);
  scaleRef.current = pixelsPerSecond;
  const duration = projectDuration(project);
  const selection = selectedIds ?? (selectedId ? [selectedId] : []);
  const effectSelection = Object.prototype.hasOwnProperty.call(props, 'selectedEffectId') ? selectedEffectId : localEffectId;
  const tracks = useMemo(() => getProjectTracks(project), [project]);
  const entries = useMemo(() => timelinePositions(project), [project]);
  const assets = useMemo(() => new Map(project.assets.map((asset) => [asset.id, asset])), [project.assets]);
  const subtitleBlocks = useMemo(() => project.subtitles?.enabled ? captionBlocks(project.subtitles) : [], [project.subtitles]);
  const lanes = useMemo(() => {
    let top = 30;
    return tracks.map((track) => { const height = track.kind === 'video' ? 102 : 68; const lane = { track, top, height }; top += height; return lane; });
  }, [tracks]);
  const nativeLanesEnd = lanes.at(-1) ? lanes.at(-1)!.top + lanes.at(-1)!.height : 30;
  const effectLanes = useMemo(() => {
    const lanes: { id: string; name: string; items: EffectItem[]; rows: number; top: number; height: number }[] = [];
    if (project.music) lanes.push({ id: 'music', name: 'Musica', items: [{ id: 'music', kind: 'music', start: project.music.start, end: project.music.loop ? duration : project.music.start + project.music.out - project.music.in, text: `${assets.get(project.music.assetId)?.name ?? 'Musica'}${project.music.loop ? ' · ↻' : ''}` }], rows: 1, top: 0, height: 48 });
    if (subtitleBlocks.length) lanes.push({ id: 'subtitles', name: 'Sottotitoli', items: subtitleBlocks.map((block, index) => ({ id: `subtitle:${index}`, kind: 'subtitle', index, start: block.start, end: block.end, text: block.words.map((word) => word.text).join(' ') })), rows: 1, top: 0, height: 48 });
    if (project.overlays?.length) lanes.push({ id: 'overlays', name: 'Comparse', items: project.overlays.map((overlay) => ({ id: overlay.id, kind: 'overlay', start: overlay.start, end: overlay.end, text: overlay.text || assets.get(overlay.assetId ?? '')?.name || 'Logo' })), rows: 1, top: 0, height: 48 });
    let top = nativeLanesEnd;
    for (const lane of lanes) {
      const ends: number[] = [];
      for (const item of [...lane.items].sort((first, second) => first.start - second.start || first.end - second.end)) {
        const row = ends.findIndex((end) => end + 4 / pixelsPerSecond <= item.start);
        item.row = row < 0 ? ends.length : row;
        ends[item.row] = item.end;
      }
      lane.rows = Math.max(1, ends.length); lane.height = 8 + lane.rows * 40; lane.top = top; top += lane.height;
    }
    return lanes;
  }, [project.music, project.overlays, subtitleBlocks, assets, duration, nativeLanesEnd, pixelsPerSecond]);
  const canvasHeight = (effectLanes.at(-1) ? effectLanes.at(-1)!.top + effectLanes.at(-1)!.height : nativeLanesEnd) + 22;
  const audioEnd = Math.max(0, ...project.audioTracks.map((track) => track.start + track.out - track.in));
  const canvasWidth = Math.max(viewport.width, GUTTER + Math.max(duration, audioEnd, effectGesture?.end ?? 0, dragExtent) * pixelsPerSecond + 24);
  const interval = [.25, .5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400].find((step) => step * pixelsPerSecond >= 50) ?? 86400;
  const firstTick = Math.max(0, Math.floor((viewport.left - GUTTER - 80) / pixelsPerSecond / interval));
  const lastTick = Math.ceil(Math.min(86400, (viewport.left + viewport.width - GUTTER + 80) / pixelsPerSecond) / interval);
  const ticks = Array.from({ length: Math.max(0, lastTick - firstTick + 1) }, (_, index) => (firstTick + index) * interval);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setViewport({ left: node.scrollLeft, top: node.scrollTop, width: node.clientWidth, height: node.clientHeight }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const previous = followRef.current;
    followRef.current = { time, zoom: pixelsPerSecond, width: node.clientWidth };
    if (previous.zoom !== pixelsPerSecond) {
      const anchor = pendingZoomRef.current;
      pendingZoomRef.current = null;
      requestedZoomRef.current = pixelsPerSecond;
      if (anchor) node.scrollLeft = Math.max(0, GUTTER + anchor.time * pixelsPerSecond - anchor.x);
      else if (duration * pixelsPerSecond <= node.clientWidth - GUTTER - 24) node.scrollLeft = 0;
      else {
        const x = GUTTER + Math.max(1, node.clientWidth - GUTTER) / 2;
        const anchorTime = Math.max(0, (node.scrollLeft + x - GUTTER) / previous.zoom);
        node.scrollLeft = Math.max(0, GUTTER + anchorTime * pixelsPerSecond - x);
      }
      setViewport({ left: node.scrollLeft, top: node.scrollTop, width: node.clientWidth, height: node.clientHeight });
      return;
    }
    if (previous.time === time && previous.width === node.clientWidth || scrubRef.current || trimRef.current || effectGestureRef.current || autoScrollRef.current || nativeDragRef.current) return;
    const x = GUTTER + time * pixelsPerSecond;
    const usable = Math.max(1, node.clientWidth - GUTTER);
    const before = node.scrollLeft;
    if (x < node.scrollLeft + GUTTER + 8) node.scrollLeft = Math.max(0, x - GUTTER - usable * .2);
    else if (x > node.scrollLeft + node.clientWidth - 24) node.scrollLeft = Math.max(0, x - GUTTER - usable * .7);
    if (node.scrollLeft !== before) setViewport({ left: node.scrollLeft, top: node.scrollTop, width: node.clientWidth, height: node.clientHeight });
  });
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !zoomCallbackRef.current) return;
      event.preventDefault(); event.stopPropagation();
      const bounds = node.getBoundingClientRect();
      const x = Math.max(GUTTER, Math.min(node.clientWidth - 1, event.clientX - bounds.left));
      const anchorTime = Math.max(0, (node.scrollLeft + x - GUTTER) / scaleRef.current);
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1;
      const delta = Math.max(-240, Math.min(240, event.deltaY * unit));
      const next = Math.max(MIN_TIMELINE_ZOOM, Math.min(MAX_TIMELINE_ZOOM, requestedZoomRef.current * Math.exp(-delta * .0025)));
      if (next === requestedZoomRef.current) return;
      pendingZoomRef.current = { time: anchorTime, x }; requestedZoomRef.current = next;
      zoomCallbackRef.current(next);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => {
    const node = scrollRef.current;
    const lane = lanes.find((lane) => lane.track.id === selectedTrackId);
    if (!node || !lane) return;
    if (lane.top < node.scrollTop + 8) node.scrollTop = Math.max(0, lane.top - 30);
    else if (lane.top + lane.height > node.scrollTop + node.clientHeight - 8) node.scrollTop = Math.max(0, lane.top + lane.height - node.clientHeight + 8);
  }, [selectedTrackId, lanes]);
  useEffect(() => {
    const node = scrollRef.current;
    const lane = effectLanes.find((lane) => lane.items.some((item) => item.id === effectSelection));
    const item = lane?.items.find((item) => item.id === effectSelection);
    if (!node || !lane || !item || effectGestureRef.current) return;
    const previous = effectRevealRef.current;
    if (previous.id === effectSelection && previous.start === item.start && previous.end === item.end) return;
    effectRevealRef.current = { id: effectSelection, start: item.start, end: item.end };
    const top = lane.top + 8 + (item.row ?? 0) * 40;
    if (top < node.scrollTop) node.scrollTop = Math.max(0, top - 8);
    else if (top + 36 > node.scrollTop + node.clientHeight) node.scrollTop = top + 44 - node.clientHeight;
    const left = GUTTER + item.start * pixelsPerSecond;
    if (left < node.scrollLeft + GUTTER) node.scrollLeft = Math.max(0, left - GUTTER - 20);
    else if (left > node.scrollLeft + node.clientWidth - 30) node.scrollLeft = Math.max(0, left - node.clientWidth + 80);
  }, [effectSelection, effectLanes, pixelsPerSecond]);
  useEffect(() => {
    if (effectGestureRef.current && effectGestureRef.current.project !== project) { effectGestureRef.current = null; setEffectGesture(null); }
  }, [project]);
  useEffect(() => {
    if (!effectGesture) return;
    const cancel = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && effectGestureRef.current) { event.preventDefault(); event.stopPropagation(); cancelEffectGesture(); } };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [!!effectGesture]);
  useEffect(() => {
    if (!snappingEnabled) setSnapGuide(null);
    autoScrollRef.current?.update?.();
  }, [snappingEnabled]);
  useEffect(() => {
    const modifier = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Alt') return;
      altRef.current = event.type === 'keydown';
      if (altRef.current) setSnapGuide(null);
      autoScrollRef.current?.update?.();
    };
    window.addEventListener('keydown', modifier, true); window.addEventListener('keyup', modifier, true);
    return () => { window.removeEventListener('keydown', modifier, true); window.removeEventListener('keyup', modifier, true); };
  }, []);
  useEffect(() => {
    const end = () => stopAutoScroll();
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && nativeDragRef.current) stopAutoScroll(); };
    window.addEventListener('dragend', end, true);
    window.addEventListener('drop', end);
    window.addEventListener('blur', end);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('dragend', end, true); window.removeEventListener('drop', end); window.removeEventListener('blur', end); window.removeEventListener('keydown', escape, true);
      autoScrollRef.current = null;
      if (autoScrollFrameRef.current !== null) cancelAnimationFrame(autoScrollFrameRef.current);
    };
  }, []);

  function timeAt(clientX: number) {
    const node = scrollRef.current;
    if (!node) return 0;
    const bounds = node.getBoundingClientRect();
    const x = Math.max(GUTTER, Math.min(node.clientWidth, clientX - bounds.left - node.clientLeft));
    return Math.max(0, Math.min(86400, (node.scrollLeft + x - GUTTER) / scaleRef.current));
  }
  function stopAutoScroll() {
    autoScrollRef.current = null; nativeDragRef.current = null;
    if (autoScrollFrameRef.current !== null) cancelAnimationFrame(autoScrollFrameRef.current);
    autoScrollFrameRef.current = null;
    setDraggingId(null); setDropTrack(null); setDropIndicator(null); setDragExtent(0); setSnapGuide(null);
  }
  function startAutoScroll(x: number, y: number, update?: () => void, vertical = false, extend = true) {
    autoScrollRef.current = { x, y, update, vertical, extend };
    if (autoScrollFrameRef.current !== null) return;
    const tick = () => {
      const motion = autoScrollRef.current, node = scrollRef.current;
      if (!motion || !node) { autoScrollFrameRef.current = null; return; }
      const bounds = node.getBoundingClientRect();
      const speed = (value: number, minimum: number, maximum: number) => value < minimum + 32 ? -Math.min(20, Math.max(0, (minimum + 32 - value) * .45)) : value > maximum - 32 ? Math.min(20, Math.max(0, (value - maximum + 32) * .45)) : 0;
      const horizontal = speed(motion.x, bounds.left + GUTTER, bounds.left + node.clientWidth);
      const verticalSpeed = motion.vertical ? speed(motion.y, bounds.top + 30, bounds.top + node.clientHeight) : 0;
      if (horizontal > 0 && motion.extend && node.scrollLeft + node.clientWidth >= node.scrollWidth - 40) {
        const extent = Math.min(86400, (node.scrollLeft + node.clientWidth - GUTTER + node.clientWidth / 2) / scaleRef.current);
        setDragExtent((previous) => Math.max(previous, extent));
      }
      const left = node.scrollLeft, top = node.scrollTop;
      node.scrollLeft += horizontal; node.scrollTop += verticalSpeed;
      if (left !== node.scrollLeft || top !== node.scrollTop) {
        setViewport({ left: node.scrollLeft, top: node.scrollTop, width: node.clientWidth, height: node.clientHeight });
        motion.update?.();
      }
      if (autoScrollRef.current) autoScrollFrameRef.current = requestAnimationFrame(tick);
      else autoScrollFrameRef.current = null;
    };
    autoScrollFrameRef.current = requestAnimationFrame(tick);
  }
  function reportDropFailure(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setDropFailure(message); onDropError?.(message);
  }
  function snapTargets(excluded: string[] = []): TimelineSnapTarget[] {
    const skipped = new Set(excluded);
    return [{ time, label: 'Cursore' }, { time: 0, label: 'Inizio timeline' },
      ...entries.filter((entry) => !skipped.has(entry.clip.id)).flatMap((entry) => [{ time: entry.start, label: 'Inizio clip' }, { time: entry.end, label: 'Fine clip' }]),
      ...project.audioTracks.filter((track) => !skipped.has(track.id)).flatMap((track) => [{ time: track.start, label: 'Inizio audio' }, { time: track.start + track.out - track.in, label: 'Fine audio' }]),
      ...(project.overlays ?? []).filter((overlay) => !skipped.has(overlay.id)).flatMap((overlay) => [{ time: overlay.start, label: 'Inizio comparsa' }, { time: overlay.end, label: 'Fine comparsa' }]),
      ...subtitleBlocks.flatMap((block, index) => skipped.has(`subtitle:${index}`) || block.words.some((word) => word.source && skipped.has(word.source.id)) ? [] : [{ time: block.start, label: 'Inizio sottotitolo' }, { time: block.end, label: 'Fine sottotitolo' }]),
    ];
  }
  function snapEdges(anchors: number[], delta: number, excluded: string[] = [], bypass = false, minDelta = -Infinity, maxDelta = Infinity) {
    return snapTimelineDelta(anchors, delta, snapTargets(excluded), scaleRef.current, { enabled: magnetRef.current, bypass: bypass || altRef.current, minDelta, maxDelta });
  }
  function showSnap(result?: TimelineSnapResult) {
    const target = result?.target;
    setSnapGuide((previous) => previous?.time === target?.time && previous?.label === target?.label ? previous : target ?? null);
  }
  function snap(value: number, excluded: string[] = [], bypass = false) {
    return snapEdges([0], value, excluded, bypass, 0, 86400).delta;
  }
  function nativePlacement(item: DraggedItem, clientX: number) {
    const chosen = item.kind === 'clip' ? entries.filter((entry) => item.ids.includes(entry.clip.id)).flatMap((entry) => [entry.start, entry.end]) : project.audioTracks.filter((entry) => item.ids.includes(entry.id)).flatMap((entry) => [entry.start, entry.start + entry.out - entry.in]);
    const anchors = chosen.length ? chosen : [item.start];
    const requested = item.grabOffset === undefined ? (clientX - item.x) / scaleRef.current : timeAt(clientX) - item.grabOffset - item.start;
    const result = snapEdges(anchors, requested, item.ids, false, -Math.min(...anchors), 86400 - Math.max(...anchors));
    return { result, start: item.start + result.delta };
  }
  function selectClip(id: string, event?: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>) {
    setLocalEffectId(null);
    let values = [id];
    if ((event?.ctrlKey || event?.metaKey) && onSelectionChange) values = selection.includes(id) ? selection.filter((value) => value !== id) : [...selection, id];
    else if (event?.shiftKey && anchorRef.current && onSelectionChange) {
      const first = project.clips.findIndex((clip) => clip.id === anchorRef.current);
      const last = project.clips.findIndex((clip) => clip.id === id);
      values = project.clips.slice(Math.min(first, last), Math.max(first, last) + 1).map((clip) => clip.id);
    } else anchorRef.current = id;
    onSelect(id, 'clip'); onSelectionChange?.(values);
  }
  function scrubStart(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const focusTarget = event.currentTarget.tabIndex >= 0 ? event.currentTarget : canvasRef.current;
    focusTarget?.focus({ preventScroll: true });
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); scrubRef.current = true; onTimeChange(Math.min(duration, timeAt(event.clientX)));
    startAutoScroll(event.clientX, event.clientY, () => onTimeChange(Math.min(duration, timeAt(event.clientX))), false, false);
  }
  function scrubMove(event: PointerEvent<HTMLElement>) { if (event.currentTarget.hasPointerCapture(event.pointerId)) { onTimeChange(Math.min(duration, timeAt(event.clientX))); const x = event.clientX; startAutoScroll(x, event.clientY, () => onTimeChange(Math.min(duration, timeAt(x))), false, false); } }
  function scrubEnd(event: PointerEvent<HTMLElement>) {
    // Starting an HTML media drag cancels its pointer sequence. That cancellation
    // must not clear the separate native drag or its retained virtualized source.
    if (!scrubRef.current) return;
    scrubRef.current = false; stopAutoScroll();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function beginDrag(event: DragEvent<HTMLElement>, item: DraggedItem) {
    altRef.current = event.altKey; showSnap();
    const dragged = { ...item, grabOffset: timeAt(event.clientX) - item.start };
    nativeDragRef.current = dragged; setDraggingId(item.id);
    event.dataTransfer.setData('application/x-ducky-item', JSON.stringify(dragged)); event.dataTransfer.effectAllowed = 'move';
    if (item.kind === 'clip' && !selection.includes(item.id)) { onSelect(item.id, 'clip'); onSelectionChange?.([item.id]); onTimeChange(time); }
    else if (item.kind === 'audio' && selectedId !== item.id) { onSelect(item.id, 'audio'); onTimeChange(time); }
  }
  function insertion(item: DraggedItem, track: TimelineTrack, clientX: number, proposedStart?: number) {
    if (item.kind !== 'clip' || track.kind !== 'video' || item.trackId !== track.id) return null;
    const chosen = entries.filter((entry) => item.ids.includes(entry.clip.id));
    if (!chosen.length || chosen.some((entry) => entry.trackId !== track.id)) return null;
    const others = entries.filter((entry) => entry.trackId === track.id && !item.ids.includes(entry.clip.id)).sort((first, second) => first.start - second.start);
    const start = proposedStart ?? Math.max(0, timeAt(clientX) - (item.grabOffset ?? 0));
    const delta = start - item.start;
    const collision = chosen.some((entry) => others.some((candidate) => candidate.start < entry.end + delta - .000001 && candidate.end > entry.start + delta + .000001));
    if (!collision || item.ids.length > 1 && !onReorderGroup) return null;
    const found = others.findIndex((entry) => timeAt(clientX) < (entry.start + entry.end) / 2);
    const index = found < 0 ? others.length : found;
    return { index, time: others[index]?.start ?? others.at(-1)?.end ?? 0 };
  }
  function updateDropIndicator(track: TimelineTrack, clientX: number) {
    const item = nativeDragRef.current;
    const placement = item ? nativePlacement(item, clientX) : { result: snapEdges([0], timeAt(clientX), [], false, 0, 86400), start: 0 };
    const insert = item ? insertion(item, track, clientX, placement.start) : null;
    showSnap(insert ? undefined : placement.result);
    setDropIndicator({ trackId: track.id, time: insert?.time ?? (item ? placement.start : placement.result.delta), insert: !!insert });
  }
  function allowDrop(event: DragEvent<HTMLDivElement>, track: TimelineTrack) {
    if (!event.dataTransfer.types.some((type) => ['application/x-ducky-item', 'application/x-ducky-asset', 'application/x-ducky-assets', 'application/x-ducky-clip'].includes(type))) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = event.dataTransfer.types.includes('application/x-ducky-asset') || event.dataTransfer.types.includes('application/x-ducky-assets') ? 'copy' : 'move'; setDropTrack(track.id);
    altRef.current = event.altKey;
    const x = event.clientX;
    updateDropIndicator(track, x); startAutoScroll(x, event.clientY, () => updateDropIndicator(track, x), true);
  }
  function drop(event: DragEvent<HTMLDivElement>, track: TimelineTrack) {
    const raw = event.dataTransfer.getData('application/x-ducky-item');
    const bulk = event.dataTransfer.getData('application/x-ducky-assets');
    const assetId = event.dataTransfer.getData('application/x-ducky-asset');
    const oldClipId = event.dataTransfer.getData('application/x-ducky-clip');
    if (!raw && !bulk && !assetId && !oldClipId) return;
    event.preventDefault(); event.stopPropagation(); setDropFailure(null);
    altRef.current = event.altKey;
    const dropTime = timeAt(event.clientX);
    if (bulk) {
      let ids: string[];
      try { const parsed: unknown = JSON.parse(bulk); if (!Array.isArray(parsed) || !parsed.length || parsed.some((id) => typeof id !== 'string' || !assets.has(id))) throw new Error('La selezione dei file non è più disponibile.'); ids = [...new Set(parsed)]; }
      catch (error) { reportDropFailure(error); stopAutoScroll(); return; }
      try { if (!onDropAssets) throw new Error('L’importazione multipla non è disponibile in questa vista.'); onDropAssets(ids, track.id, snap(dropTime, [], event.altKey)); }
      catch (error) { reportDropFailure(error); }
      stopAutoScroll(); return;
    }
    if (assetId) {
      const asset = assets.get(assetId);
      if (!asset || track.kind === 'video' && asset.kind === 'audio' || track.kind === 'audio' && !asset.hasAudio && asset.kind !== 'audio') { stopAutoScroll(); return; }
      try { onDropAsset(assetId, undefined, track.id, snap(dropTime, [], event.altKey)); } catch (error) { reportDropFailure(error); }
      stopAutoScroll(); return;
    }
    let item: DraggedItem;
    try {
      const entry = entries.find((entry) => entry.clip.id === oldClipId);
      item = raw ? JSON.parse(raw) : { id: oldClipId, ids: [oldClipId], kind: 'clip', trackId: entry?.trackId ?? '', start: entry?.start ?? 0, x: event.clientX, grabOffset: 0 };
      if (!item || typeof item.id !== 'string' || !['clip', 'audio'].includes(item.kind) || !Array.isArray(item.ids) || !item.ids.length || item.ids.some((id) => typeof id !== 'string') || !Number.isFinite(item.start) || !Number.isFinite(item.x) || item.grabOffset !== undefined && !Number.isFinite(item.grabOffset)) throw new Error('Il trascinamento contiene dati non validi.');
      const existing = item.kind === 'clip' ? project.clips : project.audioTracks;
      if (!existing.some((entry) => entry.id === item.id) || item.ids.some((id) => !existing.some((entry) => entry.id === id))) throw new Error('La selezione sulla timeline è cambiata. Ripeti lo spostamento.');
    } catch (error) { reportDropFailure(error); stopAutoScroll(); return; }
    if (item.kind === 'clip' && track.kind !== 'video' || item.kind === 'audio' && track.kind !== 'audio') { stopAutoScroll(); return; }
    try {
      const placement = nativePlacement(item, event.clientX);
      const insert = insertion(item, track, event.clientX, placement.start);
      if (insert) {
        if (item.ids.length > 1) onReorderGroup?.(item.ids, insert.index);
        else props.onReorder(item.id, insert.index);
        stopAutoScroll(); return;
      }
      const start = placement.start;
      if (item.ids.length > 1 && item.kind === 'clip' && item.trackId === track.id && onMoveGroup) onMoveGroup(item.ids, start - item.start);
      else if (onMoveItem) onMoveItem(item.id, item.kind, track.id, start);
      else if (item.kind === 'audio') onAudioChange?.(item.id, { trackId: track.id, start });
      else onMoveGroup?.([item.id], start - item.start);
    } catch (error) { reportDropFailure(error); }
    stopAutoScroll();
  }

  function beginTrim(event: PointerEvent<HTMLSpanElement>, id: string, kind: 'clip' | 'audio', side: 'in' | 'out') {
    if (event.button !== 0) return;
    const clip = kind === 'clip' ? project.clips.find((clip) => clip.id === id) : undefined;
    const audio = kind === 'audio' ? project.audioTracks.find((track) => track.id === id) : undefined;
    const item = clip ?? audio;
    if (!item) return;
    const asset = assets.get(item.assetId);
    const start = audio?.start ?? entries.find((entry) => entry.clip.id === id)?.start ?? 0;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(id, kind); if (kind === 'clip') onSelectionChange?.([id]);
    const gesture: TrimGesture = { id, kind, side, x: event.clientX, grabTime: timeAt(event.clientX), in: item.in, out: item.out, start, speed: clip?.speed ?? 1, sourceDuration: asset?.kind === 'image' ? 86400 : asset?.duration ?? item.out, nextIn: item.in, nextOut: item.out, nextStart: start };
    trimRef.current = gesture; setTrim(gesture);
    altRef.current = event.altKey; showSnap();
    const x = event.clientX;
    startAutoScroll(x, event.clientY, () => applyTrimPointer(x));
  }
  function moveTrim(event: PointerEvent<HTMLSpanElement>) {
    const initial = trimRef.current;
    if (!initial || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault(); event.stopPropagation();
    const x = event.clientX; altRef.current = event.altKey;
    applyTrimPointer(x); startAutoScroll(x, event.clientY, () => applyTrimPointer(x));
  }
  function applyTrimPointer(clientX: number) {
    const initial = trimRef.current;
    if (!initial) return;
    const next = { ...initial };
    const delta = timeAt(clientX) - initial.grabTime;
    const minimum = .04 * initial.speed;
    let alignment: TimelineSnapResult;
    if (initial.side === 'in') {
      const lower = Math.max(-initial.in / initial.speed, initial.kind === 'audio' ? -initial.start : -Infinity);
      const upper = (initial.out - initial.in - minimum) / initial.speed;
      // Audio's left edge moves; video trim keeps its start and ripples its end.
      const edge = initial.kind === 'audio' ? initial.start : initial.start + (initial.out - initial.in) / initial.speed;
      alignment = initial.kind === 'audio' ? snapEdges([edge], delta, [initial.id], false, lower, upper) : snapEdges([edge], -delta, [initial.id], false, -upper, -lower);
      const actual = initial.kind === 'audio' ? alignment.delta : -alignment.delta;
      next.nextIn = initial.in + actual * initial.speed;
      next.nextStart = initial.kind === 'audio' ? initial.start + actual : initial.start;
    } else {
      const edge = initial.start + (initial.out - initial.in) / initial.speed;
      alignment = snapEdges([edge], delta, [initial.id], false, (initial.in + minimum - initial.out) / initial.speed, (initial.sourceDuration - initial.out) / initial.speed);
      const end = edge + alignment.delta;
      next.nextOut = Math.max(initial.in + minimum, Math.min(initial.sourceDuration, initial.in + (end - initial.start) * initial.speed));
    }
    showSnap(alignment);
    trimRef.current = next; setTrim(next);
  }
  function endTrim(event: PointerEvent<HTMLSpanElement>) {
    const gesture = trimRef.current;
    if (!gesture) return;
    event.stopPropagation(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (gesture.kind === 'clip') onTrim(gesture.id, gesture.nextIn, gesture.nextOut);
    else onAudioChange?.(gesture.id, { in: gesture.nextIn, out: gesture.nextOut, start: gesture.nextStart });
    trimRef.current = null; setTrim(null); stopAutoScroll();
  }
  function trimHandles(id: string, kind: 'clip' | 'audio', inPoint: number, outPoint: number, max: number, selected: boolean) {
    return (['in', 'out'] as const).map((side) => <span key={side} role="slider" tabIndex={selected ? 0 : -1} aria-label={`${side === 'in' ? 'Taglia inizio' : 'Taglia fine'} ${kind === 'audio' ? 'audio' : 'clip'}`} aria-valuenow={side === 'in' ? inPoint : outPoint} aria-valuemin={0} aria-valuemax={max} className={`trim-handle ${side === 'in' ? 'left' : 'right'}`} draggable={false} onClick={(event) => event.stopPropagation()} onPointerDown={(event) => beginTrim(event, id, kind, side)} onPointerMove={moveTrim} onPointerUp={endTrim} onPointerCancel={() => { trimRef.current = null; setTrim(null); stopAutoScroll(); }} onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const delta = (event.key === 'ArrowLeft' ? -1 : 1) / 30;
      const speed = kind === 'clip' ? project.clips.find((clip) => clip.id === id)?.speed ?? 1 : 1;
      const input = side === 'in' ? Math.max(0, Math.min(outPoint - .04 * speed, inPoint + delta * speed)) : inPoint;
      const output = side === 'out' ? Math.max(inPoint + .04 * speed, Math.min(max, outPoint + delta * speed)) : outPoint;
      if (kind === 'clip') onTrim(id, input, output); else onAudioChange?.(id, { in: input, out: output });
    }}><GripVertical size={10} /></span>);
  }

  function selectEffect(item: EffectItem, seek = false) {
    setLocalEffectId(item.id);
    if (seek) onTimeChange(item.start);
    if (item.kind === 'subtitle') onSelectSubtitle?.(item.index!);
    else onSelectOverlay?.(item.id);
  }
  function effectEditable(item: EffectItem) { return item.kind === 'overlay' ? !!onOverlayChange : item.kind === 'subtitle' && !!onSubtitleChange; }
  function cancelEffectGesture() {
    effectGestureRef.current = null; setEffectGesture(null);
    stopAutoScroll();
    const capture = effectCaptureRef.current;
    effectCaptureRef.current = null;
    if (capture?.element.hasPointerCapture(capture.pointerId)) capture.element.releasePointerCapture(capture.pointerId);
  }
  function commitEffectGesture() {
    const gesture = effectGestureRef.current;
    if (!gesture) return;
    cancelEffectGesture();
    if (gesture.start === gesture.item.start && gesture.end === gesture.item.end) return;
    if (gesture.item.kind === 'subtitle') onSubtitleChange?.(gesture.item.index!, { start: gesture.start, end: gesture.end });
    else onOverlayChange?.(gesture.item.id, { start: gesture.start, end: gesture.end });
    onTimeChange(gesture.start);
  }
  function effectDraft(gesture: EffectGesture, delta: number, bypass = false): EffectGesture {
    const minimum = 1 / 30;
    const item = gesture.item;
    let start = item.start, end = item.end;
    let alignment: TimelineSnapResult;
    if (gesture.mode === 'move') {
      const length = item.end - item.start;
      alignment = snapEdges([item.start, item.end], delta, [item.id], bypass, -item.start, 86400 - item.end);
      start = item.start + alignment.delta;
      end = start + length;
    } else if (gesture.mode === 'start') {
      alignment = snapEdges([item.start], delta, [item.id], bypass, -item.start, item.end - minimum - item.start);
      start = item.start + alignment.delta;
    } else {
      alignment = snapEdges([item.end], delta, [item.id], bypass, item.start + minimum - item.end, 86400 - item.end);
      end = item.end + alignment.delta;
    }
    showSnap(alignment);
    return { ...gesture, start, end, snap: alignment.target?.time };
  }
  function startEffectGesture(event: PointerEvent<HTMLElement>, item: EffectItem, mode: EffectGesture['mode']) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
    selectEffect(item, true);
    if (!effectEditable(item)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    effectCaptureRef.current = { element: event.currentTarget, pointerId: event.pointerId };
    const gesture: EffectGesture = { item, mode, source: 'pointer', x: event.clientX, scroll: scrollRef.current?.scrollLeft ?? 0, grabTime: timeAt(event.clientX), start: item.start, end: item.end, project };
    effectGestureRef.current = gesture; setEffectGesture(gesture);
    altRef.current = event.altKey; showSnap();
    const x = event.clientX;
    startAutoScroll(x, event.clientY, () => applyEffectPointer(x));
  }
  function moveEffectGesture(event: PointerEvent<HTMLElement>) {
    const gesture = effectGestureRef.current;
    if (!gesture || gesture.source !== 'pointer' || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault(); event.stopPropagation();
    const x = event.clientX; altRef.current = event.altKey;
    applyEffectPointer(x); startAutoScroll(x, event.clientY, () => applyEffectPointer(x));
  }
  function applyEffectPointer(clientX: number) {
    const gesture = effectGestureRef.current;
    if (!gesture || gesture.source !== 'pointer') return;
    const delta = gesture.grabTime === undefined ? 0 : timeAt(clientX) - gesture.grabTime;
    const next = effectDraft(gesture, delta);
    effectGestureRef.current = next; setEffectGesture(next);
  }
  function endEffectGesture(event: PointerEvent<HTMLElement>) {
    if (!effectGestureRef.current || effectGestureRef.current.source !== 'pointer') return;
    event.stopPropagation();
    commitEffectGesture();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function effectKeyDown(event: KeyboardEvent<HTMLElement>, item: EffectItem, mode: EffectGesture['mode'] = 'move') {
    if (event.key === 'Escape' && effectGestureRef.current) { event.preventDefault(); event.stopPropagation(); cancelEffectGesture(); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && item.kind !== 'music' && onDeleteEffect) { event.preventDefault(); event.stopPropagation(); cancelEffectGesture(); onDeleteEffect(item.id); return; }
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); selectEffect(item, true); return; }
    if (event.key === ' ') return;
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || event.ctrlKey || event.metaKey || !effectEditable(item)) return;
    event.preventDefault(); event.stopPropagation(); selectEffect(item);
    let gesture = effectGestureRef.current;
    if (!gesture || gesture.item.id !== item.id || gesture.mode !== mode || gesture.source !== 'keyboard') gesture = { item, mode, source: 'keyboard', x: 0, scroll: 0, start: item.start, end: item.end, project };
    const current = mode === 'end' ? gesture.end - item.end : gesture.start - item.start;
    const delta = current + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 1 / 30);
    const next = effectDraft(gesture, delta, true);
    effectGestureRef.current = next; setEffectGesture(next);
  }
  function effectKeyUp(event: KeyboardEvent<HTMLElement>) {
    if (['ArrowLeft', 'ArrowRight'].includes(event.key) && effectGestureRef.current?.source === 'keyboard') { event.preventDefault(); event.stopPropagation(); commitEffectGesture(); }
  }

  return <div className="timeline-tracks-shell" onKeyDownCapture={(event) => {
    if (event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) return;
    const node = scrollRef.current;
    if (node && event.key === 'Home') node.scrollLeft = 0;
    if (node && event.key === 'End') node.scrollLeft = node.scrollWidth;
  }}>
    {dropFailure && !onDropError && <div className="timeline-drop-error" role="alert"><span>{dropFailure}</span><button type="button" aria-label="Chiudi messaggio timeline" onClick={() => setDropFailure(null)}>×</button></div>}
    <div className="timeline-tracks-bar"><button className="secondary-button" aria-label="Aggiungi traccia video" onClick={() => onAddTrack?.('video')} disabled={!onAddTrack}><Plus size={14} /><Film size={14} /> Traccia video</button><button className="secondary-button" aria-label="Aggiungi traccia audio" onClick={() => onAddTrack?.('audio')} disabled={!onAddTrack}><Plus size={14} /><Music2 size={14} /> Traccia audio</button><span>Trascina le clip tra le tracce · Ctrl/Shift per selezionare più clip</span></div>
    <div className="timeline-scroll" ref={scrollRef} onDragLeave={(event) => { if (dragLeftContainer(event)) stopAutoScroll(); }} onScroll={(event) => { const node = event.currentTarget; setViewport({ left: node.scrollLeft, top: node.scrollTop, width: node.clientWidth, height: node.clientHeight }); }}>
      <div className="timeline-canvas" ref={canvasRef} data-timeline-gutter={GUTTER} tabIndex={-1} style={{ width: canvasWidth, minWidth: '100%', height: canvasHeight, position: 'relative' }}>
        <div className="timeline-ruler" tabIndex={0} role="slider" aria-label="Cursore della timeline" aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={time} aria-valuetext={`${time.toFixed(2)} secondi`} style={{ height: 30, position: 'sticky', top: 0, zIndex: 8, touchAction: 'none' }} onPointerDown={scrubStart} onPointerMove={scrubMove} onPointerUp={scrubEnd} onPointerCancel={scrubEnd}>
          <span className="timeline-gutter-label" style={{ width: GUTTER, zIndex: 3 }} onPointerDown={(event) => event.stopPropagation()}>TEMPO</span>
          <div className="timeline-ruler-ticks" style={{ position: 'absolute', inset: 0, clipPath: `inset(0 0 0 ${viewport.left + GUTTER}px)`, pointerEvents: 'none' }}>{ticks.map((tick) => <span key={tick} className="timeline-tick" style={{ position: 'absolute', left: GUTTER + tick * pixelsPerSecond }}>{interval < 1 ? `${formatDuration(tick)}.${Math.round((tick % 1) * 100).toString().padStart(2, '0')}` : formatDuration(tick)}</span>)}</div>
          <div className="timeline-ruler-playhead" style={{ position: 'absolute', left: GUTTER + time * pixelsPerSecond, top: 0, height: 30, width: 1, visibility: GUTTER + time * pixelsPerSecond - viewport.left >= GUTTER && GUTTER + time * pixelsPerSecond - viewport.left <= viewport.width ? 'visible' : 'hidden', pointerEvents: 'none' }}><div className="timeline-playhead-head" /></div>
        </div>
        {lanes.map(({ track, top, height }) => {
          const videoItems = track.kind === 'video' ? entries.filter((entry) => entry.trackId === track.id) : [];
          const audioItems = track.kind === 'audio' ? project.audioTracks.filter((item) => (item.trackId ?? getAudioTrackId(project, item.id)) === track.id) : [];
          const empty = !videoItems.length && !audioItems.length;
          return <div key={track.id} className={`timeline-track-lane ${track.kind === 'video' ? 'timeline-video-lane' : 'timeline-audio-lane'}${dropTrack === track.id ? ' drop-target' : ''}${track.hidden ? ' track-hidden' : ''}${selectedTrackId === track.id ? ' track-selected' : ''}`} data-track-id={track.id} data-track-kind={track.kind} style={{ position: 'absolute', top, left: 0, right: 0, height }} onDragOver={(event) => allowDrop(event, track)} onDragLeave={(event) => { if (dragLeftContainer(event)) { setDropTrack(null); setDropIndicator(null); } }} onDrop={(event) => drop(event, track)} onPointerDown={(event) => { if (event.target === event.currentTarget) { onSelectTrack?.(track.id); scrubStart(event); } }} onPointerMove={scrubMove} onPointerUp={scrubEnd} onPointerCancel={scrubEnd}>
            {(draggingId || dropTrack) && <div className="timeline-native-drop-surface" aria-hidden="true" style={{ left: GUTTER }} />}
            <div className="timeline-track-header" style={{ width: GUTTER }} onClick={() => onSelectTrack?.(track.id)} onFocusCapture={() => onSelectTrack?.(track.id)}>
              <div className="track-name-row">{track.kind === 'video' ? <Film size={14} /> : <Music2 size={14} />}<input aria-label={`Nome traccia ${track.name}`} title="Doppio clic o F2 per rinominare" readOnly={editingTrack !== track.id} onDoubleClick={() => setEditingTrack(track.id)} key={`${track.id}:${track.name}`} defaultValue={track.name} maxLength={80} onBlur={(event) => { const name = event.target.value.trim() || track.name; if (name !== track.name) onTrackChange?.(track.id, { name }); setEditingTrack(null); }} onKeyDown={(event) => { if (event.key === 'F2') { event.preventDefault(); setEditingTrack(track.id); event.currentTarget.select(); } if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { event.currentTarget.value = track.name; event.currentTarget.blur(); } event.stopPropagation(); }} /></div>
              <div className="track-actions"><button type="button" aria-label={`${track.muted ? 'Attiva' : 'Disattiva'} audio ${track.name}`} aria-pressed={track.muted} title={track.muted ? 'Riattiva audio della traccia' : 'Disattiva audio della traccia'} onClick={() => onTrackChange?.(track.id, { muted: !track.muted })}>{track.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>{track.kind === 'video' && <button type="button" aria-label={`${track.hidden ? 'Mostra' : 'Nascondi'} ${track.name}`} aria-pressed={!!track.hidden} title={track.hidden ? 'Mostra traccia video' : 'Nascondi traccia video'} onClick={() => onTrackChange?.(track.id, { hidden: !track.hidden })}>{track.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>}<button type="button" aria-label={`Elimina traccia vuota ${track.name}`} title={empty ? 'Elimina traccia vuota' : 'Sposta o rimuovi le clip prima di eliminare la traccia'} disabled={!empty || !onRemoveTrack} onClick={() => onRemoveTrack?.(track.id)}><Trash2 size={13} /></button></div>
            </div>
            {empty && <div className="timeline-empty-track" style={{ left: GUTTER + 20 }}>{track.kind === 'video' ? 'Trascina qui video o foto' : 'Trascina qui un audio o un video dalla libreria'}</div>}
            {videoItems.filter((entry) => entry.clip.id === draggingId || GUTTER + entry.end * pixelsPerSecond >= viewport.left - 80 && GUTTER + entry.start * pixelsPerSecond <= viewport.left + viewport.width + 80).map(({ clip, start, end }) => {
              const asset = assets.get(clip.assetId);
              const preview = trim?.id === clip.id ? trim : null;
              const input = preview?.nextIn ?? clip.in, output = preview?.nextOut ?? clip.out;
              const shownDuration = (output - input) / clip.speed;
              const selected = selection.includes(clip.id);
              return <div key={clip.id} role="button" tabIndex={0} aria-pressed={selected} aria-label={`${asset?.name ?? 'Clip'}, ${formatDuration(shownDuration)}${selected ? ', selezionato' : ''}`} className={`timeline-clip timeline-track-item${selected ? ' selected' : ''}${asset?.missing ? ' missing' : ''}`} data-item-id={clip.id} style={{ position: 'absolute', left: GUTTER + start * pixelsPerSecond, width: Math.max(2, shownDuration * pixelsPerSecond), top: 12, height: 76, opacity: track.hidden ? .45 : 1 }} draggable={!trim} onDragStart={(event) => beginDrag(event, { id: clip.id, ids: selection.includes(clip.id) ? selection : [clip.id], kind: 'clip', trackId: track.id, start, x: event.clientX })} onDragEnd={stopAutoScroll} onClick={(event) => { event.stopPropagation(); selectClip(clip.id, event); onTimeChange(Math.min(end - .001, Math.max(start, timeAt(event.clientX)))); }} onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); selectClip(clip.id); onTimeChange(start); }
                if ((event.key === 'Delete' || event.key === 'Backspace') && onDeleteSelection) { event.preventDefault(); event.stopPropagation(); onDeleteSelection(selection.includes(clip.id) ? selection : [clip.id]); }
                if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key) && onMoveGroup) { event.preventDefault(); event.stopPropagation(); onMoveGroup(selection.includes(clip.id) ? selection : [clip.id], (event.key === 'ArrowLeft' ? -1 : 1) / 30); }
              }}><div className="clip-filmstrip" style={{ position: 'absolute', inset: 0, backgroundImage: asset?.thumbnail ? `url("${asset.thumbnail}")` : undefined, backgroundRepeat: 'repeat-x', backgroundSize: 'auto 100%' }} /><div className="clip-label"><span>{asset?.name ?? 'File non disponibile'}</span>{(clip.muted || track.muted) && <VolumeX size={12} />}</div>{asset?.hasAudio && !clip.muted && !track.muted && shownDuration * pixelsPerSecond > 30 && <Waveform samples={asset.waveform} />}{clip.title && <span className="clip-title-tag"><Type size={12} />{clip.title.text}</span>}{trimHandles(clip.id, 'clip', input, output, asset?.kind === 'image' ? 86400 : asset?.duration ?? output, selected)}</div>;
            })}
            {audioItems.filter((item) => item.id === draggingId || GUTTER + (item.start + item.out - item.in) * pixelsPerSecond >= viewport.left - 80 && GUTTER + item.start * pixelsPerSecond <= viewport.left + viewport.width + 80).map((original) => {
              const preview = trim?.id === original.id ? trim : null;
              const item = preview ? { ...original, in: preview.nextIn, out: preview.nextOut, start: preview.nextStart } : original;
              const asset = assets.get(item.assetId), selected = selectedId === item.id;
              return <button key={item.id} className={`timeline-audio-clip timeline-track-item${selected ? ' selected' : ''}`} data-item-id={item.id} style={{ position: 'absolute', left: GUTTER + item.start * pixelsPerSecond, width: Math.max(8, (item.out - item.in) * pixelsPerSecond), top: 10, height: 46, opacity: track.muted ? .45 : 1 }} aria-label={`${asset?.name ?? 'Audio'}, ${formatDuration(item.out - item.in)}`} aria-pressed={selected} draggable={!trim} onDragStart={(event) => beginDrag(event, { id: item.id, ids: [item.id], kind: 'audio', trackId: track.id, start: item.start, x: event.clientX })} onDragEnd={stopAutoScroll} onClick={(event) => { event.stopPropagation(); onSelect(item.id, 'audio'); onTimeChange(Math.min(duration, Math.max(item.start, timeAt(event.clientX)))); }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b' && onAudioSplit) { event.preventDefault(); event.stopPropagation(); onAudioSplit(item.id, time); } }}><span className="audio-clip-name"><Music2 size={12} />{asset?.name ?? 'Audio'}</span><Waveform samples={asset?.waveform} />{trimHandles(item.id, 'audio', item.in, item.out, asset?.duration ?? item.out, selected)}</button>;
            })}
          </div>;
        })}
        {effectLanes.map((lane) => <div key={lane.id} className={`timeline-effect-lane timeline-${lane.id}-lane`} style={{ position: 'absolute', top: lane.top, left: 0, right: 0, height: lane.height }}>
          <div className="timeline-track-header effect-track-header" style={{ width: GUTTER }}><Type size={13} /><span>{lane.name}{lane.rows > 1 && <small>{lane.rows} righe</small>}</span></div>
          {lane.items.filter((item) => item.id === effectGesture?.item.id || GUTTER + item.end * pixelsPerSecond >= viewport.left && GUTTER + item.start * pixelsPerSecond <= viewport.left + viewport.width).map((item) => {
            const draft = effectGesture?.item.id === item.id ? effectGesture : null;
            const start = draft?.start ?? item.start, end = draft?.end ?? item.end;
            const selected = effectSelection === item.id;
            const label = item.kind === 'subtitle' ? `Sottotitolo ${item.index! + 1}` : item.kind === 'overlay' ? 'Comparsa' : 'Musica';
            return <button key={item.id} type="button" data-effect-id={item.id} data-effect-kind={item.kind} className={`timeline-audio-clip timeline-effect-item${selected ? ' selected' : ''}${draft ? ' gesturing' : ''}`} style={{ left: GUTTER + start * pixelsPerSecond, width: Math.max(14, (end - start) * pixelsPerSecond), top: 8 + (item.row ?? 0) * 40, zIndex: draft ? 4 : 1 }} title={`${item.text}\n${start.toFixed(2)}–${end.toFixed(2)} s · Trascina per spostare, usa i bordi per ritagliare`} aria-label={`${label} ${item.text}`} aria-pressed={selected} draggable={false} onFocus={() => selectEffect(item)} onClick={() => selectEffect(item)} onPointerDown={(event) => startEffectGesture(event, item, 'move')} onPointerMove={moveEffectGesture} onPointerUp={endEffectGesture} onPointerCancel={cancelEffectGesture} onKeyDown={(event) => effectKeyDown(event, item)} onKeyUp={effectKeyUp} onBlur={() => { if (effectGestureRef.current?.source === 'keyboard') commitEffectGesture(); }}>
              <span className="effect-item-name">{item.text}</span>
              {draft && <span className="effect-gesture-readout">{start.toFixed(2)}–{end.toFixed(2)} s</span>}
              {effectEditable(item) && (['start', 'end'] as const).map((edge) => <span key={edge} role="slider" tabIndex={selected ? 0 : -1} data-effect-edge={edge} className={`effect-trim-handle ${edge}`} aria-label={`Taglia ${edge === 'start' ? 'inizio' : 'fine'} ${item.kind === 'subtitle' ? 'sottotitolo' : 'comparsa'}`} aria-orientation="horizontal" aria-valuenow={edge === 'start' ? start : end} aria-valuemin={edge === 'start' ? 0 : start + 1 / 30} aria-valuemax={edge === 'start' ? end - 1 / 30 : 86400} aria-valuetext={`${(edge === 'start' ? start : end).toFixed(2)} secondi`} onClick={(event) => event.stopPropagation()} onFocus={() => selectEffect(item)} onPointerDown={(event) => startEffectGesture(event, item, edge)} onPointerMove={moveEffectGesture} onPointerUp={endEffectGesture} onPointerCancel={cancelEffectGesture} onKeyDown={(event) => effectKeyDown(event, item, edge)} onKeyUp={effectKeyUp} onBlur={() => { if (effectGestureRef.current?.source === 'keyboard') commitEffectGesture(); }}><GripVertical size={9} /></span>)}
            </button>;
          })}
        </div>)}
        {dropIndicator && lanes.find((lane) => lane.track.id === dropIndicator.trackId) && (() => { const lane = lanes.find((lane) => lane.track.id === dropIndicator.trackId)!; return <div className={`timeline-placement-indicator${dropIndicator.insert ? ' inserting' : ''}`} style={{ position: 'absolute', left: GUTTER + dropIndicator.time * pixelsPerSecond, top: lane.top, height: lane.height, visibility: GUTTER + dropIndicator.time * pixelsPerSecond - viewport.left >= GUTTER ? 'visible' : 'hidden' }}><span>{dropIndicator.insert ? 'Inserisci qui' : `${dropIndicator.time.toFixed(2)} s`}</span></div>; })()}
        {snapGuide && snappingEnabled && <div className="timeline-snap-guide" data-snap-time={snapGuide.time} style={{ left: GUTTER + snapGuide.time * pixelsPerSecond, visibility: GUTTER + snapGuide.time * pixelsPerSecond - viewport.left >= GUTTER && GUTTER + snapGuide.time * pixelsPerSecond - viewport.left <= viewport.width ? 'visible' : 'hidden' }}><span className={`timeline-snap-label${GUTTER + snapGuide.time * pixelsPerSecond - viewport.left > viewport.width - 200 ? ' align-left' : ''}`} role="status" aria-live="polite" aria-atomic="true">Aggancio · {snapGuide.label} · {snapGuide.time.toFixed(2)} s</span></div>}
        <div className="timeline-playhead" style={{ position: 'absolute', left: GUTTER + time * pixelsPerSecond, top: 30, bottom: 12, pointerEvents: 'none', zIndex: 5, visibility: GUTTER + time * pixelsPerSecond - viewport.left >= GUTTER && GUTTER + time * pixelsPerSecond - viewport.left <= viewport.width ? 'visible' : 'hidden' }} />
      </div>
    </div>
  </div>;
}

