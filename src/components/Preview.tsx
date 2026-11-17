import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ImageOff } from 'lucide-react';
import type { AudioTrack, Project, VideoClip } from '../../shared/types';
import { clipDuration, filterCss, getAudioTrackId, getProjectTracks, projectDuration, timelinePositions } from '../model';
import { captionBlocks, drawProjectEffects, type EffectHitbox } from '../render-effects';

export interface PreviewProps {
  project: Project;
  time: number;
  playing: boolean;
  onTimeChange: (time: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onError?: (message: string) => void;
  onChange?: (project: Project) => void;
  onSelectOverlay?: (id: string) => void;
  selectedOverlayId?: string;
  onDeleteOverlay?: (id: string) => void;
}

function envelope(
  position: number,
  duration: number,
  fadeIn: number,
  fadeOut: number,
) {
  const incoming = fadeIn > 0 ? Math.min(1, Math.max(0, position / fadeIn)) : 1;
  const outgoing =
    fadeOut > 0 ? Math.min(1, Math.max(0, (duration - position) / fadeOut)) : 1;
  return Math.min(incoming, outgoing);
}

function mediaVolume(value: number) {
  return Math.min(1, Math.max(0, value));
}

function wrappedTitle(text: string, length: number) {
  return text
    .split('\n')
    .flatMap((line) => {
      if (line.length <= length) return [line];
      const lines: string[] = [];
      let current = '';
      for (const word of line.split(/\s+/)) {
        if (current && current.length + word.length + 1 > length) {
          lines.push(current);
          current = '';
        }
        let remainder = word;
        while (remainder.length > length) {
          if (current) {
            lines.push(current);
            current = '';
          }
          lines.push(remainder.slice(0, length));
          remainder = remainder.slice(length);
        }
        current += `${current ? ' ' : ''}${remainder}`;
      }
      if (current) lines.push(current);
      return lines;
    })
    .join('\n');
}

export function Preview(props: PreviewProps) {
  const {
  project,
  time,
  playing,
  onTimeChange,
  onPlayingChange,
  onError,
  onChange,
  onSelectOverlay,
  selectedOverlayId,
  onDeleteOverlay,
  } = props;
  const stageRef = useRef<HTMLDivElement>(null);
  const videoPoolRef = useRef(new Map<string, HTMLVideoElement>());
  const bufferingRef = useRef(new Set<string>());
  const failedClipsRef = useRef(new Set<string>());
  const compositeRef = useRef<HTMLCanvasElement>(null);
  const effectsRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef(new Map<string, HTMLImageElement>());
  const layersRef = useRef<HTMLCanvasElement[]>([]);
  const boxesRef = useRef<EffectHitbox[]>([]);
  const gestureRef = useRef<{ box: EffectHitbox; x: number; y: number; mode: 'move' | 'size' | 'width'; source: 'pointer' | 'keyboard'; original: Project; latest: Project } | null>(null);
  const captureRef = useRef<{ element: HTMLCanvasElement; pointerId: number } | null>(null);
  const [gestureProject, setGestureProject] = useState<Project | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const selection = Object.prototype.hasOwnProperty.call(props, 'selectedOverlayId') ? selectedOverlayId : localSelection;
  const selectedBoxId = selection?.startsWith('subtitle:') ? 'subtitles' : selection;
  const [mediaVersion, setMediaVersion] = useState(0);
  const warmthId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const failedAudioRef = useRef(new Set<string>());
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef(new WeakMap<HTMLMediaElement, { node: AnalyserNode; samples: Uint8Array<ArrayBuffer> }>());
  const duckGainRef = useRef(1);
  const previousSoundTimeRef = useRef(time);
  const readyRef = useRef(false);
  const sentTimeRef = useRef(time);
  const positionRef = useRef(time);
  const lastFrameRef = useRef(0);
  const callbacksRef = useRef({ onTimeChange, onPlayingChange, onError });
  const latestRef = useRef({ project, time, playing });
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  callbacksRef.current = { onTimeChange, onPlayingChange, onError };
  latestRef.current = { project, time, playing };

  const shownProject = gestureProject ?? project;
  useEffect(() => {
    if (gestureRef.current && gestureRef.current.original !== project) cancelGesture();
  }, [project]);
  useEffect(() => {
    if (!gestureProject) return;
    const cancel = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && gestureRef.current) { event.preventDefault(); event.stopPropagation(); cancelGesture(); } };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [!!gestureProject]);
  const duration = projectDuration(project);
  const entries = useMemo(() => timelinePositions(project), [project]);
  const tracks = useMemo(() => getProjectTracks(project), [project]);
  const trackById = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);
  const assetById = useMemo(() => new Map(project.assets.map((asset) => [asset.id, asset])), [project.assets]);
  const activeEntries = entries.filter((entry) => time >= entry.start && (time < entry.end || !playing && time === duration && entry.end === duration));
  const visibleEntries = tracks.filter((track) => track.kind === 'video' && !track.hidden).map((track) => activeEntries.find((entry) => entry.trackId === track.id)).filter((entry): entry is NonNullable<typeof entry> => !!entry);
  const neededActiveEntries = activeEntries.filter((entry) => {
    const track = trackById.get(entry.trackId);
    const asset = assetById.get(entry.clip.assetId);
    return !track?.hidden || !!asset?.hasAudio && !track?.muted && !entry.clip.muted && entry.clip.volume > 0;
  });
  const incomingEntries = visibleEntries.flatMap((entry) => {
    const laneId = entry.trackId;
    const following = entries.find((candidate) => candidate.start >= entry.end - .001 && candidate.clip.id !== entry.clip.id && candidate.trackId === laneId);
    return following && following.start <= entry.end + .001 && following.clip.transition && following.clip.transition !== 'none' ? [following] : [];
  });
  const pooledEntries = [...new Map([...neededActiveEntries, ...incomingEntries].map((entry) => [entry.clip.id, entry])).values()];

  useEffect(() => {
    let active = true;
    for (const asset of project.assets.filter((item) => item.kind === 'image')) {
      const cached = imagesRef.current.get(asset.id);
      if (cached?.src === asset.url) { cached.onload = () => { if (active) setMediaVersion((value) => value + 1); }; continue; }
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => { if (active) setMediaVersion((value) => value + 1); };
      image.src = asset.url;
      imagesRef.current.set(asset.id, image);
    }
    return () => { active = false; };
  }, [project.assets]);

  useEffect(() => {
    failedAudioRef.current.clear();
    failedClipsRef.current.clear();
  }, [project.id, project.assets]);

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setStageSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || Math.abs(time - sentTimeRef.current) > 0.12) {
      positionRef.current = time;
      lastFrameRef.current = performance.now();
    }
  }, [time, playing]);

  useLayoutEffect(() => {
    const visualsReady = neededActiveEntries.every((entry) => {
      if (failedClipsRef.current.has(entry.clip.id)) return true;
      const asset = assetById.get(entry.clip.assetId);
      if (!asset || asset.missing) return false;
      if (asset.kind === 'image') { const image = imagesRef.current.get(asset.id); return !!image?.complete && image.naturalWidth > 0; }
      const video = videoPoolRef.current.get(entry.clip.id);
      return !!video && video.readyState >= 2 && !bufferingRef.current.has(entry.clip.id);
    });
    const audioReady = project.audioTracks.filter((item) => time >= item.start && time < item.start + item.out - item.in && !trackById.get((item.trackId ?? getAudioTrackId(project, item.id)))?.muted).every((item) => failedAudioRef.current.has(item.id) || (audioRefs.current.get(item.id)?.readyState ?? 0) >= 2);
    const music = project.music;
    const musicActive = music && time >= music.start && (music.loop || time < music.start + music.out - music.in - (music.phase ?? 0)) && time < duration;
    const musicReady = !musicActive || failedAudioRef.current.has('music') || (audioRefs.current.get('music')?.readyState ?? 0) >= 2;
    readyRef.current = visualsReady && audioReady && musicReady;
  });

  useEffect(() => {
    let missing = false;
    for (const entry of neededActiveEntries) {
      const asset = assetById.get(entry.clip.assetId);
      if ((!asset || asset.missing) && !failedClipsRef.current.has(entry.clip.id)) {
        failedClipsRef.current.add(entry.clip.id); missing = true;
        onError?.(`File originale non disponibile: ${asset?.name ?? entry.clip.assetId}`);
      }
    }
    for (const item of project.audioTracks) {
      if (time < item.start || time >= item.start + item.out - item.in) continue;
      const asset = assetById.get(item.assetId);
      if ((!asset || asset.missing) && !failedAudioRef.current.has(item.id)) { failedAudioRef.current.add(item.id); missing = true; onError?.(`File audio originale non disponibile: ${asset?.name ?? item.assetId}`); }
    }
    if (missing) { if (playing) onPlayingChange(false); setMediaVersion((value) => value + 1); }
  }, [project, time, playing]);

  useEffect(() => {
    if (!playing) return;
    positionRef.current = time;
    lastFrameRef.current = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const delta = Math.min(
        0.15,
        Math.max(0, (now - lastFrameRef.current) / 1000),
      );
      lastFrameRef.current = now;
      if (readyRef.current) {
        const end = projectDuration(latestRef.current.project);
        const next = Math.min(end, positionRef.current + delta);
        positionRef.current = next;
        sentTimeRef.current = next;
        callbacksRef.current.onTimeChange(next);
        if (next >= end) {
          callbacksRef.current.onPlayingChange(false);
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // The clock reads current callbacks and project through refs while props receive its output.
  }, [playing]);

  const syncVideo = () => {
    for (const [id, element] of videoPoolRef.current) {
      const entry = neededActiveEntries.find((entry) => entry.clip.id === id);
      const incoming = incomingEntries.find((entry) => entry.clip.id === id);
      if (!entry) {
        element.pause(); element.muted = true;
        if (incoming && element.readyState >= 1 && Math.abs(element.currentTime - incoming.clip.in) > .015) element.currentTime = incoming.clip.in;
        continue;
      }
      if (element.readyState < 1) continue;
      const track = trackById.get(entry.trackId);
      const position = Math.max(0, time - entry.start);
      const target = Math.min(entry.clip.out - .01, entry.clip.in + position * entry.clip.speed);
      if (Math.abs(element.currentTime - target) > (playing ? .2 : .015)) element.currentTime = Math.max(entry.clip.in, target);
      element.playbackRate = entry.clip.speed;
      element.muted = entry.clip.muted || !!track?.muted;
      element.volume = mediaVolume(element.muted ? 0 : entry.clip.volume * envelope(position, clipDuration(entry.clip), entry.clip.fadeIn, entry.clip.fadeOut));
      if (!playing || !readyRef.current || failedClipsRef.current.has(id)) element.pause();
      else if (element.paused && element.readyState >= 2) void element.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        callbacksRef.current.onPlayingChange(false); callbacksRef.current.onError?.('Impossibile avviare l’anteprima di questo video.');
      });
    }
  };

  useEffect(() => {
    syncVideo();
  }, [time, playing, project, mediaVersion]);

  useEffect(() => {
    const music = project.music;
    const context = audioContextRef.current;
    if (playing && context?.state === 'suspended') void context.resume();
    let audibleNarration = false;
    if (playing && music?.duck) {
      const narrationElements: HTMLMediaElement[] = [
        ...[...videoPoolRef.current.values()].filter((element) => !element.paused && !element.muted && element.volume > 0),
        ...project.audioTracks.map((track) => audioRefs.current.get(track.id)).filter((element): element is HTMLAudioElement => !!element && !element.paused),
      ];
      for (const element of narrationElements) {
        if (element.readyState < 2) continue;
        let analyser = analyserRef.current.get(element);
        if (!analyser) {
          try {
            const audioContext = audioContextRef.current ??= new AudioContext();
            void audioContext.resume();
            const source = audioContext.createMediaElementSource(element);
            const node = audioContext.createAnalyser();
            node.fftSize = 256;
            source.connect(node); node.connect(audioContext.destination);
            analyser = { node, samples: new Uint8Array(node.fftSize) };
            analyserRef.current.set(element, analyser);
          } catch { continue; }
        }
        analyser.node.getByteTimeDomainData(analyser.samples);
        const rms = Math.sqrt(analyser.samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / analyser.samples.length);
        if (rms > .012) audibleNarration = true;
      }
    }
    const targetDuck = audibleNarration ? .25 : 1;
    duckGainRef.current += (targetDuck - duckGainRef.current) * (audibleNarration ? .35 : .08);
    const syncAudio = (track: AudioTrack, element: HTMLAudioElement, loop = false, duck = false, phase = 0) => {
      if (failedAudioRef.current.has(track.id)) {
        element.pause();
        return;
      }
      const trackDuration = track.out - track.in;
      const elapsed = time - track.start;
      const position = loop ? (Math.max(0, elapsed) + phase) % trackDuration : elapsed + phase;
      const laneMuted = track.id !== 'music' && !!trackById.get((track.trackId ?? getAudioTrackId(project, track.id)))?.muted;
      const audible = !laneMuted && elapsed >= 0 && (loop || position < trackDuration) && time < duration;
      element.volume = audible
        ? mediaVolume(
            track.volume * (duck ? duckGainRef.current : 1) *
              envelope(position, trackDuration, track.fadeIn, track.fadeOut),
          )
        : 0;
      if (audible && element.readyState >= 1) {
        const target = Math.min(track.out - 0.015, track.in + position);
        if (Math.abs(element.currentTime - target) > (playing ? 0.2 : 0.015))
          element.currentTime = Math.max(0, target);
      }
      if (audible && playing && readyRef.current && element.paused) {
        void element.play().catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError')
            return;
          if (!failedAudioRef.current.has(track.id)) {
            failedAudioRef.current.add(track.id);
            callbacksRef.current.onError?.(
              'Impossibile riprodurre una traccia audio. Verifica il file originale.',
            );
          }
        });
      } else if (
        (!playing || !audible || !readyRef.current) &&
        !element.paused
      ) {
        element.pause();
      }
    };
    for (const track of project.audioTracks) {
      const element = audioRefs.current.get(track.id);
      if (element) syncAudio(track, element);
    }
    if (music) {
      const element = audioRefs.current.get('music');
      if (element) syncAudio({ ...music, id: 'music', fadeIn: 0, fadeOut: 0 }, element, music.loop, music.duck, music.phase ?? 0);
    }
    const previous = previousSoundTimeRef.current;
    previousSoundTimeRef.current = time;
    if (playing && time > previous && time - previous < .25 && project.overlays?.some((overlay) => overlay.kind === 'subscribe' && overlay.sound && overlay.start >= previous && overlay.start < time)) {
      try {
        const audioContext = audioContextRef.current ??= new AudioContext();
        void audioContext.resume();
        const master = audioContext.createGain(); master.gain.value = .22; master.connect(audioContext.destination);
        const strike = (frequency: number, delay: number) => {
          const ratios = [1, 2, 2.76, 3.76, 5.4], amplitudes = [1, .6, .35, .22, .12];
          const at = audioContext.currentTime + delay;
          ratios.forEach((ratio, index) => {
            const oscillator = audioContext.createOscillator(); oscillator.frequency.value = frequency * ratio;
            const gain = audioContext.createGain(); gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(amplitudes[index] * .5, at + .005); gain.gain.exponentialRampToValueAtTime(.0001, at + .9 / (1 + ratio * .25));
            oscillator.connect(gain); gain.connect(master); oscillator.start(at); oscillator.stop(at + 1);
          });
        };
        strike(1318.5, 0); strike(1046.5, .16);
      } catch { /* Media playback continues when the audio device is unavailable. */ }
    }
  }, [project, time, playing, duration, mediaVersion]);

  useEffect(
    () => () => {
      for (const element of videoPoolRef.current.values()) element.pause();
      for (const element of audioRefs.current.values()) element.pause();
      void audioContextRef.current?.close();
    },
    [],
  );

  function canvasLayer(index: number, width: number, height: number) {
    const canvas = layersRef.current[index] ??= document.createElement('canvas');
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    return canvas;
  }

  function paintClip(target: HTMLCanvasElement, media: HTMLVideoElement | HTMLImageElement, videoClip: VideoClip, position: number) {
    const context = target.getContext('2d')!;
    const width = target.width, height = target.height;
    context.clearRect(0, 0, width, height);
    const sourceWidth = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
    const sourceHeight = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
    if (!sourceWidth || !sourceHeight) return;
    const crop = videoClip.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const sw = sourceWidth * crop.w, sh = sourceHeight * crop.h;
    const rotated = videoClip.rotation === 90 || videoClip.rotation === 270;
    const rotatedWidth = rotated ? sh : sw, rotatedHeight = rotated ? sw : sh;
    const progress = Math.max(0, Math.min(1, position / clipDuration(videoClip)));
    const smooth = progress * progress * (3 - 2 * progress);
    const amount = videoClip.zoomAmount ?? 1.12;
    const zoom = videoClip.zoom === 'in' ? 1 + (amount - 1) * smooth : videoClip.zoom === 'out' ? amount - (amount - 1) * smooth : 1;
    const draw = (cover: boolean, blur = false) => {
      const scale = (cover ? Math.max(width / rotatedWidth, height / rotatedHeight) : Math.min(width / rotatedWidth, height / rotatedHeight)) * zoom;
      context.save(); context.translate(width / 2, height / 2); context.rotate(videoClip.rotation * Math.PI / 180);
      context.filter = `${blur ? `blur(${Math.min(width, height) * .018}px) ` : ''}${videoClip.warmth ? `url(#${warmthId}-${videoClip.id}) ` : ''}${filterCss(videoClip)}`;
      context.drawImage(media, sourceWidth * crop.x, sourceHeight * crop.y, sw, sh, -sw * scale / 2, -sh * scale / 2, sw * scale, sh * scale);
      context.restore();
    };
    if (videoClip.background === 'blur') draw(true, true);
    draw(videoClip.background === 'blur' ? false : videoClip.fit === 'cover');
    if (!!shownProject.mirror !== !!videoClip.mirror) {
      const original = canvasLayer(2, width, height);
      const originalContext = original.getContext('2d')!;
      originalContext.clearRect(0, 0, width, height); originalContext.drawImage(target, 0, 0);
      context.save(); context.setTransform(-1, 0, 0, 1, width, 0); context.drawImage(original, 0, 0); context.restore();
      const area = shownProject.protectedArea;
      if (area) {
        const x = area.x * width, y = area.y * height, w = area.w * width, h = area.h * height;
        const opposite = (1 - area.x - area.w) * width;
        context.drawImage(original, opposite, y, w, h, opposite, y, w, h);
        context.drawImage(original, x, y, w, h, x, y, w, h);
      }
    }
    if (videoClip.title?.text) {
      const title = videoClip.title;
      const fontSize = width * (title.style === 'lower' ? .042 : title.style === 'cinema' ? .062 : .058);
      if (title.style === 'cinema') { context.fillStyle = '#000'; context.fillRect(0, 0, width, height * .1); context.fillRect(0, height * .9, width, height * .1); }
      context.font = `700 ${fontSize}px Arial`;
      context.fillStyle = title.color;
      context.textAlign = title.style === 'lower' ? 'left' : 'center'; context.textBaseline = 'middle';
      context.shadowColor = 'rgba(0,0,0,.7)'; context.shadowBlur = 8;
      const lines = wrappedTitle(title.text, title.style === 'lower' ? 38 : 26).split('\n');
      const center = title.style === 'lower' ? height * .9 - lines.length * fontSize * .6 : height / 2;
      lines.forEach((line, index) => context.fillText(line, title.style === 'lower' ? width * .06 : width / 2, center + (index - (lines.length - 1) / 2) * fontSize * 1.2, width * .88));
      context.shadowBlur = 0;
    }
    const placement = videoClip.placement ?? { x: .5, y: .5, scale: 1, opacity: 1 };
    if (placement.x !== .5 || placement.y !== .5 || placement.scale !== 1) {
      const unplaced = canvasLayer(3, width, height);
      const temporary = unplaced.getContext('2d')!;
      temporary.clearRect(0, 0, width, height); temporary.drawImage(target, 0, 0);
      context.clearRect(0, 0, width, height);
      context.drawImage(unplaced, placement.x * width - width * placement.scale / 2, placement.y * height - height * placement.scale / 2, width * placement.scale, height * placement.scale);
    }
    const alpha = placement.opacity * envelope(position, clipDuration(videoClip), videoClip.fadeIn, videoClip.fadeOut);
    if (alpha < 1) { context.save(); context.globalCompositeOperation = 'destination-in'; context.fillStyle = `rgba(0,0,0,${alpha})`; context.fillRect(0, 0, width, height); context.restore(); }
  }

  useLayoutEffect(() => {
    const canvas = compositeRef.current;
    const effects = effectsRef.current;
    if (!effects) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(2, Math.round(stageSize.width * ratio)), height = Math.max(2, Math.round(stageSize.height * ratio));
    for (const target of [canvas, effects]) if (target && (target.width !== width || target.height !== height)) { target.width = width; target.height = height; }
    const context = canvas?.getContext('2d');
    if (context) {
      context.fillStyle = '#000'; context.fillRect(0, 0, width, height);
      for (const entry of [...visibleEntries].reverse()) {
        const asset = assetById.get(entry.clip.assetId);
        const media = asset?.kind === 'image' ? imagesRef.current.get(asset.id) : videoPoolRef.current.get(entry.clip.id);
        if (!media || asset?.missing || failedClipsRef.current.has(entry.clip.id)) continue;
        const base = canvasLayer(0, width, height);
        const position = Math.max(0, time - entry.start);
        paintClip(base, media, entry.clip, position);
        const next = incomingEntries.find((candidate) => candidate.trackId === entry.trackId);
        const nextAsset = next ? assetById.get(next.clip.assetId) : undefined;
        const nextMedia = nextAsset?.kind === 'image' ? imagesRef.current.get(nextAsset.id) : next ? videoPoolRef.current.get(next.clip.id) : undefined;
        const transition = next?.clip.transition ?? 'none';
        const transitionDuration = Math.min(next?.clip.transitionDuration ?? .5, clipDuration(entry.clip) / 2, next ? clipDuration(next.clip) / 2 : 0);
        const progress = transitionDuration ? (position - clipDuration(entry.clip) + transitionDuration) / transitionDuration : 0;
        if (transition !== 'none' && progress > 0 && next && nextMedia) {
          const incoming = canvasLayer(1, width, height);
          paintClip(incoming, nextMedia, next.clip, 0);
          const value = Math.max(0, Math.min(1, progress));
          const blended = canvasLayer(4, width, height);
          const layerContext = blended.getContext('2d')!;
          layerContext.clearRect(0, 0, width, height);
          layerContext.save();
          if (transition === 'black' || transition === 'white') {
            layerContext.drawImage(value < .5 ? base : incoming, 0, 0);
            const alpha = 1 - Math.abs(value * 2 - 1);
            layerContext.globalCompositeOperation = 'source-atop';
            layerContext.fillStyle = transition === 'white' ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`;
            layerContext.fillRect(0, 0, width, height);
          } else {
            layerContext.globalAlpha = 1 - value;
            if (transition === 'blur') layerContext.filter = `blur(${value * 18}px)`;
            if (transition === 'zoom') { layerContext.translate(width / 2, height / 2); layerContext.scale(1 + value * .35, 1 + value * .35); layerContext.translate(-width / 2, -height / 2); }
            layerContext.drawImage(base, 0, 0);
            layerContext.setTransform(1, 0, 0, 1, 0, 0);
            layerContext.globalCompositeOperation = 'lighter'; layerContext.globalAlpha = value;
            layerContext.filter = transition === 'blur' ? `blur(${(1 - value) * 18}px)` : 'none';
            if (transition === 'zoom') { layerContext.translate(width / 2, height / 2); layerContext.scale(.75 + value * .25, .75 + value * .25); layerContext.translate(-width / 2, -height / 2); }
            layerContext.drawImage(incoming, 0, 0);
          }
          layerContext.restore();
          context.drawImage(blended, 0, 0);
        } else context.drawImage(base, 0, 0);
      }
    }
    const overlayContext = effects.getContext('2d')!;
    overlayContext.clearRect(0, 0, width, height);
    boxesRef.current = drawProjectEffects(overlayContext, width, height, shownProject, time, imagesRef.current);
    if (shownProject.protectedArea) {
      const area = shownProject.protectedArea;
      boxesRef.current.push({ id: 'protected-area', x: area.x, y: area.y, width: area.w, height: area.h, kind: 'overlay' });
    }
    if (onChange && !playing) for (const box of boxesRef.current.filter((box) => box.id === hovered || box.id === selectedBoxId || box.id === 'protected-area' || box.id === gestureRef.current?.box.id)) {
      overlayContext.save(); overlayContext.strokeStyle = box.id === 'protected-area' ? '#65cbb0' : '#f3c455'; overlayContext.lineWidth = 1.5; overlayContext.setLineDash([5, 3]); overlayContext.strokeRect(box.x * width, box.y * height, box.width * width, box.height * height); overlayContext.setLineDash([]); overlayContext.fillStyle = '#f3c455'; overlayContext.fillRect((box.x + box.width) * width - 4, (box.y + box.height) * height - 4, 8, 8);
      if (box.kind === 'subtitle') { overlayContext.fillRect(box.x * width - 4, (box.y + box.height / 2) * height - 4, 8, 8); overlayContext.fillRect((box.x + box.width) * width - 4, (box.y + box.height / 2) * height - 4, 8, 8); }
      if (gestureRef.current?.mode === 'move') { overlayContext.globalAlpha = .6; overlayContext.setLineDash([4, 5]); overlayContext.beginPath(); if (Math.abs(box.x + box.width / 2 - .5) < .001) { overlayContext.moveTo(width / 2, 0); overlayContext.lineTo(width / 2, height); } if (Math.abs(box.y + box.height / 2 - .5) < .001) { overlayContext.moveTo(0, height / 2); overlayContext.lineTo(width, height / 2); } overlayContext.stroke(); }
      overlayContext.restore();
    }
  });

  function point(event: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }) { const bounds = event.currentTarget.getBoundingClientRect(); return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height }; }
  function hitAt(x: number, y: number) { return [...boxesRef.current].reverse().find((box) => x >= box.x - .02 && x <= box.x + box.width + .03 && y >= box.y - .02 && y <= box.y + box.height + .03); }
  function selectBox(box: EffectHitbox) {
    const subtitleIndex = box.kind === 'subtitle' && project.subtitles ? captionBlocks(project.subtitles).findIndex((block) => time >= block.start && time <= block.end) : -1;
    const id = subtitleIndex >= 0 ? `subtitle:${subtitleIndex}` : box.id;
    setLocalSelection(id); onSelectOverlay?.(id);
  }
  function cancelGesture() {
    gestureRef.current = null; setGestureProject(null);
    const capture = captureRef.current; captureRef.current = null;
    if (capture?.element.hasPointerCapture(capture.pointerId)) capture.element.releasePointerCapture(capture.pointerId);
  }
  function commitGesture() {
    const gesture = gestureRef.current;
    if (!gesture) return;
    cancelGesture();
    if (gesture.latest !== gesture.original) onChange?.({ ...gesture.latest, updatedAt: new Date().toISOString() });
  }
  function beginGesture(event: PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    const { x, y } = point(event); const box = hitAt(x, y);
    if (!box) return;
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); selectBox(box);
    if (playing) onPlayingChange(false);
    if (!onChange) return;
    const resize = Math.hypot(x - box.x - box.width, y - box.y - box.height) < .045;
    const widthHandle = box.kind === 'subtitle' && Math.min(Math.abs(x - box.x), Math.abs(x - box.x - box.width)) < .025;
    gestureRef.current = { box, mode: resize ? 'size' : widthHandle ? 'width' : 'move', source: 'pointer', x, y, original: project, latest: project };
    event.currentTarget.setPointerCapture(event.pointerId); captureRef.current = { element: event.currentTarget, pointerId: event.pointerId }; setHovered(box.id);
  }
  function moveGesture(event: PointerEvent<HTMLCanvasElement>) {
    const { x, y } = point(event); const gesture = gestureRef.current;
    if (!gesture) { setHovered(hitAt(x, y)?.id ?? null); return; }
    if (gesture.source !== 'pointer' || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const dx = x - gesture.x, dy = y - gesture.y;
    const clamp = (value: number, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));
    const snap = (value: number, half = 0) => {
      if (event.altKey) return value;
      const guides = [.5, .045 + half, .955 - half].filter((guide) => guide >= 0 && guide <= 1);
      const closest = guides.reduce((best, guide) => Math.abs(guide - value) < Math.abs(best - value) ? guide : best, Infinity);
      return Math.abs(closest - value) < .02 ? closest : value;
    };
    let updated = gesture.original;
    if (gesture.box.id === 'subtitles' && updated.subtitles) {
      const style = { ...updated.subtitles.style };
      if (gesture.mode === 'move') { style.x = snap(clamp(gesture.box.x + gesture.box.width / 2 + dx, gesture.box.width / 2, 1 - gesture.box.width / 2), gesture.box.width / 2); style.y = snap(clamp(gesture.box.y + gesture.box.height / 2 + dy, gesture.box.height / 2, 1 - gesture.box.height / 2), gesture.box.height / 2); }
      if (gesture.mode === 'size') style.size_frac = clamp(style.size_frac * (1 + dx / Math.max(.05, gesture.box.width) + dy / Math.max(.05, gesture.box.height)), .025, .12);
      if (gesture.mode === 'width') style.width_frac = clamp(style.width_frac + (gesture.x < gesture.box.x + gesture.box.width / 2 ? -2 : 2) * dx, .25, .98);
      updated = { ...updated, subtitles: { ...updated.subtitles, style } };
    } else if (gesture.box.id === 'protected-area' && updated.protectedArea) {
      const area = { ...updated.protectedArea };
      if (gesture.mode === 'move') { area.x = clamp(area.x + dx, 0, 1 - area.w); area.y = clamp(area.y + dy, 0, 1 - area.h); }
      else { area.w = clamp(area.w + dx, .05, 1 - area.x); area.h = clamp(area.h + dy, .04, 1 - area.y); }
      updated = { ...updated, protectedArea: area };
    } else updated = { ...updated, overlays: updated.overlays?.map((overlay) => {
      if (overlay.id !== gesture.box.id) return overlay;
      if (gesture.mode === 'move') return { ...overlay, x: snap(clamp(overlay.x + dx), gesture.box.width / 2), y: snap(clamp(overlay.y + dy), gesture.box.height / 2) };
      const width = clamp(overlay.width + dx * 2, .03, 1);
      return { ...overlay, width, ...(overlay.fontSize === undefined ? {} : { fontSize: clamp(overlay.fontSize * width / overlay.width, .01, .3) }) };
    }) };
    gesture.latest = updated; setGestureProject(updated);
  }
  function endGesture(event: PointerEvent<HTMLCanvasElement>) {
    if (gestureRef.current?.source !== 'pointer') return;
    commitGesture();
  }
  function previewKeyDown(event: KeyboardEvent<HTMLCanvasElement>) {
    if (event.key === 'Escape' && gestureRef.current) { event.preventDefault(); event.stopPropagation(); cancelGesture(); return; }
    if (!selection) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && onDeleteOverlay) { event.preventDefault(); event.stopPropagation(); cancelGesture(); onDeleteOverlay(selection); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !onChange) return;
    const box = boxesRef.current.find((box) => box.id === selectedBoxId);
    if (!box) return;
    event.preventDefault(); event.stopPropagation();
    if (gestureRef.current?.source === 'pointer') return;
    if (playing) onPlayingChange(false);
    const previous = gestureRef.current;
    const gesture = previous?.source === 'keyboard' && previous.box.id === box.id ? previous : { box, mode: 'move' as const, source: 'keyboard' as const, x: 0, y: 0, original: project, latest: project };
    let updated = gesture.latest;
    const clamp = (value: number, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const sign = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const distance = sign * (event.shiftKey ? 10 : 1) / Math.max(1, horizontal ? stageSize.width : stageSize.height);
    if (box.kind === 'subtitle' && updated.subtitles) {
      const style = { ...updated.subtitles.style };
      if (event.ctrlKey || event.metaKey) {
        if (horizontal) style.width_frac = clamp(style.width_frac + sign * .01, .25, .98);
        else style.size_frac = clamp(style.size_frac - sign * .002, .025, .12);
      } else if (horizontal) style.x = clamp((style.x ?? box.x + box.width / 2) + distance);
      else style.y = clamp((style.y ?? box.y + box.height / 2) + distance);
      updated = { ...updated, subtitles: { ...updated.subtitles, style } };
    } else if (box.id === 'protected-area' && updated.protectedArea) {
      const area = { ...updated.protectedArea };
      if (event.ctrlKey || event.metaKey) { if (horizontal) area.w = clamp(area.w + sign * .01, .05, 1 - area.x); else area.h = clamp(area.h - sign * .01, .04, 1 - area.y); }
      else if (horizontal) area.x = clamp(area.x + distance, 0, 1 - area.w);
      else area.y = clamp(area.y + distance, 0, 1 - area.h);
      updated = { ...updated, protectedArea: area };
    } else updated = { ...updated, overlays: updated.overlays?.map((overlay) => {
      if (overlay.id !== box.id) return overlay;
      if (event.ctrlKey || event.metaKey) { const width = clamp(overlay.width + (horizontal ? sign : -sign) * .01, .03, 1); return { ...overlay, width, ...(overlay.fontSize === undefined ? {} : { fontSize: clamp(overlay.fontSize * width / overlay.width, .01, .3) }) }; }
      return horizontal ? { ...overlay, x: clamp(overlay.x + distance) } : { ...overlay, y: clamp(overlay.y + distance) };
    }) };
    gesture.latest = updated; gestureRef.current = gesture; setGestureProject(updated);
  }

  const audioItems = [...project.audioTracks, ...(project.music ? [{ id: 'music', assetId: project.music.assetId }] : [])];
  const failedVisible = visibleEntries.find((entry) => failedClipsRef.current.has(entry.clip.id) || assetById.get(entry.clip.assetId)?.missing);
  return (
    <div ref={stageRef} className="preview-stage" style={{ aspectRatio: project.aspectRatio.replace(':', ' / '), background: '#000', position: 'relative', overflow: 'hidden' }} aria-label="Anteprima del filmato">
      <svg width={0} height={0} style={{ position: 'absolute' }} aria-hidden="true"><defs>{pooledEntries.map(({ clip }) => <filter key={clip.id} id={`${warmthId}-${clip.id}`} colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values={`1 0 0 0 ${(clip.warmth ?? 0) * .15} 0 1 0 0 ${(clip.warmth ?? 0) * .02} 0 0 1 0 ${-(clip.warmth ?? 0) * .15} 0 0 0 1 0`} /></filter>)}</defs></svg>
      <div className="preview-content" style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }} aria-hidden="true">
        {pooledEntries.map((entry) => {
          const asset = assetById.get(entry.clip.assetId);
          if (!asset || asset.missing || asset.kind !== 'video') return null;
          return <video key={`${entry.clip.id}:${asset.url}`} ref={(element) => { if (element) videoPoolRef.current.set(entry.clip.id, element); else videoPoolRef.current.delete(entry.clip.id); }} data-preview-clip-id={entry.clip.id} src={asset.url} className="preview-media" style={{ width: 1, height: 1 }} playsInline crossOrigin="anonymous" preload="auto" onLoadedMetadata={() => { syncVideo(); setMediaVersion((value) => value + 1); }} onLoadedData={() => setMediaVersion((value) => value + 1)} onCanPlay={() => { bufferingRef.current.delete(entry.clip.id); setMediaVersion((value) => value + 1); }} onSeeked={() => setMediaVersion((value) => value + 1)} onWaiting={() => {
            bufferingRef.current.add(entry.clip.id);
            if (!neededActiveEntries.some((active) => active.clip.id === entry.clip.id)) return;
            readyRef.current = false;
            for (const video of videoPoolRef.current.values()) video.pause();
            for (const audio of audioRefs.current.values()) audio.pause();
          }} onError={() => {
            if (failedClipsRef.current.has(entry.clip.id)) return;
            failedClipsRef.current.add(entry.clip.id);
            if (neededActiveEntries.some((active) => active.clip.id === entry.clip.id)) onPlayingChange(false);
            onError?.(`Impossibile visualizzare “${asset.name}”. Verifica il file originale.`);
            setMediaVersion((value) => value + 1);
          }} />;
        })}
      </div>
      <canvas ref={compositeRef} className="preview-composite" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
      <canvas ref={effectsRef} className="preview-effects" tabIndex={onChange ? 0 : -1} aria-label="Anteprima modificabile. Frecce per spostare l’elemento selezionato, Ctrl e frecce per ridimensionare, Canc per eliminare." style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: onChange && hovered && !playing ? 'move' : 'default', touchAction: 'none' }} onPointerDown={beginGesture} onPointerMove={moveGesture} onPointerUp={endGesture} onPointerCancel={cancelGesture} onKeyDown={previewKeyDown} onKeyUp={(event) => { if (event.key.startsWith('Arrow') && gestureRef.current?.source === 'keyboard') { event.preventDefault(); event.stopPropagation(); commitGesture(); } }} onBlur={() => { if (gestureRef.current?.source === 'keyboard') commitGesture(); }} />
      {failedVisible && <div className="preview-placeholder" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}><ImageOff size={34} /><span>File originale non disponibile</span></div>}
      {audioItems.map((track) => {
        const asset = assetById.get(track.assetId);
        if (!asset || asset.missing) return null;
        return <audio key={`${track.id}:${asset.url}`} ref={(element) => { if (element) audioRefs.current.set(track.id, element); else audioRefs.current.delete(track.id); }} data-preview-audio-id={track.id} src={asset.url} crossOrigin="anonymous" preload="auto" onCanPlay={() => setMediaVersion((value) => value + 1)} onLoadedMetadata={() => setMediaVersion((value) => value + 1)} onError={() => {
          if (failedAudioRef.current.has(track.id)) return;
          failedAudioRef.current.add(track.id); onError?.(`Impossibile leggere l’audio “${asset.name}”.`); setMediaVersion((value) => value + 1);
        }} />;
      })}
    </div>
  );
}
