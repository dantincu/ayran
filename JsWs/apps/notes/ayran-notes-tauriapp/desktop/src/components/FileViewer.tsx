import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { readFile } from '@tauri-apps/plugin-fs';
import type { StoredAccount, CachedItem } from '../types';
import config from '../config.json';

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

export default function FileViewer({ account, item, onClose, onOpenNotebook, displayPath, siblings, siblingIdx, onNavigate }: Props) {
  const mode = detectMode(item);

  // Filen creates a new UUID on every overwrite; track the live item ID here.
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

  // image overlay + zoom + pan
  const [showImageHeader, setShowImageHeader] = useState(false);
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

  // Guard against stale async completions after unmount.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Prevent body scroll while viewer is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

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
      const path = await invoke<string>('open_file', { accountId: account.id, itemId: effectiveItemId, force });
      if (!isMountedRef.current) return;

      if (mode === 'text') {
        const bytes = await readFile(path);
        if (!isMountedRef.current) return;
        const text = new TextDecoder('utf-8').decode(bytes);
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
  }, [account.id, effectiveItemId, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void loadFile(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fullscreen ───────────────────────────────────────────────────────────────

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = (e: React.MouseEvent, containerRef: React.RefObject<HTMLDivElement | null>) => {
    e.stopPropagation();
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  // ── Image: load, zoom, pinch ─────────────────────────────────────────────────

  // Reset image state whenever a new file is loaded.
  useEffect(() => {
    setImgNaturalW(0); setImgNaturalH(0); setImgZoom(1);
    imgMinZoomRef.current = 1;
    imgNaturalWRef.current = 0; imgNaturalHRef.current = 0;
    setPanOffset({ x: 0, y: 0 }); panOffsetRef.current = { x: 0, y: 0 };
  }, [blobUrl]);

  // Shared logic for setting initial zoom — called from onLoad and from a ref
  // callback so that browser-cached images (which skip onLoad) are handled too.
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

  // Clamp pan whenever zoom changes (e.g. Ctrl+scroll zoom-out shrinks the pan range).
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
        const next = {
          x: Math.max(-maxX, Math.min(maxX, curr.x)),
          y: Math.max(-maxY, Math.min(maxY, curr.y)),
        };
        panOffsetRef.current = next;
        return next;
      });
    }
  }, [imgZoom, mode]);

  // Non-passive wheel handler for Ctrl+scroll zoom.
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

  // Mouse-drag pan — mousedown/move/up are React synthetic events so state is always current.
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
    // Only toggle if the drag was started from the image area (not from the overlay header,
    // which stops mousedown propagation so dragRef is never set from header clicks).
    const hadDragStart = dragRef.current !== null;
    const isDrag = wasDragRef.current;
    dragRef.current = null; wasDragRef.current = false;
    if (hadDragStart && !isDrag) toggleImgHeader();
  };

  // Non-passive touchmove for pinch zoom.
  useEffect(() => {
    if (mode !== 'image') return;
    const el = imgContainerRef.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
      const scale = dist / pinchStartDistRef.current;
      setImgZoom(Math.max(imgMinZoomRef.current, Math.min(1, pinchStartZoomRef.current * scale)));
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onTouchMove);
  }, [mode, blobUrl]);

  // ── Close cache menu on outside click ───────────────────────────────────────

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
      const newId = await invoke<string>('save_text_file', {
        accountId: account.id,
        itemId: effectiveItemId,
        parentId: item.parentId,
        content: editedText,
      });
      if (newId !== effectiveItemId) setEffectiveItemId(newId);
      setTextContent(editedText); setIsDirty(false);
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

  // ── Cache split-button (shared across text/audio/video/unsupported) ──────────

  const CacheControls = () => (
    <div ref={cacheMenuRef} className="relative flex items-center">
      <button onClick={() => loadFile(false)} title="Reload from cache"
        className="px-2 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-l-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors border-r border-gray-200 dark:border-gray-600">
        ↻
      </button>
      <button onClick={() => setCacheMenuOpen(o => !o)} title="Cache options"
        className="px-1.5 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-r-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
        ▾
      </button>
      {cacheMenuOpen && (
        <div className="absolute right-0 top-full mt-1 z-10 min-w-max bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1">
          <button onClick={handleHardRefresh}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
            Hard refresh
          </button>
          <button onClick={handleClearCache}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
            Clear file cache
          </button>
        </div>
      )}
    </div>
  );

  // ── Shared header bar ────────────────────────────────────────────────────────

  const hasSiblings = siblings && siblings.length > 1 && siblingIdx != null && siblingIdx >= 0;
  const canPrev = hasSiblings && siblingIdx! > 0;
  const canNext = hasSiblings && siblingIdx! < siblings!.length - 1;
  const goToPrev = () => { if (canPrev) onNavigate?.(siblings![siblingIdx! - 1], siblingIdx! - 1); };
  const goToNext = () => { if (canNext) onNavigate?.(siblings![siblingIdx! + 1], siblingIdx! + 1); };

  const HeaderBar = ({ right }: { right?: React.ReactNode }) => (
    <div className="flex items-center px-4 py-3 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 gap-2 shrink-0">
      <button onClick={onClose}
        className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors shrink-0">
        ← Back
      </button>
      <span className="text-gray-300 dark:text-gray-600 shrink-0">|</span>
      {hasSiblings && (
        <>
          <button onClick={goToPrev} disabled={!canPrev} title="Previous"
            className="p-1 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9,2 4,7 9,12" />
            </svg>
          </button>
          <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0 tabular-nums">{siblingIdx! + 1}/{siblings!.length}</span>
          <button onClick={goToNext} disabled={!canNext} title="Next"
            className="p-1 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="5,2 10,7 5,12" />
            </svg>
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

  // ── Loading / error ──────────────────────────────────────────────────────────

  if (loading) return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-gray-900">
      <HeaderBar />
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="flex flex-col items-center gap-4 w-full max-w-sm">
          <p className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-full">{item.name}</p>
          {progress ? (
            <>
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                <div
                  className="h-2 rounded-full bg-blue-600 transition-all duration-150"
                  style={{ width: progress.total ? `${Math.min(100, progress.loaded / progress.total * 100).toFixed(1)}%` : '40%' }}
                />
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
    <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-gray-900">
      <HeaderBar />
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

  if (mode === 'text') return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-gray-900">
      <HeaderBar right={
        <>
          {item.name === config.notebookFileName && onOpenNotebook && (
            <button
              onClick={() => {
                let title = '';
                try { title = (JSON.parse(editedText) as { Title?: string }).Title ?? ''; } catch { /* empty */ }
                onOpenNotebook({ title, itemId: effectiveItemId, parentId: item.parentId, displayName: displayPath ?? item.name });
              }}
              className="px-3 py-1 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
            >
              Open as Notebook
            </button>
          )}
          <button onClick={handleSave} disabled={!isDirty || saving}
            className="px-3 py-1 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors">
            {saving ? 'Saving…' : '💾 Save'}
          </button>
        </>
      } />
      {saveError && (
        <div className="px-4 py-2 bg-red-50 dark:bg-red-900/20 border-b border-red-100 dark:border-red-800 text-red-600 dark:text-red-400 text-sm flex items-center justify-between">
          <span>{saveError}</span>
          <button onClick={() => setSaveError(null)} className="text-red-400 hover:text-red-600 dark:hover:text-red-300 ml-2">✕</button>
        </div>
      )}
      <textarea
        value={editedText}
        onChange={(e) => { setEditedText(e.target.value); setIsDirty(e.target.value !== textContent); }}
        className="flex-1 p-4 font-mono text-sm resize-none bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 focus:outline-none"
        spellCheck={false}
      />
    </div>
  );

  // ── Image viewer ─────────────────────────────────────────────────────────────

  const toggleImgHeader = () => setShowImageHeader((h) => !h);
  const canZoom = imgNaturalW > 0 && imgMinZoomRef.current < 1;
  const canPan = imgNaturalW > 0 && imgZoom > imgMinZoomRef.current + 0.001;

  if (mode === 'image') return (
    <div
      ref={imgContainerRef}
      className={`fixed inset-0 z-50 bg-black overflow-hidden select-none ${canPan ? 'cursor-grab active:cursor-grabbing' : ''}`}
      onMouseDown={handleImgMouseDown}
      onMouseMove={handleImgMouseMove}
      onMouseUp={handleImgMouseUp}
      onMouseLeave={() => { dragRef.current = null; wasDragRef.current = false; }}
      onTouchStart={(e) => {
        if (e.touches.length === 2) {
          pinchStartDistRef.current = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY,
          );
          pinchStartZoomRef.current = imgZoom;
        }
      }}
    >
      {/* Pan + centering wrapper */}
      <div
        className="w-full h-full flex items-center justify-center"
        style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px)` }}
      >
        {blobUrl && (
          <img
            ref={(el) => { if (el?.complete && el.naturalWidth > 0 && imgNaturalWRef.current === 0) computeImageZoom(el); }}
            src={blobUrl}
            alt={item.name}
            onLoad={(e) => computeImageZoom(e.currentTarget)}
            style={imgNaturalW > 0
              ? { width: imgNaturalW * imgZoom, height: imgNaturalH * imgZoom, maxWidth: 'none', maxHeight: 'none' }
              : { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            className="block"
            draggable={false}
          />
        )}
      </div>

      {/* Overlay header — shown on click (toggle), hidden by default */}
      {showImageHeader && (
        <div
          className="absolute top-0 inset-x-0 flex items-center px-4 py-3 bg-gradient-to-b from-black/80 to-transparent text-white gap-2 z-10"
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <span>🖼</span>
          <span className="font-medium truncate flex-1 min-w-0">{item.name}</span>
          <CacheControls />
          {canZoom && (
            <span className="text-xs text-white/60 tabular-nums">
              {Math.round(imgZoom * 100)}% · Ctrl+scroll to zoom
            </span>
          )}
          <button
            onClick={(e) => toggleFullscreen(e, imgContainerRef)}
            title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            className="text-white/80 hover:text-white w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/20 transition-colors text-base">
            {isFullscreen ? '⊡' : '⛶'}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className="text-white/80 hover:text-white text-xl leading-none w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/20 transition-colors">
            ✕
          </button>
        </div>
      )}
    </div>
  );

  // ── Audio player ─────────────────────────────────────────────────────────────

  if (mode === 'audio') return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-900 text-white">
      <HeaderBar right={undefined} />
      <div className="flex-1 flex flex-col items-center justify-center gap-8 px-8">
        <div className="text-center space-y-2">
          <div className="text-7xl">🎵</div>
          <p className="text-lg font-medium text-gray-200">{item.name}</p>
          <p className="text-sm text-gray-400">{account.displayName ?? account.email}</p>
        </div>
        {blobUrl && (
          <audio src={blobUrl} controls
            className="w-full max-w-lg [&::-webkit-media-controls-panel]:bg-gray-800" />
        )}
      </div>
    </div>
  );

  // ── Video player (fullscreen, overlay on interaction) ────────────────────────

  if (mode === 'video') return (
    <div ref={videoContainerRef}
      className="fixed inset-0 z-50 bg-black flex items-center justify-center overflow-hidden"
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
          {/* top bar */}
          <div className="flex items-center px-4 py-3 bg-gradient-to-b from-black/70 to-transparent text-white gap-2 pointer-events-auto">
            <span>🎬</span>
            <span className="font-medium truncate flex-1 min-w-0">{item.name}</span>
            <CacheControls />
            {!isPlaying && (
              <button onClick={(e) => { e.stopPropagation(); onClose(); }}
                className="text-white/80 hover:text-white text-xl leading-none w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/20 transition-colors">
                ✕
              </button>
            )}
          </div>
          {/* centre play/pause */}
          <div className="flex-1 flex items-center justify-center pointer-events-auto">
            <button onClick={togglePlay}
              className="bg-black/60 rounded-full w-16 h-16 flex items-center justify-center text-white text-2xl hover:bg-black/80 transition-colors">
              {isPlaying ? '⏸' : '▶'}
            </button>
          </div>
          {/* bottom: seek bar + time + fullscreen */}
          <div className="flex items-center gap-3 px-4 py-3 bg-gradient-to-t from-black/70 to-transparent text-white pointer-events-auto">
            <span className="text-xs tabular-nums shrink-0 min-w-[2.5rem] text-right">{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.5}
              value={currentTime}
              onChange={(e) => {
                const t = parseFloat(e.target.value);
                setCurrentTime(t);
                if (videoRef.current) videoRef.current.currentTime = t;
              }}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 h-1 accent-white cursor-pointer"
            />
            <span className="text-xs tabular-nums shrink-0 min-w-[2.5rem]">{formatTime(duration)}</span>
            <button
              onClick={(e) => toggleFullscreen(e, videoContainerRef)}
              title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              className="text-white/80 hover:text-white w-7 h-7 flex items-center justify-center rounded hover:bg-white/20 transition-colors text-base leading-none">
              {isFullscreen ? '⊡' : '⛶'}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  // ── Unsupported / other ───────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-gray-900">
      <HeaderBar />
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
