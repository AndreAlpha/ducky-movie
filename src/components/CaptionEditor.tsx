import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AudioLines, ChevronLeft, ChevronRight, FileText, Link2, MoreHorizontal, Plus, Search, Settings2, Trash2, Unlink } from 'lucide-react';
import type { Project, SubtitleWord } from '../../shared/types';
import {
  addSubtitleEvent,
  getSubtitleEvents,
  mergeSubtitleEvents,
  rebindSubtitleEvent,
  removeSubtitleEvent,
  replaceSubtitleWords,
  setSubtitleEventText,
  setSubtitleEventTiming,
  splitSubtitleEvent,
  timelinePositions,
  updateSubtitleWord,
} from '../model';
import '../captions.css';

export interface CaptionEditorProps {
  project: Project;
  onChange: (project: Project) => void;
  onSeek: (time: number) => void;
  time: number;
  selectedIndex?: number;
  onSelect?: (index: number) => void;
  onTranscribe: () => void;
  onExport?: (format: 'txt' | 'srt') => void | Promise<void>;
  onStyle?: () => void;
  onError?: (message: string) => void;
}

type CaptionEvent = ReturnType<typeof getSubtitleEvents>[number];

function positionMenu(event: React.SyntheticEvent<HTMLDetailsElement>) {
  const menu = event.currentTarget;
  if (!menu.open) return;
  const panel = menu.querySelector<HTMLElement>('.caption-menu-items');
  const viewport = menu.closest('.caption-list');
  if (!panel || !viewport) return;
  panel.style.top = '';
  panel.style.bottom = '';
  const bounds = panel.getBoundingClientRect();
  const area = viewport.getBoundingClientRect();
  if (bounds.bottom > area.bottom && menu.getBoundingClientRect().top - bounds.height > area.top) {
    panel.style.top = 'auto';
    panel.style.bottom = 'calc(100% + 4px)';
  }
}

function menuKeyboard(event: React.KeyboardEvent<HTMLDetailsElement>) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.open = false;
    event.currentTarget.querySelector('summary')?.focus();
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !event.currentTarget.open) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  if (!buttons.length) return;
  event.stopPropagation();
  event.preventDefault();
  const index = buttons.findIndex(button => button === document.activeElement);
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  let next = direction > 0 ? 0 : buttons.length - 1;
  if (index >= 0) next = (index + direction + buttons.length) % buttons.length;
  buttons[next].focus();
}

function timestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(total / 60000);
  const wholeSeconds = Math.floor(total / 1000) % 60;
  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(total % 1000).padStart(3, '0')}`;
}

function TextDraft({ value, label, multiline = false, onCommit, onFocus, onCaret }: {
  value: string;
  label: string;
  multiline?: boolean;
  onCommit: (value: string) => void;
  onFocus?: () => void;
  onCaret?: (position: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);
  const draftRef = useRef(value);
  const submittedRef = useRef<string | null>(null);
  const previousValueRef = useRef(value);
  const valueRef = useRef(value);
  const commitRef = useRef(onCommit);
  const dirtyRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const hintId = useId();
  valueRef.current = value;
  commitRef.current = onCommit;

  function publishDirty(dirty: boolean, repeat = false) {
    if (dirtyRef.current === dirty && !(dirty && repeat)) return;
    dirtyRef.current = dirty;
    document.dispatchEvent(new CustomEvent('ducky:draft-state', { detail: { id: hintId, dirty } }));
  }

  function commit() {
    if (draftRef.current !== valueRef.current && draftRef.current !== submittedRef.current) {
      submittedRef.current = draftRef.current;
      commitRef.current(draftRef.current);
    }
    publishDirty(false);
  }

  useEffect(() => {
    const flush = () => commit();
    document.addEventListener('ducky:commit-drafts', flush);
    return () => {
      document.removeEventListener('ducky:commit-drafts', flush);
      publishDirty(false);
    };
  }, []);

  useEffect(() => {
    const pending = draftRef.current !== previousValueRef.current && draftRef.current !== submittedRef.current;
    previousValueRef.current = value;
    if (!focusedRef.current || !pending) {
      draftRef.current = value;
      setDraft(value);
      publishDirty(false);
    }
  }, [value]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(190, Math.max(58, textarea.scrollHeight))}px`;
  }, [draft]);

  const editing = {
    value: draft,
    'aria-label': label,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      submittedRef.current = null;
      draftRef.current = event.target.value;
      setDraft(event.target.value);
      publishDirty(event.target.value !== valueRef.current, true);
    },
    onFocus: () => {
      focusedRef.current = true;
      setFocused(true);
      onFocus?.();
    },
    onBlur: () => {
      focusedRef.current = false;
      setFocused(false);
      commit();
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if ((event.ctrlKey || event.metaKey) && ['s', 'o', 'i'].includes(event.key.toLowerCase())) {
        commit();
        return;
      }
      event.stopPropagation();
      if (event.key === 'Escape') {
        draftRef.current = value;
        setDraft(value);
        publishDirty(false);
        event.currentTarget.blur();
      }
      if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.currentTarget.blur();
      }
    },
  };

  if (!multiline) return <input {...editing} className="caption-word-text" />;
  return <>
    <textarea {...editing} ref={textareaRef} rows={2} className="caption-text" spellCheck
      aria-describedby={focused ? hintId : undefined}
      onSelect={event => onCaret?.(event.currentTarget.selectionStart)} />
    <span className={`caption-edit-hint${focused ? ' is-visible' : ''}`} id={hintId} aria-hidden={!focused}>Ctrl+Invio conferma · Esc annulla</span>
  </>;
}

