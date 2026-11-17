import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { ffmpegPath, ffprobePath } from '../electron/binaries';
import { runProcess } from '../electron/process';
import { createProject, createClip, createAudioTrack, createSubtitles, validateProject } from '../src/model';

const directory = await fs.mkdtemp(path.resolve('test-results/advanced-ui-'));
const video = path.join(directory, 'Scene.mp4');
const photo = path.join(directory, 'Logo.png');
const audio = path.join(directory, 'Narration.wav');
await runProcess(ffmpegPath, ['-v','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=30:duration=8','-f','lavfi','-i','sine=frequency=420:duration=8','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',video]);
await runProcess(ffmpegPath, ['-v','error','-y','-f','lavfi','-i','color=c=yellow:s=160x90','-frames:v','1',photo]);
await runProcess(ffmpegPath, ['-v','error','-y','-f','lavfi','-i','sine=frequency=220:duration=4',audio]);
const data = path.join(directory,'user');
const env = Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));
delete env.ELECTRON_RUN_AS_NODE;
env.DUCKY_TEST_USER_DATA = data;
env.DUCKY_MODELS_DIR = path.resolve('.cache/models');
const executable = process.env.DUCKY_EXECUTABLE;
if (executable) {
  const windowsDirectory=process.env.WINDIR || 'C:\\Windows';
  env.Path = `${windowsDirectory}\\System32;${windowsDirectory}`;
  env.PATH=env.Path;
  delete env.DUCKY_ENGINE_EXECUTABLE;
  delete env.DUCKY_FFMPEG_PATH;
  delete env.DUCKY_FFPROBE_PATH;
}
const app = await electron.launch({ ...(executable ? {executablePath:executable,args:[`--user-data-dir=${data}`]} : {args:[path.resolve('.')]}),env,timeout:45000 });
const page = await app.firstWindow();
const errors:string[]=[];
page.on('pageerror',error=>errors.push(error.message));
page.setDefaultTimeout(30000);
async function pickOpen(files:string[]) { await app.evaluate(({dialog},files)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:files});},files); }
async function pickSave(file:string) {
  await app.evaluate(({dialog},file)=>{
    const state=globalThis as typeof globalThis & { duckySaveDialogCalls?:number };
    state.duckySaveDialogCalls=0;
    dialog.showSaveDialog=async()=>{state.duckySaveDialogCalls!++;return {canceled:false,filePath:file};};
  },file);
}
async function save(file:string) {
  const previousTime=await fs.stat(file).then(value=>value.mtimeMs).catch(()=>0);
  await pickSave(file);
  await page.keyboard.press('Control+Shift+S');
  await expect.poll(()=>app.evaluate(()=>Number((globalThis as typeof globalThis & {duckySaveDialogCalls?:number}).duckySaveDialogCalls??0)),
    {message:'Ctrl+Shift+S apre il dialogo Salva con nome dopo il cambio progetto',timeout:10000}).toBeGreaterThan(0);
  await expect.poll(()=>fs.stat(file).then(value=>value.mtimeMs).catch(()=>0),
    {message:`Il progetto viene scritto nel file selezionato ${path.basename(file)}`,timeout:10000}).toBeGreaterThan(previousTime);
  await page.waitForFunction(()=>document.querySelector('.save-state')?.textContent?.includes('Salvato'));
}
async function open(file:string) {
  const expected=JSON.parse(await fs.readFile(file,'utf8'));
  await pickOpen([file]);
  await page.getByRole('button',{name:'Apri progetto · Ctrl+O',exact:true}).click();
  await page.waitForFunction(name=>(document.querySelector('input[aria-label="Nome del progetto"]') as HTMLInputElement)?.value===name,expected.name);
  await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
}
try {
  await page.getByRole('heading',{name:'La libreria è vuota'}).waitFor();
  await pickSave(path.join(directory,'Initial.duckymovie'));
  await pickOpen([video,photo,audio]);
  await page.getByRole('button',{name:'Importa media',exact:true}).click();
  await page.getByRole('button',{name:'Aggiungi Logo.png al film',exact:true}).waitFor({timeout:60000});
  await page.getByRole('button',{name:'Montaggio automatico',exact:true}).click();
  await page.getByLabel('Abbina le immagini al parlato con analisi locale').uncheck();
  await page.getByLabel('Crea sottotitoli sincronizzati').uncheck();
  await page.getByRole('button',{name:'Crea montaggio modificabile',exact:true}).click();
  await page.locator('.timeline-clip').first().waitFor();
  const montageFile = path.join(directory,'Montage.duckymovie');
  await save(montageFile);
  const montage = validateProject(JSON.parse(await fs.readFile(montageFile,'utf8')));
  assert.equal(montage.audioTracks.length,1);
  assert.ok(montage.clips.some(clip=>montage.assets.find(asset=>asset.id===clip.assetId)?.kind==='image'&&clip.zoom!=='none'));
  assert.ok(montage.clips.some(clip=>montage.assets.find(asset=>asset.id===clip.assetId)?.kind==='video'));
  assert.equal(montage.duration,4);
  await page.getByLabel('Nome del progetto',{exact:true}).fill('Montaggio prima dello short');
  await app.evaluate(({dialog})=>{
    const state=globalThis as typeof globalThis&{shortSaveRequests:number};state.shortSaveRequests=0;
    dialog.showSaveDialog=async()=>{state.shortSaveRequests++;return{canceled:true,filePath:''};};
  });
  await page.getByRole('button',{name:'Crea shorts',exact:true}).click();
  await page.getByLabel('Durata target shorts').fill('5');
  await page.getByRole('button',{name:'Trova momenti salienti',exact:true}).click();
  await page.locator('.short-candidates button').first().waitFor({timeout:120000});
  assert.ok(await page.locator('.short-candidates button').count()>0);
  await page.getByLabel('Entrata short').fill('1');
  await page.getByLabel('Uscita short').fill('3');
  await page.getByLabel('Inquadratura shorts',{exact:true}).selectOption('group');
  await page.getByLabel('Movimento camera shorts',{exact:true}).selectOption('responsive');
  await page.getByLabel('Anteprima video sorgente',{exact:true}).evaluate(video=>(video as HTMLVideoElement).currentTime=2);
  await page.getByRole('button',{name:'Scegli soggetto nell’anteprima',exact:true}).click();
  await expect.poll(()=>page.getByLabel('Anteprima video sorgente',{exact:true}).evaluate(video=>(video as HTMLVideoElement).currentTime)).toBe(1);
  const focusTarget=page.getByRole('button',{name:'Scegli punto del soggetto',exact:true});
  const focusBounds=await focusTarget.boundingBox();assert.ok(focusBounds);
  await focusTarget.click({position:{x:focusBounds.width*.3,y:focusBounds.height*.5}});
  await expect(page.getByLabel('Soggetto scelto',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Selezione automatica',exact:true}).click();
  await expect(page.getByLabel('Soggetto scelto',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Scegli soggetto nell’anteprima',exact:true}).click();
  await focusTarget.press('ArrowRight');await focusTarget.press('Enter');
  await expect(page.getByLabel('Soggetto scelto',{exact:true})).toBeVisible();
  await page.getByLabel('Entrata short').fill('1.1');
  await expect(page.getByLabel('Soggetto scelto',{exact:true})).toHaveCount(0);
  await page.getByLabel('Entrata short').fill('1');
  await page.getByRole('button',{name:'Scegli soggetto nell’anteprima',exact:true}).click();
  await focusTarget.press('ArrowRight');await focusTarget.press('Enter');
  await page.screenshot({path:path.join(directory,'shorts-focus.png')});
  await page.getByRole('button',{name:'Genera e modifica lo short',exact:true}).click();
  await page.waitForFunction(()=>!(document.querySelector('dialog[open]')),{},{timeout:180000});
  assert.equal(await app.evaluate(()=>(globalThis as typeof globalThis&{shortSaveRequests:number}).shortSaveRequests),0);
  assert.equal(await page.getByLabel('Formato del film',{exact:true}).inputValue(),'9:16');
  const shortFile = path.join(directory,'Short.duckymovie');
  await save(shortFile);
  const short = validateProject(JSON.parse(await fs.readFile(shortFile,'utf8')));
  assert.equal(short.clips.length,1);
  assert.ok(Math.abs(short.clips[0].out-2)<.1);
  assert.ok(short.assets.find(asset=>asset.id===short.clips[0].assetId)?.path.includes('generated'), 'Lo short resta disponibile nel progetto dopo la chiusura del lavoro');
  assert.ok(short.assets.some(asset=>asset.name==='Scene.mp4'), 'La libreria sorgente resta disponibile per creare altri short');

  const {assets} = await page.evaluate(files=>window.ducky.importMedia(files),[video,photo,audio]);
  const project = createProject('Effetti avanzati');
  project.assets=assets;
  project.clips=[{...createClip(assets[0]),out:2,zoom:'in',zoomAmount:1.07,transition:'fade',transitionDuration:.3,filter:'warm'}, {...createClip(assets[1]),out:1,start:2.5,transition:'white',transitionDuration:.2}];
  project.audioTracks=[{...createAudioTrack(assets[2]),out:3}];
  project.subtitles={...createSubtitles(),words:[{start:.2,end:.7,text:'Questo'},{start:.7,end:1.2,text:'film'},{start:1.2,end:1.8,text:'funziona.'}]};
  project.music={assetId:assets[2].id,start:0,in:0,out:1,volume:.15,loop:true,duck:true};
  const advancedFile=path.join(directory,'Advanced.duckymovie');
  await fs.writeFile(advancedFile,JSON.stringify(project));
  await open(advancedFile);
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('[aria-label="Nome del progetto"]')?.value==='Effetti avanzati');
  await page.getByRole('button',{name:'Riproduci · Spazio',exact:true}).click();
  await page.waitForFunction(()=>{
    const music=Array.from(document.querySelectorAll('audio')).at(-1);
    return !!music && !music.paused && music.volume>0 && music.volume<.08;
  });
  await page.getByRole('button',{name:'Pausa · Spazio',exact:true}).click();
  await page.getByRole('button',{name:'Proprietà del film · sottotitoli, comparse e musica',exact:true}).click();
  await page.getByLabel('Stile sottotitoli').selectOption('pop');
  await page.getByRole('button',{name:'Sottotitoli',exact:true}).click();
  await page.getByLabel('Cerca nei sottotitoli').fill('film');
  await page.getByRole('button',{name:'Sostituisci',exact:true}).click();
  await page.getByLabel('Testo sostitutivo').fill('video');
  await page.getByRole('button',{name:'Sostituisci tutte',exact:true}).click();
  await page.getByRole('button',{name:'Proprietà del film · sottotitoli, comparse e musica',exact:true}).click();
  await page.getByText('Comparse, logo e invito a iscriversi',{exact:true}).click();
  await page.getByRole('button',{name:'Iscriviti',exact:true}).click();
  await page.getByLabel('Animazione comparsa').selectOption('pop');
  await page.getByLabel('Suono di comparsa').check();
  await page.getByRole('button',{name:'Proprietà del film · sottotitoli, comparse e musica',exact:true}).click();
  await page.getByText('Cornice',{exact:true}).click();
  await page.getByLabel('Stile cornice').selectOption('film');
  await page.keyboard.press('Escape');
  await save(advancedFile);
  const updated=validateProject(JSON.parse(await fs.readFile(advancedFile,'utf8')));
  assert.equal(updated.subtitles!.words[1].text,'video');
  assert.equal(updated.frame?.style,'film');
  assert.equal(updated.overlays?.[0].animation,'pop');
  await page.screenshot({path:path.join(directory,'advanced-editor.png')});

  const templateFile=path.join(directory,'Style.duckymodel');
  await page.getByRole('button',{name:'Progetti',exact:true}).click();
  await pickSave(templateFile);
  await page.getByRole('button',{name:'Salva come modello',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.toast')?.textContent?.includes('Modello salvato'));
  const template=JSON.parse(await fs.readFile(templateFile,'utf8'));
  assert.equal(template.kind,'duckymovie-template');
  assert.equal(template.project.clips.length,0);
  await page.keyboard.press('Escape');
  const exported=path.join(directory,'Advanced.mp4');
  await pickSave(exported);
  await page.getByRole('button',{name:'Esporta film',exact:true}).click();
  await page.getByLabel('Risoluzione esportazione').selectOption('720p');
  await page.getByRole('button',{name:'Scegli dove salvare',exact:true}).click();
  await page.getByRole('heading',{name:'Il tuo film è pronto',exact:true}).waitFor({timeout:240000});
  const probe=JSON.parse((await runProcess(ffprobePath,['-v','error','-show_streams','-show_format','-of','json',exported])).toString());
  assert.ok(Math.abs(Number(probe.format.duration)-3.5)<.15);
  assert.equal(probe.streams.find((stream:{codec_type:string})=>stream.codec_type==='video').width,1280);
  assert.ok(probe.streams.some((stream:{codec_type:string})=>stream.codec_type==='audio'));
  await page.screenshot({path:path.join(directory,'exported.png')});
  await page.getByRole('button',{name:'Chiudi',exact:true}).click();

  const legacyFile=path.join(directory,'Legacy.dvproj.json');
  await fs.writeFile(legacyFile,JSON.stringify({version:3,width:1920,height:1080,
    intro:{path:video,duration:2},outro:{path:video,duration:.8},logo:photo,
    media:[{path:photo,type:'image'}],segments:[{type:'image',source:photo,start:0,end:4,zoom_in:false,transition:'white'}],
    audios:[{path:audio,start:0,in:0,out:4,volume:1.4}],
    subtitles:{enabled:true,max_words:5,max_lines:2,events:[{start:.1,end:.8,words:[{t0:.1,t1:.8,text:'Importato'}]}]},
  }));
  await page.getByRole('button',{name:'Progetti',exact:true}).click();
  await pickOpen([legacyFile]);
  await page.getByRole('button',{name:'Importa progetto DuckyPlay',exact:true}).click();
  await page.waitForFunction(()=>!(document.querySelector('dialog[open]')));
  const convertedFile=path.join(directory,'Converted.duckymovie');
  await save(convertedFile);
  const converted=validateProject(JSON.parse(await fs.readFile(convertedFile,'utf8')));
  assert.equal(converted.name,'Progetto DuckyPlay');
  assert.equal(converted.duration,9);
  assert.equal(converted.audioTracks[0].start,2);
  assert.equal(converted.audioTracks[0].volume,1.4);
  assert.equal(converted.subtitles?.words[0].start,2.1);
  assert.equal(converted.clips[1].zoom,'out');
  assert.ok(Math.abs(converted.clips[2].start!-8.2)<.001);
  assert.equal(converted.overlays?.[0].persistent,true);

  const brandingFile=path.join(directory,'Branding.duckymodel');
  await page.getByRole('button',{name:'Progetti',exact:true}).click();
  await pickSave(brandingFile);
  await page.getByRole('button',{name:'Salva come modello',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.toast')?.textContent?.includes('Modello salvato'));
  const branding=JSON.parse(await fs.readFile(brandingFile,'utf8'));
  assert.equal(branding.project.assets.length,2,'Il modello include soltanto intro/outro e logo');
  assert.ok(branding.project.assets.every((asset:{name:string})=>asset.name!=='Narration.wav'));
  await page.keyboard.press('Escape');

  const target=createProject('Film con modello');
  target.assets=assets;
  target.clips=[{...createClip(assets[1]),out:2}];
  target.audioTracks=[{...createAudioTrack(assets[2]),volume:1}];
  target.duration=4;
  target.subtitles={...createSubtitles(),words:[{start:.25,end:1,text:'Conservato'}]};
  const targetFile=path.join(directory,'With-template.duckymovie');
  await fs.writeFile(targetFile,JSON.stringify(target));
  await open(targetFile);
  await page.getByRole('button',{name:'Progetti',exact:true}).click();
  await pickOpen([brandingFile]);
  await page.getByRole('button',{name:'Applica modello',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.toast')?.textContent?.includes('Modello applicato'));
  await save(targetFile);
  const applied=validateProject(JSON.parse(await fs.readFile(targetFile,'utf8')));
  assert.equal(applied.clips.length,3);
  assert.equal(applied.clips[0].role,'intro');
  assert.equal(applied.clips[2].role,'outro');
  assert.equal(applied.clips[2].start,6);
  assert.equal(applied.duration,6.8);
  assert.equal(applied.audioTracks[0].start,2);
  assert.equal(applied.subtitles?.words[0].text,'Conservato');
  assert.equal(applied.subtitles?.words[0].start,2.25);
  assert.equal(applied.overlays?.[0].start,2);
  assert.equal(applied.overlays?.[0].end,6);

  const unavailableFile=path.join(directory,'Missing.dvproj.json');
  await fs.writeFile(unavailableFile,JSON.stringify({version:3,segments:[{type:'image',source:path.join(directory,'missing.jpg'),start:0,end:2}]}));
  await page.getByRole('button',{name:'Progetti',exact:true}).click();
  await pickOpen([unavailableFile]);
  await page.getByRole('button',{name:'Importa progetto DuckyPlay',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.toast')?.textContent?.includes('Ripristina i media'));
  await page.keyboard.press('Escape');
  assert.equal(await page.getByLabel('Nome del progetto',{exact:true}).inputValue(),'Film con modello');
  await page.locator('.fit-button').click();
  assert.equal(await page.locator('.timeline-clip').count(),3);
  await page.screenshot({path:path.join(directory,'imported-template.png')});
  assert.deepEqual(errors,[]);
  console.log(`Advanced UI passed: montage, highlight analysis, short generation, subtitle editing, overlay, frame, MP4, DuckyPlay import, template apply, unavailable-media protection. ${directory}`);
} catch (error) {
  await page.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});
  console.error('Save diagnostics',await page.evaluate(()=>({
    focused:document.activeElement?.outerHTML,dialogs:document.querySelectorAll('dialog[open]').length,
    project:document.querySelector<HTMLInputElement>('[aria-label="Nome del progetto"]')?.value,
    saveState:document.querySelector('.save-state')?.textContent,toast:document.querySelector('.toast')?.textContent,
  })));
  console.error(await page.locator('body').innerText());
  throw error;
} finally { await app.evaluate(({app})=>app.exit(0)).catch(()=>{}); await app.close().catch(()=>{}); }
