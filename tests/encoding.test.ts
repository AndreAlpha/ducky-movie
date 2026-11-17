import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { accelerationInfo, getExportCapabilities, isHardwareEncoderFailure, preferredEncoder, probeVideoEncoder, videoEncoderArgs, withEncodingFallback } from '../electron/encoding';
import { ExportJob } from '../electron/export';
import { ffmpegPath, ffprobePath } from '../electron/binaries';
import { runProcess } from '../electron/process';
import { createClip, createProject } from '../src/model';
import type { ExportCapabilities, ExportProgress, MediaAsset, VideoEncoder } from '../shared/types';

const empty:ExportCapabilities={preferred:'libx264',checkedAt:new Date().toISOString(),encoders:[
  {encoder:'h264_amf',label:'AMD',hardware:true,available:false},
  {encoder:'libx264',label:'CPU',hardware:false,available:true},
  {encoder:'h264_qsv',label:'Intel',hardware:true,available:false},
  {encoder:'h264_nvenc',label:'NVIDIA',hardware:true,available:false},
]};

test('encoder selection follows usable NVIDIA/Intel/AMD devices, with an explicit CPU override',()=>{
  assert.equal(preferredEncoder(empty),'libx264');
  const capabilities=structuredClone(empty);
  for(const encoder of ['h264_amf','h264_qsv','h264_nvenc'] as VideoEncoder[]){
    capabilities.encoders.find(item=>item.encoder===encoder)!.available=true;
    assert.equal(preferredEncoder(capabilities),encoder);
    assert.equal(preferredEncoder(capabilities,'cpu'),'libx264');
  }
  assert.ok(isHardwareEncoderFailure(new Error('[h264_nvenc] OpenEncodeSessionEx failed')));
  assert.equal(isHardwareEncoderFailure(new Error('Invalid data found when processing input')),false);
  assert.equal(isHardwareEncoderFailure(new Error('Error opening input file C:\\media\\cuda.mp4.\nError opening input files: Invalid data found when processing input')),false);
  assert.equal(isHardwareEncoderFailure(new Error('Error opening output file C:\\exports\\cuda.mp4.\nError opening output files: Permission denied')),false);
  assert.equal(isHardwareEncoderFailure(new Error('Error opening output file C:\\exports\\device.mp4.\nError opening output files: Invalid argument')),false);
  assert.equal(isHardwareEncoderFailure(new Error('Error writing trailer: No space left on device')),false);
  assert.equal(isHardwareEncoderFailure(new Error('Error opening output: Access is denied')),false);
  assert.ok(isHardwareEncoderFailure(new Error('Error while opening encoder')));
  assert.ok(isHardwareEncoderFailure(new Error('[h264_nvenc] OpenEncodeSessionEx failed\nError opening output file C:\\exports\\cuda.mp4.\nError opening output files: Invalid argument')));
});

test('cancellation and media errors never trigger an unintended CPU retry',async()=>{
  const abort=new AbortController();let count=0;
  await assert.rejects(withEncodingFallback(accelerationInfo('h264_nvenc'),async()=>{
    count++;abort.abort();throw new Error('Error while opening encoder');
  },{signal:abort.signal}),/cancelled/);
  assert.equal(count,1);
  count=0;
  await assert.rejects(withEncodingFallback(accelerationInfo('h264_nvenc'),async()=>{
    count++;throw new Error('Invalid data found when processing input');
  }),/Invalid data/);
  assert.equal(count,1);
});

test('real encode, packet probe and decode discover devices instead of trusting the encoder list',{timeout:60000},async()=>{
  const capabilities=await getExportCapabilities({refresh:true});
  assert.ok(capabilities.encoders.find(item=>item.encoder==='libx264')?.available);
  assert.ok(capabilities.encoders.filter(item=>!item.available).every(item=>!!item.reason));
  assert.equal(capabilities.preferred,preferredEncoder(capabilities));
  assert.ok(capabilities.encoders.some(item=>item.available));
  console.log('Encoder reali:',capabilities.encoders.map(item=>`${item.encoder}=${item.available}`).join(', '));
});

test('encoder probe can be cancelled during device initialization without advertising a failed device',{timeout:15000},async()=>{
  const abort=new AbortController();
  const work=probeVideoEncoder('h264_nvenc',{signal:abort.signal});
  setTimeout(()=>abort.abort(),15);
  await assert.rejects(work,/cancelled/);
});

