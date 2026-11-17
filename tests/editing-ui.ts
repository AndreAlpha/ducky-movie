import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect, type Locator } from '@playwright/test';
import { runProcess } from '../electron/process';
import { ffmpegPath } from '../electron/binaries';
import { createAudioTrack, createClip, createProject, createSubtitles, linkSubtitlesToTimeline, validateProject } from '../src/model';

await fs.mkdir('test-results', { recursive: true });
const dir = await fs.mkdtemp(path.resolve('test-results/editing-'));
const videoPath = path.join(dir, 'Video parlato.mp4');
const audioPath = path.join(dir, 'Registrazione.wav');
const logoPath = path.join(dir, 'Logo.png');
await runProcess(ffmpegPath, ['-v','error','-y','-f','lavfi','-i','color=c=navy:s=640x360:r=30','-f','lavfi','-i','sine=frequency=220:sample_rate=48000','-t','5','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',videoPath]);
await runProcess(ffmpegPath, ['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','5',audioPath]);
await runProcess(ffmpegPath, ['-v','error','-y','-f','lavfi','-i','color=c=yellow:s=120x120','-frames:v','1',logoPath]);
const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string,string] => item[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
env.DUCKY_TEST_USER_DATA = path.join(dir,'user');
const executablePath = process.env.DUCKY_EXECUTABLE;
if (executablePath) {
  env.Path = `${process.env.WINDIR}\\System32;${process.env.WINDIR}`; env.PATH = env.Path;
  delete env.DUCKY_ENGINE_EXECUTABLE; delete env.DUCKY_FFMPEG_PATH; delete env.DUCKY_FFPROBE_PATH;
}
const app = await electron.launch({ ...(executablePath ? { executablePath, args: [`--user-data-dir=${env.DUCKY_TEST_USER_DATA}`] } : { args: [path.resolve('.')] }), env, timeout: 45000 });
const page = await app.firstWindow();
page.setDefaultTimeout(20000);
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const projectFile = path.join(dir,'Editing.duckymovie');
async function save(shortcut='Control+Shift+S') {
  const before = await fs.stat(projectFile).then(stat => stat.mtimeMs).catch(() => 0);
  await app.evaluate(({dialog},file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); },projectFile);
  await page.keyboard.press(shortcut);
  await expect.poll(() => fs.stat(projectFile).then(stat => stat.mtimeMs).catch(() => 0)).toBeGreaterThan(before);
  return validateProject(JSON.parse(await fs.readFile(projectFile,'utf8')));
}
async function open() {
  await app.evaluate(({dialog},file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); },projectFile);
  await page.keyboard.press('Control+o');
  await page.getByText('Progetto aperto',{exact:true}).waitFor();
}
async function drag(element: Locator, dx: number, dy = 0) {
  await element.scrollIntoViewIfNeeded();
  const box = await element.boundingBox(); assert.ok(box);
  await page.keyboard.down('Alt');
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await page.mouse.down(); await page.mouse.move(box.x+box.width/2+dx,box.y+box.height/2+dy,{steps:8}); await page.mouse.up();
  await page.keyboard.up('Alt');
}
try {
  await page.getByRole('heading',{name:'La libreria è vuota'}).waitFor();
  const imported = await page.evaluate(paths => window.ducky.importMedia(paths),[videoPath,audioPath,logoPath]);
  assert.deepEqual(imported.errors,[]);
  const video = imported.assets.find(asset=>asset.kind==='video')!;
  const audio = imported.assets.find(asset=>asset.kind==='audio')!;
  const logo = imported.assets.find(asset=>asset.kind==='image')!;
  const clip = {...createClip(video),start:1,out:4};
  const narration = {...createAudioTrack(audio,7),out:4};
  let fixture = createProject('Montaggio sincronizzato');
  fixture.assets = imported.assets; fixture.clips=[clip]; fixture.audioTracks=[narration];
  fixture.overlays=[{id:'logo',kind:'image',assetId:logo.id,start:0,end:3,x:.5,y:.5,width:.2,opacity:1,animation:'none'},
    {id:'text',kind:'text',text:'Titolo',start:1,end:4,x:.5,y:.8,width:.5,opacity:1,animation:'none'}];
  fixture.subtitles={...createSubtitles(),words:[
    {id:'v1',segmentId:'video-phrase',text:'Ciao',start:1.25,end:1.6,source:{kind:'clip',id:clip.id,start:.25,end:.6}},
    {id:'v2',segmentId:'video-phrase',text:'mondo.',start:1.7,end:2.1,source:{kind:'clip',id:clip.id,start:.7,end:1.1}},
    {id:'a1',segmentId:'audio-first',text:'Audio.',start:7.3,end:7.7,source:{kind:'audio',id:narration.id,start:.3,end:.7}},
    {id:'a2',segmentId:'audio-last',text:'Sincronizzato.',start:9.5,end:10,source:{kind:'audio',id:narration.id,start:2.5,end:3}},
  ]};
  fixture=linkSubtitlesToTimeline(fixture);
  await fs.writeFile(projectFile,JSON.stringify(fixture)); await open();
  // Real editor controls retime linked words along with the source media.
  await page.locator(`[data-item-id="${clip.id}"]`).click();
  await page.getByLabel('Inizio clip nel film (s)',{exact:true}).fill('4');
  let project = await save(); assert.equal(project.subtitles!.words.find(word=>word.text==='Ciao')!.start,4.25);
  await page.locator(`[data-item-id="${narration.id}"]`).click();
  await page.getByLabel('Inizio traccia audio',{exact:true}).fill('10');
  project=await save(); assert.equal(project.subtitles!.words.find(word=>word.text==='Audio.')!.start,10.3);
  assert.equal(project.subtitles!.words.find(word=>word.text==='Ciao')!.start,4.25);
  // A split transfers the later transcript to the right-hand audio clip.
  await page.locator('.timeline-ruler').click({position:{x:186+12*26,y:12}});
  await page.keyboard.press('Control+b'); project=await save(); assert.equal(project.audioTracks.length,2);
  const right=project.audioTracks.find(track=>track.id!==narration.id)!;
  await page.locator(`[data-item-id="${right.id}"]`).click();
  await page.getByLabel('Inizio traccia audio',{exact:true}).fill('16');
  project=await save(); assert.ok(Math.abs(project.subtitles!.words.find(word=>word.text==='Sincronizzato.')!.start-16.5)<.05);
  // Timeline selection opens inline editing, never a modal.
  await page.locator('[data-effect-id="subtitle:0"]').click();
  assert.equal(await page.locator('dialog[open]').count(),0);
  const text=page.getByLabel('Testo frase 1',{exact:true});
  await text.fill('Testo corretto'); await text.press('End'); await text.pressSequentially(' senza perdere il collegamento.');
  assert.equal(await text.evaluate(element=>element===document.activeElement),true);
  project=await save('Control+s'); assert.ok(project.subtitles!.words.some(word=>word.text==='corretto'));
  assert.equal(await text.evaluate(element=>element===document.activeElement),true,'Salva conferma il testo in modifica senza perdere il focus');
  assert.ok(project.subtitles!.words.filter(word=>word.segmentId===project.subtitles!.words[0].segmentId).every(word=>word.source?.id===clip.id));
  await page.locator('.caption-row').first().locator('.caption-detail > summary').click();
  const endInput=page.getByLabel('Fine frase 1 (s)',{exact:true});
  await endInput.fill('5.3');project=await save('Control+s');assert.equal(await endInput.inputValue(),'5.300');
  await page.getByRole('button',{name:'Apri stile sottotitoli',exact:true}).click();
  project=await save();assert.ok(Math.abs(project.subtitles!.words.filter(word=>word.source?.id===clip.id).at(-1)!.end-5.3)<.001);
  // Logo duration and time can be edited directly, with one undo per gesture.
  const logoItem=page.locator('[data-effect-id="logo"]');
  await logoItem.click(); assert.equal(await page.locator('dialog[open]').count(),0);
  await drag(logoItem.locator('[data-effect-edge="end"]'),52);
  project=await save(); assert.ok(Math.abs(project.overlays!.find(item=>item.id==='logo')!.end-5)<.1);
  await logoItem.focus(); await page.keyboard.press('Control+z');
  project=await save(); assert.equal(project.overlays!.find(item=>item.id==='logo')!.end,3);
  await page.keyboard.press('Control+y');
  await logoItem.focus(); await page.keyboard.press('Shift+ArrowRight');
  project=await save(); assert.equal(project.overlays!.find(item=>item.id==='logo')!.start,1);
  assert.ok(Math.abs(project.overlays!.find(item=>item.id==='logo')!.end-6)<.1);
  // Overlapping graphics stay on individually reachable rows.
  const logoBox=await logoItem.boundingBox(), textBox=await page.locator('[data-effect-id="text"]').boundingBox();
  assert.ok(logoBox&&textBox&&Math.abs(logoBox.y-textBox.y)>=35);
  await page.locator('.timeline-ruler').click({position:{x:186+1.5*26,y:12}});
  await logoItem.click();
  const canvas=page.locator('.preview-effects');const box=await canvas.boundingBox();assert.ok(box);
  await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();
  await page.mouse.move(box.x+box.width*.6,box.y+box.height*.55,{steps:8});await page.mouse.up();
  project=await save(); assert.ok(project.overlays!.find(item=>item.id==='logo')!.x>.58);
  assert.equal(await page.locator('dialog[open]').count(),0);
  await page.setViewportSize({width:1100,height:760});
  await page.getByRole('button',{name:'Sottotitoli',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(dir,'inline-editor.png')});
  await open(); const reopened=await save();assert.deepEqual(reopened.subtitles,project.subtitles);
  // Opening a different revision with the same project/phrase IDs resets drafts.
  const revision=structuredClone(reopened), revisionFile=path.join(dir,'Revisione.duckymovie');
  const firstWord=revision.subtitles!.words[0];firstWord.text='Versione';
  const originalWord=revision.subtitles!.linkedWords?.find(word=>word.id===(firstWord.linkedId??firstWord.id));
  if(originalWord)originalWord.text='Versione';
  await fs.writeFile(revisionFile,JSON.stringify(revision));
  await page.getByLabel('Testo frase 1',{exact:true}).fill('Bozza del progetto precedente.');
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},revisionFile);
  await page.keyboard.press('Control+o');
  await expect(page.getByLabel('Testo frase 1',{exact:true})).toHaveValue(/^Versione /);
  await page.getByRole('button',{name:'Apri stile sottotitoli',exact:true}).click();
  project=await save();assert.equal(project.subtitles!.words[0].text,'Versione');
  assert.deepEqual(errors,[]);
  await page.getByLabel('Testo frase 1',{exact:true}).fill('Ultima modifica non persa.');
  const closed=app.waitForEvent('close',{timeout:20000});
  await app.evaluate(({dialog,BrowserWindow})=>{dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});BrowserWindow.getAllWindows()[0].close();});
  await closed;
  const afterClose=validateProject(JSON.parse(await fs.readFile(projectFile,'utf8')));
  assert.ok(afterClose.subtitles!.words.some(word=>word.text==='Ultima'),'La chiusura salva anche la frase ancora in modifica');
  console.log(`Editing UI passed: linked video/audio movement, audio split, inline captions, typing focus, logo trim/move/undo, preview drag, overlapping overlays, persistence. ${dir}`);
} catch(error) {
  await page.screenshot({path:path.join(dir,'failure.png')}).catch(()=>{});
  console.error(await page.locator('body').innerText().catch(()=>'<closed>')); throw error;
} finally { await app.evaluate(({app})=>app.exit(0)).catch(()=>{}); await app.close().catch(()=>{}); }
