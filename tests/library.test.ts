import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { insertLibraryAssets } from '../src/library';
import { addAssets, createProject, timelinePositions, validateProject } from '../src/model';
import type { MediaAsset } from '../shared/types';
import { mediaImportDirectory, rememberMediaImportDirectory, setDataDirectory } from '../electron/store';

function asset(id:string,kind:MediaAsset['kind'],duration=4):MediaAsset {
  return {id,name:id,path:`C:\\media\\${id}`,url:'',kind,duration:kind==='image'?0:duration,width:640,height:360,hasAudio:kind!=='image'};
}

test('bulk insertion keeps selection order, places visuals and audio on parallel lanes, and is atomic',()=>{
  const assets=[asset('one.png','image'),asset('two.png','image'),asset('video.mp4','video'),asset('voice.wav','audio'),asset('music.wav','audio',3)];
  const original=addAssets(createProject(),assets);
  const before=JSON.stringify(original);
  const result=insertLibraryAssets(original,assets.map(asset=>asset.id),2);
  assert.equal(result.clipIds.length,3);assert.equal(result.audioIds.length,2);
  assert.deepEqual(timelinePositions(result.project).map(({clip,start})=>[clip.assetId,start]),[['one.png',2],['two.png',7],['video.mp4',12]]);
  assert.deepEqual(result.project.audioTracks.map(track=>[track.assetId,track.start]),[['voice.wav',2],['music.wav',6]]);
  assert.equal(JSON.stringify(original),before);
  assert.doesNotThrow(()=>validateProject(result.project));
  assert.throws(()=>insertLibraryAssets(original,['one.png','missing'],0),/non è disponibile/);
  assert.equal(JSON.stringify(original),before);
});

test('explicit audio drops extract video sound while photos keep a visual lane and duplicate ids insert once',()=>{
  const project=addAssets(createProject(),[asset('film.mp4','video'),asset('cover.png','image')]);
  const result=insertLibraryAssets(project,['film.mp4','cover.png','film.mp4'],1,'audio-main');
  assert.equal(result.audioIds.length,1);assert.equal(result.clipIds.length,1);
  assert.equal(result.project.audioTracks[0].assetId,'film.mp4');
  assert.equal(result.project.clips[0].assetId,'cover.png');
  assert.equal(timelinePositions(result.project)[0].start,1);
});

test('media import folder survives app restart and missing or corrupt preferences have a safe fallback',async()=>{
  await fs.mkdir('test-results',{recursive:true});
  const root=await fs.mkdtemp(path.resolve('test-results/import-folder-'));
  const folder=path.join(root,'Foto delle vacanze');await fs.mkdir(folder);
  const settings=path.join(root,'settings');setDataDirectory(settings);
  assert.equal(await mediaImportDirectory(),undefined);
  await rememberMediaImportDirectory(folder);
  setDataDirectory(settings);assert.equal(await mediaImportDirectory(),folder);
  await fs.rmdir(folder);assert.equal(await mediaImportDirectory(),undefined);
  await fs.writeFile(path.join(settings,'import-preferences.json'),'invalid');
  assert.equal(await mediaImportDirectory(),undefined);
});
