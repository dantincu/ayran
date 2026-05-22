import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
const DiffViewerModal = lazy(() => import('./DiffViewerModal'));
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { readFile } from '@tauri-apps/plugin-fs';
import type { StoredAccount, CachedItem } from '../../types';
import config from '../../config.json';
import CodeEditor from './CodeEditor';
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import {
  cursorCharLeft, cursorCharRight, cursorLineUp, cursorLineDown,
  cursorLineStart, cursorLineEnd,
  undo as cmUndo, redo as cmRedo,
} from '@codemirror/commands';
import { useTheme } from '../../hooks/useTheme';

interface DownloadProgress { loaded: number; total: number | null; }

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatTime(s: number): string {
  if (!isFinite(s) || isNaN(s)) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

interface Props {
  account: StoredAccount;
  item: CachedItem;
  onClose: () => void;
  onOpenNotebook?: (info: { title: string; itemId: string; parentId: string; displayName: string }) => void;
  displayPath?: string;
  siblings?: CachedItem[];
  siblingIdx?: number;
  onNavigate?: (item: CachedItem, siblingIdx: number) => void;
  /** When true, integrates with the notebook layout (no fixed overlay, notebook toolbar). */
  inNotebook?: boolean;
  /** Called after a successful save with the new text content and item ID. */
  onAfterSave?: (newContent: string, newItemId: string) => Promise<void>;
  /** When provided, a "Rename note" option is added to the notebook options popover. */
  onRenameNote?: () => void;
}

type Mode = 'loading' | 'text' | 'image' | 'audio' | 'video' | 'unsupported' | 'error';

function detectMode(item: CachedItem): Mode {
  const mime = item.mimeType ?? '';
  const ext = item.name.split('.').pop()?.toLowerCase() ?? '';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml'
    || ['txt','md','json','js','ts','tsx','jsx','css','html','htm','xml','csv','yaml','yml',
        'rs','py','go','java','c','cpp','h','sh','bash','sql','toml','ini','cfg','env',
        'log','gitignore','editorconfig'].includes(ext)) return 'text';
  if (mime.startsWith('image/') || ['jpg','jpeg','png','gif','webp','svg','avif','bmp','ico'].includes(ext)) return 'image';
  if (mime.startsWith('audio/') || ['mp3','wav','ogg','flac','m4a','aac','opus'].includes(ext)) return 'audio';
  if (mime.startsWith('video/') || ['mp4','mkv','avi','mov','webm','m4v'].includes(ext)) return 'video';
  return 'unsupported';
}

function fileIcon(mode: Mode): string {
  switch (mode) {
    case 'text': return '📝';
    case 'image': return '🖼';
    case 'audio': return '🎵';
    case 'video': return '🎬';
    default: return '📄';
  }
}

// ── Shared tiny SVG icons ────────────────────────────────────────────────────

function BackChevron() {
  return <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M9 1L3 7l6 6"/></svg>;
}
function PrevChevron() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9,2 4,7 9,12"/></svg>;
}
function NextChevron() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="5,2 10,7 5,12"/></svg>;
}
function SaveIcon() {
  return <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M2 11h10M7 3v6M4 6l3 3 3-3"/></svg>;
}
function UndoIcon() {
  return <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M2 6a5 5 0 1 1 .9 3"/><path d="M2 3v3h3"/></svg>;
}
function RedoIcon() {
  return <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M12 6a5 5 0 1 0-.9 3"/><path d="M12 3v3H9"/></svg>;
}
function OptionsIcon() {
  return <svg viewBox="0 0 14 14" fill="currentColor" className="w-3.5 h-3.5"><circle cx="2" cy="7" r="1.3"/><circle cx="7" cy="7" r="1.3"/><circle cx="12" cy="7" r="1.3"/></svg>;
}
function QuickActionsIcon() {
  return <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M8 1L4 8h5l-3 5"/></svg>;
}
function CursorLeftIcon() {
  return <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3"><path d="M8 2L4 6l4 4"/></svg>;
}
function CursorRightIcon() {
  return <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3"><path d="M4 2l4 4-4 4"/></svg>;
}
function CursorUpIcon() {
  return <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3"><path d="M2 8l4-4 4 4"/></svg>;
}
function CursorDownIcon() {
  return <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3"><path d="M2 4l4 4 4-4"/></svg>;
}
function HomeIcon() {
  return <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><line x1="2" y1="3" x2="2" y2="11"/><path d="M2 7h8M7 4l3 3-3 3"/></svg>;
}
function EndIcon() {
  return <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><line x1="12" y1="3" x2="12" y2="11"/><path d="M12 7H4M7 4l-3 3 3 3"/></svg>;
}

