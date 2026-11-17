import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EngineTask, configureEngine } from '../electron/engine';
import { runProcess } from '../electron/process';
import { ffmpegPath } from '../electron/binaries';

const directory = path.resolve('test-results/ai-live');
process.env.DUCKY_MODELS_DIR = path.resolve('.cache/models');
process.env.HF_HUB_OFFLINE = '1';
configureEngine(directory);
const narration = path.join(directory, 'narration.wav');
await fs.access(narration);
const result = await new EngineTask('transcribe', { paths: [narration], language: 'it' }, (p,m) => console.log(Math.round(p*100),m)).run() as { words_by_path: Record<string,{text:string;start:number;end:number}[]> };
const words = Object.values(result.words_by_path).flat();
assert.ok(words.length >= 10, 'Trascrizione vocale reale con parole e tempi');
assert.ok(words.every(word => word.end >= word.start && word.start >= 0));
await fs.writeFile(path.join(directory,'transcript.json'),JSON.stringify(result,null,2));
const photos = [path.join(directory,'sea.png'),path.join(directory,'sun.png')];
for (let i=0;i<photos.length;i++) await runProcess(ffmpegPath,['-v','error','-y','-f','lavfi','-i',`color=c=${i?'orange':'skyblue'}:s=640x360`,'-vf',i?'drawbox=x=0:y=240:w=640:h=120:color=yellow:t=fill':'drawbox=x=0:y=180:w=640:h=180:color=blue:t=fill','-frames:v','1',photos[i]]);
const duration = words[words.length-1].end;
const semanticVideo=path.join(directory,'sun-video.mp4');
await runProcess(ffmpegPath,['-v','error','-y','-loop','1','-i',photos[1],'-t','6','-r','12','-c:v','libx264','-pix_fmt','yuv420p',semanticVideo]);
const media=[photos[0],semanticVideo];
const match = await new EngineTask('match',{images:media,words,audio_duration:duration,dedup:false,offtopic:-1,img_min:2,img_max:4},(p,m)=>console.log(Math.round(p*100),m)).run() as { segments: {source:string;start:number;end:number;sourceIn?:number;sourceDuration?:number}[];media:{path:string;type:string;status:string}[] };
assert.ok(match.segments.length > 0,'Abbinamento semantico locale reale');
assert.ok(match.segments.every(segment => media.includes(segment.source) && segment.end > segment.start),'Riferimenti rimappati alle sorgenti native, nessun frame temporaneo');
assert.ok(match.media.some(item=>item.path===semanticVideo&&item.type==='video'),'Analisi include video sorgente originale');
for(const segment of match.segments.filter(segment=>segment.source===semanticVideo)){
  assert.ok(Number.isFinite(segment.sourceIn)&&segment.sourceIn!>=0&&segment.sourceIn!<6,'Trim sorgente video finito');
  assert.equal(segment.sourceDuration,6);
}
// Guarantee the video-source branch is exercised even if CLIP prefers the photo
// for this particular narration. This reuses the already cached offline model.
const videoOnly=await new EngineTask('match',{images:[semanticVideo],words,audio_duration:duration,dedup:true,offtopic:-1,img_min:2,img_max:4},()=>{}).run() as typeof match;
assert.ok(videoOnly.segments.length>0&&videoOnly.segments.every(segment=>segment.source===semanticVideo&&Number.isFinite(segment.sourceIn)),'Abbinamento reale solo-video con sourceIn');
await fs.writeFile(path.join(directory,'match.json'),JSON.stringify(match,null,2));
await fs.writeFile(path.join(directory,'video-match.json'),JSON.stringify(videoOnly,null,2));
console.log(JSON.stringify({ok:true,words:words.length,scenes:match.segments.length,videoScenes:videoOnly.segments.length,offline:true}));
