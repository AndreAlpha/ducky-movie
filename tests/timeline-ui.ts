import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

// Isolated, real-browser component tests keep native drag/wheel/pointer behavior while
// exercising the actual model and timeline code without a user's project or media.
const source = String.raw`
import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Timeline,TIMELINE_GUTTER,MIN_TIMELINE_ZOOM,MAX_TIMELINE_ZOOM} from './src/components/Timeline';
import * as m from './src/model';
import {insertLibraryAssets} from './src/library';
import './src/styles.css';
const video={id:'asset-v',name:'Fixture video',path:'C:/fixture/video.mp4',url:'',kind:'video',duration:5,width:320,height:180,hasAudio:true};
const audio={...video,id:'asset-a',name:'Fixture audio',path:'C:/fixture/audio.wav',kind:'audio'};
let initial=m.addTimelineTrack(m.createProject('32 clip'), 'video');
initial.assets=[video,audio];
const upper=initial.tracks[0].id;
initial.clips=[{...m.createClip(video,upper),id:'upper-late',start:80},{...m.createClip(video,upper),id:'upper-early',start:10},...Array.from({length:32},(_,index)=>({...m.createClip(video),id:'c'+index,start:index*5}))];
initial.subtitles={...m.createSubtitles(),words:[{id:'w-main',segmentId:'s-main',text:'Montaggio.',start:.5,end:1,source:{kind:'clip',id:'c0',start:.5,end:1}},{id:'w-upper',segmentId:'s-upper',text:'Sovrapposizione.',start:10.5,end:11,source:{kind:'clip',id:'upper-early',start:.5,end:1}}]};
initial.overlays=[{id:'graphic',kind:'text',text:'Grafica',start:80,end:90,x:.5,y:.5,width:.3,opacity:1,animation:'none'}];
initial=m.linkSubtitlesToTimeline(initial);
function Harness(){
 const[p,setP]=useState(initial),[time,setTime]=useState(0),[zoom,setZoom]=useState(26),[selected,setSelected]=useState(null),[selection,setSelection]=useState([]),[effect,setEffect]=useState(undefined),[errors,setErrors]=useState([]),[bulk,setBulk]=useState(null),[snapping,setSnapping]=useState(true);
 const current=useRef(p),throwGroup=useRef(false),commits=useRef(0);current.current=p;
 function edit(next){commits.current++;const synchronized=m.syncLinkedSubtitles(current.current,next);current.current=synchronized;setP(synchronized);}
 function reset(){current.current=initial;setP(initial);setTime(0);setZoom(26);setSelected(null);setSelection([]);setEffect(undefined);setErrors([]);setBulk(null);setSnapping(true);throwGroup.current=false;commits.current=0;}
 function snapFixture(){throwGroup.current=false;setErrors([]);const next={...initial,assets:initial.assets.map(a=>({...a,duration:30})),clips:[{...m.createClip(video),id:'c0',in:1,out:4,start:2},{...m.createClip(video),id:'c1',in:1,out:3,start:8},{...m.createClip(video),id:'target',start:20}],audioTracks:[{...m.createAudioTrack(audio),id:'a0',in:1,out:4,start:10,trackId:'audio-main'},{...m.createAudioTrack(audio),id:'a1',in:0,out:4,start:22,trackId:'audio-main'}],overlays:[{...initial.overlays[0],id:'graphic',start:7,end:10}],subtitles:{...m.createSubtitles(),words:[{id:'w-main',segmentId:'s-main',text:'Clip.',start:2.5,end:3,source:{kind:'clip',id:'c0',start:1.5,end:2}},{id:'w-free',segmentId:'s-free',text:'Libero.',start:15,end:17}]}};current.current=next;setP(next);setTime(12);setZoom(26);setSelected(null);setSelection([]);setEffect(undefined);setSnapping(true);commits.current=0;}
 useEffect(()=>{window.timelineReview={project:p,time,zoom,errors,bulk,snapping,commits:commits.current,setTime,setZoom,setEffect,setSelection,setSnapping,throwGroup,reset,snapFixture,fit(){const node=document.querySelector('.timeline-scroll');setZoom(Math.max(MIN_TIMELINE_ZOOM,Math.min(MAX_TIMELINE_ZOOM,(node.clientWidth-TIMELINE_GUTTER-32)/m.projectDuration(current.current))));},longFilm(){const next={...current.current,duration:86400};current.current=next;setP(next);setTime(0);},upper};});
 useEffect(()=>{const key=e=>{if(e.defaultPrevented||e.target.closest('input,textarea,select'))return;if(e.key==='Home')setTime(0);if(e.key==='End')setTime(m.projectDuration(current.current));};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
 return <><button id="library-drag" draggable onDragStart={event=>{event.dataTransfer.setData('application/x-ducky-asset',video.id);event.dataTransfer.effectAllowed='copy';}}>Media di prova</button><div style={{display:'flex',height:540,width:1000}}><Timeline project={p} time={time} zoom={zoom} snappingEnabled={snapping} onZoomChange={setZoom} selectedId={selected} selectedIds={selection} selectedEffectId={effect} onSelectOverlay={setEffect} onSelectSubtitle={index=>setEffect('subtitle:'+index)} onSelectionChange={setSelection} onSelect={setSelected} onTimeChange={setTime} onPlaceItem={(id,kind,ids,lane,start,pointerTime)=>{if(throwGroup.current)throw new Error('Spostamento non disponibile');edit(m.applyTimelineMove(current.current,id,kind,ids,lane,start,pointerTime));}} onMoveGroup={(ids,delta)=>edit(m.shiftClips(current.current,ids,delta))} onDropAsset={(id,_index,lane,time)=>edit(insertLibraryAssets(current.current,[id],time,lane).project)} onDropAssets={(ids,lane,time)=>{setBulk({ids,lane,time});edit(insertLibraryAssets(current.current,ids,time,lane).project);}} onDropError={message=>setErrors(values=>[...values,message])} onTrim={(id,input,output)=>edit(m.trimClip(current.current,id,input,output))} onAudioChange={(id,patch)=>edit(m.updateAudioTrack(current.current,id,patch))} onOverlayChange={(id,patch)=>edit({...current.current,overlays:current.current.overlays.map(o=>o.id===id?{...o,...patch}:o)})} onSubtitleChange={(index,timing)=>edit(m.setSubtitleEventTiming(current.current,index,timing))} /></div></>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;

const bundle = await build({
  stdin: { contents: source, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, platform: 'browser', format: 'esm', jsx: 'automatic',
  outfile: 'timeline-review.js', external: ['/fonts/*'],
});
const javascript = bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
const server = createServer(async (request, response) => {
  if (request.url === '/timeline-review.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(javascript); }
  else if (request.url === '/timeline-review.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
  else if (request.url === '/fonts/InterVariable.woff2') { response.setHeader('Content-Type', 'font/woff2'); response.end(await fs.readFile('public/fonts/InterVariable.woff2')); }
  else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><link rel="stylesheet" href="/timeline-review.css"><style>.timeline-tracks-shell{min-width:0}</style></head><body><div id="root"></div><script type="module" src="/timeline-review.js"></script></body></html>'); }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
if (!executablePath && process.platform === 'win32') {
  const chrome = path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe');
  if (await fs.access(chrome).then(() => true).catch(() => false)) executablePath = chrome;
}
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const pageErrors: string[] = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const get = <T>(read: string): Promise<T> => page.evaluate((expression) => Function(`return (${expression})`)(), read);
const scroll = page.locator('.timeline-scroll');
async function reset() {
  await page.evaluate(() => (window as any).timelineReview.reset());
  await expect.poll(() => get<number>('window.timelineReview.zoom')).toBe(26);
  await page.locator('.timeline-ruler').focus(); await page.keyboard.press('Home');
  await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBe(0);
}
async function snapFixture() {
  await page.evaluate(() => (window as any).timelineReview.snapFixture());
  await expect.poll(() => get('({start:window.timelineReview.project.clips[0].start,track:window.timelineReview.project.clips[0].trackId,time:window.timelineReview.time,commits:window.timelineReview.commits,snapping:window.timelineReview.snapping})')).toEqual({ start: 2, track: 'video-main', time: 12, commits: 0, snapping: true });
  await scroll.evaluate(node => { node.scrollLeft = 0; node.scrollTop = 0; });
}
async function moveNative(id: string, trackId: string, start: number, snapped?: number, alt = false, expectedPlacement?: number) {
  const source = page.locator(`[data-item-id="${id}"]`), lane = page.locator(`[data-track-id="${trackId}"]`);
  const box = await source.boundingBox(), target = await lane.boundingBox(), bounds = await scroll.boundingBox(); assert.ok(box && target && bounds);
  const x = bounds.x + 186 + (start + box.width / 2 / 26) * 26;
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(x, target.y + 35, { steps: 5 });
  if (snapped !== undefined) await expect(page.locator('.timeline-snap-guide')).toHaveAttribute('data-snap-time', String(snapped));
  else await expect(page.locator('.timeline-snap-guide')).toHaveCount(0);
  if (expectedPlacement !== undefined) await expect(page.locator('.timeline-placement-indicator')).toHaveAttribute('data-drop-time', String(expectedPlacement));
  await page.mouse.up(); if (alt) await page.keyboard.up('Alt');
  await expect.poll(() => get<number>('window.timelineReview.commits')).toBe(1);
  await expect(page.locator('.timeline-snap-guide')).toHaveCount(0);
}
async function pointerGesture(selector: string, delta: number, snapped: number) {
  const box = await page.locator(selector).boundingBox(); assert.ok(box);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + delta * 26, y, { steps: 5 });
  await expect(page.locator('.timeline-snap-guide')).toHaveAttribute('data-snap-time', String(snapped));
  assert.equal(await get<number>('window.timelineReview.commits'), 0, 'Pointer drafts never commit while moving');
  await page.mouse.up(); await expect.poll(() => get<number>('window.timelineReview.commits')).toBe(1);
  await expect(page.locator('.timeline-snap-guide')).toHaveCount(0);
}
try {
  const address = server.address(); assert.ok(address && typeof address === 'object');
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => !!(window as any).timelineReview);
  await page.evaluate(() => { (window as any).dragLog=[]; for(const name of ['dragstart','dragleave','drop','dragend','blur','pointerup','pointercancel'])document.addEventListener(name,event=>(window as any).dragLog.push([name,(event.target as HTMLElement).getAttribute?.('data-item-id')??(event.target as HTMLElement).className,(event as DragEvent).clientX,(event as DragEvent).clientY]),true); });
  await page.evaluate(() => (window as any).timelineReview.setTime(100));
  await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBeGreaterThan(1500);
  await page.evaluate(() => (window as any).timelineReview.setTime(10));
  await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBeLessThan(300);
  await scroll.evaluate((node) => { node.scrollLeft = 35 * 26; });
  await expect(page.locator('.timeline-playhead')).toHaveCSS('visibility', 'hidden');
  await expect(page.locator('.timeline-ruler-playhead')).toHaveCSS('visibility', 'hidden');
  await page.locator('.timeline-ruler').focus(); await page.keyboard.press('Home');
  await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBe(0);
  await page.evaluate(() => (window as any).timelineReview.setEffect('graphic'));
  await page.waitForTimeout(50);
  const bounds = await scroll.boundingBox(); assert.ok(bounds);
  const mouseX = bounds.x + 620, mouseY = bounds.y + 50;
  const anchorBefore = await get<number>('(document.querySelector(".timeline-scroll").scrollLeft+620-186)/window.timelineReview.zoom');
  await page.mouse.move(mouseX, mouseY); await page.keyboard.down('Control'); await page.mouse.wheel(0, -200); await page.keyboard.up('Control');
  await expect.poll(() => get<number>('window.timelineReview.zoom')).toBeGreaterThan(26);
  const anchorAfter = await get<number>('(document.querySelector(".timeline-scroll").scrollLeft+620-186)/window.timelineReview.zoom');
  assert.ok(Math.abs(anchorAfter - anchorBefore) < .05, 'Ctrl+wheel preserves the time under the mouse even with an effect selected');
  assert.equal(await page.evaluate(() => visualViewport?.scale), 1, 'Ctrl+wheel must not zoom the browser');
  await page.evaluate(() => { (window as any).timelineReview.longFilm(); });
  await page.evaluate(() => (window as any).timelineReview.fit());
  await expect.poll(() => get<number>('window.timelineReview.zoom')).toBeLessThan(1);
  assert.ok(await scroll.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), 'Fit includes the real gutter for a 24-hour film');
  assert.ok(await page.locator('.timeline-tick').count() < 100, 'Long-project ruler remains bounded');
  await reset();
  const first = page.locator('[data-item-id="c0"]');
  await first.scrollIntoViewIfNeeded();
  const firstBox = await first.boundingBox(), scrollBox = await scroll.boundingBox(); assert.ok(firstBox && scrollBox);
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
  await page.mouse.down(); await page.mouse.move(firstBox.x + firstBox.width / 2 + 12, firstBox.y + firstBox.height / 2, { steps: 3 });
  await page.mouse.move(scrollBox.x + scrollBox.width - 3, firstBox.y + firstBox.height / 2, { steps: 6 });
  await page.waitForTimeout(350);
  const advanced = await scroll.evaluate((node) => node.scrollLeft);
  assert.ok(advanced > 100, 'A held native media drag scrolls continuously without additional mouse moves');
  assert.equal(await first.count(), 1, 'Virtualization retains the native drag source');
  await page.mouse.up();
  await expect.poll(() => get<number>('window.timelineReview.project.clips.find(c=>c.id==="c0").start')).toBeGreaterThan(5);
  assert.deepEqual(await get('window.timelineReview.project.clips.filter(c=>c.id.startsWith("upper-")).map(c=>[c.id,c.start])'), [['upper-late', 80], ['upper-early', 10]]);
  assert.equal(await get('window.timelineReview.project.subtitles.words.find(w=>w.id==="w-upper").start'), 10.5);
  const newStart = await get<number>('window.timelineReview.project.clips.find(c=>c.id==="c0").start');
  assert.ok(Math.abs(await get<number>('window.timelineReview.project.subtitles.words.find(w=>w.id==="w-main").start') - newStart - .5) < .001);
  // A same-lane group is inserted atomically without overlapping its neighbours.
  await reset();
  await page.locator('[data-item-id="c0"]').click();
  await page.locator('[data-item-id="c1"]').click({ modifiers: ['Control'] });
  const groupTarget = page.locator('[data-item-id="c3"]');
  await page.locator('[data-item-id="c0"]').dragTo(groupTarget, { targetPosition: { x: 100, y: 35 } });
  const order = await get<string[]>('window.timelineReview.project.clips.filter(c=>c.trackId==="video-main").map(c=>c.id)');
  assert.deepEqual(order.slice(0, 4), ['c2', 'c3', 'c0', 'c1']);
  await page.locator('.timeline-track-lane').first().evaluate((node) => node.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: window })));
  // Drop directly at a cut with a real library drag; the other video lane stays put.
  await reset();
  const trackBox = await page.locator('[data-track-id="video-main"]').boundingBox();
  const timelineBounds = await scroll.boundingBox();
  assert.ok(trackBox && timelineBounds);
  const library = await page.locator('#library-drag').boundingBox();
  assert.ok(library);
  await page.mouse.move(library.x + 10, library.y + 8); await page.mouse.down();
  await page.mouse.move(library.x + 30, library.y + 8, { steps: 3 });
  await page.mouse.move(timelineBounds.x + 186 + 5 * 26, trackBox.y + 40, { steps: 8 });
  await expect(page.locator('.timeline-placement-indicator')).toHaveAttribute('data-drop-time', '5');
  await page.mouse.up();
  await expect.poll(() => get<number>('window.timelineReview.commits')).toBe(1);
  assert.deepEqual(await get('window.timelineReview.project.clips.filter(c=>["c0","c1","c2"].includes(c.id)).map(c=>c.start)'), [0,10,15]);
  assert.equal(await get('window.timelineReview.project.clips.find(c=>c.id==="upper-early").start'), 10);
  // Release within a clip as well: respect the mouse time and keep both halves.
  await reset();
  const insideTarget = page.locator('[data-item-id="c0"]');
  await page.locator('#library-drag').dragTo(insideTarget, { targetPosition: { x: 65, y: 32 } });
  await expect.poll(() => get<number>('window.timelineReview.commits')).toBe(1);
  const afterSplit = await get<number[][]>('window.timelineReview.project.clips.filter(c=>c.trackId==="video-main").sort((a,b)=>a.start-b.start).slice(0,4).map(c=>[c.start,c.in,c.out])');
  const droppedAt = await get<number>('(window.dragLog.filter(e=>e[0]==="drop").at(-1)[2] - document.querySelector(".timeline-scroll").getBoundingClientRect().left - document.querySelector(".timeline-scroll").clientLeft - 186) / 26');
  assert.ok(Math.abs(afterSplit[1][0] - droppedAt) < .000001, `Inserted at ${afterSplit[1][0]} instead of ${droppedAt}`);
  assert.equal(afterSplit[0][2], afterSplit[1][0]);
  assert.equal(afterSplit[2][1], afterSplit[1][0]);
  assert.equal(afterSplit[2][0], afterSplit[1][0] + 5);
  assert.deepEqual(afterSplit[3], [10, 0, 5]);
  // At maximum zoom one pixel can be shorter than the shortest editable clip.
  // With the magnet off, the displayed cut and the committed cut must still agree.
  await snapFixture();
  await page.evaluate(() => {
    (window as any).timelineReview.setZoom(240);
    (window as any).timelineReview.setSnapping(false);
  });
  await expect.poll(() => get<number>('window.timelineReview.zoom')).toBe(240);
  await scroll.evaluate(node => { node.scrollLeft = 0; });
  const closeToCut = timelineBounds.x + 186 + 2 * 240 + 1;
  await page.mouse.move(library.x + 10, library.y + 8); await page.mouse.down();
  await page.mouse.move(library.x + 25, library.y + 8, { steps: 3 });
  await page.mouse.move(closeToCut, trackBox.y + 40, { steps: 12 });
  await expect(page.locator('.timeline-placement-indicator')).toHaveAttribute('data-drop-time', '2');
  await page.mouse.up();
  await expect.poll(() => get<number>('window.timelineReview.commits')).toBe(1);
  assert.equal(await get('window.timelineReview.project.clips.length'), 4);
  assert.equal(await get('window.timelineReview.project.clips.find(c=>!["c0","c1","target"].includes(c.id)).start'), 2);
  // Slight overlap beyond magnet tolerance should dock instead of returning to the old position.
  await snapFixture(); await moveNative('c1', 'video-main', 4.35, undefined, false, 5);
  assert.equal(await get('window.timelineReview.project.clips.find(c=>c.id==="c1").start'), 5);
  await snapFixture(); await moveNative('c0', 'video-main', 5.4, undefined, false, 5);
  assert.equal(await get('window.timelineReview.project.clips.find(c=>c.id==="c0").start'), 5);
  await snapFixture(); await moveNative('c0', 'video-main', 6.75, undefined, false, 10);
  assert.equal(await get('window.timelineReview.project.clips.find(c=>c.id==="c0").start'), 10);
  await snapFixture(); await moveNative('a0', 'audio-main', 19.4, undefined, false, 19);
  assert.equal(await get('window.timelineReview.project.audioTracks.find(a=>a.id==="a0").start'), 19);
  await snapFixture(); await moveNative('a0', 'audio-main', 21.61, undefined, false, 26);
  assert.equal(await get('window.timelineReview.project.audioTracks.find(a=>a.id==="a0").start'), 26);
  await reset();
  // Bulk payload takes precedence over the compatibility single-file payload.
  const lane = page.locator('[data-track-id="audio-main"]');
  await lane.evaluate((node) => { const transfer = new DataTransfer(); transfer.setData('application/x-ducky-assets', JSON.stringify(['asset-v', 'asset-a'])); transfer.setData('application/x-ducky-asset', 'asset-v'); const bounds = node.getBoundingClientRect(); node.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer, clientX: bounds.left + 220, clientY: bounds.top + 20 })); });
  assert.deepEqual(await get('window.timelineReview.bulk.ids'), ['asset-v', 'asset-a']);
  // A model callback failure is surfaced through the declared error channel.
  await reset();
  await page.evaluate(() => { (window as any).timelineReview.throwGroup.current = true; });
  await page.locator('[data-track-id="video-main"]').evaluate((node) => { const transfer = new DataTransfer(); const bounds = node.getBoundingClientRect(); transfer.setData('application/x-ducky-item', JSON.stringify({ id: 'c0', ids: ['c0', 'c1'], kind: 'clip', trackId: 'video-main', start: 0, x: bounds.left + 186, grabOffset: 0 })); node.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer, clientX: bounds.left + 186, clientY: bounds.top + 30 })); });
  assert.deepEqual(await get('window.timelineReview.errors'), ['Spostamento non disponibile']);
  // Both edges align visibly; disabled magnet and Alt preserve free movement.
  await snapFixture(); const upper = await get<string>('window.timelineReview.upper');
  await moveNative('c0', upper, 8.85, 12);
  assert.equal(await get('window.timelineReview.project.clips.find(c=>c.id==="c0").start'), 9);
  assert.equal(await get('window.timelineReview.project.subtitles.words.find(w=>w.id==="w-main").start'), 9.5);
  await snapFixture(); await moveNative('c0', upper, 11.85, 12);
  assert.equal(await get('window.timelineReview.project.clips.find(c=>c.id==="c0").start'), 12);
  await snapFixture(); await page.evaluate(() => (window as any).timelineReview.setSnapping(false));
  await moveNative('c0', upper, 8.85);
  assert.ok(Math.abs(await get<number>('window.timelineReview.project.clips.find(c=>c.id==="c0").start') - 9) > .1);
  await snapFixture(); await moveNative('c0', upper, 8.85, undefined, true);
  assert.ok(Math.abs(await get<number>('window.timelineReview.project.clips.find(c=>c.id==="c0").start') - 9) > .1);
  await snapFixture(); await page.evaluate(() => (window as any).timelineReview.setSelection(['c0', 'c1']));
  await moveNative('c0', 'video-main', 3.85, 12);
  assert.deepEqual(await get('window.timelineReview.project.clips.slice(0,2).map(c=>c.start)'), [4, 10]);
  await snapFixture(); await moveNative('a0', 'audio-main', 8.85, 12);
  assert.equal(await get('window.timelineReview.project.audioTracks[0].start'), 9);
  await snapFixture(); await pointerGesture('[data-item-id="a0"] .trim-handle.left', 1.85, 12);
  assert.deepEqual(await get('({start:window.timelineReview.project.audioTracks[0].start,in:window.timelineReview.project.audioTracks[0].in})'), { start: 12, in: 3 });
  await snapFixture(); await pointerGesture('[data-item-id="a0"] .trim-handle.right', -1.15, 12);
  assert.equal(await get('window.timelineReview.project.audioTracks[0].out'), 3);
  await snapFixture(); await pointerGesture('[data-item-id="c0"] .trim-handle.right', 6.85, 12);
  assert.equal(await get('window.timelineReview.project.clips[0].out'), 11);
  await snapFixture(); await page.evaluate(() => (window as any).timelineReview.setTime(6));
  await pointerGesture('[data-item-id="c0"] .trim-handle.left', -.85, 6);
  assert.equal(await get('window.timelineReview.project.clips[0].in'), 0);
  await snapFixture(); await pointerGesture('[data-effect-id="graphic"]', 9.85, 20);
  assert.deepEqual(await get('window.timelineReview.project.overlays.map(o=>[o.start,o.end])'), [[17, 20]]);
  await snapFixture(); await pointerGesture('[data-effect-id="graphic"] [data-effect-edge="end"]', 9.85, 20);
  assert.equal(await get('window.timelineReview.project.overlays[0].end'), 20);
  await snapFixture(); await pointerGesture('[data-effect-id="graphic"] [data-effect-edge="start"]', .85, 8);
  assert.equal(await get('window.timelineReview.project.overlays[0].start'), 8);
  await snapFixture(); await pointerGesture('[data-effect-id="subtitle:1"]', 2.85, 20);
  assert.deepEqual(await get('window.timelineReview.project.subtitles.words.filter(w=>w.id==="w-free").map(w=>[w.start,w.end])'), [[18, 20]]);
  await snapFixture(); await pointerGesture('[data-effect-id="subtitle:1"] [data-effect-edge="start"]', -5.15, 10);
  assert.equal(await get('window.timelineReview.project.subtitles.words.find(w=>w.id==="w-free").start'), 10);
  await snapFixture(); await pointerGesture('[data-effect-id="subtitle:1"] [data-effect-edge="end"]', 2.85, 20);
  assert.equal(await get('window.timelineReview.project.subtitles.words.find(w=>w.id==="w-free").end'), 20);
  // Alt and the toolbar toggle also update a stationary in-progress pointer draft.
  await snapFixture();
  const graphic = page.locator('[data-effect-id="graphic"]'), graphicBox = await graphic.boundingBox(); assert.ok(graphicBox);
  await page.mouse.move(graphicBox.x + graphicBox.width / 2, graphicBox.y + graphicBox.height / 2); await page.mouse.down();
  await page.mouse.move(graphicBox.x + graphicBox.width / 2 + 9.85 * 26, graphicBox.y + graphicBox.height / 2, { steps: 5 });
  await expect(page.locator('.timeline-snap-guide')).toHaveAttribute('data-snap-time', '20');
  await page.keyboard.down('Alt'); await expect(page.locator('.timeline-snap-guide')).toHaveCount(0);
  await expect(graphic.locator('.effect-gesture-readout')).toContainText('19.85');
  await page.keyboard.up('Alt'); await expect(page.locator('.timeline-snap-guide')).toHaveAttribute('data-snap-time', '20');
  await page.evaluate(() => (window as any).timelineReview.setSnapping(false));
  await expect(page.locator('.timeline-snap-guide')).toHaveCount(0);
  await expect(graphic.locator('.effect-gesture-readout')).toContainText('19.85');
  await page.mouse.up(); await expect.poll(() => get<number>('window.timelineReview.commits')).toBe(1);
  assert.ok(Math.abs(await get<number>('window.timelineReview.project.overlays[0].end') - 19.85) < .02);
  assert.deepEqual(pageErrors, []);
  console.log('Timeline UI passed: exact library drop at cut and inside clip, ripple, shallow/deep video and audio overlap, 32-clip drag/autoscroll and caption sync; anchored zoom, fit and follow; visible start/end/group magnet, disabled/Alt free movement, audio/video/effect/subtitle trims and one commit per gesture.');
} catch (error) {
  console.log('Timeline failure diagnostics', await get('({drag:window.dragLog,errors:window.timelineReview.errors,time:window.timelineReview.time,scroll:document.querySelector(".timeline-scroll").scrollLeft,order:window.timelineReview.project.clips.filter(c=>c.trackId==="video-main").map(c=>c.id)})'));
  await fs.mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/timeline-ui-failure.png' }).catch(() => {});
  throw error;
} finally { await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
