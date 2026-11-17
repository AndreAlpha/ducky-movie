import type { MediaAsset, Project, SubtitleWord, VideoClip } from '../shared/types';
import { canonicalMediaPath, createAudioTrack, createClip, createProject, createSubtitles, linkSubtitlesToTimeline, validateProject } from './model';

export type MontagePace = 'relaxed' | 'balanced' | 'dynamic';
export type MontageOrder = 'selection' | 'shuffle';
export type MontagePriority = 'balanced' | 'video' | 'image';
export interface SemanticMontageSegment { source: string; start: number; end: number; sourceIn?: number; zoom_in?: boolean }
export interface MontageOptions {
  assetIds: string[];
  narrationIds?: string[];
  pace?: MontagePace;
  order?: MontageOrder;
  priority?: MontagePriority;
  minSeconds?: number;
  maxSeconds?: number;
  reuse?: boolean;
  wholeVideos?: boolean;
  videoAudio?: boolean;
  subtitles?: boolean;
  wordsByAsset?: Record<string, SubtitleWord[]>;
  semanticSegments?: SemanticMontageSegment[];
  introId?: string;
  outroId?: string;
  logoId?: string;
  seed?: number;
}
export interface MontageResult {
  project: Project;
  warnings: string[];
  shotCount: number;
  usedAssetIds: string[];
  unusedAssetIds: string[];
  bodyDuration: number;
  repeated: boolean;
}

interface CutPoint { time: number; weight: number }
interface PlannedShot { asset: MediaAsset; duration: number; sourceIn?: number; zoomIn?: boolean }
const EPSILON = 0.000001;
const PACES = { relaxed: { ideal: 6, min: 3.5, max: 9, fade: .35 }, balanced: { ideal: 4, min: 2, max: 6, fade: .25 }, dynamic: { ideal: 2.5, min: 1, max: 4, fade: .12 } };

function orderedAssets(project: Project, options: MontageOptions): MediaAsset[] {
  const seen = new Set<string>();
  let assets = options.assetIds.map((id) => project.assets.find((asset) => asset.id === id))
    .filter((asset): asset is MediaAsset => !!asset && !asset.missing && asset.kind !== 'audio'
      && ![options.introId, options.outroId, options.logoId].includes(asset.id))
    .filter((asset) => { const key = canonicalMediaPath(asset.path); if (seen.has(key)) return false; seen.add(key); return true; });
  if (options.order === 'shuffle') {
    let seed = options.seed ?? [...project.id].reduce((sum, letter) => Math.imul(sum ^ letter.charCodeAt(0), 16777619), 2166136261);
    for (let index = assets.length - 1; index > 0; index--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const target = seed % (index + 1);
      [assets[index], assets[target]] = [assets[target], assets[index]];
    }
  }
  if (options.priority && options.priority !== 'balanced') {
    const preferred = options.priority;
    assets = [...assets.filter((asset) => asset.kind === preferred), ...assets.filter((asset) => asset.kind !== preferred)];
  }
  return assets;
}

function speechCutPoints(asset: MediaAsset, words: SubtitleWord[], offset = 0): CutPoint[] {
  const points: CutPoint[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const next = words[index + 1];
    const gap = next ? next.start - word.end : 0;
    const strong = /[.!?…]$/.test(word.text.trim());
    if (strong || gap > .28 || /[,;:]$/.test(word.text.trim())) {
      points.push({ time: offset + Math.min(asset.duration, word.end + Math.max(0, Math.min(gap / 2, .18))), weight: strong ? 1 : .65 });
    }
  }
  const waveform = asset.waveform ?? [];
  if (waveform.length > 2) {
    const sorted = [...waveform].sort((a, b) => a - b);
    const threshold = sorted[Math.floor(sorted.length * .65)] * .3;
    for (let index = 1; index < waveform.length - 1; index++) {
      if (waveform[index] <= threshold && waveform[index] <= waveform[index - 1] && waveform[index] <= waveform[index + 1]) {
        points.push({ time: offset + asset.duration * (index + .5) / waveform.length, weight: .45 });
      }
    }
  }
  points.push({ time: offset + asset.duration, weight: 1 });
  return points;
}

