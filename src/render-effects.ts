import type { Project, ProjectFrame, ProjectSubtitles, SubtitleWord, TimedOverlay } from '../shared/types';
import { groupSubtitleWords } from './model';

function rgbaHex(hex: string, opacity: number) {
  const raw = hex.replace('#', '');
  const value = raw.length === 3 ? raw.split('').map((character) => character + character).join('') : raw;
  const red = parseInt(value.slice(0, 2), 16) || 0;
  const green = parseInt(value.slice(2, 4), 16) || 0;
  const blue = parseInt(value.slice(4, 6), 16) || 0;
  return `rgba(${red},${green},${blue},${opacity})`;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2));
}

export function createProjectFramePng(project: Project, width: number, height: number): string | null {
  return renderFramePNG(project.frame, width, height);
}

export function renderFramePNG(frame: Project['frame'], width: number, height: number): string | null {
  if (!frame || frame.style === 'none') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  drawArtisticFrame(context, width, height, frame);
  return canvas.toDataURL('image/png');
}

export interface CaptionBlock { start: number; end: number; words: SubtitleWord[] }

export function captionBlocks(subtitles: ProjectSubtitles): CaptionBlock[] {
  return groupSubtitleWords(subtitles.words, subtitles.maxWords, subtitles.maxLines);
}

export function overlayTransform(animation: TimedOverlay['animation'], progress: number) {
  const smooth = (value: number) => { const bounded = Math.min(1, Math.max(0, value)); return bounded * bounded * (3 - 2 * bounded); };
  const incoming = smooth(progress / 0.18);
  const outgoing = smooth((1 - progress) / 0.18);
  let alpha = Math.min(incoming, outgoing);
  let scale = 1;
  let dx = 0;
  let dy = 0;
  if (animation === 'none') alpha = 1;
  if (animation === 'fade-grow') scale = 0.62 + 0.38 * incoming + 0.12 * (1 - outgoing);
  if (animation === 'pop' && progress < 0.18) {
    const value = progress / 0.18;
    const overshoot = 1.70158;
    scale = 1 + (overshoot + 1) * (value - 1) ** 3 + overshoot * (value - 1) ** 2;
  }
  if (animation === 'zoom-out') scale = 1.5 - 0.5 * incoming;
  if (animation === 'slide-up') dy = (1 - incoming) * 0.14 - (1 - outgoing) * 0.1;
  if (animation === 'slide-right') dx = -(1 - incoming) * 0.18 + (1 - outgoing) * 0.14;
  if (animation === 'breathe') scale = 1 + 0.045 * Math.sin(progress * Math.PI * 4);
  return { alpha, scale, dx, dy };
}

