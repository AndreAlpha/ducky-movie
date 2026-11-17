import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { runProcess } from '../electron/process';
import { ffmpegPath } from '../electron/binaries';

await fs.mkdir('test-results',{recursive:true});
const dir=await fs.mkdtemp(path.resolve('test-results/library-ui-'));
const photos=path.join(dir,'Foto originali'), recordings=path.join(dir,'Registrazioni');
await fs.mkdir(photos);await fs.mkdir(recordings);
const images=['A.png','B.png','C.png'].map(name=>path.join(photos,name));
for(let i=0;i<images.length;i++)await runProcess(ffmpegPath,['-v','error','-y','-f','lavfi','-i',`color=c=${['red','blue','green'][i]}:s=320x180`,'-frames:v','1',images[i]]);
const voice=path.join(recordings,'Voce.wav'), longVideo=path.join(recordings,'Video lungo.mp4');
await runProcess(ffmpegPath,['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','8',voice]);
await runProcess(ffmpegPath,['-v','error','-y','-f','lavfi','-i','color=c=purple:s=320x180:r=10','-t','65','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',longVideo]);
const env=Object.fromEntries(Object.entries(process.env).filter((item):item is[string,string]=>item[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;
env.DUCKY_TEST_USER_DATA=path.join(dir,'user');env.DUCKY_MODELS_DIR=path.resolve('.cache/models');env.HF_HUB_OFFLINE='1';
const executablePath=process.env.DUCKY_EXECUTABLE;
if(executablePath){env.Path=`${process.env.WINDIR}\\System32;${process.env.WINDIR}`;env.PATH=env.Path;delete env.DUCKY_ENGINE_EXECUTABLE;delete env.DUCKY_FFMPEG_PATH;delete env.DUCKY_FFPROBE_PATH;}
const app=await electron.launch({...executablePath?{executablePath,args:[`--user-data-dir=${env.DUCKY_TEST_USER_DATA}`]}:{args:[path.resolve('.')]},env,timeout:45000});
const page=await app.firstWindow();page.setDefaultTimeout(25000);
const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
async function pick(files:string[],canceled=false){await app.evaluate(({dialog},{files,canceled})=>{
 const state=globalThis as typeof globalThis&{mediaDialogDefaults?:Array<string|undefined>;mediaDialogProperties?:string[]};
 dialog.showOpenDialog=(async(...args:unknown[])=>{const options=args.at(-1) as {defaultPath?:string;properties:string[]};state.mediaDialogDefaults??=[];state.mediaDialogDefaults.push(options.defaultPath);state.mediaDialogProperties=options.properties;return{canceled,filePaths:files};}) as typeof dialog.showOpenDialog;
},{files,canceled});}
const selection=()=>page.locator('.asset-card.selected');
const clipIds=()=>page.locator('.timeline-clip').evaluateAll(items=>items.map(item=>item.getAttribute('data-item-id')));
try{
 await page.getByRole('heading',{name:'La libreria è vuota'}).waitFor();
 await pick(images);await page.getByRole('button',{name:'Importa media',exact:true}).click();
 await expect(selection()).toHaveCount(3);
 const a=page.getByRole('button',{name:'Anteprima di A.png',exact:true}),b=page.getByRole('button',{name:'Anteprima di B.png',exact:true}),c=page.getByRole('button',{name:'Anteprima di C.png',exact:true});
 await a.click();await expect(selection()).toHaveCount(1);await c.click({modifiers:['Control']});await expect(selection()).toHaveCount(2);
 await b.click({modifiers:['Shift']});await expect(selection()).toHaveCount(2);await expect(b).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('.library-panel input[type="checkbox"]')).toHaveCount(0);
 await b.press('Control+a');await expect(selection()).toHaveCount(3);
 await page.getByRole('button',{name:'Aggiungi selezione alla timeline',exact:true}).click();await expect(page.locator('.timeline-clip')).toHaveCount(3);
 await page.keyboard.press('Control+z');await expect(page.locator('.timeline-clip')).toHaveCount(0);
 await page.keyboard.press('Control+y');await expect(page.locator('.timeline-clip')).toHaveCount(3);
 await a.click();await b.click({modifiers:['Control']});
 await a.dragTo(page.locator('.timeline-video-lane').first(),{targetPosition:{x:186+17*26,y:45}});
 await expect(page.locator('.timeline-clip')).toHaveCount(5);
 // Native imports start in the last selected folder; cancelling retains it.
 await pick([voice,longVideo]);await page.keyboard.press('Control+i');await page.getByRole('button',{name:'Anteprima di Video lungo.mp4',exact:true}).waitFor();
 const defaults=await app.evaluate(()=>{const state=globalThis as typeof globalThis&{mediaDialogDefaults:string[];mediaDialogProperties:string[]};return{defaults:state.mediaDialogDefaults,properties:state.mediaDialogProperties};});
 assert.equal(defaults.defaults.at(-1),photos);assert.ok(defaults.properties.includes('multiSelections'));
 await pick([],true);await page.keyboard.press('Control+i');
 await expect.poll(()=>app.evaluate(()=>(globalThis as typeof globalThis&{mediaDialogDefaults:string[]}).mediaDialogDefaults.at(-1))).toBe(recordings);
 await page.getByRole('button',{name:'Aggiungi Video lungo.mp4 al film',exact:true}).click();
 // Ctrl+wheel zooms the timeline around the pointer without zooming the application.
 const scroll=page.locator('.timeline-scroll');
 await page.getByRole('button',{name:'Torna all’inizio · Home',exact:true}).click();
 const bounds=await scroll.boundingBox();assert.ok(bounds);
 const zoom=async()=>2**Number(await page.getByLabel('Zoom timeline',{exact:true}).inputValue());
 const beforeZoom=await zoom(),beforeLeft=await scroll.evaluate(node=>node.scrollLeft),pixelRatio=await page.evaluate(()=>devicePixelRatio);
 const anchorX=400;
 await page.mouse.move(bounds.x+anchorX,bounds.y+35);await page.keyboard.down('Control');await page.mouse.wheel(0,-220);await page.keyboard.up('Control');
 await expect.poll(zoom).toBeGreaterThan(beforeZoom);
 const afterZoom=await zoom(),afterLeft=await scroll.evaluate(node=>node.scrollLeft);
 assert.ok(Math.abs((beforeLeft+anchorX-186)/beforeZoom-(afterLeft+anchorX-186)/afterZoom)<.15);
 assert.equal(await page.evaluate(()=>devicePixelRatio),pixelRatio);
 await page.getByRole('button',{name:'Vai alla fine · End',exact:true}).click();await expect.poll(()=>scroll.evaluate(node=>node.scrollLeft)).toBeGreaterThan(0);
 await page.getByRole('button',{name:'Torna all’inizio · Home',exact:true}).click();await expect.poll(()=>scroll.evaluate(node=>node.scrollLeft)).toBeLessThan(1);
 const playhead=await page.locator('.timeline-playhead').boundingBox();assert.ok(playhead&&playhead.x>=bounds.x+185);
 await page.locator('.fit-button').click();
 await page.locator('.timeline-video-lane').first().evaluate(node=>node.dispatchEvent(new DragEvent('dragleave',{bubbles:true,relatedTarget:window})));
 // Unsaved automatic montage never opens a save dialog and has a complete Undo.
 const previousIds=await clipIds();
 await app.evaluate(({dialog})=>{const state=globalThis as typeof globalThis&{saveRequests:number};state.saveRequests=0;dialog.showSaveDialog=async()=>{state.saveRequests++;return{canceled:true,filePath:''};};});
 await page.getByRole('button',{name:'Seleziona tutti i media',exact:true}).click();
 await page.getByRole('button',{name:'Monta la selezione',exact:true}).click();
 const semantic=page.getByLabel('Abbina le immagini al parlato con analisi locale');if(await semantic.count())await semantic.uncheck();
 const captions=page.getByLabel('Crea sottotitoli sincronizzati');if(await captions.count())await captions.uncheck();
 await page.getByRole('button',{name:'Crea montaggio modificabile',exact:true}).click();
 await page.locator('dialog[open]').waitFor({state:'hidden',timeout:180000});
 assert.equal(await app.evaluate(()=>(globalThis as typeof globalThis&{saveRequests:number}).saveRequests),0);
 assert.notDeepEqual(await clipIds(),previousIds);
 await page.keyboard.press('Control+z');await page.locator('.fit-button').click();assert.deepEqual(await clipIds(),previousIds);
 await page.keyboard.press('Control+y');assert.notDeepEqual(await clipIds(),previousIds);
 await page.locator('.fit-button').click();
 await page.setViewportSize({width:1100,height:760});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:path.join(dir,'library-timeline.png')});
 assert.deepEqual(errors,[]);
 console.log(`Library/timeline UI passed: multi-selection, bulk add/drag/Undo, remembered import folder, Ctrl-wheel anchored zoom, reverse playhead follow, dragleave regression and automatic montage without saving. ${dir}`);
}catch(error){await page.screenshot({path:path.join(dir,'failure.png')}).catch(()=>{});console.error(await page.locator('body').innerText().catch(()=>'<closed>'));throw error;}
finally{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
