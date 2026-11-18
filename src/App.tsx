import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  CircleHelp,
  Clapperboard,
  Copy,
  Download,
  Film,
  FolderOpen,
  Image,
  Info,
  LoaderCircle,
  Maximize,
  Magnet,
  Music2,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCw,
  Save,
  Scissors,
  Search,
  Settings2,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Trash2,
  Type,
  Undo2,
  Upload,
  Volume2,
  VolumeX,
  X,
  Sparkles,
  Smartphone,
  FileText,
  ImagePlus,
} from 'lucide-react';
import type {
  AudioTrack,
  ColorFilter,
  ExportProgress,
  ExportSettings,
  Project,
  StartupUpdate,
  VideoClip,
  OverlayAnimation,
  TimelineTrack,
  TimedOverlay,
} from '../shared/types';
import {
  addAssets,
  canonicalMediaPath,
  clipDuration,
  createClip,
  createProject,
  createAudioTrack,
  getProjectTracks,
  getClipTrackId,
  getAudioTrackId,
  addTimelineTrack,
  removeTimelineTrack,
  applyTimelineMove,
  setProjectCap,
  removeProjectCap,
  updateAudioTrack,
  duplicateClip,
  duplicateAudioTrack,
  formatDuration,
  formatTimecode,
  moveClip,
  projectDuration,
  removeClips,
  removeAssets,
  getUsedAssetIds,
  updateClips,
  shiftClips,
  splitAudioTrack,
  applyProjectTemplate,
  splitClip,
  timelinePositions,
  trimClip,
  updateClip,
  syncLinkedSubtitles,
  getSubtitleEvents,
  setSubtitleEventTiming,
  removeSubtitleEvent,
  splitSubtitleEvent,
  copyLinkedSubtitles,
} from './model';
import { Preview } from './components/Preview';
import { Timeline, TIMELINE_GUTTER, MIN_TIMELINE_ZOOM, MAX_TIMELINE_ZOOM } from './components/Timeline';
import AutomationPanel from './components/AutomationPanel';
import AdvancedInspector from './components/AdvancedInspector';
import CaptionEditor from './components/CaptionEditor';
import StudioPanel, { type StudioSection } from './components/StudioPanel';
import { renderFramePNG } from './render-effects';
import { insertLibraryAssets } from './library';
import { MediaSelectionArea } from './components/MediaSelectionArea';

type LibraryTab = 'media' | 'audio' | 'titles' | 'transitions' | 'filters' | StudioSection;
type History = { project: Project; past: Project[]; future: Project[] };
type HistoryAction =
  { type: 'edit' | 'replace'; project: Project } | { type: 'undo' | 'redo' };

function historyReducer(state: History, action: HistoryAction): History {
  if (action.type === 'replace')
    return { project: action.project, past: [], future: [] };
  if (action.type === 'edit') {
    if (JSON.stringify(action.project) === JSON.stringify(state.project))
      return state;
    return {
      project: action.project,
      past: [...state.past.slice(-99), state.project],
      future: [],
    };
  }
  if (action.type === 'undo' && state.past.length) {
    return {
      project: state.past[state.past.length - 1],
      past: state.past.slice(0, -1),
      future: [state.project, ...state.future],
    };
  }
  if (action.type === 'redo' && state.future.length) {
    return {
      project: state.future[0],
      past: [...state.past, state.project],
      future: state.future.slice(1),
    };
  }
  return state;
}

const tabs: { id: LibraryTab; name: string; icon: typeof Film }[] = [
  { id: 'media', name: 'I miei media', icon: Film },
  { id: 'audio', name: 'Audio', icon: Music2 },
  { id: 'shorts', name: 'Shorts', icon: Smartphone },
  { id: 'captions', name: 'Sottotitoli', icon: FileText },
  { id: 'branding', name: 'Logo', icon: ImagePlus },
  { id: 'titles', name: 'Titoli', icon: Type },
  { id: 'caps', name: 'Intro / outro', icon: Film },
  { id: 'transitions', name: 'Transizioni', icon: Clapperboard },
  { id: 'filters', name: 'Filtri', icon: SlidersHorizontal },
];
const filters: { id: ColorFilter; label: string }[] = [
  { id: 'none', label: 'Originale' },
  { id: 'warm', label: 'Caldo' },
  { id: 'vivid', label: 'Vivido' },
  { id: 'bright', label: 'Luminoso' },
  { id: 'cool', label: 'Freddo' },
  { id: 'mono', label: 'Bianco e nero' },
  { id: 'vintage', label: 'Vintage' },
];

function IconButton({
  label,
  children,
  ...props
}: {
  label: string;
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className="icon-button" title={label} aria-label={label} {...props}>
      {children}
    </button>
  );
}

