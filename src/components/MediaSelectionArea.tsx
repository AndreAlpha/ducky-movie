import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  selectedIds: string[];
  availableIds: string[];
  onSelectionChange: (ids: string[]) => void;
}
interface Rectangle { left: number; top: number; width: number; height: number }
interface Gesture {
  pointerId: number;
  x: number; y: number;
  clientX: number; clientY: number;
  originClientX: number; originClientY: number;
  before: string[]; additive: boolean; moved: boolean;
}

/** Blank-space selection preserves the normal native drag of the media cards. */
export function MediaSelectionArea({ children, selectedIds, availableIds, onSelectionChange }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef<number | null>(null);
  const latest = useRef({ selectedIds, availableIds, onSelectionChange });
  latest.current = { selectedIds, availableIds, onSelectionChange };
  const [rectangle, setRectangle] = useState<Rectangle | null>(null);

  function select(ids: string[]) {
    const previous = latest.current.selectedIds;
    if (previous.length === ids.length && previous.every((id, index) => ids[index] === id)) return;
    latest.current.selectedIds = ids;
    latest.current.onSelectionChange(ids);
  }
  function update() {
    const node = container.current, current = gesture.current;
    if (!node || !current) return;
    if (!current.moved && Math.hypot(current.clientX - current.originClientX, current.clientY - current.originClientY) < 4) return;
    current.moved = true;
    const bounds = node.getBoundingClientRect();
    const x = Math.max(0, Math.min(node.scrollWidth, current.clientX - bounds.left + node.scrollLeft));
    const y = Math.max(0, Math.min(node.scrollHeight, current.clientY - bounds.top + node.scrollTop));
    const box = { left: Math.min(current.x, x), top: Math.min(current.y, y), width: Math.abs(x - current.x), height: Math.abs(y - current.y) };
    setRectangle(box);
    const available = new Set(latest.current.availableIds);
    const hit = Array.from(node.querySelectorAll<HTMLElement>('[data-asset-id]')).filter(card => {
      if (!available.has(card.dataset.assetId!)) return false;
      const item = card.getBoundingClientRect();
      const left = item.left - bounds.left + node.scrollLeft, top = item.top - bounds.top + node.scrollTop;
      return left < box.left + box.width && left + item.width > box.left && top < box.top + box.height && top + item.height > box.top;
    }).map(card => card.dataset.assetId!);
    select(current.additive ? [...new Set([...current.before, ...hit])] : hit);
  }
  function tick() {
    const node = container.current, current = gesture.current;
    if (!node || !current) { frame.current = null; return; }
    if (current.moved) {
      const bounds = node.getBoundingClientRect();
      const edge = Math.min(30, bounds.height / 4);
      const delta = current.clientY < bounds.top + edge ? -Math.min(18, (bounds.top + edge - current.clientY) * .5)
        : current.clientY > bounds.bottom - edge ? Math.min(18, (current.clientY - bounds.bottom + edge) * .5) : 0;
      if (delta) { const before = node.scrollTop; node.scrollTop += delta; if (node.scrollTop !== before) update(); }
    }
    frame.current = requestAnimationFrame(tick);
  }
  function finish(cancel = false) {
    const current = gesture.current;
    gesture.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    setRectangle(null);
    if (current && cancel) select(current.before);
    if (current && container.current?.hasPointerCapture(current.pointerId)) container.current.releasePointerCapture(current.pointerId);
  }
  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-asset-id],button,input,select,textarea,a')) return;
    const node = event.currentTarget, bounds = node.getBoundingClientRect();
    // Leave native scrollbar gestures to the browser.
    if (event.clientX - bounds.left >= node.clientWidth || event.clientY - bounds.top >= node.clientHeight) return;
    event.preventDefault();
    node.focus({ preventScroll: true });
    gesture.current = { pointerId: event.pointerId, x: event.clientX - bounds.left + node.scrollLeft, y: event.clientY - bounds.top + node.scrollTop,
      clientX: event.clientX, clientY: event.clientY, originClientX: event.clientX, originClientY: event.clientY,
      before: [...latest.current.selectedIds], additive: event.ctrlKey || event.metaKey || event.shiftKey, moved: false };
    node.setPointerCapture(event.pointerId);
    if (!gesture.current.additive) select([]);
    frame.current = requestAnimationFrame(tick);
  }
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); finish(true); } };
    const blur = () => finish(true);
    window.addEventListener('keydown', cancel, true); window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', cancel, true); window.removeEventListener('blur', blur);
      gesture.current = null; if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);
  return <div className={`library-content media-selection-area${rectangle ? ' selecting-media' : ''}`} ref={container} tabIndex={-1}
    onPointerDown={start} onPointerMove={event => { const current = gesture.current; if (current?.pointerId === event.pointerId) { current.clientX = event.clientX; current.clientY = event.clientY; update(); } }}
    onPointerUp={event => { if (gesture.current?.pointerId === event.pointerId) { update(); finish(); } }}
    onPointerCancel={() => finish(true)} onLostPointerCapture={() => { if (gesture.current) finish(true); }}
    onScroll={() => { if (gesture.current?.moved) update(); }}>
    {children}
    {rectangle && <div className="media-selection-marquee" aria-hidden="true" style={rectangle} />}
  </div>;
}
