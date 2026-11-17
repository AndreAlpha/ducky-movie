import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaAsset, Project, SubtitleWord } from '../shared/types';
import { createSmartMontage } from '../src/montage';
import { createProject, projectDuration, timelinePositions, updateClip, syncLinkedSubtitles, validateProject } from '../src/model';

function media(name: string, kind: MediaAsset['kind'], duration = 10): MediaAsset {
  return { id: crypto.randomUUID(), name, kind, duration, path: `C:\\Media\\${name}`, url: '', width: kind === 'audio' ? 0 : 1920,
    height: kind === 'audio' ? 0 : 1080, hasAudio: kind !== 'image' };
}
function library(...assets: MediaAsset[]): Project { return { ...createProject('Viaggio'), assets }; }
function close(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < .00001, `${actual} ≈ ${expected}`); }
function safeVideoSources(project: Project) {
  const used = new Map<string, { in: number; out: number }[]>();
  for (const clip of project.clips) {
    const asset = project.assets.find(item => item.id === clip.assetId)!;
    if (asset.kind !== 'video') continue;
    assert.ok(clip.in >= 0 && clip.out <= asset.duration + .00001 && clip.out > clip.in);
    const previous = used.get(asset.id) ?? [];
    assert.ok(previous.every(range => clip.out <= range.in + .00001 || clip.in >= range.out - .00001), 'Footage is consumed once');
    used.set(asset.id, [...previous, clip]);
  }
}

test('mixed montage respects selected order, exact narration and complete intro/outro', () => {
  const video = media('Zvideo.mp4', 'video', 9), photo = media('Afoto.png', 'image');
  const voice = media('Voce.wav', 'audio', 15), intro = media('Apertura.mp4', 'video', 2), outro = media('Chiusura.mp4', 'video', 7);
  const result = createSmartMontage(library(photo, voice, outro, video, intro), {
    assetIds: [video.id, photo.id], narrationIds: [voice.id], introId: intro.id, outroId: outro.id,
  });
  assert.equal(result.project.clips[0].role, 'intro');
  assert.equal(result.project.clips[1].assetId, video.id);
  assert.equal(result.project.clips.at(-1)?.role, 'outro');
  close(result.project.clips.at(-1)!.out, 7);
  close(result.project.clips.at(-1)!.start!, 17);
  close(result.project.audioTracks[0].start, 2);
  close(projectDuration(result.project), 24);
  close(result.bodyDuration, 15);
  assert.equal(result.repeated, false);
  safeVideoSources(result.project);
  assert.doesNotThrow(() => validateProject(JSON.parse(JSON.stringify(result.project))));
});

test('video-only montage works without narration or AI and retains original audio', () => {
  const first = media('Uno.mp4', 'video', 14), second = media('Due.mp4', 'video', 3);
  const result = createSmartMontage(library(first, second), { assetIds: [first.id, second.id] });
  assert.ok(result.project.clips.length >= 2);
  assert.equal(result.project.audioTracks.length, 0);
  assert.ok(result.project.clips.every(clip => !clip.muted));
  assert.ok(projectDuration(result.project) <= 17);
  safeVideoSources(result.project);
});

test('whole videos remain one contiguous complete shot each, also under a short narration', () => {
  const a = media('A.mp4', 'video', 13), b = media('B.mp4', 'video', 9), voice = media('Voce.wav', 'audio', 4);
  const result = createSmartMontage(library(a, b, voice), { assetIds: [b.id, a.id], narrationIds: [voice.id], wholeVideos: true, maxSeconds: 3, minSeconds: 1 });
  assert.deepEqual(result.project.clips.map(clip => [clip.assetId, clip.in, clip.out, clip.start]), [[b.id, 0, 9, 0], [a.id, 0, 13, 9]]);
  close(projectDuration(result.project), 22);
});

test('whole videos are never partially allocated to favor images', () => {
  const video = media('Film.mp4', 'video', 12), photo = media('Foto.png', 'image'), voice = media('Voce.wav', 'audio', 30);
  const result = createSmartMontage(library(video, photo, voice), { assetIds: [video.id, photo.id], narrationIds: [voice.id], wholeVideos: true, priority: 'image' });
  const clips = result.project.clips.filter(clip => clip.assetId === video.id);
  assert.equal(clips.length, 1); close(clips[0].out, 12);
  close(projectDuration(result.project), 30);
});

