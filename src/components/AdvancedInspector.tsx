import { useEffect, useState, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { NormalizedRect, Project, ProjectFrame, ProjectSubtitles, SubtitleStyle, TimedOverlay, VideoClip } from '../../shared/types';
import { createSubtitles, DEFAULT_SUBTITLE_STYLE, projectDuration, SUBTITLE_PRESETS, timelinePositions, updateClip } from '../model';

interface Props {
  project: Project;
  selectedClip?: VideoClip;
  onChange: (project: Project) => void;
  onSelect?: (id: string) => void;
  onClipPatch?: (patch: Partial<VideoClip>) => void;
  selectedItem?: string;
  focused?: boolean;
  onEditCaptions?: () => void;
}

export const FRAME_OPTIONS: [ProjectFrame['style'], string][] = [
  ['none', 'Nessuna'], ['solid', 'Bordo'], ['double', 'Doppio filo'], ['inset', 'Passe-partout'],
  ['corners', 'Angoli'], ['rounded', 'Angoli tondi'], ['vignette', 'Vignetta'], ['edgeFade', 'Sfumatura'],
  ['cinema', 'Cinema'], ['bottomBar', 'Barra in basso'], ['neon', 'Neon'], ['gradient', 'Gradiente'],
  ['sideBars', 'Barre laterali'], ['stripe', 'Striscia laterale'], ['film', 'Pellicola'], ['polaroid', 'Polaroid'],
  ['dashed', 'Tratteggio'], ['dotted', 'Punti'], ['tape', 'Nastro'], ['ornate', 'Barocca'], ['glow', 'Alone'],
];
const fonts = ['Segoe UI', 'Arial', 'Verdana', 'Georgia', 'Impact', 'Tahoma', 'Trebuchet MS', 'Times New Roman', 'Courier New'];
const animations: [TimedOverlay['animation'], string][] = [['none', 'Nessuna'], ['fade', 'Dissolvenza'], ['fade-grow', 'Dissolvi e ingrandisci'], ['pop', 'Pop'], ['zoom-out', 'Zoom indietro'], ['slide-up', 'Dal basso'], ['slide-right', 'Da sinistra'], ['breathe', 'Respiro']];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="select-control">{label}{children}</label>;
}
function NumberField({ label, value, min = 0, max = 86400, step = 0.1, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void }) {
  return <Field label={label}><input aria-label={label} type="number" value={Number(value.toFixed(4))} min={min} max={max} step={step} onChange={(event) => {
    const value = event.target.valueAsNumber;
    if (Number.isFinite(value) && value >= min && value <= max) onChange(value);
  }} /></Field>;
}
function Slider({ label, value, min, max, step = .01, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  return <label className="range-control"><span>{label}<output>{value.toFixed(2)}</output></span><input aria-label={label} type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}
function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <label className="select-control" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>{label}<input aria-label={label} type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} /></label>;
}
function Color({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <Field label={label}><input aria-label={label} type="color" value={value} onChange={(event) => onChange(event.target.value)} /></Field>;
}

export default function AdvancedInspector({ project, selectedClip, onChange, onSelect, onClipPatch, selectedItem, focused, onEditCaptions }: Props) {
  const [selectedOverlay, setSelectedOverlay] = useState<string | undefined>(() => project.overlays?.some((item) => item.id === selectedItem) ? selectedItem : undefined);
  useEffect(() => {
    setSelectedOverlay(project.overlays?.some((item) => item.id === selectedItem) ? selectedItem : undefined);
  }, [selectedItem]);
  const section = selectedItem?.startsWith('subtitle') ? 'subtitles' : selectedItem === 'music' || selectedItem === 'protected-area' ? selectedItem : 'overlay';
  const showSection = (name: string) => !focused || section === name;
  const duration = projectDuration(project);
  const change = (patch: Partial<Project>) => onChange({ ...project, ...patch, updatedAt: new Date().toISOString() });
  const patchClip = (patch: Partial<VideoClip>) => { if (!selectedClip) return; if (onClipPatch) onClipPatch(patch); else onChange(updateClip(project, selectedClip.id, patch)); };
  const subtitles = project.subtitles ?? createSubtitles();
  const setSubtitles = (patch: Partial<ProjectSubtitles>) => change({ subtitles: { ...subtitles, ...patch } });
  const setStyle = (patch: Partial<SubtitleStyle>) => setSubtitles({ style: { ...subtitles.style, ...patch } });
  const overlay = project.overlays?.find((item) => item.id === selectedOverlay);
  const patchOverlay = (patch: Partial<TimedOverlay>) => change({ overlays: project.overlays?.map((item) => item.id === selectedOverlay ? { ...item, ...patch, ...('start' in patch || 'end' in patch ? {persistent:false} : {}) } : item) });
  const frame = project.frame ?? { style: 'none' as const, color: '#ffffff', accent: '#111111', thickness: .02, opacity: 1 };
  const patchFrame = (patch: Partial<ProjectFrame>) => change({ frame: { ...frame, ...patch } });
  const music = project.music;
  const patchMusic = (patch: Partial<NonNullable<Project['music']>>) => music && change({ music: { ...music, ...patch } });

  function rectControls(label: string, rectangle: NormalizedRect, mutate: (rect: NormalizedRect) => void) {
    return <div className="number-pair" style={{ flexWrap: 'wrap' }}>{(['x', 'y', 'w', 'h'] as const).map((key) => <NumberField key={key} label={`${label} ${key.toUpperCase()} (%)`} value={rectangle[key] * 100} min={key === 'w' || key === 'h' ? 2 : 0} max={key === 'x' || key === 'y' ? 98 : 100} step={1} onChange={(value) => {
      const next = { ...rectangle, [key]: value / 100 };
      next.w = Math.min(next.w, 1 - next.x);
      next.h = Math.min(next.h, 1 - next.y);
      next.x = Math.max(0, Math.min(next.x, 1 - .02));
      next.y = Math.max(0, Math.min(next.y, 1 - .02));
      next.w = Math.max(.02, Math.min(next.w, 1 - next.x));
      next.h = Math.max(.02, Math.min(next.h, 1 - next.y));
      mutate(next);
    }} />)}</div>;
  }

  if (selectedClip) return <>
    <section className="control-section"><h3>Inquadratura</h3>
      <Check label="Specchia questa clip" value={!!selectedClip.mirror} onChange={(mirror) => patchClip({ mirror })} />
      <Slider label="Temperatura colore" value={selectedClip.warmth ?? 0} min={-1} max={1} step={.02} onChange={(warmth) => patchClip({ warmth })} />
      <Field label="Sfondo"><select aria-label="Sfondo clip" value={selectedClip.background ?? 'black'} onChange={(event) => patchClip({ background: event.target.value as VideoClip['background'] })}><option value="black">Nero</option><option value="blur">Copia sfocata</option></select></Field>
      <Check label="Ritaglio personalizzato" value={!!selectedClip.crop} onChange={(enabled) => patchClip({ crop: enabled ? { x: .1, y: .1, w: .8, h: .8 } : null })} />
      {selectedClip.crop && rectControls('Ritaglio', selectedClip.crop, (crop) => patchClip({ crop }))}
      <Field label="Movimento foto"><select aria-label="Movimento foto" value={selectedClip.zoom ?? 'none'} onChange={(event) => patchClip({ zoom: event.target.value as VideoClip['zoom'] })}><option value="none">Fermo</option><option value="in">Avvicinamento</option><option value="out">Allontanamento</option></select></Field>
      {selectedClip.zoom && selectedClip.zoom !== 'none' && <Slider label="Intensità zoom" value={selectedClip.zoomAmount ?? 1.12} min={1.02} max={1.5} onChange={(zoomAmount) => patchClip({ zoomAmount })} />}
    </section>
    <section className="control-section"><h3>Posizione sullo schermo</h3>
      <p className="panel-description">Ridimensiona la clip per sovrapporla alle tracce sottostanti.</p>
      {(['x','y','scale','opacity'] as const).map(key=><Slider key={key} label={{x:'Centro orizzontale',y:'Centro verticale',scale:'Dimensione sullo schermo',opacity:'Opacità clip'}[key]} value={(selectedClip.placement??{x:.5,y:.5,scale:1,opacity:1})[key]} min={key==='scale'?.05:0} max={key==='scale'?2:1} onChange={value=>patchClip({placement:{x:.5,y:.5,scale:1,opacity:1,...selectedClip.placement,[key]:value}})}/>)}
      <button className="text-button" onClick={()=>patchClip({placement:undefined})}>Ripristina posizione e dimensioni</button>
    </section>
    <section className="control-section"><h3>Montaggio</h3>
      <Field label="Transizione in entrata"><select aria-label="Transizione in entrata" value={selectedClip.transition ?? 'none'} onChange={(event) => patchClip({ transition: event.target.value as VideoClip['transition'] })}>{[['none', 'Taglio'], ['fade', 'Dissolvenza incrociata'], ['black', 'Passaggio al nero'], ['white', 'Passaggio al bianco'], ['zoom', 'Zoom'], ['blur', 'Sfocatura']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      {selectedClip.transition && selectedClip.transition !== 'none' && <Slider label="Durata transizione (s)" value={selectedClip.transitionDuration ?? .5} min={.1} max={2} step={.1} onChange={(transitionDuration) => patchClip({ transitionDuration })} />}
      <Field label="Ruolo clip"><select aria-label="Ruolo clip" value={selectedClip.role ?? 'normal'} onChange={(event) => patchClip({ role: event.target.value as VideoClip['role'] })}><option value="normal">Contenuto</option><option value="intro">Intro</option><option value="outro">Outro</option></select></Field>
      <Check label="Posizione libera nella timeline" value={selectedClip.start !== undefined} onChange={(enabled) => patchClip({ start: enabled ? timelinePositions(project).find((entry) => entry.clip.id === selectedClip.id)?.start ?? 0 : undefined })} />
      {selectedClip.start !== undefined && <NumberField label="Inizio clip nel film (s)" value={selectedClip.start} onChange={(start) => patchClip({ start })} />}
    </section>
  </>;

  function addOverlay(kind: TimedOverlay['kind']) {
    const image = project.assets.find((asset) => asset.kind === 'image');
    const item: TimedOverlay = { id: crypto.randomUUID(), kind, start: 0, end: Math.min(Math.max(1, duration), 4), x: .5, y: kind === 'subscribe' ? .82 : .5, width: kind === 'image' ? .2 : .45, opacity: 1, animation: 'fade', text: kind === 'subscribe' ? 'ISCRIVITI' : 'Il tuo testo', color: '#ffffff', ...(kind === 'subscribe' ? { box: true, boxColor: '#e11d2a', boxOpacity: 1 } : {}), ...(kind === 'image' && image ? { assetId: image.id } : {}) };
    change({ overlays: [...(project.overlays ?? []), item] });
    setSelectedOverlay(item.id);
    onSelect?.(item.id);
  }


  return <div className="advanced-inspector">
    <details hidden={!showSection('subtitles')} open={!selectedOverlay || selectedItem?.startsWith('subtitle')} className="control-section"><summary><strong>Sottotitoli</strong></summary>
      <Check label="Mostra sottotitoli" value={subtitles.enabled} onChange={(enabled) => setSubtitles({ enabled })} />
      <Field label="Stile sottotitoli"><select aria-label="Stile sottotitoli" value="" onChange={(event) => { const preset = SUBTITLE_PRESETS[event.target.value]; if (preset) setStyle({ ...DEFAULT_SUBTITLE_STYLE, ...preset.style }); }}><option value="">Scegli un preset</option>{Object.entries(SUBTITLE_PRESETS).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}</select></Field>
      <div className="number-pair"><NumberField label="Parole per blocco" value={subtitles.maxWords} min={1} max={10} step={1} onChange={(maxWords) => setSubtitles({ maxWords })} /><NumberField label="Righe massime" value={subtitles.maxLines} min={1} max={3} step={1} onChange={(maxLines) => setSubtitles({ maxLines })} /></div>
      <Field label="Carattere"><select aria-label="Carattere sottotitoli" value={subtitles.style.font} onChange={(event) => setStyle({ font: event.target.value })}>{fonts.map((font) => <option key={font}>{font}</option>)}</select></Field>
      <Slider label="Dimensione testo" value={subtitles.style.size_frac} min={.025} max={.12} step={.002} onChange={(size_frac) => setStyle({ size_frac })} />
      <Slider label="Larghezza testo" value={subtitles.style.width_frac} min={.25} max={.98} onChange={(width_frac) => setStyle({ width_frac })} />
      <Field label="Posizione sottotitoli"><select aria-label="Posizione sottotitoli" value={subtitles.style.position} onChange={(event) => setStyle({ position: event.target.value as SubtitleStyle['position'], x: undefined, y: undefined })}><option value="bottom">In basso</option><option value="center">Al centro</option><option value="top">In alto</option></select></Field>
      <div className="number-pair"><Color label="Colore testo" value={subtitles.style.color} onChange={(color) => setStyle({ color })} /><Color label="Parola attiva" value={subtitles.style.active_color} onChange={(active_color) => setStyle({ active_color })} /></div>
      <Color label="Colore contorno" value={subtitles.style.outline_color} onChange={(outline_color) => setStyle({ outline_color })} />
      <Slider label="Contorno" value={subtitles.style.outline} min={0} max={.02} step={.001} onChange={(outline) => setStyle({ outline })} />
      <Slider label="Ombra" value={subtitles.style.shadow} min={0} max={.02} step={.001} onChange={(shadow) => setStyle({ shadow })} />
      <Check label="Sfondo del testo" value={subtitles.style.box} onChange={(box) => setStyle({ box })} />
      {subtitles.style.box && <><Color label="Colore sfondo testo" value={subtitles.style.box_color} onChange={(box_color) => setStyle({ box_color })} /><Slider label="Opacità sfondo testo" value={subtitles.style.box_opacity} min={0} max={1} onChange={(box_opacity) => setStyle({ box_opacity })} /></>}
      <Check label="Grassetto" value={subtitles.style.bold} onChange={(bold) => setStyle({ bold })} /><Check label="Maiuscolo" value={subtitles.style.uppercase} onChange={(uppercase) => setStyle({ uppercase })} />
      <Check label="Comparsa morbida" value={subtitles.style.anim === 'fade'} onChange={(value) => setStyle({ anim: value ? 'fade' : 'none' })} />
      <button className="secondary-button full-width" onClick={onEditCaptions}>Modifica testo e tempi</button>
    </details>
    <details hidden={!showSection('overlay')} className="control-section" open={!!selectedOverlay}><summary><strong>Comparse, logo e invito a iscriversi</strong></summary>
      <div className="number-pair"><button className="secondary-button" onClick={() => addOverlay('text')}><Plus size={13} /> Testo</button><button className="secondary-button" disabled={!project.assets.some((asset) => asset.kind === 'image')} onClick={() => addOverlay('image')}><Plus size={13} /> Logo</button><button className="secondary-button" onClick={() => addOverlay('subscribe')}><Plus size={13} /> Iscriviti</button></div>
      <Field label="Comparsa da modificare"><select aria-label="Comparsa da modificare" value={selectedOverlay ?? ''} onChange={(event) => { setSelectedOverlay(event.target.value); onSelect?.(event.target.value); }}><option value="">Scegli una comparsa</option>{(project.overlays ?? []).map((item, index) => <option value={item.id} key={item.id}>{item.text || `Logo ${index + 1}`} · {item.start.toFixed(1)} s</option>)}</select></Field>
      {overlay && <>
        {overlay.kind === 'image' ? <Field label="Immagine del logo"><select aria-label="Immagine del logo" value={overlay.assetId ?? ''} onChange={(event) => patchOverlay({ assetId: event.target.value })}>{project.assets.filter((asset) => asset.kind === 'image').map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field> : <Field label="Testo comparsa"><textarea aria-label="Testo comparsa" value={overlay.text ?? ''} onChange={(event) => patchOverlay({ text: event.target.value })} /></Field>}
        <div className="number-pair"><NumberField label="Inizio comparsa (s)" value={overlay.start} max={86400-(overlay.end-overlay.start)} onChange={(start) => patchOverlay({ start, end:start+overlay.end-overlay.start })} /><NumberField label="Fine comparsa (s)" value={overlay.end} min={overlay.start + .1} onChange={(end) => patchOverlay({ end })} /></div>
        <NumberField label="Durata comparsa (s)" value={overlay.end-overlay.start} min={.1} max={86400-overlay.start} onChange={duration=>patchOverlay({end:overlay.start+duration})}/>
        <div className="number-pair"><Slider label="Posizione X" value={overlay.x} min={0} max={1} onChange={(x) => patchOverlay({ x })} /><Slider label="Posizione Y" value={overlay.y} min={0} max={1} onChange={(y) => patchOverlay({ y })} /></div>
        <Slider label="Larghezza comparsa" value={overlay.width} min={.03} max={1} onChange={(width) => patchOverlay({ width })} /><Slider label="Opacità comparsa" value={overlay.opacity} min={0} max={1} onChange={(opacity) => patchOverlay({ opacity })} />
        <Field label="Animazione comparsa"><select aria-label="Animazione comparsa" value={overlay.animation} onChange={(event) => patchOverlay({ animation: event.target.value as TimedOverlay['animation'] })}>{animations.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
        {overlay.kind !== 'image' && <Color label="Colore comparsa" value={overlay.color ?? '#ffffff'} onChange={(color) => patchOverlay({ color })} />}
        {overlay.kind !== 'image' && <><Check label="Dimensione testo personalizzata" value={overlay.fontSize !== undefined} onChange={(enabled) => patchOverlay({ fontSize: enabled ? .05 : undefined })} />{overlay.fontSize !== undefined && <Slider label="Dimensione testo comparsa" value={overlay.fontSize} min={.01} max={.2} step={.002} onChange={(fontSize) => patchOverlay({ fontSize })} />}<Check label="Sfondo comparsa" value={!!overlay.box} onChange={(box) => patchOverlay({ box })} />{(overlay.box || overlay.kind === 'subscribe') && <><Color label="Colore sfondo comparsa" value={overlay.boxColor ?? (overlay.kind === 'subscribe' ? '#e11d2a' : '#000000')} onChange={(boxColor) => patchOverlay({ boxColor })} /><Slider label="Opacità sfondo comparsa" value={overlay.boxOpacity ?? 1} min={0} max={1} onChange={(boxOpacity) => patchOverlay({ boxOpacity })} /></>}</>}
        {overlay.kind === 'subscribe' && <Check label="Suono di comparsa" value={!!overlay.sound} onChange={(sound) => patchOverlay({ sound })} />}
        <button className="secondary-button full-width" onClick={() => { change({ overlays: project.overlays?.filter((item) => item.id !== overlay.id) }); setSelectedOverlay(undefined); }}><Trash2 size={13} /> Elimina comparsa</button>
      </>}
    </details>
    <details hidden={!!focused} className="control-section"><summary><strong>Cornice</strong></summary><Field label="Stile cornice"><select aria-label="Stile cornice" value={frame.style} onChange={(event) => patchFrame({ style: event.target.value as ProjectFrame['style'] })}>{FRAME_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
      {frame.style !== 'none' && <><div className="number-pair"><Color label="Colore cornice" value={frame.color} onChange={(color) => patchFrame({ color })} /><Color label="Accento cornice" value={frame.accent} onChange={(accent) => patchFrame({ accent })} /></div><Slider label="Spessore cornice" value={frame.thickness} min={.002} max={.06} step={.002} onChange={(thickness) => patchFrame({ thickness })} /><Slider label="Opacità cornice" value={frame.opacity} min={.1} max={1} onChange={(opacity) => patchFrame({ opacity })} /></>}
    </details>
    <details hidden={!showSection('protected-area')} className="control-section" open={selectedItem === 'protected-area'}><summary><strong>Specchiatura e logo originale</strong></summary><Check label="Specchia tutto il film" value={!!project.mirror} onChange={(mirror) => change({ mirror })} /><Check label="Mantieni leggibile il logo originale" value={!!project.protectedArea} onChange={(enabled) => change({ protectedArea: enabled ? { x: .7, y: .8, w: .26, h: .15 } : null })} />{project.protectedArea && rectControls('Logo originale', project.protectedArea, (protectedArea) => change({ protectedArea }))}</details>
    <details hidden={!showSection('music')} className="control-section" open={selectedItem === 'music'}><summary><strong>Musica continua</strong></summary><Field label="Musica di sottofondo"><select aria-label="Musica di sottofondo" value={music?.assetId ?? ''} onChange={(event) => {
      const asset = project.assets.find((asset) => asset.id === event.target.value);
      change({ music: asset ? { assetId: asset.id, start: 0, in: 0, out: asset.duration, volume: .2, loop: true, duck: true } : null });
    }}><option value="">Nessuna musica</option>{project.assets.filter((asset) => asset.kind === 'audio' || asset.hasAudio).map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field>
      {music && <><NumberField label="Inizio musica nel film (s)" value={music.start} onChange={(start) => patchMusic({ start })} /><div className="number-pair"><NumberField label="Entrata musica (s)" value={music.in} max={music.out - .1} onChange={(value) => patchMusic({ in: value })} /><NumberField label="Uscita musica (s)" value={music.out} min={music.in + .1} max={project.assets.find((asset) => asset.id === music.assetId)?.duration ?? music.out} onChange={(out) => patchMusic({ out })} /></div><Slider label="Volume musica" value={music.volume} min={0} max={1} onChange={(volume) => patchMusic({ volume })} /><Check label="Ripeti fino alla fine del film" value={music.loop} onChange={(loop) => patchMusic({ loop })} /><Check label="Abbassa durante il parlato" value={music.duck} onChange={(duck) => patchMusic({ duck })} /></>}
    </details>
    <section hidden={!!focused} className="control-section"><NumberField label="Durata totale del film (s)" value={duration} min={.1} onChange={(duration) => change({ duration })} /><button className="text-button" onClick={() => change({ duration: undefined })}>Adatta la durata alle clip</button></section>
  </div>;
}