function preferredVideoDuration(asset: MediaAsset, desired: number, words: SubtitleWord[]): number {
  if (desired >= asset.duration - EPSILON) return asset.duration;
  const candidates = speechCutPoints(asset, words).filter((point) => point.time >= Math.max(.4, desired - .9) && point.time <= Math.min(asset.duration, desired + .9));
  const best = candidates.sort((a, b) => Math.abs(a.time - desired) - a.weight * .45 - (Math.abs(b.time - desired) - b.weight * .45))[0];
  return best?.time ?? desired;
}

function minimumDuration(asset:MediaAsset,minimum:number):number { return asset.kind==='video'?Math.min(minimum,asset.duration):minimum; }

function readableAssets(assets:MediaAsset[],total:number,minimum:number):MediaAsset[]{
  let cost=0;
  const selected=assets.filter(asset=>{const next=minimumDuration(asset,minimum);if(cost+next>total+EPSILON)return false;cost+=next;return true;});
  if(!selected.length)selected.push(assets[0]);
  const capacity=()=>selected.reduce((sum,asset)=>sum+(asset.kind==='image'?Infinity:asset.duration),0);
  if(capacity()<total-EPSILON){
    const photo=assets.find(asset=>asset.kind==='image'&&!selected.includes(asset));
    if(photo){
      while(selected.length&&selected.reduce((sum,asset)=>sum+minimumDuration(asset,minimum),0)+minimum>total+EPSILON)selected.pop();
      selected.push(photo);
    }else for(const asset of assets)if(!selected.includes(asset)&&capacity()<total-EPSILON)selected.push(asset);
  }
  return assets.filter(asset=>selected.includes(asset));
}

function distributeBudget(assets: MediaAsset[], total: number, ideal: number, minimumSeconds:number, options: MontageOptions): number[] {
  const capacity = assets.map((asset) => asset.kind === 'image' || options.reuse ? Infinity : asset.duration);
  const minimum = assets.map((asset) => minimumDuration(asset,minimumSeconds));
  const allocated = [...minimum];
  let remaining = total - allocated.reduce((sum, value) => sum + value, 0);
  if (remaining < -EPSILON) return minimum.map(duration=>total*duration/minimum.reduce((sum,value)=>sum+value,0));
  function fill(targets: number[]) {
    const needs = targets.map((target, index) => Math.max(0, target - allocated[index]));
    const required = needs.reduce((sum, value) => sum + value, 0);
    if (required <= EPSILON || remaining <= EPSILON) return;
    const amount = Math.min(remaining, required);
    for (let index = 0; index < assets.length; index++) allocated[index] += amount * needs[index] / required;
    remaining -= amount;
  }
  const semanticDurations = new Map<string, number>();
  for (const segment of options.semanticSegments ?? []) {
    const key = canonicalMediaPath(segment.source);
    semanticDurations.set(key, (semanticDurations.get(key) ?? 0) + Math.max(0, segment.end - segment.start));
  }
  fill(assets.map((asset, index) => {
    const priority = options.priority === asset.kind ? 1.5 : options.priority && options.priority !== 'balanced' ? .8 : 1;
    return Math.min(capacity[index], semanticDurations.get(canonicalMediaPath(asset.path)) ?? ideal * priority * (asset.kind === 'video' ? 1.5 : 1));
  }));
  if (options.priority === 'image' && assets.some((asset) => asset.kind === 'image')) {
    const count = assets.filter((asset) => asset.kind === 'image').length;
    for (let index = 0; index < assets.length; index++) if (assets[index].kind === 'image') allocated[index] += remaining / count;
    remaining = 0;
  }
  fill(assets.map((asset, index) => asset.kind === 'video' && Number.isFinite(capacity[index]) ? capacity[index] : allocated[index]));
  const flexible = assets.map((asset, index) => ({ asset, index })).filter(({ asset }) => asset.kind === 'image' || options.reuse);
  if (remaining > EPSILON && flexible.length) {
    for (const { index } of flexible) allocated[index] += remaining / flexible.length;
    remaining = 0;
  }
  if (remaining > .001) throw new Error(`I video selezionati coprono ${Math.round(total - remaining)} secondi su ${Math.round(total)}. Aggiungi foto o altri video, oppure attiva il riutilizzo dei media.`);
  return allocated;
}

