import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { readFile } from '@tauri-apps/plugin-fs';
import type { StoredAccount, CachedItem } from '../types';

interface DownloadProgress { loaded: number; total: number | null; }

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

interface Props {
  account: StoredAccount;
  item: CachedItem;
  onClose: () => void;
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

export default function FileViewer({ account, item, onClose }: Props) {
  const mode = detectMode(item);

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

  // image overlay
  const [showImageHeader, setShowImageHeader] = useState(false);

  // video controls
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);
  const [showVideoControls, setShowVideoControls] = useState(true);
  const videoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // cache management dropdown
  const [cacheMenuOpen, setCacheMenuOpen] = useState(false);
  const cacheMenuRef = useRef<HTMLDivElement>(null);

  // ── Load file ────────────────────────────────────────────────────────────────

  // Listen for download progress events emitted by the Rust backend.
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
      const path = await invoke<string>('open_file', { accountId: account.id, itemId: item.itemId, force });

      if (mode === 'text') {
        const bytes = await readFile(path);
        const text = new TextDecoder('utf-8').decode(bytes);
        setTextContent(text); setEditedText(text); setIsDirty(false);
      } else if (mode !== 'unsupported') {
        // Use asset protocol — no file is loaded into JS memory, supports range
        // requests for seeking, and handles any file size safely.
        setBlobUrl(convertFileSrc(path));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [account.id, item.itemId, item.mimeType, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void loadFile(false);
    return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      await invoke('save_text_file', {
        accountId: account.id,
        itemId: item.itemId,
        parentId: item.parentId,
        content: editedText,
      });
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
      await invoke('delete_cached_file', { accountId: account.id, itemId: item.itemId }).catch(() => {});
    }
  };

  // ── Video controls ───────────────────────────────────────────────────────────

  const showVideoControlsBriefly = () => {
    setShowVideoControls(true);
    if (videoTimerRef.current) clearTimeout(videoTimerRef.current);
    if (isPlayingRef.current) {
      videoTimerRef.current = setTimeout(() => setShowVideoControls(false), 3000);
    }
  };

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
        className="px-1.5 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-r-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
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

  const HeaderBar = ({ right }: { right?: React.ReactNode }) => (
    <div className="flex items-center px-4 py-3 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 gap-2 shrink-0">
      <button onClick={onClose}
        className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors shrink-0">
        ← Back
      </button>
      <span className="text-gray-300 dark:text-gray-600 shrink-0">|</span>
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
        <button onClick={handleSave} disabled={!isDirty || saving}
          className="px-3 py-1 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors">
          {saving ? 'Saving…' : '💾 Save'}
        </button>
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

  // ── Image viewer (fullscreen, tap to toggle header) ──────────────────────────

  if (mode === 'image') return (
    <div className="fixed inset-0 z-50 bg-black flex items-center justify-center cursor-pointer"
      onClick={() => setShowImageHeader(h => !h)}>
      {showImageHeader && (
        <div className="absolute top-0 inset-x-0 flex items-center px-4 py-3 bg-gradient-to-b from-black/80 to-transparent text-white gap-2 z-10"
          onClick={e => e.stopPropagation()}>
          <span>🖼</span>
          <span className="font-medium truncate flex-1 min-w-0">{item.name}</span>
          <CacheControls />
          <button onClick={onClose}
            className="text-white/80 hover:text-white text-xl leading-none w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/20 transition-colors">
            ✕
          </button>
        </div>
      )}
      {blobUrl && (
        <img src={blobUrl} alt={item.name}
          className="max-w-full max-h-full object-contain select-none"
          draggable={false}
          onClick={e => e.stopPropagation()} />
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

  // ── Video player (fullscreen, overlay on click) ───────────────────────────────

  if (mode === 'video') return (
    <div className="fixed inset-0 z-50 bg-black flex items-center justify-center overflow-hidden"
      onClick={showVideoControlsBriefly}
      onMouseMove={showVideoControlsBriefly}
      onTouchStart={showVideoControlsBriefly}>
      {blobUrl && (
        <video ref={videoRef} src={blobUrl}
          className="w-full h-full object-contain"
          onPlay={() => { setIsPlaying(true); isPlayingRef.current = true; showVideoControlsBriefly(); }}
          onPause={() => { setIsPlaying(false); isPlayingRef.current = false; if (videoTimerRef.current) clearTimeout(videoTimerRef.current); setShowVideoControls(true); }}
          onEnded={() => { setIsPlaying(false); isPlayingRef.current = false; setShowVideoControls(true); }}
          onClick={e => e.stopPropagation()} />
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
          {/* bottom spacer for visual balance */}
          <div className="h-12" />
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
