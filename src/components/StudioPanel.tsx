import { useState } from 'react';
import { FileText, Film, ImagePlus, Plus, Smartphone, Sparkles, Type } from 'lucide-react';
import type { OverlayAnimation, Project } from '../../shared/types';

export type StudioSection = 'shorts' | 'captions' | 'branding' | 'caps';
interface Props {
  section: StudioSection;
  project: Project;
  onImport: () => Promise<unknown>;
  onOpen: (mode:'shorts'|'transcribe'|'montage', assetId?:string) => void;
  onEffects: (selection?:string) => void;
  onLogo: (assetId:string,animation:OverlayAnimation) => void;
  onImportLogo: () => Promise<unknown>;
  onText: () => void;
  onCap: (assetId:string,role:'intro'|'outro') => void;
  onRemoveCap: (role:'intro'|'outro') => void;
  onSelectClip: (id:string) => void;
  onError: (message:string) => void;
}
export default function StudioPanel(props:Props) {
  const {section,project}=props;
  const [selectedImage,setSelectedImage]=useState('');
  const [selectedCap,setSelectedCap]=useState('');
  const [animation,setAnimation]=useState<OverlayAnimation>('fade');
  const images=project.assets.filter(asset=>asset.kind==='image'&&!asset.missing);
  const visuals=project.assets.filter(asset=>asset.kind!=='audio'&&!asset.missing);
  const imageId=images.some(asset=>asset.id===selectedImage)?selectedImage:images[0]?.id??'';
  const capId=visuals.some(asset=>asset.id===selectedCap)?selectedCap:visuals[0]?.id??'';
  const exportText=(format:'srt'|'txt')=>project.subtitles&&void window.ducky.exportTranscript(project.subtitles,format).catch(error=>props.onError(String(error)));
  return <div className="presets-panel studio-panel">
    {section==='shorts'&&<>
      <div className="feature-intro"><Smartphone size={29}/><h3>Crea un video verticale</h3><p>Trova i momenti migliori o scegli un intervallo. Rivedilo, poi monta lo short nella stessa timeline.</p></div>
      <button className="primary-button full-width" onClick={()=>props.onOpen('shorts')}><Sparkles size={16}/>Apri studio Shorts</button>
      <button className="secondary-button full-width" onClick={()=>void props.onImport()}><Plus size={15}/>Importa video per Shorts</button>
      <p className="panel-description">Sfondo sfocato o inseguimento del soggetto, durata fino a 180 secondi. Dopo la generazione puoi aggiungere logo, testi, musica e sottotitoli.</p>
      {project.assets.filter(asset=>asset.kind==='video'&&!asset.missing).map(asset=><button className="feature-media" key={asset.id} onClick={()=>props.onOpen('shorts',asset.id)}><Film size={18}/><span>{asset.name}<small>Crea short da questo video</small></span></button>)}
    </>}
    {section==='captions'&&<>
      <div className="feature-intro"><FileText size={28}/><h3>La voce diventa testo</h3><p>Trascrivi MP3, WAV, M4A e altri audio, anche in un progetto senza immagini. Sono supportati anche i video con parlato.</p></div>
      <button className="primary-button full-width" onClick={()=>props.onOpen('transcribe')}><FileText size={16}/>Trascrivi audio o video</button>
      <button className="secondary-button full-width" onClick={()=>void props.onImport()}><Plus size={15}/>Importa registrazione</button>
      <button className="secondary-button full-width" onClick={()=>props.onEffects('subtitles')}>Testo, tempi e stile karaoke</button>
      <div className="feature-actions"><button className="secondary-button" disabled={!project.subtitles?.words.length} onClick={()=>exportText('txt')}>Salva TXT</button><button className="secondary-button" disabled={!project.subtitles?.words.length} onClick={()=>exportText('srt')}>Salva SRT</button></div>
      <p className="panel-description">Scegli le clip da trascrivere, controlla il risultato e applicalo al progetto. La trascrizione rispetta tagli, velocità e posizione delle clip.</p>
    </>}
    {section==='branding'&&<>
      <div className="feature-intro"><ImagePlus size={28}/><h3>Logo e animazioni</h3><p>Importa un logo, anche PNG trasparente, oppure usa un’immagine della libreria.</p></div>
      <button className="primary-button full-width" onClick={()=>void props.onImportLogo()}><Plus size={16}/>Importa e inserisci logo</button>
      {images.length>0&&<><label className="select-control">Immagine del logo<select aria-label="Logo dalla libreria" value={imageId} onChange={event=>setSelectedImage(event.target.value)}>{images.map(asset=><option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label><label className="select-control">Animazione<select aria-label="Animazione nuovo logo" value={animation} onChange={event=>setAnimation(event.target.value as OverlayAnimation)}>{[['none','Nessuna'],['fade','Dissolvenza'],['fade-grow','Dissolvi e ingrandisci'],['pop','Pop'],['zoom-out','Zoom indietro'],['slide-up','Dal basso'],['slide-right','Da sinistra'],['breathe','Respiro']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><button className="secondary-button full-width" onClick={()=>props.onLogo(imageId,animation)}>Inserisci logo selezionato</button></>}
      <p className="panel-description">Trascina il logo nell’anteprima per posizionarlo. Nelle proprietà scegli dimensioni, durata, opacità e animazione.</p>
      {(project.overlays??[]).map((overlay,index)=><button className="feature-media" key={overlay.id} onClick={()=>props.onEffects(overlay.id)}>{overlay.kind==='image'?<ImagePlus size={17}/>:<Type size={17}/>}<span>{overlay.kind==='image'?`Logo ${index+1}`:overlay.text||'Testo'}<small>{overlay.start.toFixed(1)}–{overlay.end.toFixed(1)} s · Modifica</small></span></button>)}
      <button className="secondary-button full-width" onClick={props.onText}><Type size={15}/>Aggiungi testo animato</button>
    </>}
    {section==='caps'&&<>
      <div className="feature-intro"><Film size={28}/><h3>Apri e chiudi il tuo film</h3><p>Inserisci un video o un’immagine all’inizio o alla fine. L’intro sposta insieme le clip e il parlato, mantenendoli sincronizzati.</p></div>
      <button className="secondary-button full-width" onClick={()=>void props.onImport()}><Plus size={15}/>Importa intro o outro</button>
      {visuals.length>0&&<><label className="select-control">File da inserire<select aria-label="File intro o outro" value={capId} onChange={event=>setSelectedCap(event.target.value)}>{visuals.map(asset=><option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label><div className="feature-actions"><button className="primary-button" onClick={()=>props.onCap(capId,'intro')}>Inserisci intro</button><button className="secondary-button" onClick={()=>props.onCap(capId,'outro')}>Inserisci outro</button></div></>}
      {(['intro','outro'] as const).map(role=><section className="control-section" key={role}><h3>{role==='intro'?'Intro':'Outro'}</h3>{project.clips.filter(clip=>clip.role===role).map(clip=><button className="feature-media" key={clip.id} onClick={()=>props.onSelectClip(clip.id)}><Film size={15}/><span>{project.assets.find(asset=>asset.id===clip.assetId)?.name}<small>Seleziona e regola durata ed effetti</small></span></button>)}{project.clips.some(clip=>clip.role===role)&&<button className="text-button" onClick={()=>props.onRemoveCap(role)}>Rimuovi {role}</button>}</section>)}
      <p className="panel-description">Puoi salvare intro, outro e logo come modello da Progetti → Salva come modello.</p>
    </>}
  </div>;
}