function planShots(assets: MediaAsset[], budgets: number[], minimum:number, maximum: number, options: MontageOptions): PlannedShot[] {
  const remaining = [...budgets];
  const usedSource = new Map<string, number>();
  const shots: PlannedShot[] = [];
  while (remaining.some((duration) => duration > EPSILON)) {
    for (let index = 0; index < assets.length; index++) {
      if (remaining[index] <= EPSILON) continue;
      const asset = assets[index];
      let duration = remaining[index];
      const consumed=usedSource.get(asset.id)??0;
      const cursor=asset.kind==='video'?(options.reuse?consumed%asset.duration:consumed):0;
      if(asset.kind==='video')duration=Math.min(duration,asset.duration-cursor);
      if ((asset.kind === 'video' && !options.wholeVideos) || (asset.kind === 'image' && options.reuse)) {
        const count = Math.min(Math.max(1,Math.ceil(duration / maximum)),Math.max(1,Math.floor((duration+EPSILON)/minimum)));
        duration = duration / count;
      }
      if (asset.kind === 'video') {
        usedSource.set(asset.id, consumed + duration);
      }
      if (duration <= EPSILON) throw new Error('Un video selezionato non ha durata sufficiente per il montaggio.');
      shots.push({ asset, duration });
      remaining[index] = Math.max(0, remaining[index] - duration);
      if (shots.length > 10000) throw new Error('Questo montaggio richiede troppe scene. Scegli meno media o un ritmo più disteso.');
    }
  }
  return shots;
}

/** Preserve the assignment of each narrated window, including video sample time.
 * Finite video ranges are consumed once. A short assigned video hands its
 * remainder to other selected footage/photos without stretching its last frame.
 */