test('limited photos hold once through narration and report the longer scene', () => {
  const photo = media('Foto.png', 'image'), voice = media('Voce.wav', 'audio', 30);
  const result = createSmartMontage(library(photo, voice), { assetIds: [photo.id], narrationIds: [voice.id] });
  assert.equal(result.project.clips.length, 1); close(result.project.clips[0].out, 30);
  assert.ok(result.warnings.some(warning => warning.includes('più a lungo')));
  assert.equal(result.repeated, false);
});

test('insufficient video content requires another source or explicit reuse and never freezes', () => {
  const video = media('Breve.mp4', 'video', 2), voice = media('Voce.wav', 'audio', 12);
  assert.throws(() => createSmartMontage(library(video, voice), { assetIds: [video.id], narrationIds: [voice.id] }), /Aggiungi foto/);
  const result = createSmartMontage(library(video, voice), { assetIds: [video.id], narrationIds: [voice.id], reuse: true });
  close(projectDuration(result.project), 12);
  assert.equal(result.repeated, true);
  assert.ok(result.project.clips.every(clip => clip.in >= 0 && clip.out <= 2));
});

test('shuffle is explicit, reproducible and selection order remains the default', () => {
  const photos = [media('Z.png', 'image'), media('A.png', 'image'), media('Q.png', 'image'), media('B.png', 'image')];
  const project = library(...photos);
  const ids = photos.map(photo => photo.id);
  assert.deepEqual(createSmartMontage(project, { assetIds: ids }).usedAssetIds, ids);
  const shuffled = createSmartMontage(project, { assetIds: ids, order: 'shuffle', seed: 41 }).usedAssetIds;
  assert.notDeepEqual(shuffled, ids);
  assert.deepEqual(shuffled, createSmartMontage(project, { assetIds: ids, order: 'shuffle', seed: 41 }).usedAssetIds);
  assert.deepEqual([...shuffled].sort(), [...ids].sort());
});

test('sentence ends guide natural scene boundaries without mandatory transcription', () => {
  const a = media('Uno.png', 'image'), b = media('Due.png', 'image'), voice = media('Voce.wav', 'audio', 10);
  const words: SubtitleWord[] = [{ start: 0, end: 4.7, text: 'Prima frase.' }, { start: 4.8, end: 10, text: 'Seconda frase.' }];
  const result = createSmartMontage(library(a,b,voice), { assetIds: [a.id,b.id], narrationIds: [voice.id], wordsByAsset: { [voice.id]: words } });
  const boundary = timelinePositions(result.project)[0].end;
  close(boundary, 4.75); close(projectDuration(result.project), 10);
});

test('semantic windows retain assigned sources, exact narration times and sampled video trims', () => {
  const a = media('A.mp4', 'video', 20), b = media('B.png', 'image'), voice = media('Voce.wav', 'audio', 10);
  const result = createSmartMontage(library(a,b,voice), { assetIds: [a.id,b.id], narrationIds: [voice.id], semanticSegments: [
    { source: a.path, start: 0, end: 3, sourceIn: 1 },
    { source: b.path, start: 3, end: 6, zoom_in: false },
    { source: a.path, start: 6, end: 10, sourceIn: 11 },
  ] });
  assert.deepEqual(result.project.clips.map(clip => [clip.assetId,clip.start,clip.in,clip.out]), [[a.id,0,1,4],[b.id,3,0,3],[a.id,6,11,15]]);
  assert.equal(result.project.clips[1].zoom,'out'); close(projectDuration(result.project),10);
  safeVideoSources(result.project);
});

test('short semantic video hands remainder to a photo without extending footage', () => {
  const a = media('A.mp4','video',2), b = media('B.png','image'), voice = media('Voce.wav','audio',8);
  const result = createSmartMontage(library(a,b,voice), {assetIds:[a.id,b.id],narrationIds:[voice.id],semanticSegments:[{source:a.path,start:0,end:8,sourceIn:0}]});
  assert.deepEqual(result.project.clips.map(clip=>[clip.assetId,clip.in,clip.out]),[[a.id,0,2],[b.id,0,6]]);
  safeVideoSources(result.project); close(projectDuration(result.project),8);
});

test('adjacent semantic holds merge and excluded media cannot enter fallback', () => {
  const discarded=media('Scartata.png','image'), a=media('A.mp4','video',1), b=media('B.png','image'), voice=media('Voce.wav','audio',6);
  const result=createSmartMontage(library(a,b,voice,discarded),{assetIds:[a.id,b.id],narrationIds:[voice.id],semanticSegments:[
    {source:discarded.path,start:0,end:2},{source:b.path,start:2,end:4},{source:b.path,start:4,end:6},
  ]});
  assert.ok(result.project.clips.every(clip=>clip.assetId!==discarded.id));
  assert.equal(result.project.clips.filter(clip=>clip.assetId===b.id).length,1);
  close(projectDuration(result.project),6);
});