function TimeDraft({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(value.toFixed(3));
  const editing = useRef(false);
  const cancelled = useRef(false);
  const previousValueRef = useRef(value);
  const submittedRef = useRef<number | null>(null);
  const draftRef = useRef(value.toFixed(3));
  const valueRef = useRef(value);
  const commitRef = useRef(onCommit);
  const dirtyRef = useRef(false);
  const draftId = useId();
  valueRef.current = value;
  commitRef.current = onCommit;

  function publishDirty(dirty: boolean, repeat = false) {
    if (dirtyRef.current === dirty && !(dirty && repeat)) return;
    dirtyRef.current = dirty;
    document.dispatchEvent(new CustomEvent('ducky:draft-state', { detail: { id: draftId, dirty } }));
  }

  useEffect(() => {
    const flush = () => commit();
    document.addEventListener('ducky:commit-drafts', flush);
    return () => {
      document.removeEventListener('ducky:commit-drafts', flush);
      publishDirty(false);
    };
  }, []);

  useEffect(() => {
    const numeric = Number(draftRef.current.replace(',', '.'));
    const pending = editing.current && (!Number.isFinite(numeric) || Math.abs(numeric - previousValueRef.current) > .0001 && numeric !== submittedRef.current);
    previousValueRef.current = value;
    if (!pending) {
      draftRef.current = value.toFixed(3);
      setDraft(value.toFixed(3));
      publishDirty(false);
    }
  }, [value]);
  function commit() {
    if (cancelled.current) { cancelled.current = false; return; }
    const next = Number(draftRef.current.replace(',', '.'));
    if (Number.isFinite(next) && next >= 0 && Math.abs(next - valueRef.current) > .0001 && next !== submittedRef.current) {
      draftRef.current = next.toFixed(3);
      setDraft(draftRef.current);
      submittedRef.current = next;
      commitRef.current(next);
    } else if (!Number.isFinite(next) || next < 0) {
      draftRef.current = valueRef.current.toFixed(3);
      setDraft(draftRef.current);
    }
    publishDirty(false);
  }
  return <label className="caption-time-field"><span>{label.startsWith('Inizio') ? 'Inizio (s)' : 'Fine (s)'}</span><input type="text" inputMode="decimal"
    aria-label={label} value={draft} onFocus={() => { editing.current = true; }}
    onChange={event => {
      submittedRef.current = null;
      draftRef.current = event.target.value;
      setDraft(event.target.value);
      const numeric = Number(event.target.value.replace(',', '.'));
      publishDirty(!Number.isFinite(numeric) || Math.abs(numeric - valueRef.current) > .0001, true);
    }} onBlur={() => { editing.current = false; commit(); }}
    onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && ['s', 'o', 'i'].includes(event.key.toLowerCase())) {
        commit();
        return;
      }
      event.stopPropagation();
      if (event.key === 'Enter') event.currentTarget.blur();
      if (event.key === 'Escape') {
        cancelled.current = true;
        editing.current = false;
        draftRef.current = value.toFixed(3);
        setDraft(value.toFixed(3));
        publishDirty(false);
        event.currentTarget.blur();
      }
    }} /></label>;
}

