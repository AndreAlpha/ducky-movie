import type { ProjectSubtitles } from '../shared/types';
import { createProject, groupSubtitleWords, validateProject } from '../src/model';

export function validateTranscript(input: unknown): ProjectSubtitles {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('La trascrizione non è valida.');
  const subtitles = input as Record<string, unknown>;
  const owners = new Map<string, { kind: 'clip' | 'audio'; id: string }>();
  const words = Array.isArray(subtitles.words) ? subtitles.words.map((value, index) => {
    if (!value || typeof value !== 'object') return value;
    const original = value as Record<string, unknown>;
    const id = `transcript-word-${index}`;
    const source = original.source as { kind?: unknown; id?: unknown } | undefined;
    if (source && (source.kind === 'clip' || source.kind === 'audio') && typeof source.id === 'string') owners.set(id, { kind: source.kind, id: source.id });
    return { ...original, id, source: undefined, linkedId: undefined };
  }) : subtitles.words;
  const validated = validateProject({ ...createProject(), subtitles: { ...subtitles, words, linkedWords: undefined } }).subtitles!;
  const grouped = groupSubtitleWords(validated.words.map(word => {
    const source = word.id ? owners.get(word.id) : undefined;
    return source ? { ...word, source: { ...source, start: word.start, end: word.end } } : word;
  }), validated.maxWords, validated.maxLines);
  return { ...validated, words: grouped.flatMap((event, index) => event.words.map(word => ({ ...word, source: undefined, linkedId: undefined, segmentId: `transcript-phrase-${index}` }))) };
}

function srtTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total / 60000) % 60;
  const wholeSeconds = Math.floor(total / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(total % 1000).padStart(3, '0')}`;
}

export function formatTranscript(subtitles: ProjectSubtitles, format: 'srt' | 'txt'): string {
  const transcript = groupSubtitleWords(subtitles.words, subtitles.maxWords, subtitles.maxLines);
  if (format === 'txt') return transcript.map(block => block.words.map(word => word.text.trim()).join(' ')).join('\r\n') + (transcript.length ? '\r\n' : '');
  return transcript.map((block, index) => `${index + 1}\r\n${srtTime(block.start)} --> ${srtTime(block.end)}\r\n${block.words.map(word => word.text.trim()).join(' ')}\r\n`).join('\r\n');
}
