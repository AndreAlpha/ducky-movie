/** Geometry shared by the drop preview and the committed edit. Times are seconds. */
export interface MoveInterval {
  id: string;
  trackId: string;
  start: number;
  end: number;
}

export interface TimelineMovePlan {
  start: number;
  displaced: boolean;
  positions: Map<string, { start: number; trackId: string }>;
}

const EPSILON = 0.000001;
const length = (item: MoveInterval) => item.end - item.start;

interface Contact {
  moving: MoveInterval;
  fixed: MoveInterval;
  lane: MoveInterval[];
}

/** The primary item wins if another member of a group also hits something.
 * Within that item use the neighbour closest to the grab point, so dragging
 * a long clip across several short ones doesn't skip to the last neighbour. */
function findContact(moving: MoveInterval[], fixedByTrack: Map<string, MoveInterval[]>,
    primaryId: string, delta: number, pointer: number): Contact | undefined {
  let best: Contact | undefined;
  let bestDistance = Infinity;
  const cursors = new Map<string, number>();
  for (const item of moving) {
    const lane = fixedByTrack.get(item.trackId) ?? [];
    let cursor = cursors.get(item.trackId) ?? 0;
    while (cursor < lane.length && lane[cursor].end <= item.start + delta + EPSILON) cursor++;
    cursors.set(item.trackId, cursor);
    for (let i = cursor; i < lane.length && lane[i].start < item.end + delta - EPSILON; i++) {
      const candidate = lane[i];
      const distance = Math.max(candidate.start - pointer, pointer - candidate.end, 0);
      if (best?.moving.id === primaryId && item.id !== primaryId) continue;
      if (!best || item.id === primaryId && best.moving.id !== primaryId || distance < bestDistance) {
        best = { moving: item, fixed: candidate, lane };
        bestDistance = distance;
      }
    }
  }
  return best;
}

/** In a continuous run, moving a consecutive block changes its order while
 * preserving both ends of the run and all gaps elsewhere on the timeline. */
function reorderTouchingRun(all: MoveInterval[], moving: MoveInterval[], selected: Set<string>,
    neighbour: MoveInterval, after: boolean): Map<string, { start: number; trackId: string }> | undefined {
  if (moving.some(item => item.trackId !== neighbour.trackId)) return;
  const first = Math.min(moving[0].start, neighbour.start);
  const end = Math.max(moving[moving.length - 1].end, neighbour.end);
  const run = all.filter(item => item.trackId === neighbour.trackId && item.start >= first && item.end <= end);
  if (run.some((item, i) => i > 0 && item.start - run[i - 1].end > EPSILON)) return;
  if (moving.some((item, i) => i > 0 && item.start - moving[i - 1].end > EPSILON)) return;
  const remaining = run.filter(item => !selected.has(item.id));
  const index = remaining.findIndex(item => item.id === neighbour.id);
  remaining.splice(index + Number(after), 0, ...moving);
  const positions = new Map<string, { start: number; trackId: string }>();
  let cursor = first;
  for (const item of remaining) {
    positions.set(item.id, { start: cursor, trackId: item.trackId });
    cursor += length(item);
  }
  return positions;
}

/** Keep each fixed clip in its original slot unless the moved selection needs
 * that space. Any resulting shift stops at the next sufficiently large gap. */
function makeRoom(fixed: MoveInterval[], reserved: MoveInterval[], limit: number,
    positions: TimelineMovePlan['positions']): boolean {
  let displaced = false;
  let previousEnd = 0;
  let cursor = 0;
  for (const item of fixed) {
    let start = Math.max(previousEnd, item.start);
    while (cursor < reserved.length) {
      const slot = reserved[cursor];
      if (slot.start >= start + length(item) - EPSILON) break;
      if (slot.end > start + EPSILON) start = slot.end;
      cursor++;
    }
    previousEnd = start + length(item);
    if (previousEnd > limit + EPSILON) throw new Error('Lo spostamento supera la durata massima del film.');
    if (start > item.start + EPSILON) {
      positions.set(item.id, { start, trackId: item.trackId });
      displaced = true;
    }
  }
  return displaced;
}