test('narration and trimmed source captions remain linked through later clip edits', () => {
  const video=media('Film.mp4','video',4), photo=media('Foto.png','image'), voice=media('Voce.wav','audio',6);
  const wordsByAsset:Record<string,SubtitleWord[]>={
    [voice.id]:[{text:'Voce',start:1,end:2}], [video.id]:[{text:'Video',start:1,end:2}],
  };
  const result=createSmartMontage(library(video,photo,voice),{assetIds:[video.id,photo.id],narrationIds:[voice.id],videoAudio:true,subtitles:true,wordsByAsset});
  const subtitles=result.project.subtitles!;
  assert.ok(subtitles.words.some(word=>word.text==='Voce'&&word.source?.kind==='audio'));
  const videoWord=subtitles.words.find(word=>word.text==='Video')!;
  assert.equal(videoWord.source?.kind,'clip');
  const clip=result.project.clips.find(clip=>clip.id===videoWord.source?.id)!;
  const next=syncLinkedSubtitles(result.project,updateClip(result.project,clip.id,{speed:2}));
  const changed=next.subtitles!.words.find(word=>word.id===videoWord.id)!;
  close(changed.start,(clip.start??0)+.5);close(changed.end,(clip.start??0)+1);
});

test('canonical duplicate library paths are consumed once',()=>{
  const a=media('A.png','image'),duplicate={...a,id:crypto.randomUUID(),path:'c:/media/a.PNG'};
  const result=createSmartMontage(library(a,duplicate),{assetIds:[a.id,duplicate.id]});
  assert.equal(result.usedAssetIds.length,1);assert.equal(result.project.clips.length,1);
});

test('semantic assignment respects no reuse and holds the final photo when sources run out',()=>{
  const a=media('A.png','image'),b=media('B.png','image'),voice=media('Voce.wav','audio',12);
  const result=createSmartMontage(library(a,b,voice),{assetIds:[a.id,b.id],narrationIds:[voice.id],reuse:false,semanticSegments:[
    {source:a.path,start:0,end:4},{source:b.path,start:4,end:8},{source:a.path,start:8,end:12},
  ]});
  assert.deepEqual(result.project.clips.map(clip=>[clip.assetId,clip.start,clip.out]),[[a.id,0,4],[b.id,4,8]]);
  assert.equal(result.repeated,false);assert.ok(result.warnings.some(warning=>warning.includes('evitare ripetizioni')));
});

test('whole-video reuse rounds upward to complete footage and aligns logo/outro to the actual end',()=>{
  const a=media('V.mp4','video',10),b=media('W.mp4','video',10),voice=media('Voce.wav','audio',25),logo=media('Logo.png','image'),outro=media('Outro.mp4','video',2);
  const result=createSmartMontage(library(a,b,voice,logo,outro),{assetIds:[a.id,b.id],narrationIds:[voice.id],wholeVideos:true,reuse:true,logoId:logo.id,outroId:outro.id});
  assert.deepEqual(result.project.clips.slice(0,-1).map(clip=>[clip.assetId,clip.in,clip.out]),[[a.id,0,10],[b.id,0,10],[a.id,0,10]]);
  close(result.bodyDuration,30);close(result.project.overlays![0].end,30);close(result.project.clips.at(-1)!.start!,30);close(projectDuration(result.project),32);
  assert.equal(result.repeated,true);
});

test('semantic repeated video trim is reported even before its entire source was consumed',()=>{
  const video=media('Film.mp4','video',10),voice=media('Voce.wav','audio',4);
  const result=createSmartMontage(library(video,voice),{assetIds:[video.id],narrationIds:[voice.id],reuse:true,semanticSegments:[
    {source:video.path,start:0,end:2,sourceIn:3},{source:video.path,start:2,end:4,sourceIn:3},
  ]});
  assert.deepEqual(result.project.clips.map(clip=>[clip.in,clip.out]),[[3,5],[3,5]]);
  assert.equal(result.repeated,true);
});

