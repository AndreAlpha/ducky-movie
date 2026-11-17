import type { Project } from '../shared/types';
import { addTimelineTrack, appendAsset, getAudioTrackId, getProjectTracks, timelinePositions } from './model';

/** Insert a library selection as one undoable operation, with a cursor per media lane. */
export function insertLibraryAssets(project: Project, assetIds: readonly string[], start: number, targetTrackId?: string) {
  if (!Number.isFinite(start) || start < 0) throw new Error('La posizione nella timeline non è valida.');
  const ids=[...new Set(assetIds)];
  if (!ids.length) return { project, clipIds: [] as string[], audioIds: [] as string[] };
  const assets=ids.map(id=>project.assets.find(asset=>asset.id===id));
  if (assets.some(asset=>!asset||asset.missing)) throw new Error('Uno dei media selezionati non è disponibile. Ricollegalo prima di aggiungerlo.');
  let next=project;
  const cursors=new Map<string,number>();
  const clipIds:string[]=[],audioIds:string[]=[];
  const requested=getProjectTracks(project).find(track=>track.id===targetTrackId);
  for (const asset of assets) {
    if (!asset) continue;
    const kind=asset.kind==='audio'||requested?.kind==='audio'&&asset.kind==='video'&&asset.hasAudio?'audio':'video';
    let lane=requested?.kind===kind?requested:getProjectTracks(next).find(track=>track.kind===kind);
    if (!lane) { next=addTimelineTrack(next,kind); lane=getProjectTracks(next).find(track=>track.kind===kind)!; }
    const cursor=cursors.get(lane.id)??start;
    const oldClipIds=new Set(next.clips.map(clip=>clip.id));
    const oldAudioIds=new Set(next.audioTracks.map(audio=>audio.id));
    next=appendAsset(next,asset.id,cursor,lane.id);
    const addedClip=next.clips.find(clip=>!oldClipIds.has(clip.id));
    const addedAudio=next.audioTracks.find(audio=>!oldAudioIds.has(audio.id));
    if (addedClip) {
      const entry=timelinePositions(next).find(entry=>entry.clip.id===addedClip.id)!;
      clipIds.push(addedClip.id);cursors.set(entry.trackId,entry.end);
    } else if (addedAudio) {
      audioIds.push(addedAudio.id);cursors.set(getAudioTrackId(next,addedAudio.id),addedAudio.start+addedAudio.out-addedAudio.in);
    }
  }
  return { project:next,clipIds,audioIds };
}
