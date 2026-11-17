export interface TimelineSnapTarget { time: number; label: string }
export interface TimelineSnapResult { delta: number; target?: TimelineSnapTarget; anchor?: number }

/** Align any moving edge, preserving every distance within the selection. */
export function snapTimelineDelta(
  anchors: readonly number[], delta: number, targets: readonly TimelineSnapTarget[], pixelsPerSecond: number,
  options: { enabled?: boolean; bypass?: boolean; minDelta?: number; maxDelta?: number; threshold?: number } = {},
): TimelineSnapResult {
  const minimum = options.minDelta ?? -Infinity, maximum = options.maxDelta ?? Infinity;
  const requested = Math.max(minimum, Math.min(maximum, delta));
  if (options.enabled === false || options.bypass || !Number.isFinite(requested) || !Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) return { delta: requested };
  const tolerance = (options.threshold ?? 8) / pixelsPerSecond;
  let best: TimelineSnapResult = { delta: requested }, distance = Infinity;
  for (const target of targets) {
    if (!Number.isFinite(target.time)) continue;
    for (const anchor of anchors) {
      if (!Number.isFinite(anchor)) continue;
      const candidate = target.time - anchor, difference = Math.abs(candidate - requested);
      if (candidate < minimum - 1e-8 || candidate > maximum + 1e-8 || difference > tolerance + 1e-8 || difference >= distance - 1e-8) continue;
      best = { delta: Math.max(minimum, Math.min(maximum, candidate)), target, anchor };
      distance = difference;
    }
  }
  return best;
}