test('minimum photo duration leaves excess selections in the library',()=>{
  const photos=['A','B','C','D'].map(name=>media(`${name}.png`,'image')),voice=media('Voce.wav','audio',8);
  const project=library(...photos,voice);
  const result=createSmartMontage(project,{assetIds:photos.map(asset=>asset.id),narrationIds:[voice.id],minSeconds:3,maxSeconds:6,reuse:false});
  assert.deepEqual(result.project.clips.map(clip=>[clip.assetId,clip.out]),[[photos[0].id,4],[photos[1].id,4]]);
  assert.deepEqual(result.unusedAssetIds,photos.slice(2).map(asset=>asset.id));
  assert.equal(result.project.assets.length,project.assets.length);
  assert.ok(result.warnings.some(warning=>warning.includes('libreria')));close(projectDuration(result.project),8);
});

test('sentence alignment never shortens a photo below the requested minimum',()=>{
  const a=media('A.png','image'),b=media('B.png','image'),voice=media('Voce.wav','audio',6);
  const result=createSmartMontage(library(a,b,voice),{assetIds:[a.id,b.id],narrationIds:[voice.id],minSeconds:3,maxSeconds:6,
    wordsByAsset:{[voice.id]:[{start:0,end:2.2,text:'Frase.'},{start:2.3,end:6,text:'Seconda.'}]}});
  assert.deepEqual(result.project.clips.map(clip=>clip.out-clip.in),[3,3]);close(projectDuration(result.project),6);
});

test('finite video partitions honor scene minimum when the exact duration conflicts with the maximum',()=>{
  const video=media('Film.mp4','video',19),voice=media('Voce.wav','audio',19);
  const result=createSmartMontage(library(video,voice),{assetIds:[video.id],narrationIds:[voice.id],minSeconds:5,maxSeconds:6});
  assert.ok(result.project.clips.every(clip=>clip.out-clip.in>=5-.00001));
  assert.ok(result.warnings.some(warning=>warning.includes('più lunghi del massimo')));
  safeVideoSources(result.project);close(projectDuration(result.project),19);
});

test('source videos shorter than the minimum keep finite content and provide a clear exception',()=>{
  const video=media('Breve.mp4','video',1),photo=media('Foto.png','image'),voice=media('Voce.wav','audio',8);
  const result=createSmartMontage(library(video,photo,voice),{assetIds:[video.id,photo.id],narrationIds:[voice.id],minSeconds:3,maxSeconds:6});
  assert.equal(result.project.clips[0].out,1);
  assert.ok(result.project.clips.filter(clip=>clip.assetId===photo.id).every(clip=>clip.out>=3));
  assert.ok(result.warnings.some(warning=>warning.includes('più brevi del minimo')));
  safeVideoSources(result.project);close(projectDuration(result.project),8);
});

test('a narration shorter than the minimum stays exact and reports the unavoidable exception',()=>{
  const photo=media('Foto.png','image'),voice=media('Voce.wav','audio',1.5);
  const result=createSmartMontage(library(photo,voice),{assetIds:[photo.id],narrationIds:[voice.id],minSeconds:3,maxSeconds:6});
  close(projectDuration(result.project),1.5);assert.equal(result.project.clips.length,1);
  assert.ok(result.warnings.some(warning=>warning.includes('più brevi del minimo')));
});

test('short semantic photo windows receive the requested screen time without extending source video',()=>{
  const a=media('A.mp4','video',4),photo=media('Foto.png','image'),b=media('B.mp4','video',5),voice=media('Voce.wav','audio',10);
  const result=createSmartMontage(library(a,photo,b,voice),{assetIds:[a.id,photo.id,b.id],narrationIds:[voice.id],minSeconds:3,maxSeconds:6,semanticSegments:[
    {source:a.path,start:0,end:4,sourceIn:0},{source:photo.path,start:4,end:5},{source:b.path,start:5,end:10,sourceIn:0},
  ]});
  assert.ok(result.project.clips.filter(clip=>clip.assetId===photo.id).every(clip=>clip.out>=3));
  assert.ok(result.warnings.some(warning=>warning.includes('minima delle foto')));
  safeVideoSources(result.project);close(projectDuration(result.project),10);
});

test('selection keeps an available photo when a short video alone cannot cover narration',()=>{
  const video=media('Breve.mp4','video',2),photo=media('Foto.png','image'),voice=media('Voce.wav','audio',4);
  const result=createSmartMontage(library(video,photo,voice),{assetIds:[video.id,photo.id],narrationIds:[voice.id],minSeconds:3,maxSeconds:6});
  assert.deepEqual(result.project.clips.map(clip=>[clip.assetId,clip.out]),[[photo.id,4]]);
  assert.ok(result.unusedAssetIds.includes(video.id));close(projectDuration(result.project),4);
});