function MenuButton({ children, onClick, disabled = false }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" disabled={disabled} onClick={event => {
    const menu = event.currentTarget.closest('details');
    if (menu) menu.open = false;
    onClick();
  }}>{children}</button>;
}

const CaptionRow = memo(function CaptionRow({ event, index, selected, active, project, onSelect, onSeek, onText, onTiming, onSplit, onMerge, onRemove, onWord, onBind, canMerge, rowRef }: {
  event: CaptionEvent;
  index: number;
  selected: boolean;
  active: boolean;
  project: Project;
  onSelect: () => void;
  onSeek: () => void;
  onText: (text: string) => void;
  onTiming: (patch: { start: number; end: number }) => void;
  onSplit: (at?: number) => void;
  onMerge: () => void;
  onRemove: () => void;
  onWord: (id: string, patch: Partial<Pick<SubtitleWord, 'text' | 'start' | 'end'>>) => void;
  onBind: (source: { kind: 'clip' | 'audio'; id: string } | null) => void;
  canMerge: boolean;
  rowRef: (element: HTMLElement | null) => void;
}) {
  const caretRef = useRef<number | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [wordsOpen, setWordsOpen] = useState(false);
  const links = event.words.map(word => word.source).filter(source => !!source);
  const firstSource = links[0];
  const linked = links.length === event.words.length && !!firstSource && links.every(source => source.kind === firstSource.kind && source.id === firstSource.id);
  const mixed = links.length > 0 && !linked;
  const sourceValue = linked ? `${firstSource!.kind}:${firstSource!.id}` : mixed ? '__mixed' : '';
  const audioSources = project.audioTracks.map(track => ({ kind: 'audio' as const, id: track.id, name: project.assets.find(asset => asset.id === track.assetId)?.name || 'Audio', start: track.start }));
  const videoSources = timelinePositions(project).filter(({ clip }) => project.assets.find(asset => asset.id === clip.assetId)?.hasAudio)
    .map(({ clip, start }) => ({ kind: 'clip' as const, id: clip.id, name: project.assets.find(asset => asset.id === clip.assetId)?.name || 'Video', start }));

  function split() {
    const cursor = caretRef.current;
    const tokens = event.text.match(/\S+/g) ?? [];
    if (cursor !== null && tokens.length > 1) {
      const before = event.text.slice(0, cursor).match(/\S+/g)?.length ?? 0;
      if (before > 0 && before < event.words.length) {
        onSplit((event.words[before - 1].end + event.words[before].start) / 2);
        return;
      }
    }
    onSplit();
  }

  return <article ref={rowRef} className={`caption-row${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}`}
    aria-label={`Frase ${index + 1}`}>
    <div className="caption-row-top">
      <button className="caption-seek" type="button" onClick={() => { onSelect(); onSeek(); }}
        aria-label={`Vai alla frase ${index + 1}, ${timestamp(event.start)}`}>
        {active && <span className="caption-active-dot" aria-label="In anteprima" />}
        <time>{timestamp(event.start)}</time><span aria-hidden="true">→</span><time>{timestamp(event.end)}</time>
      </button>
      <details className="caption-menu" onToggle={positionMenu} onKeyDown={menuKeyboard}>
        <summary aria-label={`Azioni frase ${index + 1}`} title="Azioni frase"><MoreHorizontal size={16} /></summary>
        <div className="caption-menu-items">
          <MenuButton onClick={split} disabled={event.words.length < 2}>Dividi frase</MenuButton>
          <MenuButton onClick={onMerge} disabled={!canMerge}>Unisci alla seguente</MenuButton>
          <MenuButton onClick={onRemove}><Trash2 size={13} />Elimina frase</MenuButton>
        </div>
      </details>
    </div>
    <TextDraft value={event.text} label={`Testo frase ${index + 1}`} multiline onFocus={onSelect} onCommit={onText}
      onCaret={position => { caretRef.current = position; }} />
    <details className="caption-detail" onToggle={toggle => { if (toggle.target === toggle.currentTarget) setDetailOpen(toggle.currentTarget.open); }}>
      <summary>{links.length ? <Link2 size={12} /> : <Unlink size={12} />}{linked ? 'Collegata alla clip' : mixed ? 'Collegamenti misti' : 'Tempi e parole'}<span>Modifica</span></summary>
      {detailOpen && <div className="caption-detail-content">
        <div className="caption-time-pair">
          <TimeDraft label={`Inizio frase ${index + 1} (s)`} value={event.start} onCommit={start => onTiming({ start, end: event.end })} />
          <TimeDraft label={`Fine frase ${index + 1} (s)`} value={event.end} onCommit={end => onTiming({ start: event.start, end })} />
        </div>
        <label className="caption-source"><span>Sincronizzazione</span><select aria-label={`Sorgente frase ${index + 1}`} value={sourceValue}
          onChange={change => {
            const selected = [...audioSources, ...videoSources].find(source => `${source.kind}:${source.id}` === change.target.value);
            onBind(selected ? { kind: selected.kind, id: selected.id } : null);
          }}>
          <option value="">Tempi liberi</option>
          {mixed && <option value="__mixed" disabled>Collegamenti misti</option>}
          {[...audioSources, ...videoSources].map(source => <option key={`${source.kind}:${source.id}`} value={`${source.kind}:${source.id}`}>{source.name} · {source.start.toFixed(1)} s</option>)}
        </select></label>
        <details className="caption-words" onToggle={toggle => { if (toggle.target === toggle.currentTarget) setWordsOpen(toggle.currentTarget.open); }}><summary>Singole parole · {event.words.length}</summary>
          {wordsOpen && <div className="caption-word-list">{event.words.map((word, wordIndex) => <div className="caption-word" key={word.id ?? `${word.start}:${wordIndex}`}>
            <TextDraft value={word.text} label={`Parola ${wordIndex + 1} della frase ${index + 1}`} onCommit={text => { if (word.id) onWord(word.id, { text }); }} />
            <div className="caption-time-pair">
              <TimeDraft label={`Inizio parola ${wordIndex + 1} (s)`} value={word.start} onCommit={start => { if (word.id) onWord(word.id, { start }); }} />
              <TimeDraft label={`Fine parola ${wordIndex + 1} (s)`} value={word.end} onCommit={end => { if (word.id) onWord(word.id, { end }); }} />
            </div>
          </div>)}</div>}
        </details>
      </div>}
    </details>
  </article>;
}, (before, after) => before.event === after.event && before.index === after.index && before.selected === after.selected && before.active === after.active && before.project === after.project && before.canMerge === after.canMerge);