export function planMoveIntervals(items: MoveInterval[], trackIds: string[], primaryId: string,
    selectedIds: readonly string[], targetTrack: string, requested: number, limit: number,
    pointerTime?: number): TimelineMovePlan {
  if (!Number.isFinite(requested)) throw new Error('La posizione sulla timeline non è valida.');
  const primary = items.find(item => item.id === primaryId);
  if (!primary) throw new Error('L’elemento da spostare non è più sulla timeline.');
  if (!trackIds.includes(targetTrack)) throw new Error('Scegli una traccia compatibile con questo elemento.');
  const selected = new Set([primaryId, ...selectedIds]);
  const ordered = [...items].sort((a, b) => a.start - b.start);
  const offset = trackIds.indexOf(targetTrack) - trackIds.indexOf(primary.trackId);
  const moving: MoveInterval[] = [];
  const fixedByTrack = new Map<string, MoveInterval[]>();
  for (const item of ordered) {
    if (selected.has(item.id)) {
      const trackId = trackIds[trackIds.indexOf(item.trackId) + offset];
      if (!trackId) throw new Error('Il gruppo non entra nelle tracce disponibili in questa posizione.');
      moving.push({ ...item, trackId });
    } else {
      const lane = fixedByTrack.get(item.trackId) ?? [];
      lane.push(item);
      fixedByTrack.set(item.trackId, lane);
    }
  }
  if (moving.length !== selected.size) throw new Error('La selezione sulla timeline è cambiata.');
  const minDelta = -moving[0].start;
  const maxDelta = limit - Math.max(...moving.map(item => item.end));
  let delta = Math.max(minDelta, Math.min(maxDelta, requested - primary.start));
  const pointer = pointerTime !== undefined && Number.isFinite(pointerTime)
    ? pointerTime : primary.start + delta + length(primary) / 2;
  const contact = findContact(moving, fixedByTrack, primaryId, delta, pointer);
  if (contact) {
    const { fixed, moving: hit, lane } = contact;
    const midpoint = (fixed.start + fixed.end) / 2;
    // Shallow overlap attaches the near edge. Passing halfway through the
    // neighbour takes the moving block to its other side.
    const approach = offset !== 0 ? pointer : delta > 0 ? hit.end + delta : hit.start + delta;
    const after = approach >= midpoint;
    if (offset === 0) {
      const swap = reorderTouchingRun(ordered, moving, selected, fixed, after);
      if (swap) return { start: swap.get(primaryId)!.start,
        displaced: ordered.some(item => !selected.has(item.id) && swap.has(item.id)
          && Math.abs(swap.get(item.id)!.start - item.start) > EPSILON),
        positions: swap };
    }
    // Preserve relative offsets in the selected block. If it cannot fit
    // before the neighbour, the neighbour and any touching followers yield.
    const sameLane = moving.filter(item => item.trackId === hit.trackId);
    let first = sameLane.indexOf(hit), last = first;
    while (first > 0 && sameLane[first].start <= sameLane[first - 1].end + EPSILON) first--;
    while (last + 1 < sameLane.length && sameLane[last + 1].start <= sameLane[last].end + EPSILON) last++;
    const precedingEnd = lane[lane.indexOf(fixed) - 1]?.end ?? 0;
    delta = after ? fixed.end - sameLane[first].start
      : Math.max(precedingEnd - sameLane[first].start, fixed.start - sameLane[last].end);
    delta = Math.max(minDelta, Math.min(maxDelta, delta));
  }
  const positions: TimelineMovePlan['positions'] = new Map();
  const reserved = new Map<string, MoveInterval[]>();
  for (const item of moving) {
    const start = item.start + delta;
    positions.set(item.id, { start, trackId: item.trackId });
    const lane = reserved.get(item.trackId) ?? [];
    lane.push({ ...item, start, end: item.end + delta });
    reserved.set(item.trackId, lane);
  }
  let displaced = false;
  for (const [trackId, slots] of reserved) {
    if (makeRoom(fixedByTrack.get(trackId) ?? [], slots, limit, positions)) displaced = true;
  }
  return { start: primary.start + delta, displaced, positions };

}