function vmSmooth(value: number) { const bounded = Math.max(0, Math.min(1, value)); return bounded * bounded * (3 - 2 * bounded); }
function vmBackOut(value: number) { const coefficient = 1.70158; return 1 + (coefficient + 1) * (value - 1) ** 3 + coefficient * (value - 1) ** 2; }
function vmSubscribeState(progress: number) {
  const p = Math.max(0, Math.min(1, progress));
  const appear = p < .16 ? vmSmooth(p / .16) : 1;
  const outgoing = p > .86 ? vmSmooth((1 - p) / .14) : 1;
  let handAlpha = vmSmooth((p - .04) / .16);
  if (p > .4) handAlpha *= Math.max(0, 1 - (p - .4) / .14);
  const ring = (p - .34) / .5;
  const ripple = (p - .34) / .24;
  const burst = (p - .34) / .16;
  return { a: Math.min(appear, outgoing), scale: p < .16 ? vmBackOut(p / .16) : 1, hand: vmSmooth((p - .06) / .26), handA: handAlpha, press: Math.abs(p - .34) < .07 ? vmSmooth(1 - Math.abs(p - .34) / .07) : 0, burst: burst >= 0 && burst <= 1 ? 1 - burst : 0, swing: ring > 0 && ring <= 1.2 ? Math.sin(ring * Math.PI * 5) * Math.exp(-ring * 3) : 0, wave: ring > 0 && ring <= 1.2 ? Math.max(0, 1 - ring) : 0, ripple: ripple >= 0 && ripple <= 1 ? ripple : -1 };
}
function paintIcon(ctx: CanvasRenderingContext2D, path: Path2D, vw: number, vh: number, sx: number, sy: number, scale: number, color: string, rotation = 0, ax = vw / 2, ay = vh / 2, border = 0, borderColor = '#000') {
  ctx.save(); ctx.translate(sx, sy); if (rotation) ctx.rotate(rotation); ctx.scale(scale, scale); ctx.translate(-ax, -ay);
  if (border > 0) { ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.lineWidth = 2 * border / scale; ctx.strokeStyle = borderColor; ctx.stroke(path); }
  ctx.fillStyle = color; ctx.fill(path); ctx.restore();
}
function darken(hex: string, amount: number) {
  const raw = hex.replace('#', '');
  const value = raw.length === 3 ? raw.split('').map((part) => part + part).join('') : raw;
  const channel = (index: number) => Math.max(0, Math.round(parseInt(value.slice(index, index + 2), 16) * (1 - amount)));
  return `rgb(${channel(0)},${channel(2)},${channel(4)})`;
}
function paintSubscribe(context: CanvasRenderingContext2D, width: number, height: number, overlay: TimedOverlay, progress: number) {
  VM_HAND_BODY ??= new Path2D(VM_HAND_D.split('z')[0] + 'z');
  VM_BELL_PATH ??= new Path2D(VM_BELL_D);
  context.font = '700 100px "Segoe UI", Arial, sans-serif';
  const text = overlay.text || 'ISCRIVITI';
  const coefficient = 1.32 + 1.34 * 448 / 512 + .42 + context.measureText(text).width / 100;
  const fontSize = overlay.fontSize ? overlay.fontSize * height * .62 : overlay.width * width / coefficient;
  paintSubscribeNative(context, { ch: height }, { size: fontSize / height / .62, text, opacity: overlay.opacity, color: overlay.color ?? '#ffffff', box_color: overlay.boxColor ?? '#e11d2a' }, 0, 0, progress);
  return { width: fontSize * coefficient, height: fontSize * 1.7 };
}

export interface EffectHitbox { id: string; x: number; y: number; width: number; height: number; kind: 'subtitle' | 'overlay' }

const frameLayers = new Map<string, HTMLCanvasElement>();

function drawFrameLayer(context: CanvasRenderingContext2D, width: number, height: number, frame: Project['frame']) {
  if (!frame || frame.style === 'none') return;
  const key = `${width}x${height}:${JSON.stringify(frame)}`;
  let layer = frameLayers.get(key);
  if (!layer) {
    layer = document.createElement('canvas');
    layer.width = width;
    layer.height = height;
    const frameContext = layer.getContext('2d');
    if (!frameContext) return;
    drawArtisticFrame(frameContext, width, height, frame);
    if (frameLayers.size >= 8) frameLayers.clear();
    frameLayers.set(key, layer);
  }
  context.drawImage(layer, 0, 0);
}

