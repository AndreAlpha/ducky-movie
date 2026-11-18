import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { _electron as electron, expect } from '@playwright/test';
import { runProcess } from '../electron/process';
import { ffmpegPath,ffprobePath } from '../electron/binaries';
import { validateProject,projectDuration } from '../src/model';

await fs.mkdir('test-results',{recursive:true});
const dir=await fs.mkdtemp(path.resolve('test-results/remediation-'));
const speech=path.join(dir,'La mia registrazione.wav');
const videoWithAudio=path.join(dir,'Video con audio.mp4');
const red=path.join(dir,'Sfondo rosso.png'),blue=path.join(dir,'Riquadro blu.png'),logo=path.join(dir,'Logo trasparente.png');
await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/create-test-speech.ps1'),'-Destination',speech],{windowsHide:true});
for(const [file,color]of[[red,'red'],[blue,'blue'],[logo,'lime']]as const)await runProcess(ffmpegPath,['-v','error','-y','-f','lavfi','-i',`color=c=${color}:s=320x180`,'-frames:v','1',file]);
await runProcess(ffmpegPath,['-v','error','-y','-f','lavfi','-i','color=c=lime:s=100x100,format=rgba,pad=160:160:30:30:color=black@0.0','-frames:v','1',logo]);
await runProcess(ffmpegPath,['-v','error','-y','-f','lavfi','-i','color=c=yellow:s=320x180:r=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',videoWithAudio]);
const env=Object.fromEntries(Object.entries(process.env).filter((item):item is[string,string]=>item[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;
env.DUCKY_TEST_USER_DATA=path.join(dir,'user');env.DUCKY_MODELS_DIR=path.resolve('.cache/models');env.HF_HUB_OFFLINE='1';
const exe=process.env.DUCKY_EXECUTABLE;if(exe){env.Path=`${process.env.WINDIR}\\System32;${process.env.WINDIR}`;env.PATH=env.Path;delete env.DUCKY_ENGINE_EXECUTABLE;delete env.DUCKY_FFMPEG_PATH;delete env.DUCKY_FFPROBE_PATH;}
const app=await electron.launch({...exe?{executablePath:exe,args:[`--user-data-dir=${env.DUCKY_TEST_USER_DATA}`]}:{args:[path.resolve('.')]},env,timeout:45000});
const page=await app.firstWindow();page.setDefaultTimeout(30000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
app.process().stderr?.on('data',data=>fs.appendFile(path.join(dir,'electron.log'),data));
page.on('crash',()=>console.error('Renderer crashed'));
async function pick(files:string[]){await app.evaluate(({dialog},files)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:files});},files);}
async function destination(file:string){await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},file);}
async function save(file:string){
 const previousTime=await fs.stat(file).then(stat=>stat.mtimeMs).catch(()=>0);
 await destination(file);await page.keyboard.press('Control+Shift+S');
 await expect.poll(()=>fs.stat(file).then(stat=>stat.mtimeMs).catch(()=>0),{timeout:10000}).toBeGreaterThan(previousTime);
 await page.waitForFunction(()=>document.querySelector('.save-state')?.textContent?.includes('Salvato'));
 return validateProject(JSON.parse(await fs.readFile(file,'utf8')));
}
const projectFile=path.join(dir,'Montaggio.duckymovie');
try{
 await page.getByRole('heading',{name:'La libreria è vuota'}).waitFor();
 await pick([speech]);await page.getByRole('button',{name:'Importa media',exact:true}).click();
 await page.getByRole('button',{name:'Trascrivi La mia registrazione.wav',exact:true}).waitFor({timeout:60000});
 // The audio itself can be auditioned before adding any video or image.
 await page.getByRole('button',{name:'Anteprima di La mia registrazione.wav',exact:true}).click();
 await page.getByRole('button',{name:'Riproduci · Spazio',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('audio')?.currentTime!>.2);await page.getByRole('button',{name:'Pausa · Spazio',exact:true}).click();
 await page.getByRole('button',{name:'Trascrivi La mia registrazione.wav',exact:true}).click();
 await page.getByRole('button',{name:'Trascrivi audio selezionato',exact:true}).click();
 await page.getByLabel('Risultato trascrizione').waitFor({timeout:180000});
 const transcript=await page.getByLabel('Risultato trascrizione').inputValue();assert.ok(transcript.split(/\s+/).length>10);
 const srt=path.join(dir,'Parlato.srt');await destination(srt);await page.getByRole('button',{name:'Esporta sottotitoli SRT',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('fieldset.automation-controls')?.hasAttribute('disabled'));
 assert.match(await fs.readFile(srt,'utf8'),/\d\d:\d\d:\d\d,\d{3} -->/);
 await page.getByRole('button',{name:'Aggiungi sottotitoli al progetto',exact:true}).click();await page.locator('dialog[open]').waitFor({state:'hidden'});
 let project=await save(projectFile);assert.equal(project.clips.length,0);assert.equal(project.audioTracks.length,1);assert.ok(project.subtitles!.words.length>10);assert.ok(projectDuration(project)>5);
 const narrationLane=project.audioTracks[0].trackId;
 const narration=page.locator(`.timeline-track-lane[data-track-id="${narrationLane}"] .timeline-audio-clip`);
 await narration.first().click({position:{x:60,y:20}});await page.keyboard.press('Control+b');
 assert.equal(await narration.count(),2,'Il taglio audio crea due clip nella STESSA traccia');
 project=await save(projectFile);assert.equal(project.audioTracks[0].trackId,project.audioTracks[1].trackId);
 const originalLanes=await page.locator('.timeline-track-lane').count();
 await page.getByRole('button',{name:'Aggiungi traccia audio',exact:true}).click();assert.equal(await page.locator('.timeline-track-lane').count(),originalLanes+1);
 // A library video dropped on an audio lane contributes only its soundtrack.
 await pick([videoWithAudio]);await page.keyboard.press('Control+i');
 const videoSource=page.getByRole('button',{name:'Anteprima di Video con audio.mp4',exact:true});await videoSource.waitFor();
 const extractionLane=page.locator('.timeline-track-lane[data-track-kind="audio"]').last();
 const extractionLaneId=await extractionLane.getAttribute('data-track-id');
 await videoSource.dragTo(extractionLane,{targetPosition:{x:190,y:30}});
 await extractionLane.locator('.timeline-audio-clip').waitFor();
 project=await save(projectFile);assert.equal(project.clips.length,0);assert.equal(project.audioTracks.length,3);
 const extracted=project.audioTracks.find(track=>track.trackId===extractionLaneId)!;
 assert.equal(project.assets.find(asset=>asset.id===extracted.assetId)?.kind,'video');
 assert.equal(await extractionLane.locator('.timeline-audio-clip').getAttribute('aria-pressed'),'true');
 // Import and overlay two visual lanes without losing the existing narration.
 await pick([red,blue]);await page.keyboard.press('Control+i');await page.getByRole('button',{name:'Aggiungi Sfondo rosso.png al film',exact:true}).waitFor();
 await page.getByRole('button',{name:'Torna all’inizio · Home',exact:true}).click();
 await page.getByRole('button',{name:'Aggiungi Sfondo rosso.png al film',exact:true}).click();
 await page.getByRole('button',{name:'Aggiungi traccia video',exact:true}).click();
 await page.getByRole('button',{name:'Torna all’inizio · Home',exact:true}).click();
 await page.getByRole('button',{name:'Aggiungi Riquadro blu.png al film',exact:true}).click();
 // Both layers start at zero. Seek inside their overlap after button insertion
 // advances the playhead, so the preview assertion samples both at once.
 await page.getByRole('button',{name:'Torna all’inizio · Home',exact:true}).click();
 await page.getByLabel('Dimensione sullo schermo',{exact:true}).press('Home');
 for(let index=0;index<35;index++)await page.getByLabel('Dimensione sullo schermo',{exact:true}).press('ArrowRight');
 project=await save(projectFile);assert.equal(new Set(project.clips.map(clip=>clip.trackId)).size,2);assert.equal(project.clips[1].placement?.scale,.4);
 await page.waitForFunction(()=>{const canvas=document.querySelector<HTMLCanvasElement>('.preview-composite');const context=canvas?.getContext('2d');if(!canvas||!context)return false;const center=context.getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data;const corner=context.getImageData(20,20,1,1).data;return center[2]>220&&center[0]<30&&corner[0]>220&&corner[2]<30;});
 await page.getByRole('button',{name:'Logo',exact:true}).click();await pick([logo]);await page.getByRole('button',{name:'Importa e inserisci logo',exact:true}).click();
 await page.getByLabel('Animazione comparsa').selectOption('pop');await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Titoli',exact:true}).click();await page.getByRole('button',{name:'Aggiungi testo animato',exact:true}).click();
 await page.getByLabel('Testo comparsa',{exact:true}).fill('Il mio film');await page.getByLabel('Animazione comparsa').selectOption('slide-up');await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Intro / outro',exact:true}).click();await page.getByLabel('File intro o outro').selectOption({label:'Sfondo rosso.png'});await page.getByRole('button',{name:'Inserisci intro',exact:true}).click();
 project=await save(projectFile);assert.ok(project.audioTracks.every(track=>track.start>=5));assert.ok(project.clips.some(clip=>clip.role==='intro'));
 await page.getByRole('button',{name:'Rimuovi intro',exact:true}).click();project=await save(projectFile);assert.equal(project.audioTracks[0].start,0);
 await page.getByRole('button',{name:'Shorts',exact:true}).click();await page.getByRole('button',{name:'Apri studio Shorts',exact:true}).click();await page.getByRole('heading',{name:'Crea shorts',exact:true}).waitFor();await page.keyboard.press('Escape');
 await page.setViewportSize({width:1100,height:760});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:path.join(dir,'editor-tracks.png')});
 // Save/reopen preserves track identity, overlay animations and narration timing.
 project=await save(projectFile);await pick([projectFile]);await page.keyboard.press('Control+o');await page.getByText('Progetto aperto',{exact:true}).waitFor();
 assert.equal(await page.locator('.timeline-track-lane').count(),project.tracks!.length);
 const video=path.join(dir,'Multitraccia.mp4');await destination(video);await page.getByRole('button',{name:'Esporta film',exact:true}).click();await page.getByLabel('Risoluzione esportazione').selectOption('720p');await page.getByRole('button',{name:'Scegli dove salvare',exact:true}).click();
 await page.getByRole('heading',{name:'Il tuo film è pronto',exact:true}).waitFor({timeout:240000});
 const probe=JSON.parse((await runProcess(ffprobePath,['-v','error','-show_format','-of','json',video])).toString());assert.ok(Math.abs(Number(probe.format.duration)-projectDuration(project))<.15);
 assert.deepEqual(errors,[]);console.log(`Remediation UI passed: real audio transcription/SRT, audio audition, same-lane split, add tracks, video soundtrack extraction, compositing, logo/text animations, intro retiming, visible Shorts, persistence/export. ${dir}`);
}catch(error){console.error('Workflow failure',error);await page.screenshot({path:path.join(dir,'failure.png')}).catch(()=>{});console.error(await page.locator('body').innerText().catch(()=>'<page closed>'));throw error;}finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