function planSemanticShots(assets: MediaAsset[], total: number, segments: SemanticMontageSegment[], reuse: boolean): { shots: PlannedShot[]; adjusted: boolean } {
  const shots: PlannedShot[] = [];
  const usedPhotos = new Set<string>();
  let adjusted = false;
  const occupied = new Map<string, { start: number; end: number }[]>();
  const append = (asset: MediaAsset, duration: number, sourceIn?: number, zoomIn?: boolean) => {
    const previous = shots[shots.length - 1];
    if (previous?.asset.id === asset.id && (asset.kind === 'image' || Math.abs((previous.sourceIn ?? 0) + previous.duration - (sourceIn ?? 0)) < EPSILON)) previous.duration += duration;
    else shots.push({ asset, duration, sourceIn, zoomIn });
    if(asset.kind==='image')usedPhotos.add(asset.id);
    if (asset.kind === 'video') {
      const used = occupied.get(asset.id) ?? [];
      used.push({ start: sourceIn!, end: sourceIn! + duration });
      occupied.set(asset.id, used.sort((a, b) => a.start - b.start));
    }
  };
  const available = (asset: MediaAsset, desired: number, wanted: number): { start: number; duration: number } | null => {
    if (asset.kind === 'image') return !reuse&&usedPhotos.has(asset.id)&&shots.at(-1)?.asset.id!==asset.id ? null : { start: 0, duration: wanted };
    const ranges: { start: number; end: number }[] = [];
    let cursor = 0;
    for (const used of reuse ? [] : occupied.get(asset.id) ?? []) {
      if (used.start > cursor + EPSILON) ranges.push({ start: cursor, end: used.start });
      cursor = Math.max(cursor, used.end);
    }
    if (asset.duration > cursor + EPSILON) ranges.push({ start: cursor, end: asset.duration });
    const candidates = ranges.map((range) => {
      const duration = Math.min(wanted, range.end - range.start);
      return { start: Math.max(range.start, Math.min(desired, range.end - duration)), duration };
    }).sort((a, b) => Math.min(wanted, b.duration) - Math.min(wanted, a.duration) || Math.abs(a.start - desired) - Math.abs(b.start - desired));
    return candidates[0] ?? null;
  };
  const fill = (duration: number, preferred?: MediaAsset, sourceIn = 0, zoomIn?: boolean) => {
    let remaining = duration;
    while (remaining > EPSILON) {
      const choices = [...(preferred ? [preferred] : []), ...assets.filter((asset) => asset !== preferred)];
      let chosen: { asset: MediaAsset; start: number; duration: number } | undefined;
      for (const asset of choices) {
        const range = available(asset, asset === preferred ? sourceIn : 0, remaining);
        if (range && range.duration > EPSILON) { chosen = { asset, ...range }; break; }
      }
      if (!chosen) throw new Error('I video selezionati non coprono tutta la narrazione. Aggiungi una foto o altro video, oppure attiva il riutilizzo dei media.');
      if(preferred&&chosen.asset.id!==preferred.id)adjusted=true;
      append(chosen.asset, chosen.duration, chosen.asset.kind === 'video' ? chosen.start : undefined, zoomIn);
      remaining -= chosen.duration;
      // Once a short chosen source has run out, prefer another selected asset.
      if (remaining > EPSILON) preferred = undefined;
      if (shots.length > 10000) throw new Error('Questo montaggio richiede troppe scene. Scegli meno media.');
    }
  };
  let cursor = 0;
  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    const asset = assets.find((item) => canonicalMediaPath(item.path) === canonicalMediaPath(segment.source));
    if (!asset || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)) continue;
    const start = Math.max(cursor, 0, Math.min(total, segment.start));
    const end = Math.min(total, segment.end);
    if (end <= start + EPSILON) continue;
    if (start > cursor + EPSILON) fill(start - cursor);
    const sourceIn = Number.isFinite(segment.sourceIn) ? Math.max(0, segment.sourceIn! + start - segment.start) : 0;
    fill(end - start, asset, sourceIn, segment.zoom_in);
    cursor = end;
  }
  if (cursor < total - EPSILON) fill(total - cursor);
  return {shots,adjusted};
}

function keepPhotosReadable(shots:PlannedShot[],minimum:number):boolean{
  let adjusted=false;
  for(let index=0;index<shots.length;index++){
    const shot=shots[index];
    if(shot.asset.kind!=='image'||shot.duration>=minimum-EPSILON)continue;
    const other=shots.slice(0,index).reverse().find(item=>item.asset.kind==='image')
      ??shots.find((item,otherIndex)=>otherIndex>index&&item.asset.kind==='image');
    if(other){other.duration+=shot.duration;shots.splice(index,1);index=-1;adjusted=true;continue;}
    // A short semantic window can leave only one photo between videos. Give
    // that photo enough screen time by trimming its neighbours, never freezing
    // or extending the finite video source.
    for(const direction of [-1,1]){
      while(shot.duration<minimum-EPSILON){
        const neighbour=shots[index+direction];
        if(!neighbour)break;
        const amount=Math.min(minimum-shot.duration,neighbour.duration);
        neighbour.duration-=amount;shot.duration+=amount;adjusted=true;
        if(direction===1&&neighbour.sourceIn!==undefined)neighbour.sourceIn+=amount;
        if(neighbour.duration<=EPSILON){shots.splice(index+direction,1);if(direction===-1)index--;}
      }
    }
  }
  return adjusted;
}