test('basic auto and CPU exports retain H.264/AAC, dimensions, timing and honest encoder diagnostics',{timeout:120000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ducky-gpu-export-'));
  try{
    const source=path.join(directory,'source.mp4');
    await runProcess(ffmpegPath,['-v','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=1.2','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1.2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',source]);
    const asset:MediaAsset={id:crypto.randomUUID(),name:'source.mp4',path:source,url:'',kind:'video',duration:1.2,width:640,height:360,hasAudio:true};
    const project={...createProject('GPU'),assets:[asset],clips:[{...createClip(asset),in:.1,out:1.1,brightness:.05}]};
    for(const acceleration of ['auto','cpu'] as const){
      const output=path.join(directory,`${acceleration}.mp4`),events:ExportProgress[]=[];
      await new ExportJob(project,{resolution:'720p',fps:24,quality:'standard',acceleration},output,event=>events.push(event)).start();
      const final=events.at(-1)!;
      assert.equal(final.state,'complete',final.error);
      assert.equal(final.acceleration?.requested,acceleration);
      assert.ok(final.acceleration?.label);
      if(acceleration==='cpu')assert.equal(final.acceleration?.encoder,'libx264');
      else{
        const capabilities=await getExportCapabilities();
        if(capabilities.preferred!=='libx264'&&!final.acceleration?.fallback)assert.equal(final.acceleration?.mode,'gpu');
      }
      const metadata=JSON.parse((await runProcess(ffprobePath,['-v','error','-show_streams','-show_format','-of','json',output])).toString());
      const video=metadata.streams.find((item:any)=>item.codec_type==='video'),audio=metadata.streams.find((item:any)=>item.codec_type==='audio');
      assert.equal(video.codec_name,'h264');assert.equal(video.pix_fmt,'yuv420p');assert.equal(video.width,1280);assert.equal(video.height,720);
      assert.equal(audio.codec_name,'aac');assert.equal(Number(audio.sample_rate),48000);
      assert.ok(Math.abs(Number(metadata.format.duration)-1)<.08);
      assert.ok(events.some(event=>event.message?.includes('CPU')),'CPU compositing is disclosed');
      console.log(`${acceleration}: ${final.acceleration?.label}, ${metadata.format.size} byte, ${metadata.format.duration}s`);
    }
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('cancelling an active GPU/CPU export stops FFmpeg, preserves the destination and cleans its work directory',{timeout:60000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ducky-gpu-cancel-'));
  try{
    const source=path.join(directory,'photo.png');
    await runProcess(ffmpegPath,['-v','error','-y','-f','lavfi','-i','color=c=red:size=320x180','-frames:v','1',source]);
    const asset:MediaAsset={id:crypto.randomUUID(),name:'photo.png',path:source,url:'',kind:'image',duration:0,width:320,height:180,hasAudio:false};
    const project={...createProject('Cancel'),assets:[asset],clips:[{...createClip(asset),out:120}]};
    const output=path.join(directory,'movie.mp4');
    await fs.writeFile(output,'existing destination');
    const events:ExportProgress[]=[];let cancelled=false;
    const job=new ExportJob(project,{resolution:'720p',fps:30,quality:'standard'},output,event=>{
      events.push(event);
      if(event.state==='running'&&event.progress>.005&&!cancelled){cancelled=true;job.cancel();}
    });
    await job.start();
    assert.equal(cancelled,true);assert.equal(events.at(-1)?.state,'cancelled');
    assert.equal(await fs.readFile(output,'utf8'),'existing destination');
    assert.equal((await fs.readdir(directory)).some(item=>item.startsWith('.duckymovie-render-')),false);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('an actual unavailable NVIDIA device falls back once to a compatible CPU encode',{timeout:60000},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ducky-gpu-fallback-'));
  try{
    const output=path.join(directory,'fallback.mp4'),attempts:VideoEncoder[]=[];
    let reported='';
    await withEncodingFallback(accelerationInfo('h264_nvenc'),async info=>{
      attempts.push(info.encoder);
      await runProcess(ffmpegPath,['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=0.5','-f','lavfi','-i','sine=frequency=330:duration=0.5',
        ...videoEncoderArgs(info.encoder,'high'),...(info.mode==='gpu'?['-gpu','9999']:[]),'-c:a','aac','-shortest',output]);
    },{onFallback:info=>{reported=info.fallback??'';}});
    assert.deepEqual(attempts,['h264_nvenc','libx264']);assert.ok(reported.includes('CPU'));
    const metadata=JSON.parse((await runProcess(ffprobePath,['-v','error','-show_streams','-of','json',output])).toString());
    assert.ok(metadata.streams.some((item:any)=>item.codec_name==='h264'&&item.pix_fmt==='yuv420p'));
    assert.ok(metadata.streams.some((item:any)=>item.codec_name==='aac'));
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
