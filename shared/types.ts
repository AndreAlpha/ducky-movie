export type MediaKind = 'video' | 'image' | 'audio';
export type ColorFilter = 'none' | 'warm' | 'cool' | 'mono' | 'vintage' | 'vivid' | 'bright';

export interface NormalizedRect { x: number; y: number; w: number; h: number }
export type ClipTransition = 'none' | 'fade' | 'black' | 'white' | 'zoom' | 'blur';
export type OverlayAnimation = 'none' | 'fade' | 'fade-grow' | 'pop' | 'zoom-out' | 'slide-up' | 'slide-right' | 'breathe';
export interface SubtitleSource { kind: 'clip' | 'audio'; id: string; start: number; end: number }
export interface SubtitleWord {
  start: number; end: number; text: string;
  id?: string;
  segmentId?: string;
  source?: SubtitleSource;
  linkedId?: string;
  detached?: boolean;
}
export interface LinkedSubtitleWord {
  id: string;
  text: string;
  segmentId?: string;
  sources: SubtitleSource[];
}
export interface SubtitleStyle {
  font: string;
  size_frac: number;
  color: string;
  active_color: string;
  outline: number;
  outline_color: string;
  shadow: number;
  box: boolean;
  box_color: string;
  box_opacity: number;
  position: 'bottom' | 'center' | 'top';
  margin_frac: number;
  uppercase: boolean;
  bold: boolean;
  anim: 'none' | 'fade';
  x?: number;
  y?: number;
  width_frac: number;
}
export interface ProjectSubtitles {
  enabled: boolean;
  words: SubtitleWord[];
  style: SubtitleStyle;
  maxWords: number;
  maxLines: number;
  linkedWords?: LinkedSubtitleWord[];
}
export interface TimedOverlay {
  id: string;
  kind: 'image' | 'text' | 'subscribe';
  assetId?: string;
  text?: string;
  start: number;
  end: number;
  x: number;
  y: number;
  width: number;
  opacity: number;
  animation: OverlayAnimation;
  color?: string;
  sound?: boolean;
  fontSize?: number;
  box?: boolean;
  boxColor?: string;
  boxOpacity?: number;
  persistent?: boolean;
}
export interface ProjectMusic {
  assetId: string;
  start: number;
  in: number;
  out: number;
  volume: number;
  loop: boolean;
  duck: boolean;
  phase?: number;
}
export type FrameStyle = 'none' | 'solid' | 'double' | 'inset' | 'corners' | 'rounded' | 'vignette' | 'edgeFade' | 'cinema' | 'bottomBar' | 'neon' | 'gradient' | 'sideBars' | 'stripe' | 'film' | 'polaroid' | 'dashed' | 'dotted' | 'tape' | 'ornate' | 'glow';
export interface ProjectFrame { style: FrameStyle; color: string; accent: string; thickness: number; opacity: number }

export interface MediaAsset {
  id: string;
  name: string;
  path: string;
  url: string;
  kind: MediaKind;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  thumbnail?: string;
  waveform?: number[];
  missing?: boolean;
}

export interface ClipTitle {
  text: string;
  style: 'center' | 'lower' | 'cinema';
  color: string;
}

export interface TimelineTrack {
  id: string;
  kind: 'video' | 'audio';
  name: string;
  muted: boolean;
  hidden?: boolean;
}

export interface VideoClip {
  id: string;
  assetId: string;
  in: number;
  out: number;
  speed: number;
  volume: number;
  muted: boolean;
  filter: ColorFilter;
  brightness: number;
  contrast: number;
  saturation: number;
  warmth?: number;
  fit: 'contain' | 'cover';
  rotation: 0 | 90 | 180 | 270;
  fadeIn: number;
  fadeOut: number;
  title: ClipTitle | null;
  crop?: NormalizedRect | null;
  mirror?: boolean;
  zoom?: 'none' | 'in' | 'out';
  zoomAmount?: number;
  transition?: ClipTransition;
  transitionDuration?: number;
  start?: number;
  background?: 'black' | 'blur';
  role?: 'normal' | 'intro' | 'outro';
  trackId?: string;
  placement?: { x: number; y: number; scale: number; opacity: number };
}