export default function CaptionEditor({ project, onChange, onSeek, time, selectedIndex, onSelect, onTranscribe, onExport, onStyle, onError }: CaptionEditorProps) {
  const events = useMemo(() => getSubtitleEvents(project), [project]);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const projectRef = useRef(project);
  const timeRef = useRef(time);
  const callbacksRef = useRef({ onChange, onSelect, onSeek, onError });
  const listRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(new Map<string, HTMLElement>());
  const userScrollRef = useRef(0);
  const focusNewRef = useRef<string | null>(null);
  const pendingScrollRef = useRef<string | null>(null);
  projectRef.current = project;
  timeRef.current = time;
  callbacksRef.current = { onChange, onSelect, onSeek, onError };
  const active = events.find(event => time >= event.start && time < event.end);
  const controlledSelected = selectedIndex !== undefined ? events[selectedIndex]?.id : undefined;
  const chosen = controlledSelected ?? selectedId;
  const filtered = useMemo(() => events.map((event, index) => ({ event, index })).filter(({ event }) => event.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [events, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50));
  const shownPage = Math.min(page, pageCount - 1);

  useEffect(() => {
    const target = focusNewRef.current;
    if (!target || !rowsRef.current.has(target)) return;
    focusNewRef.current = null;
    const textarea = rowsRef.current.get(target)?.querySelector('textarea');
    textarea?.focus();
    textarea?.select();
  }, [events, shownPage]);

  useLayoutEffect(() => {
    const id = pendingScrollRef.current;
    if (!id || !rowsRef.current.has(id)) return;
    pendingScrollRef.current = null;
    rowsRef.current.get(id)?.scrollIntoView({ block: 'nearest' });
  }, [shownPage, events]);

  useEffect(() => {
    if (!active || editorRef.current?.contains(document.activeElement) || Date.now() - userScrollRef.current < 3000) return;
    const index = filtered.findIndex(({ event }) => event.id === active.id);
    if (index < 0) return;
    if (Math.floor(index / 50) !== shownPage) {
      pendingScrollRef.current = active.id;
      setPage(Math.floor(index / 50));
    } else rowsRef.current.get(active.id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active?.id]);

  useEffect(() => {
    if (!controlledSelected || editorRef.current?.contains(document.activeElement)) return;
    let index = filtered.findIndex(({ event }) => event.id === controlledSelected);
    if (index < 0) { setQuery(''); index = events.findIndex(event => event.id === controlledSelected); }
    if (index >= 0 && Math.floor(index / 50) !== shownPage) {
      pendingScrollRef.current = controlledSelected;
      setPage(Math.floor(index / 50));
    } else rowsRef.current.get(controlledSelected)?.scrollIntoView({ block: 'nearest' });
  }, [controlledSelected]);

  function apply(operation: (current: Project) => Project): Project | null {
    try {
      const next = operation(projectRef.current);
      projectRef.current = next;
      setError('');
      setNotice('');
      callbacksRef.current.onChange(next);
      return next;
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(message);
      callbacksRef.current.onError?.(message);
      return null;
    }
  }

  function eventOperation(id: string, operation: (current: Project, index: number) => Project): Project | null {
    return apply(current => {
      const index = getSubtitleEvents(current).findIndex(event => event.id === id);
      return index < 0 ? current : operation(current, index);
    });
  }

  function select(id: string) {
    const index = getSubtitleEvents(projectRef.current).findIndex(event => event.id === id);
    if (index < 0) return;
    setSelectedId(id);
    callbacksRef.current.onSelect?.(index);
  }

  function add() {
    const previous = new Set(getSubtitleEvents(projectRef.current).map(event => event.id));
    const next = apply(current => addSubtitleEvent(current, time));
    if (!next) return;
    const created = getSubtitleEvents(next).find(event => !previous.has(event.id));
    if (created) {
      setQuery('');
      focusNewRef.current = created.id;
      setPage(Math.floor(getSubtitleEvents(next).findIndex(event => event.id === created.id) / 50));
      select(created.id);
      callbacksRef.current.onSeek(created.start);
    }
  }

  function remove(id: string, index: number) {
    const next = eventOperation(id, removeSubtitleEvent);
    if (!next) return;
    const remaining = getSubtitleEvents(next);
    const selected = remaining[Math.min(index, remaining.length - 1)];
    setSelectedId(selected?.id ?? null);
    if (selected) callbacksRef.current.onSelect?.(Math.min(index, remaining.length - 1));
  }

  function replace() {
    const before = getSubtitleEvents(projectRef.current).map(event => event.text).join('\n');
    const next = apply(current => replaceSubtitleWords(current, query, replacement));
    if (!next) return;
    const after = getSubtitleEvents(next).map(event => event.text).join('\n');
    setNotice(before === after ? 'Nessuna parola corrispondente.' : 'Sostituzione completata.');
  }

  async function exportFile(format: 'txt' | 'srt') {
    try { await onExport?.(format); }
    catch (failure) { const message = failure instanceof Error ? failure.message : String(failure); setError(message); onError?.(message); }
  }

  return <div className="caption-editor" ref={editorRef}>
    <div className="caption-editor-tools">
      <button className="primary-button" type="button" onClick={onTranscribe}><AudioLines size={15} />Trascrivi audio</button>
      {onStyle && <button type="button" className="caption-icon" aria-label="Apri stile sottotitoli" title="Stile sottotitoli" onClick={onStyle}><Settings2 size={17} /></button>}
      <details className="caption-menu caption-export-menu" onKeyDown={menuKeyboard}><summary aria-label="Esporta sottotitoli" title="Esporta sottotitoli"><MoreHorizontal size={17} /></summary><div className="caption-menu-items">
        <MenuButton disabled={!events.length || !onExport} onClick={() => void exportFile('txt')}><FileText size={14} />Salva testo TXT</MenuButton>
        <MenuButton disabled={!events.length || !onExport} onClick={() => void exportFile('srt')}>Esporta sottotitoli SRT</MenuButton>
      </div></details>
    </div>
    {events.length > 0 && <div className="caption-search-area">
      <div className="caption-search"><Search size={14} /><input type="search" aria-label="Cerca nei sottotitoli" placeholder="Cerca nel testo" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></div>
      <button className={`caption-replace-toggle${showReplace ? ' is-open' : ''}`} type="button" aria-expanded={showReplace} onClick={() => setShowReplace(!showReplace)}>Sostituisci</button>
      {showReplace && <div className="caption-replace"><input aria-label="Testo sostitutivo" placeholder="Sostituisci con…" value={replacement} onChange={event => setReplacement(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && query.trim()) { event.preventDefault(); replace(); } }} /><button className="secondary-button" type="button" disabled={!query.trim()} onClick={replace}>Sostituisci tutte</button></div>}
    </div>}
    <div className="caption-list-meta"><span>{events.length === 1 ? '1 frase' : `${events.length} frasi`}</span>{query && <span>{filtered.length} trovate</span>}</div>
    <div ref={listRef} className="caption-list" onWheel={() => { userScrollRef.current = Date.now(); }} onPointerDown={() => { userScrollRef.current = Date.now(); }}>
      {!events.length && <div className="caption-empty"><FileText size={25} /><p>La tua trascrizione apparirà qui.</p><span>Trascrivi il parlato oppure scrivi la prima frase.</span></div>}
      {!!events.length && !filtered.length && <p className="caption-no-results">Nessuna frase corrisponde alla ricerca.</p>}
      {filtered.slice(shownPage * 50, shownPage * 50 + 50).map(({ event, index }) => <CaptionRow key={event.id} event={event} index={index} project={project}
        selected={chosen === event.id} active={active?.id === event.id} canMerge={index + 1 < events.length}
        rowRef={element => { if (element) rowsRef.current.set(event.id, element); else rowsRef.current.delete(event.id); }}
        onSelect={() => select(event.id)} onSeek={() => callbacksRef.current.onSeek(event.start)}
        onText={text => { eventOperation(event.id, (current, index) => setSubtitleEventText(current, index, text)); }}
        onTiming={patch => { eventOperation(event.id, (current, index) => setSubtitleEventTiming(current, index, patch)); }}
        onSplit={at => { eventOperation(event.id, (current, index) => splitSubtitleEvent(current, index, at ?? (timeRef.current > event.start && timeRef.current < event.end ? timeRef.current : undefined))); }}
        onMerge={() => { eventOperation(event.id, mergeSubtitleEvents); }}
        onRemove={() => remove(event.id, index)}
        onWord={(id, patch) => { apply(current => updateSubtitleWord(current, id, patch)); }}
        onBind={source => { eventOperation(event.id, (current, index) => rebindSubtitleEvent(current, index, source)); }} />)}
    </div>
    {pageCount > 1 && <nav className="caption-pagination" aria-label="Pagine delle frasi"><button type="button" aria-label="Frasi precedenti" disabled={shownPage === 0} onClick={() => { userScrollRef.current = Date.now(); setPage(shownPage - 1); listRef.current?.scrollTo({ top: 0 }); }}><ChevronLeft size={14} /></button><span>{shownPage + 1} / {pageCount}</span><button type="button" aria-label="Frasi successive" disabled={shownPage + 1 >= pageCount} onClick={() => { userScrollRef.current = Date.now(); setPage(shownPage + 1); listRef.current?.scrollTo({ top: 0 }); }}><ChevronRight size={14} /></button></nav>}
    {error && <p className="caption-feedback is-error" role="alert">{error}</p>}
    {notice && <p className="caption-feedback" role="status">{notice}</p>}
    <button className="caption-add" type="button" onClick={add}><Plus size={15} />Aggiungi frase qui</button>
  </div>;
}