function alignCuts(shots: PlannedShot[], cuts: CutPoint[], ideal: number, minimum:number, reuse: boolean, wholeVideos: boolean): void {
  if (!cuts.length) return;
  const totals = new Map<string, number>();
  for (const shot of shots) totals.set(shot.asset.id, (totals.get(shot.asset.id) ?? 0) + shot.duration);
  let cursor = 0;
  for (let index = 0; index < shots.length - 1; index++) {
    const left = shots[index]; const right = shots[index + 1];
    const boundary = cursor + left.duration;
    const radius = Math.min(1, ideal * .3);
    const candidates = cuts.filter((cut) => Math.abs(cut.time - boundary) <= radius)
      .sort((a, b) => Math.abs(a.time - boundary) - a.weight * .65 - (Math.abs(b.time - boundary) - b.weight * .65));
    const selected = candidates.find((cut) => {
      const delta = cut.time - boundary;
      if (left.duration + delta < Math.min(minimum, left.duration)-EPSILON || right.duration - delta < Math.min(minimum, right.duration)-EPSILON) return false;
      if (reuse && (left.asset.kind === 'video' || right.asset.kind === 'video')) return false;
      if (left.asset.id === right.asset.id) return true;
      if (wholeVideos && (left.asset.kind === 'video' || right.asset.kind === 'video')) return false;
      if (!reuse && left.asset.kind === 'video' && (totals.get(left.asset.id) ?? 0) + delta > left.asset.duration + EPSILON) return false;
      if (!reuse && right.asset.kind === 'video' && (totals.get(right.asset.id) ?? 0) - delta > right.asset.duration + EPSILON) return false;
      return true;
    });
    if (selected) {
      const delta = selected.time - boundary;
      left.duration += delta; right.duration -= delta;
      totals.set(left.asset.id, (totals.get(left.asset.id) ?? 0) + delta);
      totals.set(right.asset.id, (totals.get(right.asset.id) ?? 0) - delta);
    }
    cursor += left.duration;
  }
}

function fitClip(clip: VideoClip, asset: MediaAsset, aspectRatio: Project['aspectRatio']): VideoClip {
  const ratio = aspectRatio === '9:16' ? 9 / 16 : aspectRatio === '1:1' ? 1 : 16 / 9;
  if (asset.kind === 'video' && asset.height > 0 && Math.abs(asset.width / asset.height - ratio) > .15) return { ...clip, fit: 'contain', background: 'blur' };
  return { ...clip, fit: 'cover' };
}