export interface AudioTrack {
  id: string;
  assetId: string;
  start: number;
  in: number;
  out: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  trackId?: string;
}

export interface Project {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  aspectRatio: '16:9' | '9:16' | '1:1';
  assets: MediaAsset[];
  clips: VideoClip[];
  audioTracks: AudioTrack[];
  tracks?: TimelineTrack[];
  duration?: number;
  subtitles?: ProjectSubtitles;
  overlays?: TimedOverlay[];
  music?: ProjectMusic | null;
  mirror?: boolean;
  frame?: ProjectFrame | null;
  protectedArea?: NormalizedRect | null;
}

export interface ExportSettings {
  resolution: '720p' | '1080p' | '1440p' | '2160p';
  fps: 24 | 25 | 30 | 60;
  quality: 'standard' | 'high';
  acceleration?: 'auto' | 'cpu';
  framePng?: string;
}

export type VideoEncoder = 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264';
export interface ExportAccelerationInfo {
  mode: 'gpu' | 'cpu';
  encoder: VideoEncoder;
  label: string;
  requested: 'auto' | 'cpu';
  fallback?: string;
}
export interface ExportEncoderCapability {
  encoder: VideoEncoder;
  label: string;
  hardware: boolean;
  available: boolean;
  reason?: string;
}
export interface ExportCapabilities {
  encoders: ExportEncoderCapability[];
  preferred: VideoEncoder;
  checkedAt: string;
}

export interface ExportProgress {
  jobId: string;
  progress: number;
  state: 'running' | 'complete' | 'cancelled' | 'error';
  path?: string;
  error?: string;
  message?: string;
  acceleration?: ExportAccelerationInfo;
}

export interface OpenProjectResult {
  project: Project;
  path: string;
  missingAssets: string[];
}

export interface AutomationRequest {
  action: 'highlights' | 'transcribe' | 'match' | 'short-base' | 'read-script';
  payload: Record<string, unknown>;
}
export interface AutomationProgress {
  jobId: string;
  progress: number;
  message: string;
  state: 'running' | 'complete' | 'cancelled' | 'error';
  result?: unknown;
  error?: string;
}

export interface DuckyAPI {
  importMedia: (
    paths?: string[],
  ) => Promise<{ assets: MediaAsset[]; errors: string[] }>;
  openProject: (path?: string) => Promise<OpenProjectResult | null>;
  saveProject: (
    project: Project,
    path?: string,
    forceDialog?: boolean,
  ) => Promise<string | null>;
  autosave: (project: Project) => Promise<void>;
  recoverAutosave: () => Promise<Project | null>;
  clearAutosave: () => Promise<void>;
  getRecentProjects: () => Promise<
    { name: string; path: string; updatedAt: string }[]
  >;
  exportVideo: (
    project: Project,
    settings: ExportSettings,
  ) => Promise<{ jobId: string; path: string } | null>;
  cancelExport: (jobId: string) => Promise<void>;
  getExportCapabilities: () => Promise<ExportCapabilities>;
  onExportProgress: (callback: (event: ExportProgress) => void) => () => void;
  revealFile: (path: string) => Promise<void>;
  getVersion: () => Promise<string>;
  getPathForFile: (file: File) => string;
  setDirty: (dirty: boolean) => void;
  onSaveRequested: (callback: () => void) => () => void;
  startAutomation: (request: AutomationRequest) => Promise<{ jobId: string }>;
  onAutomationProgress: (callback: (event: AutomationProgress) => void) => () => void;
  cancelAutomation: (jobId: string) => Promise<void>;
  importScript: () => Promise<{ path: string; text: string } | null>;
  importLegacyProject: () => Promise<Project | null>;
  saveTemplate: (project: Project) => Promise<string | null>;
  openTemplate: () => Promise<Project | null>;
  exportTranscript: (subtitles: ProjectSubtitles, format: 'srt' | 'txt') => Promise<string | null>;
}

declare global {
  interface Window {
    ducky: DuckyAPI;
  }
}