export default function FileViewer({
  account, item, onClose, onOpenNotebook, displayPath, siblings, siblingIdx, onNavigate,
  inNotebook = false, onAfterSave, onRenameNote,
}: Props) {
  const mode = detectMode(item);
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  const [effectiveItemId, setEffectiveItemId] = useState(item.itemId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  // text editor
  const [textContent, setTextContent] = useState('');
  const [editedText, setEditedText] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const savedFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lineEnding, setLineEnding] = useState<'lf' | 'crlf'>('lf');
  const [showDiff, setShowDiff] = useState(false);

  // notebook toolbar popovers
  const [showOptions, setShowOptions] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  const cmRef = useRef<ReactCodeMirrorRef>(null);

  // image overlay + zoom + pan
  const [showImageHeader, setShowImageHeader] = useState(true);
  const imgContainerRef = useRef<HTMLDivElement>(null);
  const [imgNaturalW, setImgNaturalW] = useState(0);
  const [imgNaturalH, setImgNaturalH] = useState(0);
  const imgNaturalWRef = useRef(0);
  const imgNaturalHRef = useRef(0);
  const [imgZoom, setImgZoom] = useState(1);
  const imgMinZoomRef = useRef(1);
  const pinchStartDistRef = useRef(0);
  const pinchStartZoomRef = useRef(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const panOffsetRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const wasDragRef = useRef(false);

  // video controls
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);
  const [showVideoControls, setShowVideoControls] = useState(true);
  const videoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // cache management dropdown
  const [cacheMenuOpen, setCacheMenuOpen] = useState(false);
  const cacheMenuRef = useRef<HTMLDivElement>(null);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Prevent body scroll only in standalone (non-notebook) mode.
  useEffect(() => {
    if (inNotebook) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [inNotebook]);

  // Close options popover on outside click.
  useEffect(() => {
    if (!showOptions) return;
    const handler = (e: MouseEvent) => {
      if (optionsRef.current && !optionsRef.current.contains(e.target as Node))
        setShowOptions(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showOptions]);

  // ── Load file ────────────────────────────────────────────────────────────────

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<DownloadProgress>('file-download-progress', (e) => setProgress(e.payload))
      .then((fn) => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  const loadFile = useCallback(async (force: boolean) => {
    setLoading(true); setError(null); setProgress(null);
    setBlobUrl(null);
    try {
      let path: string | null = null;
      if (account.shelvesetActive) {
        const shelvedPath = await invoke<string | null>('shelveset_get_content_path', {
          accountId: account.id, itemId: effectiveItemId,
        });
        if (shelvedPath) {
          path = shelvedPath;
        } else if (!effectiveItemId.startsWith('shv-')) {
          path = await invoke<string>('open_file', { accountId: account.id, itemId: effectiveItemId, force, itemName: item.name });
        }
      } else {
        path = await invoke<string>('open_file', { accountId: account.id, itemId: effectiveItemId, force, itemName: item.name });
      }
      if (!isMountedRef.current) return;
      if (path === null) {
        if (mode === 'text') { setTextContent(''); setEditedText(''); setIsDirty(false); setLineEnding('lf'); }
        return;
      }
      if (mode === 'text') {
        const bytes = await readFile(path);
        if (!isMountedRef.current) return;
        const raw = new TextDecoder('utf-8').decode(bytes);
        const hasCRLF = raw.includes('\r\n');
        setLineEnding(hasCRLF ? 'crlf' : 'lf');
        const text = hasCRLF ? raw.replace(/\r\n/g, '\n') : raw;
        setTextContent(text); setEditedText(text); setIsDirty(false);
      } else if (mode !== 'unsupported') {
        setBlobUrl(convertFileSrc(path));
      }
    } catch (e) {
      if (!isMountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [account.id, account.shelvesetActive, effectiveItemId, item.name, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void loadFile(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fullscreen ───────────────────────────────────────────────────────────────

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = (e: React.MouseEvent, containerRef: React.RefObject<HTMLDivElement | null>) => {
    e.stopPropagation();
    if (!document.fullscreenElement) containerRef.current?.requestFullscreen();
    else document.exitFullscreen();
  };

  // ── Image: zoom + pan ────────────────────────────────────────────────────────

  useEffect(() => {
    setImgNaturalW(0); setImgNaturalH(0); setImgZoom(1);
    imgMinZoomRef.current = 1;
    imgNaturalWRef.current = 0; imgNaturalHRef.current = 0;
    setPanOffset({ x: 0, y: 0 }); panOffsetRef.current = { x: 0, y: 0 };
  }, [blobUrl]);

  const computeImageZoom = useCallback((el: HTMLImageElement) => {
    const nw = el.naturalWidth; const nh = el.naturalHeight;
    if (!nw || !nh) return;
    setImgNaturalW(nw); setImgNaturalH(nh);
    imgNaturalWRef.current = nw; imgNaturalHRef.current = nh;
    const vw = imgContainerRef.current?.clientWidth ?? window.innerWidth;
    const vh = imgContainerRef.current?.clientHeight ?? window.innerHeight;
    const minZoom = Math.min(vw / nw, vh / nh, 1);
    imgMinZoomRef.current = minZoom;
    setImgZoom(minZoom);
    setPanOffset({ x: 0, y: 0 }); panOffsetRef.current = { x: 0, y: 0 };
  }, []);

  useEffect(() => {
    if (mode !== 'image') return;
    if (imgZoom <= imgMinZoomRef.current + 0.001) {
      setPanOffset({ x: 0, y: 0 }); panOffsetRef.current = { x: 0, y: 0 };
    } else {
      setPanOffset((curr) => {
        const el = imgContainerRef.current;
        if (!el || imgNaturalWRef.current === 0) return curr;
        const maxX = Math.max(0, (imgNaturalWRef.current * imgZoom - el.clientWidth) / 2);
        const maxY = Math.max(0, (imgNaturalHRef.current * imgZoom - el.clientHeight) / 2);
        const next = { x: Math.max(-maxX, Math.min(maxX, curr.x)), y: Math.max(-maxY, Math.min(maxY, curr.y)) };
        panOffsetRef.current = next;
        return next;
      });
    }
  }, [imgZoom, mode]);

  useEffect(() => {
    if (mode !== 'image') return;
    const el = imgContainerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setImgZoom((prev) => Math.max(imgMinZoomRef.current, Math.min(1, prev * factor)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [mode, blobUrl]);

  const handleImgMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: panOffset.x, panY: panOffset.y };
    wasDragRef.current = false;
  };
  const handleImgMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (!wasDragRef.current && Math.hypot(dx, dy) > 5) wasDragRef.current = true;
    if (!wasDragRef.current) return;
    const el = imgContainerRef.current;
    let nx = dragRef.current.panX + dx;
    let ny = dragRef.current.panY + dy;
    if (el && imgNaturalWRef.current > 0) {
      const maxX = Math.max(0, (imgNaturalWRef.current * imgZoom - el.clientWidth) / 2);
      const maxY = Math.max(0, (imgNaturalHRef.current * imgZoom - el.clientHeight) / 2);
      nx = Math.max(-maxX, Math.min(maxX, nx));
      ny = Math.max(-maxY, Math.min(maxY, ny));
    }
    const next = { x: nx, y: ny };
    panOffsetRef.current = next;
    setPanOffset(next);
  };
  const handleImgMouseUp = () => {
    const hadDragStart = dragRef.current !== null;
    const isDrag = wasDragRef.current;
    dragRef.current = null; wasDragRef.current = false;
    if (hadDragStart && !isDrag) toggleImgHeader();
  };

  useEffect(() => {
    if (mode !== 'image') return;
    const el = imgContainerRef.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const scale = dist / pinchStartDistRef.current;
      setImgZoom(Math.max(imgMinZoomRef.current, Math.min(1, pinchStartZoomRef.current * scale)));
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onTouchMove);
  }, [mode, blobUrl]);

  // ── Cache menu outside-click ─────────────────────────────────────────────────

  useEffect(() => {
    if (!cacheMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (cacheMenuRef.current && !cacheMenuRef.current.contains(e.target as Node)) setCacheMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [cacheMenuOpen]);

  // ── Save (text only) ─────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!isDirty || saving) return;
    setSaving(true); setSaveError(null);
    try {
      const content = lineEnding === 'crlf' ? editedText.replace(/\n/g, '\r\n') : editedText;
      let savedItemId = effectiveItemId;
      if (account.shelvesetActive) {
        await invoke('shelveset_save_content', {
          accountId: account.id, itemId: effectiveItemId, itemName: item.name,
          parentId: item.parentId, isDir: false, isNew: effectiveItemId.startsWith('shv-'),
          displayPath: displayPath ?? item.name, content,
        });
      } else {
        const newId = await invoke<string>('save_text_file', {
          accountId: account.id, itemId: effectiveItemId, parentId: item.parentId,
          content, itemName: item.name,
        });
        if (newId !== effectiveItemId) { setEffectiveItemId(newId); savedItemId = newId; }
      }
      setTextContent(editedText); setIsDirty(false);
      if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current);
      setSavedFlash(true);
      savedFlashTimerRef.current = setTimeout(() => setSavedFlash(false), 2000);
      if (onAfterSave) await onAfterSave(editedText, savedItemId).catch(() => {});
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // ── Cache controls ───────────────────────────────────────────────────────────

  const handleHardRefresh = () => { setCacheMenuOpen(false); void loadFile(true); };
  const handleClearCache = async () => {
    setCacheMenuOpen(false);
    if (account.provider !== 'local-fs') {
      await invoke('delete_cached_file', { accountId: account.id, itemId: effectiveItemId }).catch(() => {});
    }
  };

  // ── Video controls ───────────────────────────────────────────────────────────

  const showVideoControlsBriefly = useCallback(() => {
    setShowVideoControls(true);
    if (videoTimerRef.current) clearTimeout(videoTimerRef.current);
    if (isPlayingRef.current) {
      videoTimerRef.current = setTimeout(() => setShowVideoControls(false), 3000);
    }
  }, []);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      void videoRef.current.play();
      setIsPlaying(true); isPlayingRef.current = true;
      showVideoControlsBriefly();
    } else {
      videoRef.current.pause();
      setIsPlaying(false); isPlayingRef.current = false;
      if (videoTimerRef.current) clearTimeout(videoTimerRef.current);
      setShowVideoControls(true);
    }
  };

  useEffect(() => () => { if (videoTimerRef.current) clearTimeout(videoTimerRef.current); }, []);

  // ── Cursor navigation via CodeMirror commands ────────────────────────────────

  const moveCursor = (dir: 'left' | 'right' | 'up' | 'down' | 'home' | 'end') => {
    const view = cmRef.current?.view;
    if (!view) return;
    view.focus();
    switch (dir) {
      case 'left':  cursorCharLeft(view);  break;
      case 'right': cursorCharRight(view); break;
      case 'up':    cursorLineUp(view);    break;
      case 'down':  cursorLineDown(view);  break;
      case 'home':  cursorLineStart(view); break;
      case 'end':   cursorLineEnd(view);   break;
    }
  };

  const execUndo = () => { const v = cmRef.current?.view; if (v) { cmUndo(v); v.focus(); } };
  const execRedo = () => { const v = cmRef.current?.view; if (v) { cmRedo(v); v.focus(); } };

  // ── Shared sibling navigation ────────────────────────────────────────────────

  const hasSiblings = siblings && siblings.length > 1 && siblingIdx != null && siblingIdx >= 0;
  const canPrev = hasSiblings && siblingIdx! > 0;
  const canNext = hasSiblings && siblingIdx! < siblings!.length - 1;
  const goToPrev = () => { if (canPrev) onNavigate?.(siblings![siblingIdx! - 1], siblingIdx! - 1); };
  const goToNext = () => { if (canNext) onNavigate?.(siblings![siblingIdx! + 1], siblingIdx! + 1); };
  const toggleImgHeader = () => setShowImageHeader((h) => !h);
  const canZoom = imgNaturalW > 0 && imgMinZoomRef.current < 1;
  const canPan = imgNaturalW > 0 && imgZoom > imgMinZoomRef.current + 0.001;

  // ── Cache split-button ───────────────────────────────────────────────────────

  const CacheControls = ({ white = false }: { white?: boolean }) => {
    const cls = white
      ? 'px-2 py-1 text-sm text-white/80 hover:text-white hover:bg-white/20 transition-colors border-r border-white/30'
      : 'px-2 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors border-r border-gray-200 dark:border-gray-600';
    const toggleCls = white
      ? 'px-1.5 py-1 text-sm text-white/80 hover:text-white hover:bg-white/20 transition-colors'
      : 'px-1.5 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors';
    return (
      <div ref={cacheMenuRef} className="relative flex items-center">
        <button onClick={() => loadFile(false)} title="Reload from cache" className={`${cls} rounded-l-lg`}>↻</button>
        <button onClick={() => setCacheMenuOpen(o => !o)} title="Cache options" className={`${toggleCls} rounded-r-lg`}>▾</button>
        {cacheMenuOpen && (
          <div className="absolute right-0 top-full mt-1 z-[60] min-w-max bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg">
            <div className="px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">Cache options</div>
            <div className="py-1">
              <button onClick={handleHardRefresh} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Hard refresh</button>
              <button onClick={handleClearCache} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Clear file cache</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── Standalone HeaderBar (non-notebook mode) ─────────────────────────────────

  const HeaderBar = ({ right }: { right?: React.ReactNode }) => (
    <div className="flex items-center px-4 py-3 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 gap-2 shrink-0">
      <button onClick={onClose} title="Back"
        className="p-1 rounded text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors shrink-0">
        <BackChevron />
      </button>
      <span className="text-gray-300 dark:text-gray-600 shrink-0">|</span>
      {hasSiblings && (
        <>
          <button onClick={goToPrev} disabled={!canPrev} title="Previous"
            className="p-1 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0">
            <PrevChevron />
          </button>
          <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0 tabular-nums">{siblingIdx! + 1}/{siblings!.length}</span>
          <button onClick={goToNext} disabled={!canNext} title="Next"
            className="p-1 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0">
            <NextChevron />
          </button>
          <span className="text-gray-300 dark:text-gray-600 shrink-0">|</span>
        </>
      )}
      <span className="shrink-0">{fileIcon(mode)}</span>
      <span className="font-medium text-gray-900 dark:text-white truncate min-w-0 flex-1">{item.name}</span>
      <div className="flex items-center gap-2 shrink-0">
        <CacheControls />
        {right}
      </div>
    </div>
  );

  // ── Notebook toolbar (replaces HeaderBar in notebook mode) ───────────────────

  // Separator between button groups.
  const Sep = () => <span className="w-px h-4 bg-gray-200 dark:bg-gray-600 mx-0.5 shrink-0" />;

  const ib = 'shrink-0 w-7 h-7 flex items-center justify-center rounded text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors';
  const ibDis = `${ib} disabled:opacity-30 disabled:cursor-default`;


  // Options popover (text-mode-only).
  // Uses fixed positioning so it is not clipped by the toolbar's overflow-x-auto.
  const OptionsPopover = () => {
    const rect = optionsRef.current?.getBoundingClientRect();
    return (
    <div
      style={{ position: 'fixed', top: (rect?.bottom ?? 0) + 4, right: window.innerWidth - (rect?.right ?? 0) }}
      className="z-[60] min-w-max bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg"
    >
      <div className="px-4 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">Options</div>
      <div className="py-1">
        <button
          onClick={() => { setLineEnding((e) => e === 'lf' ? 'crlf' : 'lf'); }}
          className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center justify-between gap-4">
          <span>Line endings</span>
          <span className="font-mono text-xs text-gray-500">{lineEnding.toUpperCase()}</span>
        </button>
        {isDirty && (
          <button onClick={() => { setShowOptions(false); setShowDiff(true); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
            Compare with saved
          </button>
        )}
        {onRenameNote && (
          <button onClick={() => { setShowOptions(false); onRenameNote(); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
            Rename note
          </button>
        )}
        {item.name === config.notebookFileName && onOpenNotebook && (
          <button
            onClick={() => {
              setShowOptions(false);
              let title = '';
              try { title = (JSON.parse(editedText) as { Title?: string }).Title ?? ''; } catch { /* empty */ }
              onOpenNotebook({ title, itemId: effectiveItemId, parentId: item.parentId, displayName: displayPath ?? item.name });
            }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
            Open as Notebook
          </button>
        )}
        <div className="border-t border-gray-100 dark:border-gray-700 my-1" />
        <button onClick={() => { setShowOptions(false); void loadFile(true); }}
          className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
          Hard refresh
        </button>
        {account.provider !== 'local-fs' && (
          <button onClick={() => { setShowOptions(false); invoke('delete_cached_file', { accountId: account.id, itemId: effectiveItemId }).catch(() => {}); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
            Clear file cache
          </button>
        )}
      </div>
    </div>
  );
  };

  // The compact notebook toolbar (for text / audio / unsupported / loading / error).
  const NotebookBar = () => (
    <div className="shrink-0 flex items-center gap-0.5 px-2 py-1 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
      {/* Back */}
      <button onClick={onClose} title="Back to explorer" className={ib}><BackChevron /></button>

      {/* Sibling navigation */}
      {hasSiblings && (
        <>
          <Sep />
          <button onClick={goToPrev} disabled={!canPrev} title="Previous file" className={ibDis}><PrevChevron /></button>
          <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums px-1 shrink-0">{siblingIdx! + 1}/{siblings!.length}</span>
          <button onClick={goToNext} disabled={!canNext} title="Next file" className={ibDis}><NextChevron /></button>
        </>
      )}

      {/* Text-mode controls */}
      {mode === 'text' && !loading && !error && (
        <>
          <Sep />
          {/* Cursor arrows */}
          <button onClick={() => moveCursor('left')} title="Cursor left" className={ib}><CursorLeftIcon /></button>
          <button onClick={() => moveCursor('up')} title="Cursor up" className={ib}><CursorUpIcon /></button>
          <button onClick={() => moveCursor('down')} title="Cursor down" className={ib}><CursorDownIcon /></button>
          <button onClick={() => moveCursor('right')} title="Cursor right" className={ib}><CursorRightIcon /></button>
          <button onClick={() => moveCursor('home')} title="Line start" className={ib}><HomeIcon /></button>
          <button onClick={() => moveCursor('end')} title="Line end" className={ib}><EndIcon /></button>
          <Sep />
          {/* Undo / Redo */}
          <button onClick={execUndo} title="Undo" className={ib}><UndoIcon /></button>
          <button onClick={execRedo} title="Redo" className={ib}><RedoIcon /></button>
          <Sep />
          {/* Save */}
          <button onClick={() => void handleSave()} disabled={!isDirty || saving}
            title={saving ? 'Saving…' : isDirty ? 'Save' : 'No unsaved changes'}
            className={`${ibDis} ${isDirty && !saving ? 'text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300' : ''}`}>
            <SaveIcon />
          </button>
          {/* Saved flash */}
          {savedFlash && (
            <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 px-1 shrink-0">✓ Saved</span>
          )}
          {/* Options */}
          <div ref={optionsRef} className="relative shrink-0">
            <button onClick={() => setShowOptions(o => !o)} title="Options" className={ib}><OptionsIcon /></button>
            {showOptions && <OptionsPopover />}
          </div>
        </>
      )}

      {/* Non-text cache reload (audio / unsupported) */}
      {(mode === 'audio' || mode === 'unsupported') && !loading && !error && (
        <>
          <Sep />
          <CacheControls />
        </>
      )}

      <div className="flex-1" />

      {/* Quick actions */}
      <button onClick={() => {}} title="Quick actions" className={ib}><QuickActionsIcon /></button>
    </div>
  );

  // ── Loading / error ──────────────────────────────────────────────────────────

  const wrapCls = inNotebook
    ? 'flex-1 min-h-0 flex flex-col overflow-hidden bg-white dark:bg-gray-900'
    : 'fixed inset-0 z-50 flex flex-col bg-white dark:bg-gray-900';

  if (loading) return (
    <div className={wrapCls}>
      {inNotebook ? <NotebookBar /> : <HeaderBar />}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="flex flex-col items-center gap-4 w-full max-w-sm">
          <p className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-full">{item.name}</p>
          {progress ? (
            <>
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                <div className="h-2 rounded-full bg-blue-600 transition-all duration-150"
                  style={{ width: progress.total ? `${Math.min(100, progress.loaded / progress.total * 100).toFixed(1)}%` : '40%' }} />
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                {formatBytes(progress.loaded)}
                {progress.total != null ? ` / ${formatBytes(progress.total)} · ${Math.min(100, Math.round(progress.loaded / progress.total * 100))}%` : ''}
              </p>
            </>
          ) : (
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
              <div className="h-2 rounded-full bg-blue-600 animate-pulse w-1/3" />
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (error) return (
    <div className={wrapCls}>
      {inNotebook ? <NotebookBar /> : <HeaderBar />}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-3 max-w-md">
          <p className="text-red-500 dark:text-red-400">{error}</p>
          <button onClick={() => loadFile(false)} className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">
            Try again
          </button>
        </div>
      </div>
    </div>
  );

  // ── Text viewer / editor ─────────────────────────────────────────────────────

  if (mode === 'text') {
    const outerCls = inNotebook
      ? 'flex-1 min-h-0 flex flex-col overflow-hidden bg-white dark:bg-gray-900'
      : 'fixed inset-0 z-50 flex flex-col bg-white dark:bg-gray-900';

    return (
      <>
        {showDiff && (
          <Suspense fallback={null}>
            <DiffViewerModal
              filename={item.name}
              leftLabel="Saved" rightLabel="Unsaved edits"
              leftContent={textContent} rightContent={editedText}
              onApply={(result) => { setEditedText(result); setIsDirty(result !== textContent); setShowDiff(false); }}
              onDiscard={() => { setEditedText(textContent); setIsDirty(false); setShowDiff(false); }}
              onClose={() => setShowDiff(false)}
            />
          </Suspense>
        )}
        <div className={outerCls}>
          {inNotebook ? <NotebookBar /> : (
            <HeaderBar right={
              <>
                {item.name === config.notebookFileName && onOpenNotebook && (
                  <button
                    onClick={() => {
                      let title = '';
                      try { title = (JSON.parse(editedText) as { Title?: string }).Title ?? ''; } catch { /* empty */ }
                      onOpenNotebook({ title, itemId: effectiveItemId, parentId: item.parentId, displayName: displayPath ?? item.name });
                    }}
                    className="px-3 py-1 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors">
                    Open as Notebook
                  </button>
                )}
                {isDirty && (
                  <button onClick={() => setShowDiff(true)} title="Compare with saved version"
                    className="p-1.5 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><path d="M3 4h4M3 8h3M3 12h4"/><path d="M13 4H9M13 8h-3M13 12H9"/><path d="M7.5 2v12" strokeDasharray="2 1"/></svg>
                  </button>
                )}
                <button onClick={() => setLineEnding((e) => e === 'lf' ? 'crlf' : 'lf')}
                  title={lineEnding === 'crlf' ? 'CRLF — click to switch to LF' : 'LF — click to switch to CRLF'}
                  className="px-2 py-1 rounded text-xs font-mono bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
                  {lineEnding === 'crlf' ? 'CRLF' : 'LF'}
                </button>
                {savedFlash && (
                  <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 shrink-0"><path d="M2 7l3.5 3.5L12 3"/></svg>
                    Saved
                  </span>
                )}
                <button onClick={() => void handleSave()} disabled={!isDirty || saving} title={saving ? 'Saving…' : 'Save'}
                  className="p-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors">
                  <SaveIcon />
                </button>
              </>
            } />
          )}
          {saveError && (
            <div className="px-4 py-2 bg-red-50 dark:bg-red-900/20 border-b border-red-100 dark:border-red-800 text-red-600 dark:text-red-400 text-sm flex items-center justify-between shrink-0">
              <span>{saveError}</span>
              <button onClick={() => setSaveError(null)} className="text-red-400 hover:text-red-600 dark:hover:text-red-300 ml-2">✕</button>
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-hidden">
            <CodeEditor
              ref={cmRef}
              value={editedText}
              onChange={(val) => { setEditedText(val); setIsDirty(val !== textContent); }}
              filename={item.name}
              isDark={isDark}
            />
          </div>
        </div>
      </>
    );
  }

  // ── Image viewer ─────────────────────────────────────────────────────────────

  if (mode === 'image') {
    const imgOuterCls = inNotebook
      ? `flex-1 min-h-0 relative bg-black overflow-hidden select-none ${canPan ? 'cursor-grab active:cursor-grabbing' : ''}`
      : `fixed inset-0 z-50 bg-black overflow-hidden select-none ${canPan ? 'cursor-grab active:cursor-grabbing' : ''}`;

    const overlayBtnCls = 'p-1 rounded text-white/80 hover:text-white hover:bg-white/20 transition-colors shrink-0';

    return (
      <div
        ref={imgContainerRef}
        className={imgOuterCls}
        onMouseDown={handleImgMouseDown}
        onMouseMove={handleImgMouseMove}
        onMouseUp={handleImgMouseUp}
        onMouseLeave={() => { dragRef.current = null; wasDragRef.current = false; }}
        onTouchStart={(e) => {
          if (e.touches.length === 2) {
            pinchStartDistRef.current = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            pinchStartZoomRef.current = imgZoom;
          }
        }}
      >
        {/* Pan + centering wrapper */}
        <div className="w-full h-full flex items-center justify-center"
          style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px)` }}>
          {blobUrl && (
            <img
              ref={(el) => { if (el?.complete && el.naturalWidth > 0 && imgNaturalWRef.current === 0) computeImageZoom(el); }}
              src={blobUrl} alt={item.name}
              onLoad={(e) => computeImageZoom(e.currentTarget)}
              style={imgNaturalW > 0
                ? { width: imgNaturalW * imgZoom, height: imgNaturalH * imgZoom, maxWidth: 'none', maxHeight: 'none' }
                : { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
              className="block" draggable={false}
            />
          )}
        </div>

        {/* Overlay header */}
        {showImageHeader && (
          <div
            className="absolute top-0 inset-x-0 flex items-center px-2 py-2 bg-gradient-to-b from-black/80 to-transparent text-white gap-1 z-10"
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={(e) => { e.stopPropagation(); onClose(); }} title="Back" className={overlayBtnCls}><BackChevron /></button>
            <span className="text-white/40 shrink-0">|</span>
            {hasSiblings && (
              <>
                <button onClick={(e) => { e.stopPropagation(); goToPrev(); }} disabled={!canPrev} title="Previous" className={overlayBtnCls}><PrevChevron /></button>
                <span className="text-xs text-white/60 tabular-nums shrink-0">{siblingIdx! + 1}/{siblings!.length}</span>
                <button onClick={(e) => { e.stopPropagation(); goToNext(); }} disabled={!canNext} title="Next" className={overlayBtnCls}><NextChevron /></button>
                <span className="text-white/40 shrink-0">|</span>
              </>
            )}
            {!inNotebook && (
              <>
                <span>🖼</span>
                <span className="font-medium truncate flex-1 min-w-0">{item.name}</span>
              </>
            )}
            <div className="flex-1" />
            <CacheControls white />
            {canZoom && <span className="text-xs text-white/60 tabular-nums shrink-0">{Math.round(imgZoom * 100)}%</span>}
            <button onClick={(e) => toggleFullscreen(e, imgContainerRef)} title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              className="text-white/80 hover:text-white w-7 h-7 flex items-center justify-center rounded hover:bg-white/20 transition-colors text-base">
              {isFullscreen ? '⊡' : '⛶'}
            </button>
            {inNotebook ? (
              <button onClick={() => {}} title="Quick actions" className={overlayBtnCls}><QuickActionsIcon /></button>
            ) : (
              <button onClick={(e) => { e.stopPropagation(); onClose(); }}
                className="text-white/80 hover:text-white text-xl leading-none w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/20 transition-colors">
                ✕
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Audio player ─────────────────────────────────────────────────────────────

  if (mode === 'audio') {
    const audioCls = inNotebook
      ? 'flex-1 min-h-0 flex flex-col bg-gray-900 text-white overflow-hidden'
      : 'fixed inset-0 z-50 flex flex-col bg-gray-900 text-white';
    return (
      <div className={audioCls}>
        {inNotebook ? <NotebookBar /> : <HeaderBar />}
        <div className="flex-1 flex flex-col items-center justify-center gap-8 px-8 overflow-auto">
          <div className="text-center space-y-2">
            <div className="text-7xl">🎵</div>
            <p className="text-lg font-medium text-gray-200">{item.name}</p>
            <p className="text-sm text-gray-400">{account.displayName ?? account.email}</p>
          </div>
          {blobUrl && <audio src={blobUrl} controls className="w-full max-w-lg [&::-webkit-media-controls-panel]:bg-gray-800" />}
        </div>
      </div>
    );
  }

  // ── Video player ─────────────────────────────────────────────────────────────

  if (mode === 'video') {
    const videoCls = inNotebook
      ? 'flex-1 min-h-0 relative bg-black flex items-center justify-center overflow-hidden'
      : 'fixed inset-0 z-50 bg-black flex items-center justify-center overflow-hidden';
    const overlayBtnCls = 'p-1 rounded text-white/80 hover:text-white hover:bg-white/20 transition-colors shrink-0';

    return (
      <div ref={videoContainerRef}
        className={videoCls}
        onClick={showVideoControlsBriefly}
        onMouseMove={showVideoControlsBriefly}
        onTouchStart={showVideoControlsBriefly}>
        {blobUrl && (
          <video ref={videoRef} src={blobUrl}
            className="w-full h-full object-contain"
            onPlay={() => { setIsPlaying(true); isPlayingRef.current = true; showVideoControlsBriefly(); }}
            onPause={() => { setIsPlaying(false); isPlayingRef.current = false; if (videoTimerRef.current) clearTimeout(videoTimerRef.current); setShowVideoControls(true); }}
            onEnded={() => { setIsPlaying(false); isPlayingRef.current = false; setShowVideoControls(true); }}
            onTimeUpdate={() => { if (videoRef.current) setCurrentTime(videoRef.current.currentTime); }}
            onLoadedMetadata={() => { if (videoRef.current) setDuration(videoRef.current.duration); }}
            onClick={(e) => { e.stopPropagation(); showVideoControlsBriefly(); }}
          />
        )}
        {showVideoControls && (
          <div className="absolute inset-0 flex flex-col pointer-events-none">
            {/* Top bar */}
            <div className="flex items-center px-2 py-2 bg-gradient-to-b from-black/70 to-transparent text-white gap-1 pointer-events-auto">
              <button onClick={(e) => { e.stopPropagation(); onClose(); }} title="Back" className={overlayBtnCls}><BackChevron /></button>
              <span className="text-white/40 shrink-0">|</span>
              {hasSiblings && (
                <>
                  <button onClick={(e) => { e.stopPropagation(); goToPrev(); }} disabled={!canPrev} title="Previous" className={overlayBtnCls}><PrevChevron /></button>
                  <span className="text-xs text-white/60 tabular-nums shrink-0">{siblingIdx! + 1}/{siblings!.length}</span>
                  <button onClick={(e) => { e.stopPropagation(); goToNext(); }} disabled={!canNext} title="Next" className={overlayBtnCls}><NextChevron /></button>
                  <span className="text-white/40 shrink-0">|</span>
                </>
              )}
              {!inNotebook && (
                <>
                  <span>🎬</span>
                  <span className="font-medium truncate flex-1 min-w-0">{item.name}</span>
                </>
              )}
              <div className="flex-1" />
              <CacheControls white />
              {inNotebook && (
                <button onClick={() => {}} title="Quick actions" className={overlayBtnCls}><QuickActionsIcon /></button>
              )}
            </div>
            {/* Centre play/pause */}
            <div className="flex-1 flex items-center justify-center pointer-events-auto">
              <button onClick={togglePlay}
                className="bg-black/60 rounded-full w-16 h-16 flex items-center justify-center text-white text-2xl hover:bg-black/80 transition-colors">
                {isPlaying ? '⏸' : '▶'}
              </button>
            </div>
            {/* Bottom: seek bar + fullscreen */}
            <div className="flex items-center gap-3 px-4 py-3 bg-gradient-to-t from-black/70 to-transparent text-white pointer-events-auto">
              <span className="text-xs tabular-nums shrink-0 min-w-[2.5rem] text-right">{formatTime(currentTime)}</span>
              <input type="range" min={0} max={duration || 0} step={0.5} value={currentTime}
                onChange={(e) => { const t = parseFloat(e.target.value); setCurrentTime(t); if (videoRef.current) videoRef.current.currentTime = t; }}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 h-1 accent-white cursor-pointer" />
              <span className="text-xs tabular-nums shrink-0 min-w-[2.5rem]">{formatTime(duration)}</span>
              <button onClick={(e) => toggleFullscreen(e, videoContainerRef)} title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                className="text-white/80 hover:text-white w-7 h-7 flex items-center justify-center rounded hover:bg-white/20 transition-colors text-base leading-none">
                {isFullscreen ? '⊡' : '⛶'}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Unsupported / other ───────────────────────────────────────────────────────

  const unsupCls = inNotebook
    ? 'flex-1 min-h-0 flex flex-col overflow-hidden bg-white dark:bg-gray-900'
    : 'fixed inset-0 z-50 flex flex-col bg-white dark:bg-gray-900';

  return (
    <div className={unsupCls}>
      {inNotebook ? <NotebookBar /> : <HeaderBar />}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-3">
          <div className="text-5xl">📄</div>
          <p className="font-medium text-gray-700 dark:text-gray-300">{item.name}</p>
          <p className="text-sm text-gray-400 dark:text-gray-500">No preview available for this file type.</p>
        </div>
      </div>
    </div>
  );
}