function RangeControl({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
  display,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  display?: string;
}) {
  return (
    <label className="range-control">
      <span>
        {label}
        <output>{display ?? value.toFixed(2)}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Modal({
  title,
  onClose,
  children,
  wide = false,
  locked = false,
  descriptionId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  locked?: boolean;
  descriptionId?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialogRef.current;
    node?.showModal();
    node?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      aria-describedby={descriptionId}
      className={`modal ${wide ? 'wide' : ''}`}
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onClose();
      }}
      onClick={(event) => {
        if (!locked && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-inner">
        <div className="modal-heading">
          <h2>{title}</h2>
          {!locked && (
            <IconButton label="Chiudi finestra" onClick={onClose}>
              <X size={18} />
            </IconButton>
          )}
        </div>
        {children}
      </div>
    </dialog>
  );
}

function updateErrorMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
}

function PrivateUpdateAccess({ refresh }: { refresh: () => Promise<StartupUpdate | null> }) {
  const input = useRef<HTMLInputElement>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function readStatus() {
    if (configured !== null || reading) return;
    setReading(true);
    setError('');
    try {
      const result = await window.ducky.hasUpdateAccess();
      if (typeof result !== 'boolean') throw new Error('Gli aggiornamenti sono disponibili nell’app per Windows.');
      setConfigured(result);
    } catch (cause) {
      setError(updateErrorMessage(cause));
    } finally {
      setReading(false);
    }
  }

  async function saveAccess(remove: boolean) {
    const field = input.current;
    if (!field || saving || configured === null) return;
    if (!remove && !field.value.trim()) { field.focus(); return; }
    setSaving(true);
    setNotice('');
    setError('');
    try {
      const request = window.ducky.setUpdateAccess(remove ? '' : field.value.trim());
      field.value = '';
      await request;
      setConfigured(!remove);
      setNotice(remove ? 'Token rimosso.' : 'Token salvato. Controllo degli aggiornamenti in corso…');
      const release = await refresh();
      if (release) setNotice(`DuckyMovie ${release.version} è disponibile. Chiudi la guida per aggiornare.`);
      else setNotice(remove ? 'Token rimosso.' : 'Token salvato. Nessuna nuova versione trovata.');
    } catch (cause) {
      setError(updateErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return <details className="modal-intro" style={{ marginTop: 20 }}
    onToggle={event => { if (event.currentTarget.open) void readStatus(); }}>
    <summary style={{ cursor: 'pointer' }}>Aggiornamenti da un repository privato</summary>
    <p className="modal-intro">Su GitHub crea un token personale di tipo <strong>fine-grained</strong>,
      seleziona il repository <strong>AndreAlpha/ducky-movie</strong> e assegna il permesso <strong>Contents · Read-only</strong>.</p>
    {reading && <p className="modal-intro" role="status">Verifica dell’accesso…</p>}
    {configured !== null && <form className="new-project-form" onSubmit={event => { event.preventDefault(); void saveAccess(false); }}>
      <label>{configured ? 'Sostituisci il token GitHub salvato' : 'Token GitHub'}
        <input ref={input} type="password" autoComplete="off" spellCheck={false} disabled={saving} required />
      </label>
      <div className="modal-actions">
        {configured && <button type="button" className="secondary-button" disabled={saving} onClick={() => void saveAccess(true)}>Rimuovi token</button>}
        <button type="submit" className="primary-button" disabled={saving}>Salva token</button>
      </div>
    </form>}
    {notice && <p className="modal-intro" role="status">{notice}</p>}
    {error && <p className="modal-intro" role="alert">{error}</p>}
  </details>;
}

function StartupUpdateDialog({ update, saveProject, onClose }: {
  update: StartupUpdate;
  saveProject: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<'offer' | 'saving' | 'downloading' | 'cancelling' | 'installing' | 'error'>('offer');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const attempt = useRef<symbol | null>(null);
  const downloaded = useRef(false);

  useEffect(() => window.ducky.onUpdateProgress(setProgress), []);

  async function start() {
    if (attempt.current) return;
    const token = Symbol();
    attempt.current = token;
    try {
      setPhase('saving');
      if (!(await saveProject())) {
        onClose();
        return;
      }
      if (!downloaded.current) {
        setProgress(0);
        setPhase('downloading');
        await window.ducky.downloadStartupUpdate();
        if (attempt.current !== token) return;
        downloaded.current = true;
      }
      setPhase('installing');
      await window.ducky.installStartupUpdate();
    } catch (cause) {
      if (attempt.current !== token) return;
      setError(updateErrorMessage(cause));
      setPhase('error');
    } finally {
      if (attempt.current === token) attempt.current = null;
    }
  }

  async function dismiss() {
    if (phase === 'saving' || phase === 'installing' || phase === 'cancelling') return;
    if (phase === 'offer') { onClose(); return; }
    attempt.current = null;
    setPhase('cancelling');
    try {
      await window.ducky.cancelStartupUpdate();
      onClose();
    } catch (cause) {
      setError(updateErrorMessage(cause));
      setPhase('error');
    }
  }

  const offer = phase === 'offer' || phase === 'error';
  return (
    <Modal title="Aggiornamento disponibile" descriptionId="update-description" onClose={() => void dismiss()}
      locked={!offer && phase !== 'downloading'}>
      <p className="modal-intro" id="update-description">
        È disponibile <strong>DuckyMovie {update.version}</strong>. Dopo il download, DuckyMovie installerà
        l’aggiornamento e si riaprirà automaticamente.
        {!update.installed && ' Stai usando la versione portatile. L’aggiornamento installerà DuckyMovie su Windows. Per aprire la versione aggiornata, usa il menu Start.'}
      </p>
      {phase === 'error' && <p className="modal-intro" role="alert">Aggiornamento non riuscito. {error}</p>}
      {phase === 'downloading' && <div className="export-result">
        <progress aria-label="Download aggiornamento" value={progress} max={1} />
        <div className="export-progress-label">Download · {Math.round(progress * 100)}%</div>
      </div>}
      {phase === 'saving' && <p role="status">Preparazione del progetto…</p>}
      {phase === 'cancelling' && <p role="status">Annullamento del download…</p>}
      {phase === 'installing' && <p role="status">Installazione e riavvio in corso…</p>}
      {offer && <div className="modal-actions">
        <button className="secondary-button" data-initial-focus onClick={() => void dismiss()}>Adesso no</button>
        <button className="primary-button" onClick={() => void start()}><Download size={15} />
          {phase === 'error' ? 'Riprova' : 'Aggiorna e riavvia'}
        </button>
      </div>}
      {phase === 'downloading' && <div className="modal-actions">
        <button className="secondary-button" onClick={() => void dismiss()}>Annulla download</button>
      </div>}
    </Modal>
  );
}

export default function App() {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({
    project: createProject('Il mio film'),
    past: [],
    future: [],
  }));
  const { project } = history;
  const [projectPath, setProjectPath] = useState<string>();
  const [savedSnapshot, setSavedSnapshot] = useState(() =>
    JSON.stringify(project),
  );
  const [tab, setTab] = useState<LibraryTab>('media');
  const [query, setQuery] = useState('');
  const [mediaFilter, setMediaFilter] = useState('all');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<'clip' | 'audio'>('clip');
  const [sourceAssetId, setSourceAssetId] = useState<string | null>(null);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const assetAnchor = useRef<string | null>(null);
  const [pendingAssetRemoval, setPendingAssetRemoval] = useState<{ projectId: string; ids: string[]; usedCount: number } | null>(null);
  const [sourceTime, setSourceTime] = useState(0);
  const [zoom, setZoom] = useState(26);
  const [snappingEnabled, setSnappingEnabled] = useState(() => {
    try { return localStorage.getItem('ducky:timeline-snapping') !== 'off'; } catch { return true; }
  });
  const [timelineHeight,setTimelineHeight]=useState<number>();
  const timelineResize=useRef<{y:number;height:number}|null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<'video' | 'audio' | 'title'>(
    'video',
  );
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [autosaved, setAutosaved] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  const [modal, setModal] = useState<
    'export' | 'help' | 'projects' | 'new' | 'montage' | 'shorts' | 'transcribe' | 'update' | null
  >(null);
  const [startupUpdate, setStartupUpdate] = useState<StartupUpdate | null>(null);
  const updateCheck = useRef(0);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [effectSelection, setEffectSelection] = useState<string>();
  const [editorGeneration, setEditorGeneration] = useState(0);
  const pendingDrafts = useRef(new Set<string>());
  const [hasPendingDraft, setHasPendingDraft] = useState(false);
  const currentEffectSelection = useRef(effectSelection);
  currentEffectSelection.current = effectSelection;
  const [automationAssetId, setAutomationAssetId] = useState<string>();
  const [automationAssetIds, setAutomationAssetIds] = useState<string[]>();
  const [activeTrackId, setActiveTrackId] = useState<string>('video-main');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const copiedClips = useRef<VideoClip[]>([]);
  const [recent, setRecent] = useState<
    { name: string; path: string; updatedAt: string }[]
  >([]);
  const [recovery, setRecovery] = useState<Project | null>(null);
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [exportSettings, setExportSettings] = useState<ExportSettings>({
    resolution: '1080p',
    fps: 30,
    quality: 'high',
    acceleration: 'auto',
  });
  const [exportCapabilities, setExportCapabilities] = useState<Awaited<ReturnType<Window['ducky']['getExportCapabilities']>> | null>(null);
  const [checkingAcceleration, setCheckingAcceleration] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(
    null,
  );
  const [exportPending, setExportPending] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [newName, setNewName] = useState('Il mio film');
  const [newRatio, setNewRatio] = useState<Project['aspectRatio']>('16:9');
  const duration = useMemo(() => projectDuration(project), [project]);
  const dirty = useMemo(
    () => hasPendingDraft || JSON.stringify(project) !== savedSnapshot,
    [project, savedSnapshot, hasPendingDraft],
  );
  const currentProject = useRef(project);
  const currentPath = useRef(projectPath);
  const currentSavedSnapshot = useRef(savedSnapshot);
  const pendingSave = useRef<Promise<boolean> | null>(null);
  const changingProject = useRef(false);
  currentProject.current = project;
  currentPath.current = projectPath;
  currentSavedSnapshot.current = savedSnapshot;
  const selectedClip =
    selectedType === 'clip'
      ? project.clips.find((clip) => clip.id === selectedId)
      : undefined;
  const selectedAudio =
    selectedType === 'audio'
      ? project.audioTracks.find((track) => track.id === selectedId)
      : undefined;
  const selectedVideoLane = selectedClip && getClipTrackId(project, selectedClip.id);
  const selectedLaneClips = selectedVideoLane ? timelinePositions(project)
    .filter(entry => entry.trackId === selectedVideoLane)
    .sort((a, b) => a.start - b.start).map(entry => entry.clip) : [];
  const selectedAsset = project.assets.find(
    (asset) => asset.id === (selectedClip?.assetId ?? selectedAudio?.assetId),
  );
  const sourceAsset = project.assets.find(
    (asset) => asset.id === sourceAssetId,
  );
  const sourceProject = useMemo(() => {
    if (!sourceAsset) return null;
    return {
      ...createProject(sourceAsset.name),
      aspectRatio: project.aspectRatio,
      assets: [sourceAsset],
      clips: sourceAsset.kind === 'audio' ? [] : [createClip(sourceAsset)],
      audioTracks: sourceAsset.kind === 'audio' ? [{...createAudioTrack(sourceAsset),volume:1}] : [],
    };
  }, [sourceAsset, project.aspectRatio]);
  const previewProject = sourceProject ?? project;
  const previewTime = sourceProject ? sourceTime : time;
  const previewDuration = sourceProject
    ? projectDuration(sourceProject)
    : duration;
  const changePreviewTime = sourceProject ? setSourceTime : setTime;
  const exportRunning = exportPending || exportProgress?.state === 'running';
  const say = useCallback(
    (text: string, error = false) => setToast({ text, error }),
    [],
  );
  const edit = useCallback((next: Project) => {
    const selection = currentEffectSelection.current;
    const caption = selection?.startsWith('subtitle:') ? getSubtitleEvents(currentProject.current)[Number(selection.split(':')[1])] : undefined;
    const synchronized = syncLinkedSubtitles(currentProject.current, next);
    if (caption) {
      const index = getSubtitleEvents(synchronized).findIndex(item => item.id === caption.id);
      const selected = index < 0 ? 'subtitles' : `subtitle:${index}`;
      currentEffectSelection.current = selected;
      setEffectSelection(selected);
    }
    currentProject.current = synchronized;
    dispatch({ type: 'edit', project: synchronized });
  }, []);

  const applyHistory = useCallback((type: 'undo' | 'redo') => {
    const target = type === 'undo' ? history.past.at(-1) : history.future[0];
    if (!target) return;
    const selected = currentEffectSelection.current;
    if (selected?.startsWith('subtitle:')) {
      const caption = getSubtitleEvents(currentProject.current)[Number(selected.split(':')[1])];
      const index = caption ? getSubtitleEvents(target).findIndex(item=>item.id===caption.id) : -1;
      currentEffectSelection.current = index < 0 ? 'subtitles' : `subtitle:${index}`;
      setEffectSelection(currentEffectSelection.current);
    }
    currentProject.current = target;
    setPlaying(false);
    dispatch({type});
  }, [history]);

  const replaceEditorProject = useCallback((next: Project) => {
    setSelectedAssetIds([]); assetAnchor.current=null;
    setPendingAssetRemoval(null);
    pendingDrafts.current.clear();
    setHasPendingDraft(false);
    currentEffectSelection.current = undefined;
    setEffectSelection(undefined);
    setEditorGeneration(value=>value+1);
    dispatch({type:'replace',project:next});
  }, []);

  useEffect(() => { if (selectedId) setEffectSelection(undefined); }, [selectedId]);
  useEffect(() => { try { localStorage.setItem('ducky:timeline-snapping',snappingEnabled?'on':'off'); } catch { /* Session preference still works without storage. */ } }, [snappingEnabled]);
  useEffect(() => {
    if (modal !== 'export') return;
    let active = true;
    setCheckingAcceleration(true);
    window.ducky.getExportCapabilities().then(value => { if (active) setExportCapabilities(value); })
      .catch(() => { if (active) setExportCapabilities(null); })
      .finally(() => { if (active) setCheckingAcceleration(false); });
    return () => { active = false; };
  }, [modal]);
  useEffect(() => { setEffectSelection(undefined); }, [project.id]);
  useEffect(() => {
    const available=new Set(project.assets.map(asset=>asset.id));
    setSelectedAssetIds(previous=>previous.every(id=>available.has(id))?previous:previous.filter(id=>available.has(id)));
    if(assetAnchor.current&&!available.has(assetAnchor.current))assetAnchor.current=null;
  }, [project.assets]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 10000 : 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let active = true;
    window.ducky
      .recoverAutosave()
      .then((value) => {
        if (active && value && (value.assets.length || value.clips.length))
          setRecovery(value);
      })
      .catch((error) => {
        if (active)
          say(`Recupero del progetto non riuscito. ${error.message}`, true);
      })
      .finally(() => {
        if (active) setRecoveryChecked(true);
      });
    return () => {
      active = false;
    };
  }, [say]);

  const refreshUpdate = useCallback(async () => {
    const request = ++updateCheck.current;
    setStartupUpdate(null);
    const update = await window.ducky.getStartupUpdate();
    if (request === updateCheck.current) setStartupUpdate(update);
    return update;
  }, []);
  useEffect(() => {
    if (!recoveryChecked) return;
    void refreshUpdate()
      .catch(() => { /* An unavailable release feed should not interrupt editing. */ });
    return () => { updateCheck.current++; };
  }, [recoveryChecked, refreshUpdate]);

  useEffect(() => {
    if (!startupUpdate || !recoveryChecked || recovery || modal || pendingAssetRemoval ||
        busy || saving || automationBusy || exportRunning || changingProject.current) return;
    setPlaying(false);
    setModal('update');
  }, [startupUpdate, recoveryChecked, recovery, modal, pendingAssetRemoval, busy, saving, automationBusy, exportRunning]);

  useEffect(() => {
    window.ducky.setDirty(dirty);
  }, [dirty, project, savedSnapshot]);
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{id:string;dirty:boolean}>).detail;
      if (!detail) return;
      if (detail.dirty) pendingDrafts.current.add(detail.id);
      else pendingDrafts.current.delete(detail.id);
      setHasPendingDraft(pendingDrafts.current.size > 0);
      window.ducky.setDirty(pendingDrafts.current.size > 0 || JSON.stringify(currentProject.current) !== currentSavedSnapshot.current);
    };
    document.addEventListener('ducky:draft-state',update);
    return ()=>document.removeEventListener('ducky:draft-state',update);
  }, []);
  useEffect(() => {
    setAutosaved(false);
    if (!dirty || !recoveryChecked || recovery || hasPendingDraft) return;
    let active = true;
    const timer = setTimeout(() => {
      if (pendingDrafts.current.size) return;
      const current = currentProject.current;
      const snapshot = {
        ...current,
        name: current.name.trim() || 'Il mio film',
      };
      window.ducky
        .autosave(snapshot)
        .then(() => {
          if (active) setAutosaved(true);
        })
        .catch((error) => {
          if (active)
            say(`Salvataggio automatico non riuscito. ${error.message}`, true);
        });
    }, 1200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [project, dirty, recoveryChecked, recovery, say, hasPendingDraft]);

  useEffect(() => {
    if (time > duration) setTime(duration);
    if (
      selectedId &&
      !project.clips.some((clip) => clip.id === selectedId) &&
      !project.audioTracks.some((track) => track.id === selectedId)
    )
      setSelectedId(null);
  }, [duration, project.clips, project.audioTracks, selectedId, time]);

  const save = useCallback(
    (forceDialog = false): Promise<boolean> => {
      document.dispatchEvent(new Event('ducky:commit-drafts'));
      if (pendingSave.current) return pendingSave.current;
      let snapshot = currentProject.current;
      if (!snapshot.name.trim()) {
        snapshot = { ...snapshot, name: 'Il mio film' };
        edit(snapshot);
      }
      const serializedSnapshot = JSON.stringify(snapshot);
      setSaving(true);
      pendingSave.current = (async () => {
        try {
          const path = await window.ducky.saveProject(
            snapshot,
            currentPath.current,
            forceDialog,
          );
          if (!path) return false;
          if (currentProject.current.id === snapshot.id) {
            currentPath.current = path;
            currentSavedSnapshot.current = serializedSnapshot;
            setProjectPath(path);
            setSavedSnapshot(serializedSnapshot);
            const hasMoreChanges =
              pendingDrafts.current.size > 0 || JSON.stringify(currentProject.current) !== serializedSnapshot;
            window.ducky.setDirty(hasMoreChanges);
            say(
              hasMoreChanges
                ? 'Versione salvata. Ci sono altre modifiche da salvare.'
                : 'Progetto salvato',
            );
          }
          return true;
        } catch (error) {
          say(String(error), true);
          return false;
        } finally {
          pendingSave.current = null;
          setSaving(false);
        }
      })();
      return pendingSave.current;
    },
    [edit, say],
  );

  const saveBeforeReplacing = useCallback(async () => {
    document.dispatchEvent(new Event('ducky:commit-drafts'));
    while (
      JSON.stringify(currentProject.current) !== currentSavedSnapshot.current
    ) {
      if (!(await save())) return false;
    }
    return true;
  }, [save]);

  useEffect(
    () =>
      window.ducky.onSaveRequested(() => {
        // The native File menu can send Ctrl+S even while a modal owns focus.
        // Keep an explicit close-time save available when the project is dirty.
        if (modal === 'update' && !dirty) return;
        void save();
      }),
    [save, modal, dirty],
  );
  useEffect(
    () =>
      window.ducky.onExportProgress((event) => {
        setExportProgress(event);
        if (event.state === 'error')
          say(event.error ?? 'Esportazione non riuscita', true);
      }),
    [say],
  );

  const importMedia = useCallback(
    async (paths?: string[]) => {
      const projectId = currentProject.current.id;
      setBusy(true);
      setPlaying(false);
      try {
        const result = await window.ducky.importMedia(paths);
        if (result.assets.length) {
          if (currentProject.current.id !== projectId) {
            say(
              'Il progetto è cambiato durante l’importazione. Importa i file nel progetto aperto.',
              true,
            );
            return;
          }
          const next = addAssets(currentProject.current, result.assets);
          edit(next);
          setTab('media');
          const first = next.assets.find(
            (asset) =>
              canonicalMediaPath(asset.path) ===
              canonicalMediaPath(result.assets[0].path),
          );
          if (first) {
            setSourceAssetId(first.id);
            setSourceTime(0);
            const importedPaths=new Set(result.assets.map(asset=>canonicalMediaPath(asset.path)));
            setSelectedAssetIds(next.assets.filter(asset=>importedPaths.has(canonicalMediaPath(asset.path))).map(asset=>asset.id));
            assetAnchor.current=first.id;
          }
          say(
            `${result.assets.length} ${result.assets.length === 1 ? 'file importato' : 'file importati'}`,
          );
        }
        if (result.errors.length) say(result.errors.join('\n'), true);
      } catch (error) {
        say(String(error), true);
      } finally {
        setBusy(false);
      }
    },
    [edit, say],
  );

  function selectLibraryAsset(assetId:string,event?:Pick<ReactMouseEvent,'ctrlKey'|'metaKey'|'shiftKey'>) {
    let selection=[assetId];
    if (event?.shiftKey&&assetAnchor.current) {
      const first=visibleAssets.findIndex(asset=>asset.id===assetAnchor.current),last=visibleAssets.findIndex(asset=>asset.id===assetId);
      const range=first<0?[assetId]:visibleAssets.slice(Math.min(first,last),Math.max(first,last)+1).filter(asset=>!asset.missing).map(asset=>asset.id);
      selection=event.ctrlKey||event.metaKey?[...new Set([...selectedAssetIds,...range])]:range;
    } else if (event?.ctrlKey||event?.metaKey) selection=selectedAssetIds.includes(assetId)?selectedAssetIds.filter(id=>id!==assetId):[...selectedAssetIds,assetId];
    else assetAnchor.current=assetId;
    setSelectedAssetIds(selection); setPlaying(false);
    setSourceAssetId(assetId);setSourceTime(0);
  }

  function addLibrarySelection(assetIds = selectedAssetIds, trackId?: string, dropTime?: number) {
    try {
      const base = currentProject.current;
      const active = getProjectTracks(base).find(track => track.id === activeTrackId);
      const audioOnly = assetIds.every(id => base.assets.find(asset => asset.id === id)?.kind === 'audio');
      const preferred = trackId ?? (active?.kind === 'video' || audioOnly ? active?.id : undefined);
      const result = insertLibraryAssets(base, assetIds, dropTime ?? time, preferred);
      if (result.project === base) return;

      edit(result.project);
      setSourceAssetId(null);
      setPlaying(false);
      setEffectSelection(undefined);
      const videoIds = new Set(result.clipIds);
      const audioIds = new Set(result.audioIds);
      const spans = [
        ...timelinePositions(result.project).filter(entry => videoIds.has(entry.clip.id)),
        ...result.project.audioTracks.filter(audio => audioIds.has(audio.id)).map(audio => ({
          start: audio.start, end: audio.start + audio.out - audio.in,
        })),
      ];
      const firstClip = result.clipIds[0];
      const id = firstClip ?? result.audioIds[0];
      setSelectedId(id);
      setSelectedType(firstClip ? 'clip' : 'audio');
      setSelectedIds(result.clipIds);
      setActiveTrackId(firstClip ? getClipTrackId(result.project, id) : getAudioTrackId(result.project, id));
      // Repeated button insertions build a sequence. For a mouse drop, show its first frame.
      setTime(dropTime === undefined ? Math.max(...spans.map(span => span.end)) : Math.min(...spans.map(span => span.start)));
      say(spans.length === 1 ? 'Media aggiunto alla timeline' : `${spans.length} media aggiunti alla timeline`);
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    }
  }

  function removeLibrarySelection(ids: readonly string[]) {
    document.dispatchEvent(new Event('ducky:commit-drafts'));
    const base = currentProject.current;
    const next = removeAssets(base, ids);
    if (next === base) return;
    const removed = new Set(ids);
    edit(next);
    setPlaying(false);
    setSelectedAssetIds(previous => previous.filter(id => !removed.has(id)));
    if (assetAnchor.current && removed.has(assetAnchor.current)) assetAnchor.current = null;
    if (sourceAssetId && removed.has(sourceAssetId)) { setSourceAssetId(null); setSourceTime(0); }
    setSelectedIds(previous => previous.filter(id => next.clips.some(clip => clip.id === id)));
    if (selectedId && !next.clips.some(clip => clip.id === selectedId) && !next.audioTracks.some(audio => audio.id === selectedId)) setSelectedId(null);
    if (effectSelection && base.overlays?.some(overlay => overlay.id === effectSelection) && !next.overlays?.some(overlay => overlay.id === effectSelection)) setEffectSelection(undefined);
    const count = base.assets.length - next.assets.length;
    say(`${count === 1 ? 'Media rimosso' : `${count} media rimossi`} dal progetto. Ctrl+Z per annullare.`);
    document.querySelector<HTMLElement>('.media-selection-area')?.focus({ preventScroll: true });
  }

  function requestLibraryRemoval() {
    if (busy || !selectedAssetIds.length || document.querySelector('dialog[open]')) return;
    const base = currentProject.current;
    const ids = selectedAssetIds.filter(id => base.assets.some(asset => asset.id === id));
    if (!ids.length) return;
    const usedCount = getUsedAssetIds(base, ids).length;
    setPlaying(false);
    if (usedCount) setPendingAssetRemoval({ projectId: base.id, ids, usedCount });
    else removeLibrarySelection(ids);
  }

  function closeLibraryRemoval() {
    document.getElementById('remove-media-description')?.closest<HTMLDialogElement>('dialog')?.close();
    setPendingAssetRemoval(null);
    document.querySelector<HTMLElement>('.media-selection-area')?.focus({ preventScroll: true });
  }

  const deleteSelection = useCallback(() => {
    if (effectSelection && effectSelection !== 'film' && effectSelection !== 'subtitles' && effectSelection !== 'protected-area') {
      deleteEffect(effectSelection);
      return;
    }
    if (!selectedId) return;
    setPlaying(false);
    if (selectedType === 'clip') edit(removeClips(project, selectedIds.length ? selectedIds : [selectedId]));
    else
      edit({
        ...project,
        updatedAt: new Date().toISOString(),
        audioTracks: project.audioTracks.filter(
          (track) => track.id !== selectedId,
        ),
      });
    setSelectedId(null);
    setSelectedIds([]);
  }, [project, selectedId, selectedIds, selectedType, edit, effectSelection]);

  const splitSelection = useCallback(() => {
    if (effectSelection?.startsWith('subtitle:')) {
      const index = Number(effectSelection.split(':')[1]);
      const event = getSubtitleEvents(project)[index];
      if (event && time > event.start && time < event.end) edit(splitSubtitleEvent(project,index,time));
      else say('Posiziona il cursore nella frase da dividere');
      setPlaying(false);
      return;
    }
    if (effectSelection) return;
    if (selectedType === 'audio' && selectedId) {
      const next = splitAudioTrack(project, selectedId, time);
      if (next === project) say('Posiziona il cursore all’interno della traccia audio da dividere');
      else edit(next);
      setPlaying(false);
      return;
    }
    const clip =
      selectedClip ??
      timelinePositions(project).find(
        (entry) => time > entry.start && time < entry.end,
      )?.clip;
    if (!clip) return;
    const next = splitClip(project, clip.id, time);
    if (next.clips.length === project.clips.length) {
      say('Posiziona il cursore all’interno della clip da dividere');
      return;
    }
    edit(next);
    setPlaying(false);
    setSourceAssetId(null);
  }, [project, selectedClip, selectedId, selectedType, time, edit, say, effectSelection]);

  function selectTimeline(id: string, kind: 'clip' | 'audio') {
    setEffectSelection(undefined);
    setSelectedId(id);
    setSelectedType(kind);
    setActiveTrackId(kind==='clip'?getClipTrackId(project,id):getAudioTrackId(project,id));
    if (kind === 'audio') setSelectedIds([]);
    setSourceAssetId(null);
    setPlaying(false);
    const position =
      kind === 'clip'
        ? timelinePositions(project).find((entry) => entry.clip.id === id)
            ?.start
        : project.audioTracks.find((track) => track.id === id)?.start;
    if (position !== undefined) setTime(position);
  }

  function patchClip(patch: Partial<VideoClip>) {
    if (!selectedClip) return;
    try {
      edit(selectedIds.length > 1 && !Object.hasOwn(patch, 'start')
        ? updateClips(currentProject.current, selectedIds, patch)
        : updateClip(currentProject.current, selectedClip.id, patch));
    } catch (error) {
      say(String(error), true);
    }
  }

  function showEffects(selection?: string) {
    setPlaying(false);
    setSourceAssetId(null);
    setSelectedId(null);
    setSelectedIds([]);
    setEffectSelection(selection ?? 'film');
    setInspectorOpen(true);
    if (selection?.startsWith('subtitle')) setTab('captions');
  }

  function patchOverlay(id: string, patch: Partial<TimedOverlay>) {
    const base = currentProject.current;
    const overlay = base.overlays?.find(item => item.id === id);
    if (!overlay) return;
    const updated = { ...overlay, ...patch };
    if (!Number.isFinite(updated.start) || !Number.isFinite(updated.end) || updated.start < 0 || updated.end <= updated.start || updated.end > 86400) return;
    if ('start' in patch || 'end' in patch) updated.persistent = false;
    edit({ ...base, overlays: base.overlays!.map(item => item.id === id ? updated : item) });
  }

  function deleteEffect(id: string) {
    const base = currentProject.current;
    if (id === 'subtitles') {
      const index = getSubtitleEvents(base).findIndex(item=>time>=item.start&&time<item.end);
      if (index < 0) return;
      id = `subtitle:${index}`;
    }
    if (id.startsWith('subtitle:')) edit(removeSubtitleEvent(base, Number(id.split(':')[1])));
    else if (id === 'music') edit({ ...base, music: null });
    else edit({ ...base, overlays: base.overlays?.filter(item => item.id !== id) });
    setEffectSelection(id.startsWith('subtitle:') ? 'subtitles' : undefined);
  }

  function seekCaption(value: number) {
    setSourceAssetId(null);
    setPlaying(false);
    setTime(value);
  }

  function openAutomation(mode: 'shorts'|'transcribe'|'montage', assetId?: string) {
    setAutomationAssetId(assetId);
    setAutomationAssetIds(mode==='montage'&&selectedAssetIds.length?[...selectedAssetIds]:undefined);
    setPlaying(false);
    setModal(mode);
  }
  function addLogo(assetId:string, animation:OverlayAnimation='fade') {
    const base=currentProject.current;
    const asset=base.assets.find(item=>item.id===assetId&&item.kind==='image'&&!item.missing);
    if (!asset) { say('Importa un’immagine da usare come logo.',true); return; }
    const id=crypto.randomUUID();
    edit({...base,overlays:[...(base.overlays??[]),{id,kind:'image',assetId,start:0,end:projectDuration(base)||5,x:.86,y:.16,width:.2,opacity:1,animation,persistent:true}]});
    setSourceAssetId(null);setTime(.3);showEffects(id);
  }
  async function importLogo() {
    try {
      const result=await window.ducky.importMedia();
      if (!result.assets.length) return;
      const base=addAssets(currentProject.current,result.assets); edit(base);
      const source=result.assets.find(asset=>asset.kind==='image');
      const asset=base.assets.find(asset=>source&&canonicalMediaPath(asset.path)===canonicalMediaPath(source.path));
      if (asset) addLogo(asset.id); else say('Scegli un’immagine per il logo, per esempio PNG, JPG o WebP.',true);
    } catch(error) { say(String(error),true); }
  }
  function addAnimatedText() {
    const base=currentProject.current; const id=crypto.randomUUID();const start=Math.min(time,projectDuration(base));
    edit({...base,overlays:[...(base.overlays??[]),{id,kind:'text',text:'Il tuo testo',start,end:start+4,x:.5,y:.5,width:.65,opacity:1,animation:'fade-grow',color:'#ffffff',fontSize:.065}]});
    setSourceAssetId(null);setTime(start+.3);showEffects(id);
  }
  function addCap(assetId:string,role:'intro'|'outro') {
    try { const next=setProjectCap(currentProject.current,assetId,role);edit(next);const clip=next.clips.find(item=>item.role===role);if(clip){setSelectedId(clip.id);setSelectedIds([clip.id]);setSelectedType('clip');setActiveTrackId(getClipTrackId(next,clip.id));setTime(timelinePositions(next).find(item=>item.clip.id===clip.id)?.start??0);}setSourceAssetId(null);setPlaying(false);setInspectorOpen(true);say(`${role==='intro'?'Intro':'Outro'} inserita. Puoi regolare la clip nella timeline.`); }
    catch(error){say(String(error),true);}
  }

  function trimSelection(id: string, inPoint: number, outPoint: number) {
    try {
      edit(trimClip(currentProject.current, id, inPoint, outPoint));
    } catch (error) {
      say(String(error), true);
    }
  }

  function patchAudio(patch: Partial<AudioTrack>) {
    if (!selectedAudio) return;
    try { edit(updateAudioTrack(currentProject.current,selectedAudio.id,patch)); }
    catch(error){say(String(error),true);}
  }

  const openProject = useCallback(
    async (path?: string) => {
      if (changingProject.current) return;
      changingProject.current = true;
      setBusy(true);
      try {
        if (!(await saveBeforeReplacing())) return;
        const result = await window.ducky.openProject(path);
        if (!result) return;
        if (!(await saveBeforeReplacing())) return;
        currentProject.current = result.project;
        currentPath.current = result.path;
        currentSavedSnapshot.current = JSON.stringify(result.project);
        replaceEditorProject(result.project);
        setProjectPath(result.path);
        setSavedSnapshot(JSON.stringify(result.project));
        setSelectedId(null);
        setSelectedIds([]);
        setSourceAssetId(null);
        setTime(0);
        setPlaying(false);
        setModal(null);
        if (result.missingAssets.length)
          say(
            `File da ricollegare. ${result.missingAssets.join(', ')}. Ripristina i file nelle posizioni originali e riapri il progetto.`,
            true,
          );
        else say('Progetto aperto');
      } catch (error) {
        say(String(error), true);
      } finally {
        changingProject.current = false;
        setBusy(false);
      }
    },
    [saveBeforeReplacing, say, replaceEditorProject],
  );

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.defaultPrevented) return;
      if (document.querySelector('dialog[open]')) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (target.closest('input, textarea, select, [contenteditable="true"]') && !(modifier && ['s','o','i'].includes(event.key.toLowerCase()))) return;
      if (modifier && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save(event.shiftKey);
      } else if (modifier && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void openProject();
      } else if (modifier && event.key.toLowerCase() === 'i') {
        event.preventDefault();
        if (!busy) void importMedia();
      } else if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        setPlaying(false);
        applyHistory(event.shiftKey ? 'redo' : 'undo');
      } else if (modifier && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        setPlaying(false);
        applyHistory('redo');
      } else if (modifier && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        splitSelection();
      } else if (modifier && event.key.toLowerCase() === 'd' && (selectedClip || selectedAudio)) {
        event.preventDefault();
        edit(selectedAudio ? duplicateAudioTrack(project,selectedAudio.id) : duplicateClip(project,selectedClip!.id));
      } else if (modifier && event.key.toLowerCase() === 'a' && project.clips.length) {
        event.preventDefault();
        setSelectedIds(project.clips.map(clip => clip.id));
        setSelectedId(project.clips[0].id);
        setSelectedType('clip');
      } else if (modifier && event.key.toLowerCase() === 'c' && selectedType === 'clip' && selectedId) {
        event.preventDefault();
        const ids = new Set(selectedIds.length ? selectedIds : [selectedId]);
        copiedClips.current = timelinePositions(project).filter(entry=>ids.has(entry.clip.id)).map(entry=>({...structuredClone(entry.clip),start:entry.start,trackId:getClipTrackId(project,entry.clip.id)}));
        say(`${copiedClips.current.length} clip copiate`);
      } else if (modifier && event.key.toLowerCase() === 'v' && copiedClips.current.length) {
        event.preventDefault();
        const compatible=copiedClips.current.filter(clip=>project.assets.some(asset=>asset.id===clip.assetId)&&getProjectTracks(project).some(track=>track.id===clip.trackId&&track.kind==='video'));
        const firstStart=Math.min(...compatible.map(clip=>clip.start??0));
        const copies = compatible.map(clip=>({...structuredClone(clip),id:crypto.randomUUID(),start:duration+(clip.start??0)-firstStart}));
        if (copies.length) {
          edit(copyLinkedSubtitles(project, { ...project, clips: [...project.clips, ...copies] }, compatible.map((clip,index)=>({kind:'clip',id:clip.id,newId:copies[index].id}))));
          setSelectedIds(copies.map(clip => clip.id)); setSelectedId(copies[0].id); setSelectedType('clip');
          setSourceAssetId(null); setTime(duration); setPlaying(false);
        }
      } else if (!modifier && !event.altKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        if (!event.repeat) setSnappingEnabled(value => !value);
      } else if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        (selectedId || effectSelection && !['film','subtitles','protected-area'].includes(effectSelection))
      ) {
        event.preventDefault();
        deleteSelection();
      } else if (
        event.code === 'Space' &&
        (!target.closest('button') || target.closest('.timeline-audio-clip'))
      ) {
        event.preventDefault();
        if (previewDuration) setPlaying((value) => !value);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        setPlaying(false);
        changePreviewTime(
          Math.max(
            0,
            Math.min(
              previewDuration,
              previewTime +
                (event.key === 'ArrowLeft' ? -1 : 1) *
                  (event.shiftKey ? 1 : 1 / 30),
            ),
          ),
        );
      } else if (event.key === 'Home') {
        event.preventDefault();
        setPlaying(false);
        changePreviewTime(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        setPlaying(false);
        changePreviewTime(previewDuration);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [
    project,
    save,
    openProject,
    importMedia,
    splitSelection,
    deleteSelection,
    selectedClip,
    selectedAudio,
    selectedId,
    selectedIds,
    selectedType,
    effectSelection,
    applyHistory,
    duration,
    edit,
    modal,
    recovery,
    previewDuration,
    previewTime,
    sourceProject,
    busy,
  ]);

  async function startExport() {
    document.dispatchEvent(new Event('ducky:commit-drafts'));
    const exportProject = currentProject.current;
    setPlaying(false);
    setExportPending(true);
    setExportProgress(null);
    try {
      const shortSide = { '720p': 720, '1080p': 1080, '1440p': 1440, '2160p': 2160 }[exportSettings.resolution];
      const longSide = Math.round(shortSide * 16 / 9 / 2) * 2;
      const width = exportProject.aspectRatio === '16:9' ? longSide : shortSide;
      const height = exportProject.aspectRatio === '9:16' ? longSide : shortSide;
      const result = await window.ducky.exportVideo(exportProject, { ...exportSettings,
        framePng: exportProject.frame && exportProject.frame.style !== 'none' ? renderFramePNG(exportProject.frame, width, height) ?? undefined : undefined,
      });
      if (result)
        setExportProgress((previous) =>
          previous?.jobId === result.jobId
            ? previous
            : {
                jobId: result.jobId,
                path: result.path,
                progress: 0,
                state: 'running',
              },
        );
    } catch (error) {
      say(String(error), true);
    } finally {
      setExportPending(false);
    }
  }

  async function showProjects() {
    setModal('projects');
    try {
      setRecent(await window.ducky.getRecentProjects());
    } catch (error) {
      say(String(error), true);
    }
  }

  async function applyGeneratedProject(next: Project, replace = false, summary?: string) {
    if (replace && (modal === 'montage' || modal === 'shorts')) {
      document.dispatchEvent(new Event('ducky:commit-drafts'));
      const base=currentProject.current;
      edit({...next,id:base.id,createdAt:base.createdAt});
      setTime(0); setSelectedId(null); setSelectedIds([]); setSourceAssetId(null);
      setEffectSelection(undefined);
      const timelineWidth=document.querySelector('.timeline-scroll')?.clientWidth??900;
      setZoom(Math.max(MIN_TIMELINE_ZOOM,Math.min(MAX_TIMELINE_ZOOM,(timelineWidth-TIMELINE_GUTTER-32)/Math.max(.01,projectDuration(next)))));
    } else if (replace) {
      if (!(await saveBeforeReplacing())) return;
      currentProject.current = next;
      currentPath.current = undefined;
      currentSavedSnapshot.current = '';
      replaceEditorProject(next);
      setProjectPath(undefined); setSavedSnapshot('');
      setTime(0); setSelectedId(null); setSelectedIds([]); setSourceAssetId(null);
    } else {
      if (currentProject.current.id !== next.id) throw new Error('Il progetto è cambiato durante la trascrizione. Ripeti l’operazione sul film aperto.');
      const base=addAssets(currentProject.current,next.assets);
      const trackIds=new Set(getProjectTracks(base).map(track=>track.id));
      const audioIds=new Set(base.audioTracks.map(track=>track.id));
      edit({ ...base, subtitles: next.subtitles, duration:Math.max(projectDuration(base),projectDuration(next)),tracks:[...getProjectTracks(base),...getProjectTracks(next).filter(track=>!trackIds.has(track.id))],audioTracks:[...base.audioTracks,...next.audioTracks.filter(track=>!audioIds.has(track.id))] });
    }
    setPlaying(false);
    setModal(null);
    if (!replace) showEffects('subtitles');
    say(summary || (replace ? 'Montaggio pronto e modificabile. Ctrl+Z ripristina il montaggio precedente.' : 'Sottotitoli aggiunti al film'));
  }

  async function newProject() {
    if (changingProject.current) return;
    changingProject.current = true;
    try {
      if (!(await saveBeforeReplacing())) return;
      const next = {
        ...createProject(newName.trim() || 'Il mio film'),
        aspectRatio: newRatio,
      };
      currentProject.current = next;
      currentPath.current = undefined;
      currentSavedSnapshot.current = JSON.stringify(next);
      replaceEditorProject(next);
      setProjectPath(undefined);
      setSavedSnapshot(JSON.stringify(next));
      setTime(0);
      setSelectedId(null);
      setSourceAssetId(null);
      setPlaying(false);
      setModal(null);
      await window.ducky
        .autosave(next)
        .catch((error) => say(String(error), true));
    } finally {
      changingProject.current = false;
    }
  }

  async function discardRecovery() {
    try {
      await window.ducky.clearAutosave();
      setRecovery(null);
    } catch (error) {
      say(
        `Impossibile rimuovere il salvataggio di recupero. ${String(error)}`,
        true,
      );
    }
  }

  async function resumeRecovery() {
    if (!recovery || changingProject.current) return;
    changingProject.current = true;
    try {
      if (!(await saveBeforeReplacing())) return;
      currentProject.current = recovery;
      currentPath.current = undefined;
      currentSavedSnapshot.current = '';
      replaceEditorProject(recovery);
      setProjectPath(undefined);
      setSavedSnapshot('');
      setRecovery(null);
      setSelectedId(null);
      setSourceAssetId(null);
      setTime(0);
      setPlaying(false);
      say('Progetto recuperato. Salvalo per scegliere una cartella.');
    } finally {
      changingProject.current = false;
    }
  }

  const visibleAssets = project.assets.filter(
    (asset) =>
      asset.name
        .toLocaleLowerCase('it')
        .includes(query.toLocaleLowerCase('it')) &&
      (tab === 'audio'
        ? asset.kind === 'audio'
        : mediaFilter === 'all' || asset.kind === mediaFilter),
  );
  const aspectStyle = project.aspectRatio.replace(':', ' / ');

  return (
    <div
      className="app"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          if (modal === 'update') return;
          setDraggingFiles(true);
        }
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
          setDraggingFiles(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDraggingFiles(false);
        if (busy || modal === 'update') return;
        const paths = Array.from(event.dataTransfer.files)
          .map((file) => window.ducky.getPathForFile(file))
          .filter(Boolean);
        if (paths.length) void importMedia(paths);
      }}
    >
      <header className="app-header">
        <button
          className="brand"
          onClick={() => void showProjects()}
          title="Progetti DuckyMovie"
        >
          <img className="duck-logo" src="./icon.png" alt="" />
          <span>
            Ducky<span className="brand-light">Movie</span>
          </span>
        </button>
        <div className="header-divider" />
        <button className="projects-button" onClick={() => void showProjects()}>
          <FolderOpen size={16} /> Progetti
        </button>
        <div className="project-title">
          <input
            aria-label="Nome del progetto"
            value={project.name}
            maxLength={100}
            onChange={(event) =>
              edit({
                ...project,
                name: event.target.value,
                updatedAt: new Date().toISOString(),
              })
            }
            onBlur={() => {
              if (!project.name.trim())
                edit({ ...project, name: 'Il mio film' });
            }}
          />
          <span
            className={`save-state ${dirty ? 'dirty' : ''}`}
            title={
              projectPath ?? 'Salva il progetto per scegliere una cartella'
            }
          >
            {saving ? (
              <LoaderCircle size={11} className="spin" />
            ) : (
              <span className="status-dot" />
            )}
            {saving
              ? 'Salvataggio…'
              : dirty
                ? autosaved
                  ? 'Recupero automatico aggiornato'
                  : 'Modifiche da salvare'
                : projectPath
                  ? 'Salvato'
                  : 'Nuovo progetto'}
          </span>
        </div>
        <div className="header-actions">
          <IconButton
            label="Apri progetto · Ctrl+O"
            onClick={() => void openProject()}
          >
            <FolderOpen size={18} />
          </IconButton>
          <IconButton
            label="Salva progetto · Ctrl+S"
            onClick={() => void save()}
            disabled={saving}
          >
            <Save size={18} />
          </IconButton>
          <button
            className="primary-button export-button"
            onClick={() => setModal('export')}
            disabled={!duration || !!recovery}
          >
            <Upload size={16} /> Esporta film
          </button>
        </div>
      </header>

      <div className="workspace-toolbar">
        <div className="workspace-label">
          <span className="workspace-dot" /> Montaggio
        </div>
        <div className="project-settings">
          <label>
            Formato{' '}
            <select
              aria-label="Formato del film"
              value={project.aspectRatio}
              onChange={(event) =>
                edit({
                  ...project,
                  aspectRatio: event.target.value as Project['aspectRatio'],
                  updatedAt: new Date().toISOString(),
                })
              }
            >
              <option value="16:9">16:9 · Orizzontale</option>
              <option value="9:16">9:16 · Verticale</option>
              <option value="1:1">1:1 · Quadrato</option>
            </select>
          </label>
          <span className="toolbar-separator" />
          <span>Anteprima</span>
          <span className="muted">30 fps</span>
        </div>
        <IconButton
          label={inspectorOpen ? 'Nascondi proprietà' : 'Mostra proprietà'}
          onClick={() => setInspectorOpen(!inspectorOpen)}
          aria-pressed={inspectorOpen}
        >
          <Settings2 size={17} />
        </IconButton>
        <button className="workspace-action" aria-label="Montaggio automatico" onClick={() => openAutomation('montage')}><Sparkles size={16}/><span>Montaggio automatico</span></button>
        <button className="workspace-action" aria-label="Crea shorts" onClick={() => openAutomation('shorts')}><Smartphone size={16}/><span>Shorts</span></button>
        <button className="workspace-action" aria-label="Trascrivi e crea sottotitoli" onClick={() => openAutomation('transcribe',sourceAsset?.hasAudio?sourceAsset.id:undefined)}><FileText size={16}/><span>Trascrivi audio</span></button>
        <IconButton label="Proprietà del film · sottotitoli, comparse e musica" onClick={() => showEffects()}><SlidersHorizontal size={17} /></IconButton>
      </div>

      <main
        className={`editor-workspace ${inspectorOpen ? '' : 'inspector-hidden'}`}
      >
        <nav className="library-nav" aria-label="Libreria del progetto">
          {tabs.map(({ id, name, icon: Icon }) => (
            <button
              key={id}
              className={tab === id ? 'active' : ''}
              onClick={() => {
                setTab(id);
                if (id === 'captions') showEffects('subtitles');
                setQuery('');
              }}
              title={name}
              aria-label={name}
              aria-pressed={tab === id}
            >
              <Icon size={21} />
              <span>{name}</span>
            </button>
          ))}
          <button
            className="help-nav"
            onClick={() => setModal('help')}
            title="Guida e scorciatoie"
            aria-label="Guida e scorciatoie"
          >
            <CircleHelp size={20} />
            <span>Guida</span>
          </button>
        </nav>
        <section
          className="library-panel"
          aria-label={tabs.find((item) => item.id === tab)?.name}
          onKeyDown={event=>{
            if(!['media','audio'].includes(tab)||(event.target as HTMLElement).closest('input:not([type="checkbox"]),textarea,select,[contenteditable="true"]')||document.querySelector('dialog[open]'))return;
            if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();event.stopPropagation();setSelectedAssetIds(visibleAssets.filter(asset=>!asset.missing).map(asset=>asset.id));}
            else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setSelectedAssetIds([]);}
            else if(['Delete','Backspace'].includes(event.key)){event.preventDefault();event.stopPropagation();if(!event.repeat)requestLibraryRemoval();}
            else if((event.ctrlKey||event.metaKey)&&['b','c','d','v'].includes(event.key.toLowerCase()))event.stopPropagation();
          }}
        >
          <div className="panel-heading">
            <h2>{tabs.find((item) => item.id === tab)?.name}</h2>
            {(tab === 'media' || tab === 'audio') && (
              <IconButton
                label="Importa file · Ctrl+I"
                disabled={busy}
                onClick={() => void importMedia()}
              >
                <Plus size={19} />
              </IconButton>
            )}
          </div>
          {(tab === 'media' || tab === 'audio') && (
            <>
              <div className="library-tools">
                <label className="search-field">
                  <Search size={14} />
                  <input
                    aria-label="Cerca nella libreria"
                    placeholder="Cerca nella libreria"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                {tab === 'media' && (
                  <div className="segmented media-segmented">
                    {[
                      ['all', 'Tutti'],
                      ['video', 'Video'],
                      ['image', 'Foto'],
                      ['audio', 'Audio'],
                    ].map(([id, name]) => (
                      <button
                        key={id}
                        className={mediaFilter === id ? 'active' : ''}
                        onClick={() => setMediaFilter(id)}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {project.assets.length>0&&<div className="library-selection-tools">
                <div className="library-selection-count"><button className="text-button" aria-label="Seleziona tutti i media" onClick={()=>setSelectedAssetIds(visibleAssets.filter(asset=>!asset.missing).map(asset=>asset.id))}>Seleziona tutti</button><span aria-live="polite">{selectedAssetIds.length} selezionati</span><button className="text-button" aria-label="Deseleziona media" disabled={!selectedAssetIds.length} onClick={()=>{setSelectedAssetIds([]);assetAnchor.current=null;}}>Deseleziona</button></div>
                <button className="secondary-button full-width" aria-label="Aggiungi selezione alla timeline" disabled={!selectedAssetIds.length} onClick={()=>addLibrarySelection()}><Plus size={14}/>Aggiungi {selectedAssetIds.length>1?`${selectedAssetIds.length} media`:'alla timeline'}</button><button className="text-button library-montage" disabled={!selectedAssetIds.length} onClick={()=>openAutomation('montage')}><Sparkles size={13}/>Monta la selezione</button>
                <p>Trascina dal vuoto per il lazo · Ctrl+clic aggiunge · Maiusc+clic seleziona un intervallo · Canc rimuove dal progetto</p>
              </div>}
              <MediaSelectionArea selectedIds={selectedAssetIds} availableIds={visibleAssets.filter(asset=>!asset.missing).map(asset=>asset.id)} onSelectionChange={ids=>{setSelectedAssetIds(ids);assetAnchor.current=ids[0]??null;}}>
                {visibleAssets.length ? (
                  <div className="asset-grid">
                    {visibleAssets.map((asset) => (
                      <div
                        key={asset.id}
                        data-asset-id={asset.id}
                        className={`asset-card ${selectedAssetIds.includes(asset.id) ? 'selected' : ''} ${asset.missing ? 'missing' : ''}`}
                        onClick={event=>{if(!asset.missing&&!(event.target as HTMLElement).closest('button')){selectLibraryAsset(asset.id,event);event.currentTarget.querySelector<HTMLButtonElement>('.asset-preview')?.focus({preventScroll:true});}}}
                      >
                        <button
                          className="asset-preview"
                          disabled={asset.missing}
                          draggable={!asset.missing}
                          aria-label={`Anteprima di ${asset.name}`}
                          aria-pressed={selectedAssetIds.includes(asset.id)}
                          title={`${asset.name}\n${asset.kind === 'image' ? `${asset.width} × ${asset.height}` : formatDuration(asset.duration)}\nDoppio clic per aggiungere al film`}
                          onDragStart={(event) => {
                            const ids=selectedAssetIds.includes(asset.id)?selectedAssetIds.filter(id=>project.assets.some(item=>item.id===id&&!item.missing)):[asset.id];
                            if(!selectedAssetIds.includes(asset.id))setSelectedAssetIds([asset.id]);
                            if(ids.length>1)event.dataTransfer.setData('application/x-ducky-assets',JSON.stringify(ids));
                            event.dataTransfer.setData(
                              'application/x-ducky-asset',
                              asset.id,
                            );
                            event.dataTransfer.effectAllowed = 'copy';
                          }}
                          onClick={event => selectLibraryAsset(asset.id,event)}
                          onDoubleClick={event =>
                            !asset.missing && !event.ctrlKey && !event.metaKey && !event.shiftKey && addLibrarySelection([asset.id])
                          }
                        >
                          {asset.thumbnail ? (
                            <img src={asset.thumbnail} alt="" loading="lazy" />
                          ) : (
                            <div className="asset-fallback">
                              {asset.kind === 'audio' ? (
                                <Music2 size={24} />
                              ) : asset.kind === 'image' ? (
                                <Image size={24} />
                              ) : (
                                <Film size={24} />
                              )}
                            </div>
                          )}
                          <span className="asset-type">
                            {asset.kind === 'audio' ? (
                              <Music2 size={10} />
                            ) : asset.kind === 'image' ? (
                              <Image size={10} />
                            ) : (
                              <Film size={10} />
                            )}
                          </span>
                          <span className="asset-duration">
                            {asset.missing
                              ? 'File mancante'
                              : asset.kind === 'image'
                                ? 'FOTO'
                                : formatDuration(asset.duration)}
                          </span>
                        </button>
                        <div className="asset-bottom">
                          <span title={asset.name}>{asset.name}</span>
                          <button
                            title={`Aggiungi ${asset.name} al film`}
                            aria-label={`Aggiungi ${asset.name} al film`}
                            disabled={asset.missing}
                            onClick={() => addLibrarySelection([asset.id])}
                          >
                            <Plus size={14} />
                          </button>
                        </div>
                        {asset.hasAudio && <button className="asset-transcribe" disabled={asset.missing} onClick={()=>openAutomation('transcribe',asset.id)} aria-label={`Trascrivi ${asset.name}`}><FileText size={12}/>Trascrivi</button>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="library-empty">
                    <div className="empty-import-icon">
                      {tab === 'audio' ? (
                        <Music2 size={28} strokeWidth={1.4} />
                      ) : (
                        <Film size={30} strokeWidth={1.4} />
                      )}
                    </div>
                    <h3>
                      {query
                        ? 'Nessun file trovato'
                        : tab === 'audio'
                          ? 'Aggiungi audio e registrazioni'
                          : project.assets.length
                            ? 'Nessun file in questa categoria'
                            : 'La libreria è vuota'}
                    </h3>
                    <p>
                      {query
                        ? 'Prova a cercare con un altro nome.'
                        : tab === 'audio'
                          ? 'Importa musica o registrazioni dal tuo PC e aggiungile alla timeline.'
                          : 'Importa video, immagini o audio, poi trascinali nella timeline.'}
                    </p>
                    {!query && (
                      <button
                        className="primary-button"
                        onClick={() => void importMedia()}
                        disabled={busy}
                      >
                        {busy ? (
                          <LoaderCircle size={16} className="spin" />
                        ) : (
                          <Plus size={16} />
                        )}
                        {busy
                          ? 'Importazione…'
                          : tab === 'audio'
                            ? 'Importa audio'
                            : 'Importa media'}
                      </button>
                    )}
                    {!query && (
                      <small>
                        {tab === 'audio'
                          ? 'MP3, WAV, AAC, FLAC, M4A'
                          : 'Video, immagini e audio'}
                      </small>
                    )}
                  </div>
                )}
              </MediaSelectionArea>
              <div className="library-footer">
                <span>
                  {visibleAssets.length}{' '}
                  {visibleAssets.length === 1 ? 'elemento' : 'elementi'}
                </span>
                <span>
                  File sul tuo PC <span className="local-dot" />
                </span>
              </div>
            </>
          )}
          {tab === 'captions' && <CaptionEditor key={editorGeneration} project={project} time={time} onChange={edit} onSeek={seekCaption} selectedIndex={effectSelection?.startsWith('subtitle:') ? Number(effectSelection.split(':')[1]) : undefined} onSelect={index=>showEffects(`subtitle:${index}`)} onTranscribe={()=>openAutomation('transcribe')} onStyle={()=>showEffects('subtitles')} onExport={async format=>{if(project.subtitles)await window.ducky.exportTranscript(project.subtitles,format);}} onError={message=>say(message,true)}/>}
          {(['shorts','branding','caps'] as string[]).includes(tab) && <StudioPanel section={tab as StudioSection} project={project} onImport={()=>importMedia()} onOpen={openAutomation} onEffects={showEffects} onLogo={addLogo} onImportLogo={importLogo} onText={addAnimatedText} onCap={addCap} onRemoveCap={role=>{try{edit(removeProjectCap(project,role));}catch(error){say(String(error),true);}}} onSelectClip={id=>{selectTimeline(id,'clip');setInspectorOpen(true);}} onError={message=>say(message,true)}/>}
          {tab === 'titles' && (
            <div className="presets-panel">
              <button className="primary-button full-width" onClick={addAnimatedText}><Type size={16}/>Aggiungi testo animato</button>
              <p className="panel-description">Il testo animato ha una durata indipendente e funziona anche senza una clip video. Puoi scegliere animazione, dimensione, colore e posizione.</p>
              <p className="panel-description">
                Scegli un titolo per la clip selezionata.
              </p>
              {(['center', 'lower', 'cinema'] as const).map((style) => (
                <button
                  key={style}
                  className={`title-preset ${style}`}
                  disabled={!selectedClip}
                  onClick={() => {
                    patchClip({
                      title: {
                        text: selectedClip?.title?.text ?? 'La mia storia',
                        style,
                        color: '#ffffff',
                      },
                    });
                    setInspectorTab('title');
                    setInspectorOpen(true);
                  }}
                >
                  <span className="title-example">
                    <span>
                      {style === 'cinema'
                        ? 'LA MIA STORIA'
                        : style === 'lower'
                          ? 'Un momento da ricordare'
                          : 'La mia storia'}
                    </span>
                    {style === 'cinema' && <small>UN FILM DI RICORDI</small>}
                  </span>
                  <span className="preset-label">
                    {style === 'center'
                      ? 'Essenziale'
                      : style === 'lower'
                        ? 'Sottopancia'
                        : 'Cinema'}
                    <Plus size={14} />
                  </span>
                </button>
              ))}
              {!selectedClip && (
                <p className="selection-hint">
                  <Info size={14} /> Seleziona una clip nella timeline.
                </p>
              )}
            </div>
          )}
          {tab === 'transitions' && (
            <div className="presets-panel">
              <p className="panel-description">
                Scegli il passaggio dalla clip precedente a quella selezionata, sulla stessa traccia. I testi e i loghi hanno animazioni proprie nelle loro proprietà.
              </p>
              {([['none','Taglio diretto'],['fade','Dissolvenza incrociata'],['black','Passaggio al nero'],['white','Passaggio al bianco'],['zoom','Zoom'],['blur','Sfocatura']] as const).map(([transition,label]) => (
                <button
                  className="transition-preset"
                  key={transition}
                  disabled={!selectedClip}
                  onClick={() =>
                    patchClip({
                      transition,
                      transitionDuration: Math.min(.5,clipDuration(selectedClip!)/2),
                    })
                  }
                >
                  <span className={`transition-example ${transition==='none'?'':'fade'}`}>
                    <span />
                    <ArrowRight size={20} />
                    <span />
                  </span>
                  <span className="preset-label">
                    {label}
                    <Plus size={14} />
                  </span>
                </button>
              ))}
              {!selectedClip && (
                <p className="selection-hint">
                  <Info size={14} /> Seleziona una clip nella timeline.
                </p>
              )}
            </div>
          )}
          {tab === 'filters' && (
            <div className="presets-panel">
              <p className="panel-description">
                Dai un’atmosfera alla clip selezionata.
              </p>
              <div className="filter-grid">
                {filters.map((filter) => (
                  <button
                    key={filter.id}
                    className={`filter-preset ${selectedClip?.filter === filter.id ? 'selected' : ''}`}
                    disabled={!selectedClip}
                    onClick={() => patchClip({ filter: filter.id })}
                  >
                    <span className={`filter-sample ${filter.id}`}>
                      {selectedAsset?.thumbnail ? (
                        <img src={selectedAsset.thumbnail} alt="" />
                      ) : (
                        <span className="sample-landscape" />
                      )}
                    </span>
                    <span>
                      {filter.label}
                      {selectedClip?.filter === filter.id && (
                        <Check size={12} />
                      )}
                    </span>
                  </button>
                ))}
              </div>
              {!selectedClip && (
                <p className="selection-hint">
                  <Info size={14} /> Seleziona una clip nella timeline.
                </p>
              )}
            </div>
          )}
        </section>

        <section className="viewer-panel" aria-label="Anteprima del film">
          <div className="viewer-heading">
            <span>{sourceProject ? 'Sorgente' : 'Il tuo film'}</span>
            {sourceProject ? (
              <button
                className="text-button"
                onClick={() => {
                  setSourceAssetId(null);
                  setPlaying(false);
                }}
              >
                Torna al film <ArrowRight size={13} />
              </button>
            ) : (
              <span className="viewer-format">{project.aspectRatio}</span>
            )}
          </div>
          <div
            className="viewer-canvas"
            style={{ '--film-ratio': aspectStyle } as React.CSSProperties}
          >
            {previewDuration > 0 ? (
              <Preview
                project={previewProject}
                time={previewTime}
                playing={playing}
                onTimeChange={changePreviewTime}
                onPlayingChange={setPlaying}
                onError={(message) => say(message, true)}
                onChange={sourceProject ? undefined : edit}
                onSelectOverlay={id=>{const index=id==='subtitles'?getSubtitleEvents(currentProject.current).findIndex(item=>time>=item.start&&time<=item.end):-1;showEffects(index>=0?`subtitle:${index}`:id);}}
                selectedOverlayId={effectSelection}
                onDeleteOverlay={deleteEffect}
              />
            ) : (
              <div className="viewer-empty">
                <div className="empty-frame">
                  <Clapperboard size={42} strokeWidth={1} />
                  <span className="frame-corner tl" />
                  <span className="frame-corner tr" />
                  <span className="frame-corner bl" />
                  <span className="frame-corner br" />
                </div>
                <h2>Il tuo film è ancora vuoto</h2>
                <p>Aggiungi una clip con + o trascinala nella timeline.</p>
              </div>
            )}
          </div>
          <div className="viewer-transport">
            <span className="timecode">
              {formatTimecode(previewTime)}
              <span> / {formatTimecode(previewDuration)}</span>
            </span>
            <div className="transport-buttons">
              <IconButton
                label="Torna all’inizio · Home"
                disabled={!previewDuration}
                onClick={() => {
                  changePreviewTime(0);
                  setPlaying(false);
                }}
              >
                <SkipBack size={16} fill="currentColor" />
              </IconButton>
              <button
                className="play-button"
                aria-label={playing ? 'Pausa · Spazio' : 'Riproduci · Spazio'}
                disabled={!previewDuration}
                onClick={() => {
                  if (previewTime >= previewDuration) changePreviewTime(0);
                  setPlaying(!playing);
                }}
              >
                {playing ? (
                  <Pause size={20} fill="currentColor" />
                ) : (
                  <Play size={20} fill="currentColor" />
                )}
              </button>
              <IconButton
                label="Vai alla fine · End"
                disabled={!previewDuration}
                onClick={() => {
                  changePreviewTime(previewDuration);
                  setPlaying(false);
                }}
              >
                <SkipForward size={16} fill="currentColor" />
              </IconButton>
            </div>
            <IconButton
              label="Schermo intero anteprima"
              disabled={!previewDuration}
              onClick={() => {
                const stage = document.querySelector('.viewer-canvas');
                if (document.fullscreenElement) void document.exitFullscreen();
                else
                  void stage
                    ?.requestFullscreen()
                    .catch((error) => say(String(error), true));
              }}
            >
              <Maximize size={16} />
            </IconButton>
          </div>
          {sourceProject && (
            <div className="source-bar">
              <span title={sourceAsset?.name}>{sourceAsset?.name}</span>
              <button
                className="text-button"
                onClick={() => sourceAsset && addLibrarySelection([sourceAsset.id])}
              >
                <Plus size={14} /> Aggiungi al film
              </button>
            </div>
          )}
        </section>

        {inspectorOpen && (
          <aside className="inspector" aria-label="Proprietà della selezione">
            <div className="panel-heading">
              <h2>{effectSelection?.startsWith('subtitle') ? 'Stile sottotitoli' : effectSelection === 'film' ? 'Proprietà del film' : effectSelection ? 'Proprietà elemento' : 'Proprietà'}</h2>
              <Settings2 size={15} className="muted" />
            </div>
            {effectSelection ? <div className="inspector-content effect-inspector"><p className="panel-description">{effectSelection.startsWith('subtitle') ? 'Modifica le frasi a sinistra. Qui scegli lo stile del testo.' : effectSelection === 'film' ? 'Aspetto, musica e impostazioni del film.' : 'Trascina i bordi nella timeline per cambiare la durata. Sposta e ridimensiona nell’anteprima.'}</p><AdvancedInspector project={project} selectedItem={effectSelection} focused={effectSelection !== 'film'} onSelect={showEffects} onEditCaptions={()=>showEffects('subtitles')} onChange={edit}/></div> : selectedClip || selectedAudio ? (
              <>
                <div className="selection-name">
                  <span className="selection-icon">
                    {selectedAudio ? <Music2 size={17} /> : <Film size={17} />}
                  </span>
                  <div>
                    <strong title={selectedAsset?.name}>
                      {selectedAsset?.name}
                    </strong>
                    <small>
                      {selectedAudio
                        ? 'Traccia audio'
                        : `${selectedAsset?.kind === 'image' ? 'Foto' : 'Clip video'} · ${formatDuration(clipDuration(selectedClip!))}`}
                    </small>
                  </div>
                </div>
                {selectedClip && (
                  <div className="inspector-tabs">
                    {[
                      ['video', 'Video'],
                      ['audio', 'Audio'],
                      ['title', 'Titolo'],
                    ].map(([id, label]) => (
                      <button
                        key={id}
                        className={inspectorTab === id ? 'active' : ''}
                        onClick={() =>
                          setInspectorTab(id as typeof inspectorTab)
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="inspector-content">
                  {selectedClip && inspectorTab === 'video' && (
                    <>
                      <AdvancedInspector project={project} selectedClip={selectedClip} onChange={edit} onClipPatch={patchClip} />
                      <section className="control-section">
                        <h3>
                          Ritaglio e durata <Scissors size={13} />
                        </h3>
                        <div className="number-pair">
                          <label>
                            Entrata{' '}
                            <div>
                              <input
                                aria-label="Entrata clip in secondi"
                                type="number"
                                min={0}
                                max={selectedClip.out - 0.04}
                                step={0.1}
                                value={Number(selectedClip.in.toFixed(2))}
                                onChange={(event) => {
                                  const value = Number(event.target.value);
                                  if (
                                    Number.isFinite(value) &&
                                    value >= 0 &&
                                    value < selectedClip.out - 0.03
                                  )
                                    trimSelection(
                                      selectedClip.id,
                                      value,
                                      selectedClip.out,
                                    );
                                }}
                              />
                              <span>s</span>
                            </div>
                          </label>
                          <label>
                            Uscita{' '}
                            <div>
                              <input
                                aria-label="Uscita clip in secondi"
                                type="number"
                                min={selectedClip.in + 0.04}
                                max={
                                  selectedAsset?.kind === 'image'
                                    ? 3600
                                    : selectedAsset?.duration
                                }
                                step={0.1}
                                value={Number(selectedClip.out.toFixed(2))}
                                onChange={(event) => {
                                  const value = Number(event.target.value);
                                  if (
                                    Number.isFinite(value) &&
                                    value > selectedClip.in + 0.03 &&
                                    value <=
                                      (selectedAsset?.kind === 'image'
                                        ? 3600
                                        : (selectedAsset?.duration ?? 0))
                                  )
                                    trimSelection(
                                      selectedClip.id,
                                      selectedClip.in,
                                      value,
                                    );
                                }}
                              />
                              <span>s</span>
                            </div>
                          </label>
                        </div>
                        <label className="select-control">
                          Velocità
                          <select
                            aria-label="Velocità della clip"
                            value={selectedClip.speed}
                            onChange={(event) =>
                              patchClip({ speed: Number(event.target.value) })
                            }
                          >
                            {[0.25, 0.5, 1, 1.5, 2, 4].map((speed) => (
                              <option key={speed} value={speed}>
                                {speed}×{speed === 1 ? ' · Normale' : ''}
                              </option>
                            ))}
                          </select>
                        </label>
                      </section>
                      <section className="control-section">
                        <h3>Inquadratura</h3>
                        <div className="segmented">
                          <button
                            className={
                              selectedClip.fit === 'contain' ? 'active' : ''
                            }
                            onClick={() => patchClip({ fit: 'contain' })}
                          >
                            Adatta
                          </button>
                          <button
                            className={
                              selectedClip.fit === 'cover' ? 'active' : ''
                            }
                            onClick={() => patchClip({ fit: 'cover' })}
                          >
                            Riempi
                          </button>
                        </div>
                        <button
                          className="secondary-button full-width"
                          onClick={() =>
                            patchClip({
                              rotation: ((selectedClip.rotation + 90) %
                                360) as VideoClip['rotation'],
                            })
                          }
                        >
                          <RotateCw size={14} /> Ruota di 90°{' '}
                          <span className="muted">
                            {selectedClip.rotation}°
                          </span>
                        </button>
                      </section>
                      <section className="control-section">
                        <h3>
                          Colore{' '}
                          <button
                            className="text-button"
                            onClick={() =>
                              patchClip({
                                brightness: 0,
                                contrast: 1,
                                saturation: 1,
                                filter: 'none',
                              })
                            }
                          >
                            Ripristina
                          </button>
                        </h3>
                        <label className="select-control">
                          Filtro
                          <select
                            aria-label="Filtro colore"
                            value={selectedClip.filter}
                            onChange={(event) =>
                              patchClip({
                                filter: event.target.value as ColorFilter,
                              })
                            }
                          >
                            {filters.map((filter) => (
                              <option key={filter.id} value={filter.id}>
                                {filter.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <RangeControl
                          label="Luminosità"
                          min={-0.5}
                          max={0.5}
                          value={selectedClip.brightness}
                          display={`${Math.round(selectedClip.brightness * 100)}`}
                          onChange={(value) => patchClip({ brightness: value })}
                        />
                        <RangeControl
                          label="Contrasto"
                          min={0.5}
                          max={1.5}
                          value={selectedClip.contrast}
                          display={`${Math.round(selectedClip.contrast * 100)}%`}
                          onChange={(value) => patchClip({ contrast: value })}
                        />
                        <RangeControl
                          label="Saturazione"
                          min={0}
                          max={2}
                          value={selectedClip.saturation}
                          display={`${Math.round(selectedClip.saturation * 100)}%`}
                          onChange={(value) => patchClip({ saturation: value })}
                        />
                      </section>
                      <section className="control-section">
                        <h3>Dissolvenza al nero</h3>
                        <RangeControl
                          label="Entrata"
                          min={0}
                          max={Math.min(3, clipDuration(selectedClip) / 2)}
                          step={0.05}
                          value={selectedClip.fadeIn}
                          display={`${selectedClip.fadeIn.toFixed(2)} s`}
                          onChange={(value) => patchClip({ fadeIn: value })}
                        />
                        <RangeControl
                          label="Uscita"
                          min={0}
                          max={Math.min(3, clipDuration(selectedClip) / 2)}
                          step={0.05}
                          value={selectedClip.fadeOut}
                          display={`${selectedClip.fadeOut.toFixed(2)} s`}
                          onChange={(value) => patchClip({ fadeOut: value })}
                        />
                      </section>
                    </>
                  )}
                  {selectedClip && inspectorTab === 'audio' && (
                    <section className="control-section">
                      <h3>
                        Audio originale <Volume2 size={14} />
                      </h3>
                      <button
                        className="secondary-button full-width"
                        aria-pressed={selectedClip.muted}
                        onClick={() =>
                          patchClip({ muted: !selectedClip.muted })
                        }
                      >
                        {selectedClip.muted ? (
                          <VolumeX size={16} />
                        ) : (
                          <Volume2 size={16} />
                        )}
                        {selectedClip.muted
                          ? 'Audio disattivato'
                          : 'Audio attivo'}
                      </button>
                      <RangeControl
                        label="Volume"
                        min={0}
                        max={1}
                        value={selectedClip.volume}
                        display={`${Math.round(selectedClip.volume * 100)}%`}
                        onChange={(value) => patchClip({ volume: value })}
                      />
                      {!selectedAsset?.hasAudio && (
                        <p className="panel-description">
                          Questa clip non contiene una traccia audio.
                        </p>
                      )}
                    </section>
                  )}
                  {selectedClip && inspectorTab === 'title' && (
                    <section className="control-section">
                      <h3>
                        Titolo sovrapposto{' '}
                        {selectedClip.title && (
                          <button
                            className="text-button"
                            onClick={() => patchClip({ title: null })}
                          >
                            Rimuovi
                          </button>
                        )}
                      </h3>
                      <label className="text-control">
                        Testo
                        <textarea
                          aria-label="Testo del titolo"
                          maxLength={160}
                          rows={4}
                          placeholder="Scrivi il tuo titolo…"
                          value={selectedClip.title?.text ?? ''}
                          onChange={(event) =>
                            patchClip({
                              title: {
                                text: event.target.value,
                                style: selectedClip.title?.style ?? 'center',
                                color: selectedClip.title?.color ?? '#ffffff',
                              },
                            })
                          }
                        />
                      </label>
                      <label className="select-control">
                        Stile
                        <select
                          aria-label="Stile del titolo"
                          value={selectedClip.title?.style ?? 'center'}
                          onChange={(event) =>
                            patchClip({
                              title: {
                                text:
                                  selectedClip.title?.text || 'La mia storia',
                                style: event.target.value as
                                  'center' | 'lower' | 'cinema',
                                color: selectedClip.title?.color ?? '#ffffff',
                              },
                            })
                          }
                        >
                          <option value="center">Essenziale</option>
                          <option value="lower">Sottopancia</option>
                          <option value="cinema">Cinema</option>
                        </select>
                      </label>
                      <label className="select-control">
                        Colore
                        <input
                          aria-label="Colore del titolo"
                          type="color"
                          value={selectedClip.title?.color ?? '#ffffff'}
                          onChange={(event) =>
                            patchClip({
                              title: {
                                text:
                                  selectedClip.title?.text || 'La mia storia',
                                style: selectedClip.title?.style ?? 'center',
                                color: event.target.value,
                              },
                            })
                          }
                        />
                      </label>
                      <p className="panel-description">
                        Il titolo rimane visibile per tutta la durata della
                        clip.
                      </p>
                      <button className="secondary-button full-width" disabled={!selectedClip.title?.text.trim()} onClick={()=>{
                        const entry=timelinePositions(project).find(item=>item.clip.id===selectedClip.id);const title=selectedClip.title;
                        if(!entry||!title)return;const id=crypto.randomUUID();
                        const next=updateClip(project,selectedClip.id,{title:null});
                        edit({...next,overlays:[...(next.overlays??[]),{id,kind:'text',text:title.text,start:entry.start,end:entry.end,x:.5,y:title.style==='lower'?.82:.5,width:.75,opacity:1,animation:'fade-grow',color:title.color,fontSize:title.style==='cinema'?.055:.065}]});
                        setTime(entry.start+Math.min(.3,(entry.end-entry.start)/2));setSourceAssetId(null);showEffects(id);
                      }}><Sparkles size={14}/>Anima questo titolo</button>
                    </section>
                  )}
                  {selectedAudio && (
                    <>
                      <section className="control-section">
                        <h3>Posizione e ritaglio</h3>
                        <label className="select-control">
                          Inizio nel film{' '}
                          <input
                            aria-label="Inizio traccia audio"
                            type="number"
                            min={0}
                            max={86400}
                            step={0.1}
                            value={Number(selectedAudio.start.toFixed(2))}
                            onChange={(event) => {
                              const value = Number(event.target.value);
                              if (
                                Number.isFinite(value) &&
                                value >= 0 &&
                                value <= 86400
                              )
                                patchAudio({ start: value });
                            }}
                          />
                        </label>
                        <div className="number-pair">
                          <label>
                            Entrata{' '}
                            <div>
                              <input
                                aria-label="Entrata audio"
                                type="number"
                                min={0}
                                max={selectedAudio.out - 0.04}
                                step={0.1}
                                value={selectedAudio.in}
                                onChange={(event) => {
                                  const value = Number(event.target.value);
                                  if (
                                    value >= 0 &&
                                    value < selectedAudio.out - 0.03
                                  )
                                    patchAudio({ in: value });
                                }}
                              />
                              <span>s</span>
                            </div>
                          </label>
                          <label>
                            Uscita{' '}
                            <div>
                              <input
                                aria-label="Uscita audio"
                                type="number"
                                min={selectedAudio.in + 0.04}
                                max={selectedAsset?.duration}
                                step={0.1}
                                value={selectedAudio.out}
                                onChange={(event) => {
                                  const value = Number(event.target.value);
                                  if (
                                    value > selectedAudio.in + 0.03 &&
                                    value <= (selectedAsset?.duration ?? 0)
                                  )
                                    patchAudio({ out: value });
                                }}
                              />
                              <span>s</span>
                            </div>
                          </label>
                        </div>
                      </section>
                      <section className="control-section">
                        <h3>Volume e dissolvenze</h3>
                        <RangeControl
                          label="Volume"
                          min={0}
                          max={1}
                          value={selectedAudio.volume}
                          display={`${Math.round(selectedAudio.volume * 100)}%`}
                          onChange={(value) => patchAudio({ volume: value })}
                        />
                        <RangeControl
                          label="Entrata"
                          min={0}
                          max={Math.min(
                            5,
                            (selectedAudio.out - selectedAudio.in) / 2,
                          )}
                          step={0.1}
                          value={selectedAudio.fadeIn}
                          display={`${selectedAudio.fadeIn.toFixed(1)} s`}
                          onChange={(value) => patchAudio({ fadeIn: value })}
                        />
                        <RangeControl
                          label="Uscita"
                          min={0}
                          max={Math.min(
                            5,
                            (selectedAudio.out - selectedAudio.in) / 2,
                          )}
                          step={0.1}
                          value={selectedAudio.fadeOut}
                          display={`${selectedAudio.fadeOut.toFixed(1)} s`}
                          onChange={(value) => patchAudio({ fadeOut: value })}
                        />
                      </section>
                    </>
                  )}
                </div>
                <div className="inspector-footer">
                  <button
                    className="text-button danger"
                    onClick={deleteSelection}
                  >
                    <Trash2 size={14} /> Rimuovi dal film
                  </button>
                </div>
              </>
            ) : (
              <div className="inspector-empty">
                <div className="inspector-empty-icon">
                  <Settings2 size={27} strokeWidth={1.2} />
                </div>
                <p>
                  Seleziona una clip nella timeline per regolare immagine, audio
                  e titoli.
                </p>
              </div>
            )}
          </aside>
        )}
      </main>

      <section className="timeline-panel" aria-label="Montaggio del film" style={timelineHeight?{flexBasis:timelineHeight,flexGrow:0}:undefined}>
        <div className="timeline-resize" role="separator" aria-label="Altezza timeline" aria-orientation="horizontal" aria-valuemin={180} aria-valuemax={Math.max(180,window.innerHeight-300)} aria-valuenow={timelineHeight??Math.round(window.innerHeight/3)} tabIndex={0}
          onPointerDown={event=>{timelineResize.current={y:event.clientY,height:event.currentTarget.parentElement!.getBoundingClientRect().height};event.currentTarget.setPointerCapture(event.pointerId);}}
          onPointerMove={event=>{if(timelineResize.current)setTimelineHeight(Math.max(180,Math.min(window.innerHeight-300,timelineResize.current.height+timelineResize.current.y-event.clientY)));}}
          onPointerUp={event=>{timelineResize.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
          onPointerCancel={()=>{timelineResize.current=null;}}
          onKeyDown={event=>{if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();event.stopPropagation();setTimelineHeight(Math.max(180,Math.min(window.innerHeight-300,(timelineHeight??window.innerHeight/3)+(event.key==='ArrowUp'?30:-30))));}}}
          title="Trascina per ingrandire la timeline" />
        <div className="timeline-toolbar">
          <div className="timeline-toolbar-left">
            <strong>Timeline</strong>
            <span className="clip-count">{project.clips.length} clip</span>
            <span className="toolbar-separator" />
            <IconButton
              label="Annulla · Ctrl+Z"
              disabled={!history.past.length}
              onClick={() => {
                setPlaying(false);
                applyHistory('undo');
              }}
            >
              <Undo2 size={17} />
            </IconButton>
            <IconButton
              label="Ripeti · Ctrl+Y"
              disabled={!history.future.length}
              onClick={() => {
                setPlaying(false);
                applyHistory('redo');
              }}
            >
              <Redo2 size={17} />
            </IconButton>
            <span className="toolbar-separator" />
            <IconButton
              label="Dividi clip · Ctrl+B"
              disabled={effectSelection ? !effectSelection.startsWith('subtitle:') : !project.clips.length && !project.audioTracks.length}
              onClick={splitSelection}
            >
              <Scissors size={17} />
            </IconButton>
            <IconButton
              label="Duplica clip · Ctrl+D"
              disabled={!selectedClip && !selectedAudio}
              onClick={() => { if(selectedAudio) edit(duplicateAudioTrack(project,selectedAudio.id)); else if(selectedClip) edit(duplicateClip(project, selectedClip.id)); }}
            >
              <Copy size={16} />
            </IconButton>
            <IconButton
              label="Rimuovi selezione · Canc"
              disabled={!selectedId && (!effectSelection || ['film','subtitles','protected-area'].includes(effectSelection))}
              onClick={deleteSelection}
            >
              <Trash2 size={16} />
            </IconButton>
            {selectedClip && (
              <>
                <span className="toolbar-separator" />
                <IconButton
                  label="Sposta clip a sinistra"
                  disabled={selectedLaneClips[0]?.id === selectedId}
                  onClick={() =>
                    edit(
                      moveClip(
                        project,
                        selectedClip.id,
                        selectedLaneClips.findIndex(
                          (clip) => clip.id === selectedId,
                        ) - 1,
                      ),
                    )
                  }
                >
                  <ArrowLeft size={16} />
                </IconButton>
                <IconButton
                  label="Sposta clip a destra"
                  disabled={
                    selectedLaneClips.at(-1)?.id === selectedId
                  }
                  onClick={() =>
                    edit(
                      moveClip(
                        project,
                        selectedClip.id,
                        selectedLaneClips.findIndex(
                          (clip) => clip.id === selectedId,
                        ) + 1,
                      ),
                    )
                  }
                >
                  <ArrowRight size={16} />
                </IconButton>
              </>
            )}
          </div>
          <div className="timeline-toolbar-right">
            <button className={`timeline-magnet${snappingEnabled?' active':''}`} aria-label="Calamita" aria-pressed={snappingEnabled} title="Allinea clip e bordi · N · Alt per ignorare" onClick={()=>setSnappingEnabled(value=>!value)}><Magnet size={15}/><span>Calamita</span></button>
            <button
              className="text-button fit-button"
              disabled={!duration}
              onClick={() => {
                const width =
                  document.querySelector('.timeline-scroll')?.clientWidth ??
                  800;
                setZoom(Math.max(MIN_TIMELINE_ZOOM, Math.min(MAX_TIMELINE_ZOOM, (width - TIMELINE_GUTTER - 32) / duration)));
              }}
            >
              Adatta
            </button>
            <span className="zoom-symbol">−</span>
            <input
              aria-label="Zoom timeline"
              type="range"
              min={Math.log2(MIN_TIMELINE_ZOOM)}
              max={Math.log2(MAX_TIMELINE_ZOOM)}
              step={.05}
              value={Math.log2(zoom)}
              onChange={(event) => setZoom(2**Number(event.target.value))}
            />
            <span className="zoom-symbol">+</span>
          </div>
        </div>
        <Timeline
          project={project}
          snappingEnabled={snappingEnabled}
          selectedTrackId={activeTrackId}
          onSelectTrack={setActiveTrackId}
          onAddTrack={(kind)=>{const next=addTimelineTrack(project,kind);const previous=new Set(getProjectTracks(project).map(track=>track.id));const track=getProjectTracks(next).find(track=>!previous.has(track.id));edit(next);if(track)setActiveTrackId(track.id);}}
          onTrackChange={(id,patch)=>edit({...project,tracks:getProjectTracks(project).map(track=>track.id===id?{...track,...patch}:track)})}
          onRemoveTrack={(id)=>{try{edit(removeTimelineTrack(project,id));}catch(error){say(String(error),true);}}}
          onPlaceItem={(id, kind, ids, trackId, start, pointerTime) => {
            try {
              const base = currentProject.current;
              const next = applyTimelineMove(base, id, kind, ids, trackId, start, pointerTime);
              if (next !== base) edit(next);
              setPlaying(false);
              setActiveTrackId(trackId);
            } catch (error) {
              say(error instanceof Error ? error.message : String(error), true);
            }
          }}
          time={time}
          selectedId={selectedId}
          selectedIds={selectedIds}
          onSelectionChange={(ids) => { setSelectedIds(ids); setSelectedId(current => ids.includes(current ?? '') ? current : ids[0] ?? null); }}
          onMoveGroup={(ids, delta) => { setPlaying(false); edit(shiftClips(project, ids, delta)); }}
          onDeleteSelection={(ids) => { edit(removeClips(project, ids)); setSelectedId(null); setSelectedIds([]); }}
          onAudioChange={(id, patch) => {try{edit(updateAudioTrack(project,id,patch));}catch(error){say(String(error),true);}}}
          onAudioSplit={(id, cursor) => edit(splitAudioTrack(project, id, cursor))}
          onSelectOverlay={showEffects}
          onSelectSubtitle={(index) => showEffects(`subtitle:${index}`)}
          selectedEffectId={effectSelection}
          onOverlayChange={patchOverlay}
          onSubtitleChange={(index,patch)=>{try{edit(setSubtitleEventTiming(currentProject.current,index,patch));}catch(error){say(String(error),true);}}}
          onDeleteEffect={deleteEffect}
          zoom={zoom}
          onTimeChange={(value) => {
            setSourceAssetId(null);
            setPlaying(false);
            setTime(value);
          }}
          onSelect={selectTimeline}
          onDropAsset={(id, _index, trackId, at) => addLibrarySelection([id], trackId, at)}
          onDropAssets={addLibrarySelection}
          onDropError={message=>say(message,true)}
          onZoomChange={setZoom}
          onTrim={trimSelection}
        />
        <footer className="status-bar">
          <span>
            <span className="local-dot" /> DuckyMovie{' '}
            <span className="status-separator">·</span> Montaggio locale
          </span>
          <span>
            {busy ? (
              <>
                <LoaderCircle size={11} className="spin" /> Preparazione dei
                media…
              </>
            ) : duration ? (
              `${formatDuration(duration)} di film · ${project.aspectRatio}`
            ) : (
              'Trascina i tuoi media nella timeline per iniziare'
            )}
          </span>
          <button onClick={() => setModal('help')}>
            Scorciatoie da tastiera <CircleHelp size={12} />
          </button>
        </footer>
      </section>

      {toast && (
        <div
          className={`toast ${toast.error ? 'error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
        >
          {toast.error ? <Info size={17} /> : <Check size={17} />}
          <span>{toast.text}</span>
          <button aria-label="Chiudi messaggio" onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {draggingFiles && (
        <div className="file-drop-overlay">
          <ArrowDownToLine size={42} />
          <h2>Lascia qui i tuoi media</h2>
          <p>Video, foto e audio saranno aggiunti alla libreria.</p>
        </div>
      )}

      {modal === 'update' && startupUpdate && <StartupUpdateDialog update={startupUpdate}
        saveProject={saveBeforeReplacing} onClose={() => { setStartupUpdate(null); setModal(null); }} />}
      {modal === 'export' && (
        <Modal
          title={
            exportProgress?.state === 'complete'
              ? 'Il tuo film è pronto'
              : 'Esporta il tuo film'
          }
          onClose={() => setModal(null)}
          locked={!!exportRunning}
        >
          {exportProgress ? (
            <div className="export-result">
              <div
                className={`export-result-icon ${exportProgress.state === 'complete' ? 'success' : ''}`}
              >
                {exportProgress.state === 'complete' ? (
                  <Check size={32} />
                ) : exportProgress.state === 'running' ? (
                  <Film size={30} />
                ) : (
                  <Info size={30} />
                )}
              </div>
              <h3>
                {exportProgress.state === 'complete'
                  ? project.name
                  : exportProgress.state === 'running'
                    ? 'Diamo vita alla tua storia…'
                    : exportProgress.state === 'cancelled'
                      ? 'Esportazione annullata'
                      : 'Esportazione non riuscita'}
              </h3>
              <p>
                {exportProgress.state === 'complete'
                  ? 'Il video MP4 è stato salvato sul tuo PC.'
                  : exportProgress.state === 'running'
                    ? 'Puoi continuare a montare quando il film sarà pronto.'
                    : (exportProgress.error ??
                      'Il progetto è pronto per una nuova esportazione.')}
              </p>
              {exportProgress.acceleration && <p className="export-acceleration" role="status"><strong>{exportProgress.acceleration.label}</strong>{exportProgress.acceleration.fallback && <span>{exportProgress.acceleration.fallback}</span>}</p>}
              {exportProgress.state === 'running' && exportProgress.message && <p className="export-stage">{exportProgress.message}</p>}
              {(exportProgress.state === 'running' ||
                exportProgress.state === 'complete') && (
                <>
                  <progress max={1} value={exportProgress.progress} />
                  <div className="export-progress-label">
                    {Math.round(exportProgress.progress * 100)}%
                  </div>
                </>
              )}
              <div className="modal-actions">
                {exportProgress.state === 'running' ? (
                  <button
                    className="secondary-button"
                    onClick={() =>
                      void window.ducky
                        .cancelExport(exportProgress.jobId)
                        .catch((error) => say(String(error), true))
                    }
                  >
                    Annulla esportazione
                  </button>
                ) : (
                  <>
                    <button
                      className="secondary-button"
                      onClick={() => {
                        setExportProgress(null);
                        setModal(null);
                      }}
                    >
                      Chiudi
                    </button>
                    {exportProgress.state === 'complete' &&
                    exportProgress.path ? (
                      <button
                        className="primary-button"
                        onClick={() =>
                          void window.ducky
                            .revealFile(exportProgress.path!)
                            .catch((error) => say(String(error), true))
                        }
                      >
                        <FolderOpen size={15} /> Mostra il file
                      </button>
                    ) : (
                      <button
                        className="primary-button"
                        onClick={() => setExportProgress(null)}
                      >
                        Riprova
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="export-summary">
                <div className="export-film-icon">
                  <Film size={25} />
                </div>
                <div>
                  <strong>{project.name}</strong>
                  <span>
                    {formatDuration(duration)} · {project.aspectRatio} · MP4
                  </span>
                </div>
              </div>
              <div className="export-options">
                <label>
                  Risoluzione
                  <select
                    aria-label="Risoluzione esportazione"
                    value={exportSettings.resolution}
                    onChange={(event) =>
                      setExportSettings({
                        ...exportSettings,
                        resolution: event.target
                          .value as ExportSettings['resolution'],
                      })
                    }
                  >
                    <option value="720p">HD · 720p</option>
                    <option value="1080p">Full HD · 1080p</option>
                    <option value="1440p">Quad HD · 1440p</option>
                    <option value="2160p">Ultra HD · 4K</option>
                  </select>
                </label>
                <label>
                  Fotogrammi al secondo
                  <select
                    aria-label="Fotogrammi al secondo"
                    value={exportSettings.fps}
                    onChange={(event) =>
                      setExportSettings({
                        ...exportSettings,
                        fps: Number(
                          event.target.value,
                        ) as ExportSettings['fps'],
                      })
                    }
                  >
                    {[24, 25, 30, 60].map((fps) => (
                      <option key={fps} value={fps}>
                        {fps} fps
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Qualità
                  <select
                    aria-label="Qualità esportazione"
                    value={exportSettings.quality}
                    onChange={(event) =>
                      setExportSettings({
                        ...exportSettings,
                        quality: event.target
                          .value as ExportSettings['quality'],
                      })
                    }
                  >
                    <option value="high">Alta · più dettaglio</option>
                    <option value="standard">
                      Standard · file più piccolo
                    </option>
                  </select>
                </label>
                <label>
                  Accelerazione video
                  <select aria-label="Accelerazione esportazione" value={exportSettings.acceleration??'auto'} onChange={event=>setExportSettings({...exportSettings,acceleration:event.target.value as 'auto'|'cpu'})}>
                    <option value="auto">Automatica · usa la GPU disponibile</option>
                    <option value="cpu">Solo CPU · compatibilità</option>
                  </select>
                </label>
              </div>
              <div className="export-acceleration" role="status">
                <strong>{exportSettings.acceleration==='cpu'?'Codifica con CPU':checkingAcceleration?'Verifica accelerazione video…':exportCapabilities?.encoders.find(encoder=>encoder.encoder===exportCapabilities.preferred)?.label??'Accelerazione verificata all’avvio'}</strong>
                <span>{exportSettings.acceleration==='cpu'?'La codifica video userà il processore.':'La GPU accelera la codifica; gli effetti possono usare anche la CPU. Se la GPU non è disponibile, il video viene esportato con la CPU.'}</span>
              </div>
              <p className="export-note">
                <Info size={14} /> Video H.264 e audio AAC, pronto per essere
                condiviso.
              </p>
              <div className="modal-actions">
                <button
                  className="secondary-button"
                  disabled={exportPending}
                  onClick={() => setModal(null)}
                >
                  Annulla
                </button>
                <button
                  className="primary-button"
                  disabled={exportPending}
                  onClick={() => void startExport()}
                >
                  {exportPending ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Download size={15} />
                  )}{' '}
                  {exportPending ? 'Preparazione…' : 'Scegli dove salvare'}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {(modal === 'montage' || modal === 'shorts' || modal === 'transcribe') && <Modal title={modal === 'montage' ? 'Montaggio automatico' : modal === 'shorts' ? 'Crea shorts' : 'Sottotitoli dal parlato'} onClose={() => setModal(null)} wide locked={automationBusy}>
        <AutomationPanel project={project} mode={modal} initialAssetId={automationAssetId} initialAssetIds={automationAssetIds} onImport={()=>importMedia()} onApply={applyGeneratedProject} onBusy={setAutomationBusy} onError={message => say(message, true)} />
      </Modal>}
      {modal === 'help' && (
        <Modal
          title="Il tuo studio di montaggio"
          onClose={() => setModal(null)}
          wide
        >
          <p className="modal-intro">
            Trascina un media nel punto in cui vuoi inserirlo, oppure posiziona
            il cursore e premi +. Le clip successive sulla traccia si spostano
            quanto basta per fargli spazio.
          </p>
          <div className="help-tips">
            <div>
              <Scissors size={20} />
              <h3>Trova il momento giusto</h3>
              <p>
                Trascina i bordi di una clip per ritagliarla. Posiziona il
                cursore e premi Ctrl+B per dividerla.
              </p>
            </div>
            <div>
              <Music2 size={20} />
              <h3>Aggiungi l’atmosfera</h3>
              <p>
                Importa un file audio e aggiungilo al film. Regola inizio,
                volume e dissolvenze nelle proprietà.
              </p>
            </div>
            <div>
              <Save size={20} />
              <h3>Ritrova il tuo lavoro</h3>
              <p>
                Salva il progetto .duckymovie. Mantieni i media nella stessa
                cartella, oppure sposta insieme progetto e media conservando la
                struttura.
              </p>
            </div>
          </div>
          <div className="shortcut-grid">
            {[
              ['Spazio', 'Riproduci / pausa'],
              ['Ctrl + I', 'Importa media'],
              ['Ctrl + clic', 'Seleziona più media o clip'],
              ['Maiusc + clic', 'Seleziona un intervallo'],
              ['Ctrl + A', 'Seleziona tutti nella libreria o nella timeline'],
              ['Ctrl + rotellina', 'Ingrandisci o riduci la timeline'],
              ['N / Alt durante il trascinamento', 'Attiva la calamita / ignora l’aggancio'],
              ['Ctrl + S', 'Salva progetto'],
              ['Ctrl + Shift + S', 'Salva con nome'],
              ['Ctrl + O', 'Apri progetto'],
              ['Ctrl + B', 'Dividi al cursore'],
              ['Ctrl + D', 'Duplica clip'],
              ['Canc', 'Rimuovi selezione'],
              ['Ctrl + Z', 'Annulla'],
              ['Ctrl + Y', 'Ripeti'],
              ['← / →', 'Un fotogramma'],
              ['Shift + ← / →', 'Un secondo'],
            ].map(([key, label]) => (
              <div key={key}>
                <span>{label}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
          </div>
          <PrivateUpdateAccess refresh={refreshUpdate} />
        </Modal>
      )}
      {modal === 'projects' && (
        <Modal title="I tuoi progetti" onClose={() => setModal(null)}>
          <div className="project-actions">
            <button
              className="new-project-card"
              onClick={() => {
                setNewName('Il mio film');
                setModal('new');
              }}
            >
              <Plus size={24} />
              <span>Nuovo film</span>
            </button>
            <button
              className="new-project-card"
              onClick={() => void openProject()}
            >
              <FolderOpen size={24} />
              <span>Apri progetto</span>
            </button>
          </div>
          <div className="project-exchange-actions">
            <button className="secondary-button" onClick={() => void (async () => {
              try { const next = await window.ducky.importLegacyProject(); if (next) await applyGeneratedProject(next, true); }
              catch (error) { say(String(error), true); }
            })()}>Importa progetto DuckyPlay</button>
            <button className="secondary-button" onClick={() => void (async () => {
              try { const file = await window.ducky.saveTemplate(project); if (file) say('Modello salvato: intro, outro, comparse e stile'); }
              catch (error) { say(String(error), true); }
            })()}>Salva come modello</button>
            <button className="secondary-button" onClick={() => void (async () => {
              try { const template = await window.ducky.openTemplate(); if (template) { edit(applyProjectTemplate(project, template)); setModal(null); say('Modello applicato al film'); } }
              catch (error) { say(String(error), true); }
            })()}>Applica modello</button>
          </div>
          {recent.length > 0 && (
            <>
              <h3 className="recent-heading">Recenti</h3>
              <div className="recent-projects">
                {recent.map((item) => (
                  <button
                    key={item.path}
                    onClick={() => void openProject(item.path)}
                  >
                    <Film size={19} />
                    <div>
                      <strong>{item.name}</strong>
                      <small title={item.path}>{item.path}</small>
                    </div>
                    <ArrowRight size={15} />
                  </button>
                ))}
              </div>
            </>
          )}
        </Modal>
      )}
      {modal === 'new' && (
        <Modal title="Una nuova storia" onClose={() => setModal(null)}>
          <div className="new-project-form">
            <label>
              Nome del film
              <input
                autoFocus
                value={newName}
                maxLength={100}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void newProject();
                }}
              />
            </label>
            <label>
              Formato
              <select
                value={newRatio}
                onChange={(event) =>
                  setNewRatio(event.target.value as Project['aspectRatio'])
                }
              >
                <option value="16:9">16:9 · Orizzontale</option>
                <option value="9:16">9:16 · Verticale</option>
                <option value="1:1">1:1 · Quadrato</option>
              </select>
            </label>
          </div>
          <div className="modal-actions">
            <button className="secondary-button" onClick={() => setModal(null)}>
              Annulla
            </button>
            <button
              className="primary-button"
              onClick={() => void newProject()}
            >
              <Plus size={16} /> Crea film
            </button>
          </div>
        </Modal>
      )}
      {pendingAssetRemoval && (
        <Modal title={pendingAssetRemoval.ids.length === 1 ? 'Rimuovere questo media?' : `Rimuovere ${pendingAssetRemoval.ids.length} media?`}
          onClose={closeLibraryRemoval} descriptionId="remove-media-description">
          <p className="modal-intro" id="remove-media-description">
            {pendingAssetRemoval.usedCount === 1 ? 'Un media selezionato è usato nel film e verrà rimosso anche dalla timeline.' : `${pendingAssetRemoval.usedCount} media selezionati sono usati nel film e verranno rimossi anche dalla timeline.`}
            {' '}Le altre clip resteranno al loro posto, lasciando spazi vuoti. Saranno rimossi anche gli eventuali loghi, la musica e i sottotitoli collegati a questi media.
          </p>
          <p>I file originali sul computer resteranno intatti. Puoi annullare la rimozione con Ctrl+Z.</p>
          <div className="modal-actions">
            <button className="secondary-button" data-initial-focus onClick={closeLibraryRemoval}>Annulla</button>
            <button className="primary-button" onClick={() => {
              const request = pendingAssetRemoval;
              closeLibraryRemoval();
              if (request.projectId === currentProject.current.id) removeLibrarySelection(request.ids);
            }}><Trash2 size={16}/>Rimuovi dal progetto e dalla timeline</button>
          </div>
        </Modal>
      )}
      {recovery && (
        <Modal
          title="Riprendi la tua storia"
          onClose={() => void discardRecovery()}
          locked
        >
          <div className="recovery-icon">
            <Save size={30} />
          </div>
          <p className="modal-intro">
            È disponibile un salvataggio automatico di{' '}
            <strong>{recovery.name}</strong>, aggiornato il{' '}
            {new Date(recovery.updatedAt).toLocaleString('it-IT')}.
          </p>
          <div className="modal-actions">
            <button
              className="secondary-button"
              onClick={() => void discardRecovery()}
            >
              Comincia da zero
            </button>
            <button
              className="primary-button"
              onClick={() => void resumeRecovery()}
            >
              Riprendi il progetto
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