export function createSmartMontage(project: Project, options: MontageOptions): MontageResult {
  const pace = PACES[options.pace ?? 'balanced'];
  const minimum = options.minSeconds ?? pace.min;
  const maximum = options.maxSeconds ?? pace.max;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < .1 || maximum < minimum || maximum > 60) throw new Error('Scegli durate delle scene valide.');
  const ideal = Math.min(maximum, Math.max(minimum, pace.ideal));
  let assets = orderedAssets(project, options);
  if (!assets.length) throw new Error('Seleziona almeno un video o una foto per il montaggio.');
  const narrations = [...new Set(options.narrationIds ?? [])].map((id) => project.assets.find((asset) => asset.id === id));
  if (narrations.some((asset) => !asset || asset.missing || !asset.hasAudio || asset.kind === 'image')) throw new Error('Una narrazione selezionata non è disponibile.');
  const voices = narrations as MediaAsset[];
  const voiceDuration = voices.reduce((sum, asset) => sum + asset.duration, 0);
  const defaults = assets.map((asset) => asset.kind === 'image' ? ideal : options.wholeVideos ? asset.duration
    : Math.max(minimumDuration(asset,minimum),preferredVideoDuration(asset, Math.min(asset.duration, ideal * 1.5), options.wordsByAsset?.[asset.id] ?? [])));
  const defaultDurations=new Map(assets.map((asset,index)=>[asset.id,defaults[index]]));
  let bodyDuration = voices.length ? options.wholeVideos ? Math.max(voiceDuration, defaults.reduce((sum, duration) => sum + duration, 0)) : voiceDuration
    : defaults.reduce((sum, duration) => sum + duration, 0);
  if (!Number.isFinite(bodyDuration) || bodyDuration < .03 || bodyDuration > 86400) throw new Error('La durata dei media selezionati non è valida.');
  const warnings: string[] = [];
  if (!options.wholeVideos&&assets.reduce((sum, asset) => sum + minimumDuration(asset,minimum), 0) > bodyDuration+EPSILON) {
    assets=readableAssets(assets,bodyDuration,minimum);
    warnings.push('Alcuni media restano nella libreria per mantenere scene leggibili nella durata disponibile.');
  }
  const semantic = !!options.semanticSegments?.length && !options.wholeVideos;
  let budgets: number[];
  if(options.wholeVideos){
    budgets=defaults.slice(0,assets.length);
    let remaining=bodyDuration-budgets.reduce((sum,duration)=>sum+duration,0);
    const photos=assets.map((asset,index)=>({asset,index})).filter(({asset})=>asset.kind==='image');
    if(remaining>EPSILON&&photos.length){for(const {index} of photos)budgets[index]+=remaining/photos.length;remaining=0;}
    if(remaining>EPSILON&&!options.reuse)throw new Error('I video interi selezionati non coprono tutta la narrazione. Aggiungi foto o altri video, oppure attiva il riutilizzo dei media.');
    // Repeated whole footage always stays whole, even if it finishes after voice.
    for(let index=0;remaining>EPSILON;index=(index+1)%assets.length){budgets[index]+=assets[index].duration;remaining-=assets[index].duration;}
    bodyDuration=budgets.reduce((sum,duration)=>sum+duration,0);
  }else budgets=voices.length ? distributeBudget(assets, bodyDuration, ideal,minimum, options) : assets.map(asset=>defaultDurations.get(asset.id)!);
  const semanticPlan=semantic?planSemanticShots(assets,bodyDuration,options.semanticSegments!,!!options.reuse):null;
  const shots = semanticPlan?.shots??planShots(assets,budgets,minimum,maximum,options);
  if(semantic&&keepPhotosReadable(shots,minimum))warnings.push('Alcune assegnazioni sono state unite per rispettare la durata minima delle foto.');
  if(semanticPlan?.adjusted)warnings.push('Alcune scene suggerite sono state adattate per rispettare la durata dei video ed evitare ripetizioni.');
  const cuts: CutPoint[] = [];
  let audioOffset = 0;
  for (const asset of voices) {
    cuts.push(...speechCutPoints(asset, options.wordsByAsset?.[asset.id] ?? [], audioOffset));
    audioOffset += asset.duration;
  }
  if (!semantic) alignCuts(shots, cuts, ideal,minimum, !!options.reuse, !!options.wholeVideos);
  if(shots.some(shot=>shot.duration<minimum-EPSILON))warnings.push('Alcune scene sono più brevi del minimo per rispettare la durata della narrazione o il contenuto video disponibile.');
  if (options.wholeVideos && options.semanticSegments?.length) warnings.push('I video interi conservano il loro ordine e la loro durata. Disattiva questa opzione per abbinare le singole scene al parlato.');
  if (shots.some((shot) => shot.asset.kind === 'image' && shot.duration > maximum + .1)) warnings.push('Le foto rimangono più a lungo per accompagnare tutta la narrazione senza ripetizioni.');
  if(!options.wholeVideos&&shots.some(shot=>shot.asset.kind==='video'&&shot.duration>maximum+.1))warnings.push('Alcuni estratti video sono più lunghi del massimo per rispettare la durata minima delle scene.');
  const next = createProject(`${project.name} · Montaggio`);
  next.aspectRatio = project.aspectRatio; next.assets = [...project.assets];
  const cap = (assetId: string | undefined, role: 'intro' | 'outro') => {
    const asset = project.assets.find((item) => item.id === assetId);
    if (!assetId) return null;
    if (!asset || asset.missing || asset.kind === 'audio') throw new Error(`Scegli un video o una foto disponibile come ${role}.`);
    return fitClip({ ...createClip(asset), role }, asset, next.aspectRatio);
  };
  const intro = cap(options.introId, 'intro'); const outro = cap(options.outroId, 'outro');
  const offset = intro ? intro.out - intro.in : 0;
  if (intro) next.clips.push({ ...intro, start: 0 });
  const sourceCursors = new Map<string, number>();
  const sourceRanges = new Map<string,{start:number;end:number}[]>();
  let cursor = offset;
  let repeated = false;
  for (let index = 0; index < shots.length; index++) {
    const shot = shots[index];
    let sourceStart = 0;
    if (shot.asset.kind === 'video') {
      const consumed = sourceCursors.get(shot.asset.id) ?? 0;
      sourceStart = shot.sourceIn ?? (options.reuse ? consumed % shot.asset.duration : consumed);
      const ranges=sourceRanges.get(shot.asset.id)??[];
      if(ranges.some(range=>sourceStart<range.end-EPSILON&&sourceStart+shot.duration>range.start+EPSILON))repeated=true;
      sourceRanges.set(shot.asset.id,[...ranges,{start:sourceStart,end:sourceStart+shot.duration}]);
      sourceCursors.set(shot.asset.id, consumed + shot.duration);
    } else if (next.clips.some((clip) => clip.assetId === shot.asset.id && !clip.role)) repeated = true;
    const previous = shots[index - 1];
    const dissolve = index === 0 ? !!intro : previous.asset.kind === 'image' && shot.asset.kind === 'image' && previous.asset.id !== shot.asset.id;
    const clip = fitClip({ ...createClip(shot.asset), start: cursor, in: sourceStart, out: sourceStart + shot.duration,
      muted: shot.asset.kind === 'video' && voices.length > 0 && !options.videoAudio,
      transition: dissolve ? 'fade' : 'none', transitionDuration: dissolve ? Math.min(pace.fade, shot.duration / 2) : 0,
      ...(shot.asset.kind === 'image' ? { zoom: shot.zoomIn === undefined ? index % 2 ? 'out' as const : 'in' as const : shot.zoomIn ? 'in' as const : 'out' as const, zoomAmount: 1.05 } : {}),
    }, shot.asset, next.aspectRatio);
    if (shot.asset.kind === 'video' && clip.out > shot.asset.duration + EPSILON) throw new Error('Il montaggio supera il contenuto disponibile di un video.');
    next.clips.push(clip);
    cursor += shot.duration;
  }
  const words: SubtitleWord[] = [];
  let voiceCursor = offset;
  for (const asset of voices) {
    const track = { ...createAudioTrack(asset, voiceCursor), volume: 1 };
    next.audioTracks.push(track);
    for (const word of options.wordsByAsset?.[asset.id] ?? []) if (word.text.trim() && word.end > word.start && word.start < asset.duration) {
      words.push({ id: crypto.randomUUID(), text: word.text, start: voiceCursor + Math.max(0, word.start), end: voiceCursor + Math.min(asset.duration, word.end),
        source: { kind: 'audio', id: track.id, start: Math.max(0, word.start), end: Math.min(asset.duration, word.end) } });
    }
    voiceCursor += asset.duration;
  }
  if (outro) next.clips.push({ ...outro, start: cursor, transition: 'fade', transitionDuration: Math.min(.25, (outro.out - outro.in) / 2) });
  for (const clip of next.clips) {
    if (!clip.role && voices.length && !options.videoAudio) continue;
    for (const word of options.wordsByAsset?.[clip.assetId] ?? []) if (word.text.trim() && word.end > clip.in && word.start < clip.out) {
      words.push({ id: crypto.randomUUID(), text: word.text, start: clip.start! + Math.max(clip.in, word.start) - clip.in,
        end: clip.start! + Math.min(clip.out, word.end) - clip.in,
        source: { kind: 'clip', id: clip.id, start: Math.max(0, word.start), end: word.end } });
    }
  }
  next.duration = cursor + (outro ? outro.out - outro.in : 0);
  if (options.subtitles && words.length) next.subtitles = { ...createSubtitles(), words };
  if (options.logoId) next.overlays = [{ id: crypto.randomUUID(), kind: 'image', assetId: options.logoId, start: offset,
    end: offset + bodyDuration, x: .88, y: .88, width: .12, opacity: 1, animation: 'none', persistent: true }];
  const usedAssetIds = [...new Set(shots.map((shot) => shot.asset.id))];
  return { project: validateProject(linkSubtitlesToTimeline(next)), warnings, shotCount: shots.length, usedAssetIds,
    unusedAssetIds: options.assetIds.filter((assetId) => !usedAssetIds.includes(assetId) && ![options.introId, options.outroId, options.logoId].includes(assetId)),
    bodyDuration, repeated };
}