export function drawProjectEffects(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  project: Project,
  time: number,
  images: Map<string, HTMLImageElement> = new Map(),
): EffectHitbox[] {
  const boxes: EffectHitbox[] = [];
  for (const overlay of project.overlays ?? []) {
    if (time < overlay.start || time >= overlay.end) continue;
    const image = overlay.assetId ? images.get(overlay.assetId) : undefined;
    const progress = (time - overlay.start) / (overlay.end - overlay.start);
    const animation = overlay.kind === 'subscribe' ? { alpha: 1, scale: 1, dx: 0, dy: 0 } : overlayTransform(overlay.animation, progress);
    let overlayWidth = overlay.width * width;
    let overlayHeight = overlay.kind === 'image' && image ? overlayWidth * image.naturalHeight / image.naturalWidth : overlayWidth * 0.23;
    if (overlay.kind === 'text') overlayHeight = overlayWidth * 0.3;
    const x = (overlay.x + animation.dx) * width;
    const y = (overlay.y + animation.dy) * height;
    context.save();
    context.globalAlpha = overlay.kind === 'subscribe' ? 1 : overlay.opacity * animation.alpha;
    context.translate(x, y);
    context.scale(animation.scale, animation.scale);
    if (overlay.kind === 'image' && image?.complete && image.naturalWidth) {
      context.drawImage(image, -overlayWidth / 2, -overlayHeight / 2, overlayWidth, overlayHeight);
    } else if (overlay.kind === 'subscribe') {
      const bounds = paintSubscribe(context, width, height, overlay, progress);
      overlayWidth = bounds.width; overlayHeight = bounds.height;
    } else if (overlay.kind === 'text') {
      context.fillStyle = overlay.color ?? '#ffffff';
      const fontSize = overlay.fontSize ? overlay.fontSize * height : overlayWidth * .13;
      context.font = `700 ${fontSize}px "Segoe UI", Arial, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.shadowColor = '#000000';
      context.shadowBlur = overlayWidth * 0.02;
      const lines = (overlay.text || 'Il tuo testo').split('\n');
      const lineHeight = fontSize * 1.32;
      overlayHeight = lines.length * lineHeight;
      if (overlay.box) {
        const boxWidth = Math.min(overlayWidth, Math.max(...lines.map((line) => context.measureText(line).width))) + fontSize * .56;
        context.fillStyle = rgbaHex(overlay.boxColor ?? '#000000', overlay.boxOpacity ?? .6);
        context.fillRect(-boxWidth / 2, -overlayHeight / 2 - fontSize * .15, boxWidth, overlayHeight + fontSize * .3);
        context.fillStyle = overlay.color ?? '#ffffff';
      }
      lines.forEach((line, index) => context.fillText(line, 0, (index - (lines.length - 1) / 2) * lineHeight, overlayWidth));
    }
    context.restore();
    boxes.push({ id: overlay.id, x: (x - overlayWidth / 2) / width, y: (y - overlayHeight / 2) / height, width: overlayWidth / width, height: overlayHeight / height, kind: 'overlay' });
  }
  drawFrameLayer(context, width, height, project.frame);
  const subtitles = project.subtitles;
  const block = subtitles?.enabled ? captionBlocks(subtitles).find((item) => time >= item.start && time <= item.end) : undefined;
  if (!subtitles || !block) return boxes;
  const style = subtitles.style;
  const shortSide = Math.min(width, height);
  const fontSize = style.size_frac * shortSide;
  context.save();
  context.font = `${style.bold ? 700 : 400} ${fontSize}px "${style.font}"`;
  context.textBaseline = 'alphabetic';
  context.lineJoin = 'round';
  const space = context.measureText(' ').width;
  const labels = block.words.map((word) => style.uppercase ? word.text.toUpperCase() : word.text);
  const widths = labels.map((label) => context.measureText(label).width);
  const rows: number[][] = [[]];
  let rowWidth = 0;
  const maximum = width * style.width_frac;
  widths.forEach((wordWidth, index) => {
    if (rowWidth && rowWidth + space + wordWidth > maximum && rows.length < subtitles.maxLines) { rows.push([]); rowWidth = 0; }
    rows[rows.length - 1].push(index);
    rowWidth += wordWidth + (rowWidth ? space : 0);
  });
  const lineHeight = fontSize * 1.18;
  const blockHeight = rows.length * lineHeight;
  const centerX = (style.x ?? 0.5) * width;
  const baseY = style.position === 'top' ? style.margin_frac * height : style.position === 'center' ? (height - blockHeight) / 2 : height - style.margin_frac * height - blockHeight;
  const top = style.y === undefined ? baseY : style.y * height - blockHeight / 2;
  const maxWidth = Math.max(...rows.map((row) => row.reduce((sum, index) => sum + widths[index], 0) + Math.max(0, row.length - 1) * space));
  const alpha = style.anim === 'fade' ? Math.min(1, Math.max(0, (time - block.start) / 0.15)) : 1;
  context.globalAlpha = alpha;
  const active = block.words.findIndex((word) => word.start <= time && time < word.end);
  rows.forEach((row, rowIndex) => {
    const rowWidth = row.reduce((sum, index) => sum + widths[index], 0) + Math.max(0, row.length - 1) * space;
    let x = centerX - rowWidth / 2;
    const baseline = top + rowIndex * lineHeight + fontSize;
    if (style.box) {
      context.fillStyle = rgbaHex(style.box_color, style.box_opacity);
      context.fillRect(x - fontSize * 0.28, baseline - fontSize * 1.07, rowWidth + fontSize * 0.56, lineHeight);
    }
    row.forEach((index) => {
      context.shadowColor = '#000000';
      context.shadowBlur = style.shadow * shortSide;
      context.shadowOffsetY = style.shadow * shortSide;
      context.strokeStyle = style.outline_color;
      context.lineWidth = style.outline * shortSide * 2;
      if (style.outline > 0) context.strokeText(labels[index], x, baseline);
      context.fillStyle = index === active ? style.active_color : style.color;
      context.fillText(labels[index], x, baseline);
      x += widths[index] + space;
    });
  });
  context.restore();
  boxes.push({ id: 'subtitles', x: (centerX - maxWidth / 2) / width, y: top / height, width: maxWidth / width, height: blockHeight / height, kind: 'subtitle' });
  return boxes;
}

// Frame artwork adapted from DuckyPlay. The same drawing produces preview and export PNGs.
export function drawArtisticFrame(ctx: CanvasRenderingContext2D, W: number, H: number, f: ProjectFrame | null | undefined) {
  const style = f?.style;
  if (!f || !style || style === 'none') return;
  const t = Math.max(1, (f.thickness != null ? f.thickness : 0.02) * W);
  const c = f.color || '#FFFFFF';
  const c2 = f.accent || '#111111';
  const op = f.opacity == null ? 1 : Math.max(0, Math.min(1, f.opacity));
  ctx.save();
  ctx.globalAlpha = op;
  const rect = (o: number, lw: number, st: string | CanvasGradient) => { ctx.strokeStyle = st; ctx.lineWidth = lw; ctx.strokeRect(o + lw / 2, o + lw / 2, W - 2 * o - lw, H - 2 * o - lw); };
  switch (style) {
    case 'solid': rect(0, t, c); break;
    case 'double': { const lw = Math.max(1, t * 0.28); rect(t * 0.5, lw, c); rect(t * 1.9, lw, c); break; }
    case 'inset': { const m = t * 2.2; ctx.fillStyle = c; ctx.fillRect(0, 0, W, H); ctx.clearRect(m, m, W - 2 * m, H - 2 * m); ctx.globalAlpha = op; rect(m - Math.max(1, t * 0.15), Math.max(1, t * 0.15), c2); break; }
    case 'corners': { const L = W * 0.12, p = t; ctx.strokeStyle = c; ctx.lineWidth = t; ctx.lineCap = 'round';
      const k = (x: number, y: number, dx: number, dy: number) => { ctx.beginPath(); ctx.moveTo(x, y + dy * L); ctx.lineTo(x, y); ctx.lineTo(x + dx * L, y); ctx.stroke(); };
      k(p, p, 1, 1); k(W - p, p, -1, 1); k(p, H - p, 1, -1); k(W - p, H - p, -1, -1); break; }
    case 'rounded': { const r = W * 0.09, p = t; ctx.strokeStyle = c; ctx.lineWidth = t; ctx.lineCap = 'round';
      const a = (x: number, y: number, a0: number, a1: number) => { ctx.beginPath(); ctx.arc(x, y, r, a0, a1); ctx.stroke(); };
      a(p + r, p + r, Math.PI, 1.5 * Math.PI); a(W - p - r, p + r, 1.5 * Math.PI, 2 * Math.PI); a(W - p - r, H - p - r, 0, 0.5 * Math.PI); a(p + r, H - p - r, 0.5 * Math.PI, Math.PI); break; }
    case 'vignette': { const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.34, W / 2, H / 2, Math.hypot(W, H) * 0.52);
      g.addColorStop(0, rgbaHex(c, 0)); g.addColorStop(0.68, rgbaHex(c, 0)); g.addColorStop(1, rgbaHex(c, op));
      ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); break; }
    case 'edgeFade': { ctx.globalAlpha = 1; const d = W * 0.16;
      const gr = (x0: number, y0: number, x1: number, y1: number) => { const g = ctx.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, rgbaHex(c, op)); g.addColorStop(1, rgbaHex(c, 0)); return g; };
      ctx.fillStyle = gr(0, 0, d, 0); ctx.fillRect(0, 0, d, H); ctx.fillStyle = gr(W, 0, W - d, 0); ctx.fillRect(W - d, 0, d, H);
      ctx.fillStyle = gr(0, 0, 0, d); ctx.fillRect(0, 0, W, d); ctx.fillStyle = gr(0, H, 0, H - d); ctx.fillRect(0, H - d, W, d); break; }
    case 'cinema': { const bh = H * Math.max(0.04, (f.thickness != null ? f.thickness : 0.028) * 3.2); ctx.fillStyle = c; ctx.fillRect(0, 0, W, bh); ctx.fillRect(0, H - bh, W, bh); break; }
    case 'bottomBar': { const bh = H * 0.12; const g = ctx.createLinearGradient(0, H - bh, 0, H); g.addColorStop(0, rgbaHex(c, 0)); g.addColorStop(1, rgbaHex(c, op)); ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(0, H - bh, W, bh); break; }
    case 'neon': { ctx.strokeStyle = c; ctx.lineWidth = t; ctx.shadowColor = c; ctx.shadowBlur = t * 2.6; const o = t * 1.5;
      ctx.strokeRect(o, o, W - 2 * o, H - 2 * o); ctx.strokeRect(o, o, W - 2 * o, H - 2 * o); ctx.shadowBlur = 0; break; }
    case 'gradient': { const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, c); g.addColorStop(1, c2); rect(0, t, g); break; }
    case 'sideBars': { const bw = t * 1.8; ctx.fillStyle = c; ctx.fillRect(0, 0, bw, H); ctx.fillRect(W - bw, 0, bw, H);
      const iw = Math.max(1, bw * 0.22); ctx.fillStyle = c2; ctx.fillRect(bw, 0, iw, H); ctx.fillRect(W - bw - iw, 0, iw, H); break; }
    case 'stripe': { const sw = t * 2.2; ctx.fillStyle = c; ctx.fillRect(0, 0, sw, H); const iw = Math.max(1, sw * 0.28); ctx.fillStyle = c2; ctx.fillRect(sw, 0, iw, H); break; }
    case 'film': { const bw = W * 0.058; ctx.fillStyle = c; ctx.fillRect(0, 0, bw, H); ctx.fillRect(W - bw, 0, bw, H);
      const hw = bw * 0.5, hh = H * 0.026, gap = H * 0.058; ctx.fillStyle = '#F2F2F2';
      for (let y = gap * 0.5; y < H - hh; y += gap) { roundRectPath(ctx, (bw - hw) / 2, y, hw, hh, hh * 0.35); ctx.fill(); roundRectPath(ctx, W - bw + (bw - hw) / 2, y, hw, hh, hh * 0.35); ctx.fill(); } break; }
    case 'polaroid': { const m = W * 0.045, bottom = H * 0.13; ctx.fillStyle = c; ctx.fillRect(0, 0, W, H); ctx.clearRect(m, m, W - 2 * m, H - m - bottom); break; }
    case 'dashed': { ctx.setLineDash([t * 1.8, t * 1.1]); rect(0, t, c); ctx.setLineDash([]); break; }
    case 'dotted': { ctx.lineCap = 'round'; ctx.setLineDash([1, t * 1.7]); rect(0, t, c); ctx.setLineDash([]); break; }
    case 'tape': { const tw = W * 0.17, th = W * 0.05; ctx.globalAlpha = op; ctx.fillStyle = c;
      const pc = (x: number, y: number, ang: number) => { ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.fillRect(-tw / 2, -th / 2, tw, th); ctx.restore(); };
      pc(W * 0.14, H * 0.04, -0.35); pc(W * 0.86, H * 0.04, 0.35); pc(W * 0.14, H * 0.96, 0.35); pc(W * 0.86, H * 0.96, -0.35); break; }
    case 'ornate': { const lw = Math.max(1, t * 0.4); rect(t * 0.6, lw, c); rect(t * 2.2, lw, c2);
      ctx.fillStyle = c; const d = t * 1.4; const q = t * 1.4;
      const dia = (x: number, y: number) => { ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4); ctx.fillRect(-d / 2, -d / 2, d, d); ctx.restore(); };
      dia(q, q); dia(W - q, q); dia(q, H - q); dia(W - q, H - q); break; }
    case 'glow': { const d = W * 0.22; ctx.globalAlpha = 1;
      const gr = (x0: number, y0: number, x1: number, y1: number) => { const g = ctx.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, rgbaHex(c, op * 0.9)); g.addColorStop(1, rgbaHex(c, 0)); return g; };
      ctx.fillStyle = gr(0, 0, d, 0); ctx.fillRect(0, 0, d, H); ctx.fillStyle = gr(W, 0, W - d, 0); ctx.fillRect(W - d, 0, d, H);
      ctx.fillStyle = gr(0, 0, 0, d); ctx.fillRect(0, 0, W, d); ctx.fillStyle = gr(0, H, 0, H - d); ctx.fillRect(0, H - d, W, d); break; }
  }
  ctx.restore();
}

const VM_HAND_D = 'M128 40c0-22.1 17.9-40 40-40s40 17.9 40 40l0 148.2c8.5-7.6 19.7-12.2 32-12.2c20.6 0 38.2 13 45 31.2c8.8-9.3 21.2-15.2 35-15.2c25.3 0 46 19.5 47.9 44.3c8.5-7.7 19.8-12.3 32.1-12.3c26.5 0 48 21.5 48 48l0 48 0 16 0 48c0 70.7-57.3 128-128 128l-16 0-64 0-.1 0-5.2 0c-5 0-9.9-.3-14.7-1c-55.3-5.6-106.2-34-140-79L8 336c-13.3-17.7-9.7-42.7 8-56s42.7-9.7 56 8l56 74.7L128 40zM240 304c0-8.8-7.2-16-16-16s-16 7.2-16 16l0 96c0 8.8 7.2 16 16 16s16-7.2 16-16l0-96zm48-16c-8.8 0-16 7.2-16 16l0 96c0 8.8 7.2 16 16 16s16-7.2 16-16l0-96c0-8.8-7.2-16-16-16zm80 16c0-8.8-7.2-16-16-16s-16 7.2-16 16l0 96c0 8.8 7.2 16 16 16s16-7.2 16-16l0-96z';
const VM_BELL_D = 'M224 0c-17.7 0-32 14.3-32 32l0 19.2C119 66 64 130.6 64 208l0 18.8c0 47-17.3 92.4-48.5 127.6l-7.4 8.3c-8.4 9.4-10.4 22.9-5.3 34.4S19.4 416 32 416l384 0c12.6 0 24-7.4 29.2-18.9s3.1-25-5.3-34.4l-7.4-8.3C401.3 319.2 384 273.9 384 226.8l0-18.8c0-77.4-55-142-128-156.8L256 32c0-17.7-14.3-32-32-32zm45.3 493.3c12-12 18.7-28.3 18.7-45.3l-64 0-64 0c0 17 6.7 33.3 18.7 45.3s28.3 18.7 45.3 18.7s33.3-6.7 45.3-18.7z';
let VM_HAND_BODY: Path2D; let VM_BELL_PATH: Path2D;
  function paintSubscribeNative(ctx: CanvasRenderingContext2D, r: { ch: number }, ov: { size: number; text?: string; opacity?: number; color?: string; box_color?: string }, cx: number, cy: number, p: number) {
    const s = vmSubscribeState(p);
    const amul = Math.max(0, Math.min(1, s.a * (ov.opacity != null ? ov.opacity : 0.9)));
    if (amul <= 0.004 || s.scale <= 0.02) return;
    const fs = Math.max(8, (ov.size || 0.07) * r.ch * 0.62);
    const text = ov.text || 'ISCRIVITI';
    ctx.save();
    ctx.font = `700 ${fs}px "Segoe UI", Arial, sans-serif`;
    const tw = ctx.measureText(text).width;
    const BH = fs * 1.7, bellH = fs * 1.34, bellW = bellH * 448 / 512, padX = fs * 0.66, gap = fs * 0.42;
    const BW = padX * 2 + bellW + gap + tw;
    ctx.globalAlpha = amul;
    ctx.translate(cx, cy); ctx.scale(s.scale, s.scale); ctx.translate(-cx, -cy);
    const x0 = cx - BW / 2, y0 = cy - BH / 2, pdy = s.press * fs * 0.12;
    if (s.ripple >= 0) {
      ctx.save(); ctx.globalAlpha = amul * (1 - s.ripple) * 0.6;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, fs * 0.10);
      ctx.beginPath(); ctx.arc(cx, cy + pdy, BH * (0.55 + 0.95 * s.ripple), 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    ctx.save();                                            // bottone con ombra morbida
    const shb = Math.max(5, BH * 0.16);
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = shb; ctx.shadowOffsetX = shb * 0.2; ctx.shadowOffsetY = shb * 0.32;
    ctx.fillStyle = s.press > 0 ? darken(ov.box_color || '#E11D2A', 0.13 * s.press) : (ov.box_color || '#E11D2A');
    roundRectPath(ctx, x0, y0 + pdy, BW, BH, BH * 0.32); ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.11)';              // riflesso in alto
    roundRectPath(ctx, x0, y0 + pdy, BW, BH * 0.5, BH * 0.30); ctx.fill();
    ctx.fillStyle = ov.color || '#FFFFFF';                 // testo
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x0 + padX + bellW + gap, cy + pdy + fs * 0.02);

    // campanella bianca (YouTube) che oscilla + onde quando squilla
    const bx = x0 + padX + bellW / 2;
    paintIcon(ctx, VM_BELL_PATH, 448, 512, bx, cy + pdy, bellH / 512, '#fff', s.swing * 0.28);
    if (s.wave > 0.01) {
      ctx.save(); ctx.strokeStyle = `rgba(255,255,255,${0.8 * s.wave})`; ctx.lineWidth = Math.max(2, fs * 0.06);
      for (let k = 1; k <= 2; k++) {
        const r2 = bellW * (0.7 + 0.40 * k);
        ctx.beginPath(); ctx.arc(bx, cy + pdy, r2, Math.PI * 1.14, Math.PI * 1.42); ctx.stroke();
        ctx.beginPath(); ctx.arc(bx, cy + pdy, r2, -Math.PI * 0.42, -Math.PI * 0.14); ctx.stroke();
      }
      ctx.restore();
    }

    // mano bianca (silhouette piena, bordo nero) che clicca → entra dal basso e SPARISCE
    const handH = BH * 1.2, hsc = handH / 512;
    const tcx = cx + BW * 0.02, tcy = (y0 + BH + pdy) - fs * 0.05;
    const scx = cx + BW * 0.12, scy = (y0 + BH + pdy) + handH * 0.80;
    const fxp = scx + (tcx - scx) * s.hand;
    const fyp = scy + (tcy - scy) * s.hand - s.press * fs * 0.18;
    if (s.handA > 0.01) {
      ctx.save(); ctx.globalAlpha = amul * s.handA;
      paintIcon(ctx, VM_HAND_BODY, 448, 512, fxp, fyp, hsc, '#fff', 0, 168, 0, Math.max(2, handH * 0.05), '#000');
      ctx.restore();
    }
    if (s.burst > 0.01) {                                  // trattini del clic sopra il dito
      ctx.save(); ctx.globalAlpha = amul * s.burst;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, fs * 0.08); ctx.lineCap = 'round';
      const bcx = tcx, bcy = tcy - fs * 0.18;
      const r0 = fs * (0.10 + 0.10 * s.burst), r1 = r0 + fs * (0.20 + 0.16 * s.burst);
      for (const [dx, dy] of [[0, -1], [-0.6, -0.82], [0.6, -0.82], [-0.96, -0.32], [0.96, -0.32]]) {
        ctx.beginPath(); ctx.moveTo(bcx + dx * r0, bcy + dy * r0); ctx.lineTo(bcx + dx * r1, bcy + dy * r1); ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }
