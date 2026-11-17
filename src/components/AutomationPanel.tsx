import { useEffect, useRef, useState } from 'react';
import { Check, FileText, Film, LoaderCircle, Scissors, Sparkles, Crosshair, X } from 'lucide-react';
import type { AutomationProgress, AutomationRequest, MediaAsset, Project, SubtitleWord } from '../../shared/types';
import { addAssets, addTimelineTrack, getProjectTracks, getAudioTrackId, getClipTrackId, canonicalMediaPath, createAudioTrack, createClip, createProject, projectDuration, timelinePositions, linkSubtitlesToTimeline, replaceSourceSubtitles } from '../model';
import { createSmartMontage, type MontagePace, type MontageOrder, type MontagePriority, type SemanticMontageSegment } from '../montage';

const subtitleStyle = { font: 'Segoe UI', size_frac: .052, color: '#ffffff', active_color: '#f5ce69', outline: .006, outline_color: '#000000', shadow: .004, box: false, box_color: '#000000', box_opacity: .55, position: 'bottom' as const, margin_frac: .1, uppercase: false, bold: true, anim: 'fade' as const, width_frac: .9 };
type Candidate = { start: number; end: number; score: number };
type TranscriptResult = { words_by_path: Record<string, SubtitleWord[]> };
type MatchResult = { segments: SemanticMontageSegment[]; media?: { path: string; status: string }[] };
export interface AutomationPanelProps {
  project: Project;
  mode: 'montage' | 'shorts' | 'transcribe';
  onApply: (project: Project, newProject?: boolean, summary?: string) => void | Promise<void>;
  onBusy: (busy: boolean) => void;
  onError: (message: string) => void;
  initialAssetId?: string;
  initialAssetIds?: string[];
  onImport?: () => Promise<unknown>;
}

export default function AutomationPanel({ project, mode, onApply, onBusy, onError, initialAssetId, initialAssetIds, onImport }: AutomationPanelProps) {
  const available = project.assets.filter(asset => !asset.missing);
  const images = available.filter(asset => asset.kind === 'image');
  const audios = available.filter(asset => asset.kind === 'audio');
  const videos = available.filter(asset => asset.kind === 'video');
  const visualMedia = available.filter(asset => asset.kind !== 'audio');
  const narrationMedia = available.filter(asset => asset.hasAudio && asset.kind !== 'image');
  const initialIds = initialAssetIds?.length ? initialAssetIds : initialAssetId ? [initialAssetId] : null;
  const [imageIds, setImageIds] = useState(() => initialIds ? initialIds.filter(id => visualMedia.some(asset => asset.id === id)) : visualMedia.map(asset => asset.id));
  const [audioIds, setAudioIds] = useState(() => initialIds ? initialIds.filter(id => audios.some(asset => asset.id === id)) : audios.map(asset => asset.id));
  const [introId, setIntroId] = useState('');
  const [outroId, setOutroId] = useState('');
  const [logoId, setLogoId] = useState('');
  const [semantic, setSemantic] = useState(false);
  const [transcribe, setTranscribe] = useState(false);
  const [pace, setPace] = useState<MontagePace>('balanced');
  const [order, setOrder] = useState<MontageOrder>('selection');
  const [priority, setPriority] = useState<MontagePriority>('balanced');
  const [reuse, setReuse] = useState(false);
  const [wholeVideos, setWholeVideos] = useState(false);
  const [videoAudio, setVideoAudio] = useState(false);
  const [dedup, setDedup] = useState(true);
  const [minSeconds, setMinSeconds] = useState(2);
  const [maxSeconds, setMaxSeconds] = useState(6);
  const [offtopic, setOfftopic] = useState(.12);
  const [script, setScript] = useState('');
  const [language, setLanguage] = useState('it');
  const [videoId, setVideoId] = useState(videos.find(asset => asset.id === initialAssetId)?.id ?? videos[0]?.id ?? '');
  const spokenFiles = available.filter(asset => asset.hasAudio && asset.kind !== 'image');
  const lanes = getProjectTracks(project);
  const narrationItems = [
    ...project.audioTracks.map(track => ({ id: `audio:${track.id}`, asset: available.find(asset => asset.id === track.assetId), start: track.start, in: track.in, out: track.out, speed: 1, muted: track.volume === 0 || !!lanes.find(lane => lane.id === getAudioTrackId(project,track.id))?.muted })),
    ...timelinePositions(project).map(({clip,start}) => ({ id: `clip:${clip.id}`, asset: available.find(asset => asset.id === clip.assetId && asset.hasAudio), start, in: clip.in, out: clip.out, speed: clip.speed, muted: clip.muted || clip.volume === 0 || !!lanes.find(lane => lane.id === getClipTrackId(project,clip.id))?.muted })),
  ].filter(item => !!item.asset);
  const [scope, setScope] = useState<'timeline'|'files'>(initialAssetId || !narrationItems.length ? 'files' : 'timeline');
  const [speechIds, setSpeechIds] = useState(initialAssetId ? [initialAssetId] : spokenFiles.map(asset => asset.id));
  const [narrationIds, setNarrationIds] = useState(narrationItems.filter(item => !item.muted).map(item => item.id));
  const [speechStart, setSpeechStart] = useState(0);
  const [includeSource, setIncludeSource] = useState(!project.audioTracks.length && !project.clips.some(clip=>project.assets.find(asset=>asset.id===clip.assetId)?.hasAudio));
  const [transcribed, setTranscribed] = useState<SubtitleWord[] | null>(null);
  const [transcribedProject, setTranscribedProject] = useState<Project | null>(null);
  const [targetDuration, setTargetDuration] = useState(40);
  const [count, setCount] = useState(4);
  const [shortStyle, setShortStyle] = useState<'blur' | 'crop'>('crop');
  const [trackingMode, setTrackingMode] = useState<'person' | 'group'>('person');
  const [trackingSensitivity, setTrackingSensitivity] = useState<'steady' | 'responsive'>('steady');
  const [focus, setFocus] = useState<{ x: number; y: number } | null>(null);
  const [pickingFocus, setPickingFocus] = useState(false);
  const [previewSize, setPreviewSize] = useState({ width: 1, height: 1 });
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [status, setStatus] = useState<AutomationProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const jobRef = useRef<string | null>(null);
  const waiter = useRef<{ resolve: (value: unknown) => void; reject: (error: Error) => void } | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const knownAssets = useRef(new Set(available.map(asset => asset.id)));
  const selectedVideo = videos.find(asset => asset.id === videoId);
  const candidate = candidates[candidateIndex];
  const selectedVisuals = imageIds.filter(id => visualMedia.some(asset => asset.id === id) && ![introId,outroId,logoId].includes(id));
  const selectedNarrationDuration = audioIds.reduce((sum,id)=>sum+(narrationMedia.find(asset=>asset.id===id)?.duration??0),0);
  const sourceRatio = (selectedVideo?.width || 16) / (selectedVideo?.height || 9);
  const contentWidth = Math.min(previewSize.width, previewSize.height * sourceRatio);
  const contentHeight = contentWidth / sourceRatio;
  const contentLeft = (previewSize.width - contentWidth) / 2;
  const contentTop = (previewSize.height - contentHeight) / 2;
  useEffect(()=>{
    const added=available.filter(asset=>!knownAssets.current.has(asset.id));
    knownAssets.current=new Set(available.map(asset=>asset.id));
    if(!added.length)return;
    setImageIds(ids=>[...ids,...added.filter(asset=>asset.kind!=='audio').map(asset=>asset.id)]);
    setAudioIds(ids=>[...ids,...added.filter(asset=>asset.kind==='audio').map(asset=>asset.id)]);
    setSpeechIds(ids=>[...ids,...added.filter(asset=>asset.hasAudio&&asset.kind!=='image').map(asset=>asset.id)]);
  },[project.assets]);
  useEffect(()=>{if(!videos.some(asset=>asset.id===videoId)&&videos.length){setVideoId(videos[0].id);setCandidates([]);}},[videoId,project.assets]);

  useEffect(() => window.ducky.onAutomationProgress(event => {
    if (jobRef.current && event.jobId !== jobRef.current) return;
    setStatus(event);
    if (event.state === 'complete') { waiter.current?.resolve(event.result); waiter.current = null; jobRef.current = null; }
    if (event.state === 'error' || event.state === 'cancelled') { waiter.current?.reject(new Error(event.error ?? 'Operazione annullata')); waiter.current = null; jobRef.current = null; }
  }), []);
  useEffect(() => () => { if (jobRef.current) void window.ducky.cancelAutomation(jobRef.current); }, []);
  useEffect(() => {
    if (previewRef.current && candidate) previewRef.current.currentTime = candidate.start;
    setFocus(null);setPickingFocus(false);
  }, [candidateIndex, candidate?.start, videoId]);
  useEffect(()=>{
    const node=previewRef.current;
    if(!node)return;
    const observer=new ResizeObserver(()=>setPreviewSize({width:node.clientWidth,height:node.clientHeight}));
    observer.observe(node);
    return()=>observer.disconnect();
  },[selectedVideo?.id]);

  async function run<T>(request: AutomationRequest): Promise<T> {
    setStatus(null);
    return new Promise<T>((resolve, reject) => {
      waiter.current = { resolve: value => resolve(value as T), reject };
      window.ducky.startAutomation(request).then(result => { if (waiter.current) jobRef.current = result.jobId; }).catch(error => { waiter.current = null; reject(error); });
    });
  }
  async function perform(work: () => Promise<void>) {
    setBusy(true); onBusy(true); setSummary(''); setErrorMessage('');
    try { await work(); } catch (error) { const message = error instanceof Error ? error.message : String(error); setErrorMessage(message); onError(message); }
    finally { setBusy(false); onBusy(false); }
  }
  function sourceWords(result: TranscriptResult, asset: MediaAsset) {
    return Object.entries(result.words_by_path).find(([path]) => canonicalMediaPath(path) === canonicalMediaPath(asset.path))?.[1] ?? [];
  }
  async function createMontage() {
    if (!selectedVisuals.length) throw new Error('Seleziona almeno un video o una foto per il montaggio.');
    const selectedNarrations=audioIds.map(id=>narrationMedia.find(asset=>asset.id===id)).filter((asset):asset is MediaAsset=>!!asset);
    const selectedMedia=selectedVisuals.map(id=>visualMedia.find(asset=>asset.id===id)!).filter(Boolean);
    const bodySpeech=selectedNarrations.reduce((sum,asset)=>sum+asset.duration,0);
    const capSources=[introId,outroId].map(id=>available.find(asset=>asset.id===id)).filter((asset):asset is MediaAsset=>!!asset&&asset.hasAudio);
    const captionVideoSources=transcribe&&(!selectedNarrations.length||videoAudio)?selectedMedia.filter(asset=>asset.kind==='video'&&asset.hasAudio):[];
    const transcriptionSources=[...selectedNarrations,...captionVideoSources,...(transcribe?capSources:[])];
    const shouldTranscribe=transcribe || semantic&&!script.trim()&&!!selectedNarrations.length;
    const wordsByAsset:Record<string,SubtitleWord[]>={};
    if(shouldTranscribe&&transcriptionSources.length){
      const result=await run<TranscriptResult>({action:'transcribe',payload:{paths:[...new Set(transcriptionSources.map(asset=>asset.path))],language}});
      for(const asset of transcriptionSources) wordsByAsset[asset.id]=sourceWords(result,asset);
    }
    let segments:MatchResult['segments']|undefined;
    let discarded=0;
    let montageVisuals=selectedVisuals;
    if(semantic){
      if(!bodySpeech)throw new Error('Seleziona una narrazione per abbinare le scene al parlato.');
      let cursor=0;
      const words=selectedNarrations.flatMap(asset=>{
        const items=(wordsByAsset[asset.id]??[]).map(word=>({...word,start:word.start+cursor,end:word.end+cursor}));
        cursor+=asset.duration;return items;
      });
      const matched=await run<MatchResult>({action:'match',payload:{images:selectedMedia.map(asset=>asset.path),words,audio_duration:bodySpeech,dedup,offtopic,img_min:minSeconds,img_max:maxSeconds,script}});
      const excluded=new Set((matched.media??[]).filter(media=>media.status==='dup'||media.status==='offtopic').map(media=>canonicalMediaPath(media.path)));
      montageVisuals=selectedVisuals.filter(id=>!excluded.has(canonicalMediaPath(visualMedia.find(asset=>asset.id===id)!.path)));
      if(!montageVisuals.length)throw new Error('Nessuno dei media selezionati è adatto alla narrazione. Riduci la soglia fuori tema o scegli altri media.');
      segments=matched.segments.filter(segment=>!excluded.has(canonicalMediaPath(segment.source)));
      discarded=excluded.size;
    }
    const result=createSmartMontage(project,{assetIds:montageVisuals,narrationIds:audioIds,pace,order,priority,minSeconds,maxSeconds,
      reuse,wholeVideos,videoAudio,subtitles:transcribe,wordsByAsset,semanticSegments:segments,introId: introId||undefined,outroId:outroId||undefined,logoId:logoId||undefined});
    const details=[`${result.shotCount} scene`,`${Math.round(projectDuration(result.project))} secondi`,
      ...(discarded?[`${discarded} media duplicati o fuori tema individuati`]:[]),...result.warnings];
    await onApply(result.project,true,`Montaggio pronto. ${details.join(' · ')}`);
  }
  async function transcribeTimeline() {
    setTranscribed(null); setTranscribedProject(null);
    const sources = scope === 'timeline' ? narrationItems.filter(item => narrationIds.includes(item.id)) : [];
    const files = scope === 'files' ? speechIds.map(id => spokenFiles.find(asset => asset.id === id)).filter((asset):asset is MediaAsset => !!asset) : [];
    const paths = [...new Set(scope === 'timeline' ? sources.map(item => item.asset!.path) : files.map(asset => asset.path))];
    if (!paths.length) throw new Error('Seleziona almeno un file audio o una clip con parlato. Puoi trascrivere anche senza immagini o video nella timeline.');
    const result = await run<TranscriptResult>({ action: 'transcribe', payload: { paths, language } });
    const words: SubtitleWord[] = [];
    let next = project;
    if (scope === 'timeline') for (const item of sources) {
      words.push(...sourceWords(result,item.asset!).filter(word => word.end > item.in && word.start < item.out).map(word => ({...word,id:crypto.randomUUID(),source:{kind:item.id.startsWith('audio:')?'audio' as const:'clip' as const,id:item.id.slice(item.id.indexOf(':')+1),start:word.start,end:word.end},start:item.start+(Math.max(item.in,word.start)-item.in)/item.speed,end:item.start+(Math.min(item.out,word.end)-item.in)/item.speed})));
    } else {
      let cursor = speechStart;
      const emptyLane=getProjectTracks(project).find(lane=>lane.kind==='audio'&&!lane.muted&&!project.audioTracks.some(track=>getAudioTrackId(project,track.id)===lane.id));
      if (includeSource && !emptyLane) next = addTimelineTrack(project,'audio');
      const lane = emptyLane ?? getProjectTracks(next).filter(track => track.kind === 'audio').at(-1)!;
      const tracks = [...next.audioTracks];
      for (const asset of files) {
        if (includeSource) {
          const track={...createAudioTrack(asset,cursor,lane.id),volume:1};
          tracks.push(track);
          words.push(...sourceWords(result,asset).map(word=>({...word,id:crypto.randomUUID(),source:{kind:'audio' as const,id:track.id,start:word.start,end:word.end},start:word.start+cursor,end:word.end+cursor})));
        } else {
          const instances=narrationItems.filter(item=>item.asset?.id===asset.id);
          if (instances.length) for (const item of instances) {
            words.push(...sourceWords(result,asset).filter(word=>word.end>item.in&&word.start<item.out).map(word=>({...word,id:crypto.randomUUID(),source:{kind:item.id.startsWith('audio:')?'audio' as const:'clip' as const,id:item.id.slice(item.id.indexOf(':')+1),start:word.start,end:word.end},start:item.start+(Math.max(item.in,word.start)-item.in)/item.speed,end:item.start+(Math.min(item.out,word.end)-item.in)/item.speed})));
          } else words.push(...sourceWords(result,asset).map(word=>({...word,id:crypto.randomUUID(),start:word.start+cursor,end:word.end+cursor})));
        }
        cursor += asset.duration;
      }
      next = {...next,audioTracks:tracks,duration:Math.max(projectDuration(next),cursor)};
    }
    const ordered = words.filter(word => word.end > word.start && word.end > 0).sort((a,b) => a.start-b.start);
    if (!ordered.length) { setSummary('Analisi completata. Nessun parlato riconosciuto nei file selezionati.'); return; }
    next = {...next,subtitles:{...project.subtitles,enabled:true,words:project.subtitles?.words??[],style:project.subtitles?.style ?? subtitleStyle,maxWords:project.subtitles?.maxWords ?? 5,maxLines:project.subtitles?.maxLines ?? 2}};
    const owners = ordered.flatMap(word=>word.source ? [{kind:word.source.kind,id:word.source.id}] : []);
    next = replaceSourceSubtitles(next,ordered,owners);
    setTranscribed(ordered); setTranscribedProject(next);
    setSummary(`${ordered.length} parole riconosciute. Salva il testo oppure aggiungi i sottotitoli al progetto.`);
  }
  async function analyzeShorts() {
    if (!selectedVideo) throw new Error('Importa e seleziona un video.');
    const result = await run<{ candidates: Candidate[] }>({ action: 'highlights', payload: { path: selectedVideo.path, count, duration: targetDuration } });
    const valid=(result.candidates??[]).filter(item=>Number.isFinite(item.start)&&Number.isFinite(item.end)&&item.end>item.start)
      .map(item=>({...item,start:Math.max(0,item.start),end:Math.min(selectedVideo.duration,item.end,item.start+180)})).filter(item=>item.end-item.start>=.05);
    if(!valid.length)throw new Error('Non sono stati trovati intervalli utilizzabili. Scegli un intervallo manuale.');
    setCandidates(valid); setCandidateIndex(0);
    setSummary(`${valid.length} intervalli trovati. Seleziona una proposta per ascoltarla e correggere entrata e uscita.`);
  }
  async function createShort() {
    if (!selectedVideo || !candidate || candidate.end <= candidate.start || candidate.end - candidate.start > 180) throw new Error('Scegli un intervallo valido di massimo 180 secondi.');
    const result = await run<{ path: string }>({ action: 'short-base', payload: { path: selectedVideo.path, start: candidate.start, end: candidate.end, style: shortStyle,
      ...(shortStyle==='crop'?{tracking:{mode:trackingMode,sensitivity:trackingSensitivity,...(focus?{focusX:focus.x,focusY:focus.y}:{})}}:{}) } });
    const imported = await window.ducky.importMedia([result.path]);
    if (!imported.assets.length) throw new Error(imported.errors.join('\n') || 'Generazione dello short non riuscita');
    const next = addAssets(addAssets(createProject(`${selectedVideo.name.replace(/\.[^.]+$/, '')} · Short ${candidateIndex + 1}`),project.assets), imported.assets);
    const generated=next.assets.find(asset=>canonicalMediaPath(asset.path)===canonicalMediaPath(imported.assets[0].path))!;
    next.aspectRatio = '9:16'; next.clips = [createClip(generated)];
    await onApply(next, true,`Short pronto · ${(candidate.end-candidate.start).toFixed(1)} secondi · ${shortStyle==='blur'?'fotogramma intero':trackingMode==='group'?'inquadratura di gruppo':'soggetto seguito'}`);
  }
  function chooseFocus(clientX:number,clientY:number){
    const rect=previewRef.current?.getBoundingClientRect();
    if(!rect||!contentWidth||!contentHeight)return;
    const x=(clientX-rect.left-contentLeft)/contentWidth;
    const y=(clientY-rect.top-contentTop)/contentHeight;
    if(x<0||x>1||y<0||y>1)return;
    previewRef.current?.pause();setFocus({x,y});setPickingFocus(false);
  }
  function previewCandidate(index:number){
    setCandidateIndex(index);
    const node=previewRef.current;
    if(node){node.currentTime=candidates[index].start;void node.play().catch(()=>{});}
  }
  function selectAssets(label: string, assets: MediaAsset[], selection: string[], setSelection: (ids: string[]) => void) {
    return <fieldset className="automation-assets"><legend>{label}</legend><div className="automation-asset-actions"><button className="text-button" onClick={() => setSelection(assets.map(asset => asset.id))}>Seleziona tutti</button><button className="text-button" onClick={() => setSelection([])}>Deseleziona</button></div>{assets.map(asset => <label key={asset.id}><input type="checkbox" checked={selection.includes(asset.id)} onChange={event => setSelection(event.target.checked ? [...selection, asset.id] : selection.filter(id => id !== asset.id))} />{asset.name}</label>)}{!assets.length && <p className="panel-description">Importa i file nella libreria per selezionarli qui.</p>}</fieldset>;
  }
  function assetSelect(label: string, assets: MediaAsset[], value: string, onChange: (value:string)=>void, optional=true) {
    return <label className="select-control">{label}<select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>{optional && <option value="">Nessuno</option>}{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>;
  }
  return <div className="automation-panel"><fieldset disabled={busy} className="automation-controls">
    {mode === 'montage' && <>
      <p className="modal-intro">Scegli video e foto, poi il ritmo. Il montaggio rimane modificabile nella timeline.</p>
      {onImport && <button className="secondary-button" onClick={()=>void perform(async()=>{await onImport();})}>Importa video, foto o audio</button>}
      <div className="automation-columns">{selectAssets('Video e foto · ordine di selezione',visualMedia,imageIds,setImageIds)}{selectAssets('Narrazione facoltativa · ordine di selezione',narrationMedia,audioIds,setAudioIds)}</div>
      <label className="select-control">Ritmo<select aria-label="Ritmo del montaggio" value={pace} onChange={event=>{
        const value=event.target.value as MontagePace;setPace(value);
        const limits=value==='relaxed'?[3.5,9]:value==='dynamic'?[1,4]:[2,6];setMinSeconds(limits[0]);setMaxSeconds(limits[1]);
      }}><option value="relaxed">Disteso · lascia respirare le scene</option><option value="balanced">Naturale · ritmo equilibrato</option><option value="dynamic">Dinamico · scene più brevi</option></select></label>
      <div className="number-pair"><label className="select-control">Ordine<select aria-label="Ordine dei media" value={order} disabled={semantic} onChange={event=>setOrder(event.target.value as MontageOrder)}><option value="selection">Segui la selezione</option><option value="shuffle">Mescola i media</option></select></label>
        <label className="select-control">Priorità<select aria-label="Priorità dei media" value={priority} onChange={event=>setPriority(event.target.value as MontagePriority)}><option value="balanced">Bilanciata</option><option value="video">Dai spazio ai video</option><option value="image">Dai spazio alle foto</option></select></label></div>
      <div className="montage-recap" role="status"><strong>{selectedVisuals.length} media selezionati</strong><span>{audioIds.length?`${audioIds.length} narrazioni · ${Math.round(selectedNarrationDuration)} secondi di parlato`:'Audio originale dei video · narrazione facoltativa'}</span><span>{order==='shuffle'?'Ordine mescolato':semantic?'Ordine guidato dal parlato':'Ordine della selezione'} · {wholeVideos?'video interi':'estratti video'} · {reuse?'riutilizzo consentito':'foto senza ripetizioni'}</span></div>
      <section className="control-section"><h3>Apertura e chiusura</h3>{assetSelect('Intro',visualMedia,introId,setIntroId)}{assetSelect('Outro',visualMedia,outroId,setOutroId)}{assetSelect('Logo',images,logoId,setLogoId)}</section>
      <section className="control-section"><label className="checkbox-control"><input type="checkbox" checked={transcribe} onChange={event=>setTranscribe(event.target.checked)}/>Crea sottotitoli sincronizzati</label>
        <label className="checkbox-control"><input type="checkbox" checked={semantic} onChange={event=>setSemantic(event.target.checked)}/>Abbina le immagini al parlato con analisi locale</label>
        {semantic && <><p className="panel-description">L’analisi abbina foto e momenti dei video alle frasi della narrazione. Un copione può guidare l’abbinamento.</p><label className="checkbox-control"><input type="checkbox" checked={dedup} onChange={event=>setDedup(event.target.checked)}/>Individua immagini quasi duplicate</label><label className="select-control">Soglia immagini fuori tema<input type="number" min={0} max={.5} step={.01} value={offtopic} onChange={event=>setOfftopic(Math.max(0,Math.min(.5,Number(event.target.value))))}/></label><button className="secondary-button full-width" onClick={()=>void window.ducky.importScript().then(value=>{if(value)setScript(value.text);}).catch(error=>onError(String(error)))}><FileText size={14}/>Importa copione Word o testo</button><textarea className="script-input" aria-label="Copione" rows={3} value={script} onChange={event=>setScript(event.target.value)} placeholder="Copione facoltativo per affinare l’abbinamento"/></>}
      </section>
      <details className="montage-options"><summary>Altre scelte di montaggio</summary><div className="number-pair"><label>Durata minima scena<input aria-label="Durata minima immagine" type="number" min={.5} max={maxSeconds} step={.5} value={minSeconds} onChange={event=>setMinSeconds(Math.max(.5,Math.min(maxSeconds,Number(event.target.value))))}/></label><label>Durata massima scena<input aria-label="Durata massima immagine" type="number" min={minSeconds} max={30} step={.5} value={maxSeconds} onChange={event=>setMaxSeconds(Math.max(minSeconds,Math.min(30,Number(event.target.value))))}/></label></div>
        <label className="checkbox-control"><input type="checkbox" checked={wholeVideos} onChange={event=>setWholeVideos(event.target.checked)}/>Usa i video interi</label>
        <label className="checkbox-control"><input type="checkbox" checked={reuse} onChange={event=>setReuse(event.target.checked)}/>Riutilizza i media se serve</label>
        {!!audioIds.length&&<label className="checkbox-control"><input type="checkbox" checked={videoAudio} onChange={event=>setVideoAudio(event.target.checked)}/>Mantieni anche l’audio dei video durante la narrazione</label>}
      </details>
      <button className="primary-button full-width" disabled={!selectedVisuals.length} onClick={()=>void perform(createMontage)}><Sparkles size={15}/>Crea montaggio modificabile</button>
    </>}
    {mode === 'transcribe' && <>
      <p className="modal-intro">Trascrivi audio e registrazioni, anche senza immagini o video. Puoi usare i file della libreria oppure le clip già montate.</p>
      <label className="select-control">Sorgente della trascrizione<select aria-label="Sorgente della trascrizione" value={scope} onChange={event=>{setScope(event.target.value as 'timeline'|'files');setTranscribed(null);}}><option value="files">File audio e video della libreria</option><option value="timeline">Clip audio e parlato della timeline</option></select></label>
      {onImport && <button className="secondary-button" onClick={()=>void perform(async()=>{await onImport();})}>Importa audio o video</button>}
      {scope === 'files' ? <>
        {selectAssets('Audio e video da trascrivere · ordine di selezione',spokenFiles,speechIds,setSpeechIds)}
        <label className="select-control">Inizio nel progetto (s)<input aria-label="Inizio trascrizione nel progetto" type="number" min={0} value={speechStart} onChange={event=>setSpeechStart(Math.max(0,Number(event.target.value)))}/></label>
        <label className="checkbox-control"><input type="checkbox" checked={includeSource} onChange={event=>setIncludeSource(event.target.checked)}/>Aggiungi il parlato su una traccia audio quando applichi i sottotitoli</label>
      </> : <fieldset className="automation-assets"><legend>Clip con parlato</legend>{narrationItems.map(item=><label key={item.id}><input type="checkbox" checked={narrationIds.includes(item.id)} onChange={event=>setNarrationIds(event.target.checked?[...narrationIds,item.id]:narrationIds.filter(id=>id!==item.id))}/>{item.asset!.name} · {item.start.toFixed(1)} s{item.muted?' · audio silenziato':''}</label>)}{!narrationItems.length&&<p className="panel-description">Nessun audio in timeline. Scegli i file della libreria per trascriverli direttamente.</p>}</fieldset>}
      <button className="primary-button" onClick={() => void perform(transcribeTimeline)} disabled={scope==='files'?!speechIds.length:!narrationIds.length}><FileText size={15}/>Trascrivi audio selezionato</button>
      {transcribed && transcribedProject?.subtitles && <div className="transcript-result"><h3>Trascrizione</h3><textarea aria-label="Risultato trascrizione" readOnly rows={5} value={transcribed.map(word=>word.text).join(' ')}/><div className="feature-actions"><button className="secondary-button" onClick={()=>void perform(async()=>{await window.ducky.exportTranscript({...transcribedProject.subtitles!,words:transcribed},'txt');})}>Salva testo TXT</button><button className="secondary-button" onClick={()=>void perform(async()=>{await window.ducky.exportTranscript({...transcribedProject.subtitles!,words:transcribed},'srt');})}>Esporta sottotitoli SRT</button><button className="primary-button" onClick={()=>void perform(async()=>{await onApply(transcribedProject);})}>Aggiungi sottotitoli al progetto</button></div></div>}
    </>}
    {(mode === 'transcribe'||mode === 'montage'&&(transcribe||semantic)) && <><label className="select-control">Lingua del parlato<select aria-label="Lingua del parlato" value={language} onChange={event=>setLanguage(event.target.value)}><option value="it">Italiano</option><option value="en">Inglese</option><option value="es">Spagnolo</option><option value="fr">Francese</option><option value="de">Tedesco</option><option value="tr">Turco</option><option value="auto">Rileva automaticamente</option></select></label><p className="panel-description">Trascrizione e abbinamento avvengono sul PC. I modelli vengono scaricati al primo utilizzo e poi riutilizzati offline.</p></>}
    {mode === 'shorts' && <>
      {assetSelect('Video sorgente',videos,videoId,id=>{setVideoId(id);setCandidates([]);setFocus(null);setPickingFocus(false);},false)}
      <div className="number-pair"><label>Proposte<input aria-label="Numero proposte shorts" type="number" min={1} max={12} value={count} onChange={event=>setCount(Math.max(1,Math.min(12,Number(event.target.value))))}/></label><label>Durata target in secondi<input aria-label="Durata target shorts" type="number" min={5} max={180} value={targetDuration} onChange={event=>setTargetDuration(Math.max(5,Math.min(180,Number(event.target.value))))}/></label></div>
      <label className="select-control">Formato verticale<select aria-label="Formato verticale shorts" value={shortStyle} onChange={event=>setShortStyle(event.target.value as 'blur'|'crop')}><option value="blur">Sfondo sfocato</option><option value="crop">Insegui il soggetto</option></select></label>
      {shortStyle==='crop'&&<><div className="number-pair"><label className="select-control">Inquadratura<select aria-label="Inquadratura shorts" value={trackingMode} onChange={event=>setTrackingMode(event.target.value as 'person'|'group')}><option value="person">Un soggetto</option><option value="group">Gruppo · mantieni più persone</option></select></label><label className="select-control">Movimento camera<select aria-label="Movimento camera shorts" value={trackingSensitivity} onChange={event=>setTrackingSensitivity(event.target.value as 'steady'|'responsive')}><option value="steady">Stabile · movimenti morbidi</option><option value="responsive">Reattivo · segui l’azione</option></select></label></div>
        <div className="automation-asset-actions"><button className="secondary-button" aria-pressed={pickingFocus} disabled={!selectedVideo} onClick={()=>{if(previewRef.current){previewRef.current.pause();previewRef.current.currentTime=candidate?.start??0;}setPickingFocus(!pickingFocus);}}><Crosshair size={14}/>{pickingFocus?'Annulla scelta soggetto':'Scegli soggetto nell’anteprima'}</button>{focus&&<button className="text-button" onClick={()=>{setFocus(null);setPickingFocus(false);}}><X size={13}/>Selezione automatica</button>}</div><p className="panel-description">{pickingFocus?'Tocca il soggetto nel fotogramma. Con la tastiera usa le frecce e Invio.':focus?'Il punto scelto guida l’inseguimento del soggetto.':'La camera sceglie il soggetto automaticamente. Puoi indicarlo nell’anteprima.'}</p><span className="short-focus-announcement" aria-live="polite" aria-atomic="true">{focus?`Soggetto a ${(focus.x*100).toLocaleString('it-IT',{maximumFractionDigits:1})}% da sinistra e ${(focus.y*100).toLocaleString('it-IT',{maximumFractionDigits:1})}% dall’alto.`:pickingFocus?'Punto iniziale al centro del fotogramma.':''}</span></>}
      {selectedVideo&&<div className={`short-preview-stage ${pickingFocus?'picking':''}`}>
        <video key={selectedVideo.id} ref={previewRef} className="short-source-preview" src={selectedVideo.url} controls={!pickingFocus} preload="metadata" aria-label="Anteprima video sorgente" onLoadedMetadata={event=>{event.currentTarget.currentTime=candidate?.start??0;setPreviewSize({width:event.currentTarget.clientWidth,height:event.currentTarget.clientHeight});}} onTimeUpdate={event=>{if(candidate&&event.currentTarget.currentTime>=candidate.end&&!event.currentTarget.paused){event.currentTarget.pause();event.currentTarget.currentTime=Math.max(candidate.start,candidate.end-.04);}}} onPlay={event=>{if(candidate&&(event.currentTarget.currentTime<candidate.start||event.currentTarget.currentTime>=candidate.end))event.currentTarget.currentTime=candidate.start;}} />
        {focus&&shortStyle==='crop'&&<span className="short-focus-marker" aria-label="Soggetto scelto" style={{left:contentLeft+focus.x*contentWidth,top:contentTop+focus.y*contentHeight}}><Crosshair size={28}/></span>}
        {pickingFocus&&shortStyle==='crop'&&<button className="short-focus-target" aria-label="Scegli punto del soggetto" autoFocus onClick={event=>chooseFocus(event.clientX,event.clientY)} onKeyDown={event=>{
          if(event.key==='Escape'){setPickingFocus(false);event.preventDefault();return;}
          if(event.key==='Enter'||event.key===' '){setFocus(focus??{x:.5,y:.5});setPickingFocus(false);event.preventDefault();return;}
          if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();setFocus(point=>({x:Math.max(0,Math.min(1,(point?.x??.5)+(event.key==='ArrowRight'?.025:event.key==='ArrowLeft'?-.025:0))),y:Math.max(0,Math.min(1,(point?.y??.5)+(event.key==='ArrowDown'?.025:event.key==='ArrowUp'?-.025:0)))}));}
        }}/>}</div>}
      <p className="panel-description">Le proposte seguono frasi, pause, movimento e stacchi. Puoi ascoltarle e correggere ogni intervallo.</p>
      <div className="automation-asset-actions"><button className="primary-button" disabled={!selectedVideo} onClick={()=>void perform(analyzeShorts)}><Sparkles size={15}/>Trova momenti salienti</button><button className="secondary-button" disabled={!selectedVideo} onClick={()=>{setCandidates([{start:0,end:Math.min(targetDuration,selectedVideo?.duration??0),score:0}]);setCandidateIndex(0);}}>Intervallo manuale</button></div>
      {candidates.length>0 && <><div className="short-candidates">{candidates.map((item,index)=><button key={index} className={`secondary-button ${candidateIndex===index?'chosen':''}`} onClick={()=>previewCandidate(index)}>Short {index+1}<small>{item.start.toFixed(1)}–{item.end.toFixed(1)} s{item.score>0?` · ${Math.round(item.score)}/100`:''}</small></button>)}</div>
      <div className="number-pair"><label>Entrata in secondi<input aria-label="Entrata short" type="number" min={0} max={candidate.end-.05} step={.1} value={candidate.start} onChange={event=>{const value=Number(event.target.value);if(value>=0&&value<candidate.end-.04)setCandidates(items=>items.map((item,index)=>index===candidateIndex?{...item,start:value}:item));}}/></label><label>Uscita in secondi<input aria-label="Uscita short" type="number" min={candidate.start+.05} max={Math.min(selectedVideo?.duration??0,candidate.start+180)} step={.1} value={candidate.end} onChange={event=>{const value=Number(event.target.value);if(value>candidate.start+.04&&value<=Math.min(selectedVideo?.duration??0,candidate.start+180))setCandidates(items=>items.map((item,index)=>index===candidateIndex?{...item,end:value}:item));}}/></label></div>
      <button className="primary-button full-width" onClick={()=>void perform(createShort)}><Scissors size={15}/>Genera e modifica lo short</button><p className="panel-description">Lo short si apre nella timeline. Puoi aggiungere sottotitoli, cornici, logo, musica ed effetti prima di esportarlo.</p></>}
    </>}
  </fieldset>
  {busy && <div className="automation-progress" role="status"><span><LoaderCircle size={15} className="spin"/>{status?.message || 'Preparazione…'}</span><progress max={1} value={status?.progress??0}/><span>{Math.round((status?.progress??0)*100)}%</span><button className="secondary-button" disabled={!jobRef.current} onClick={()=>jobRef.current&&void window.ducky.cancelAutomation(jobRef.current)}>Annulla operazione</button></div>}
  {summary && <p className="automation-summary" role="status"><Check size={14}/>{summary}</p>}
  {errorMessage && <p className="automation-error" role="alert">{errorMessage}</p>}
  {!available.length && <p className="panel-description"><Film size={14}/> Importa prima i tuoi media nella libreria.</p>}
  </div>;
}
