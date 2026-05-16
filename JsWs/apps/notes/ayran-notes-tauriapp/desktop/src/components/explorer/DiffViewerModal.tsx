import { useState, useMemo, useRef, useEffect, useCallback } from 'react';

// ── Diff algorithm (LCS-based) ────────────────────────────────────────────────

type DiffOp = { t: 'same' | 'del' | 'ins'; s: string };

function computeDiff(left: string[], right: string[]): DiffOp[] {
  // Safety cap: fall back to block-diff for very large files.
  if (left.length * right.length > 4_000_000) {
    return [
      ...left.map((s): DiffOp => ({ t: 'del', s })),
      ...right.map((s): DiffOp => ({ t: 'ins', s })),
    ];
  }
  const m = left.length, n = right.length;
  // Use typed arrays for speed.
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = left[i-1] === right[j-1]
        ? dp[i-1][j-1] + 1
        : Math.max(dp[i-1][j], dp[i][j-1]);
  const ops: DiffOp[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && left[i-1] === right[j-1]) {
      ops.unshift({ t: 'same', s: left[i-1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      ops.unshift({ t: 'ins', s: right[j-1] }); j--;
    } else {
      ops.unshift({ t: 'del', s: left[i-1] }); i--;
    }
  }
  return ops;
}

// ── Row + Hunk model ──────────────────────────────────────────────────────────

interface Row {
  kind: 'same' | 'del' | 'ins' | 'hunk-header';
  text?: string;
  ln?: number;   // left (original) line number
  rn?: number;   // right (modified) line number
  hunkId: number; // -1 for 'same'
}

type HunkChoice = 'left' | 'right' | 'both';

function buildRows(ops: DiffOp[]): { rows: Row[]; hunkCount: number } {
  const rows: Row[] = [];
  let hunkId = -1, ln = 1, rn = 1, i = 0;
  while (i < ops.length) {
    if (ops[i].t === 'same') {
      rows.push({ kind: 'same', text: ops[i].s, ln: ln++, rn: rn++, hunkId: -1 });
      i++;
    } else {
      hunkId++;
      rows.push({ kind: 'hunk-header', hunkId });
      while (i < ops.length && ops[i].t !== 'same') {
        if (ops[i].t === 'del') rows.push({ kind: 'del', text: ops[i].s, ln: ln++, hunkId });
        else                    rows.push({ kind: 'ins', text: ops[i].s, rn: rn++, hunkId });
        i++;
      }
    }
  }
  return { rows, hunkCount: hunkId + 1 };
}

function computeResult(rows: Row[], hunks: Map<number, HunkChoice>): string {
  const lines: string[] = [];
  let delBuf: string[] = [], insBuf: string[] = [], curHunk = -1;
  const flush = () => {
    if (curHunk < 0) return;
    const choice = hunks.get(curHunk) ?? 'right';
    if (choice === 'left')       lines.push(...delBuf);
    else if (choice === 'right') lines.push(...insBuf);
    else                         lines.push(...delBuf, ...insBuf);
    delBuf = []; insBuf = []; curHunk = -1;
  };
  for (const row of rows) {
    if (row.kind === 'same')        { flush(); lines.push(row.text!); }
    else if (row.kind === 'hunk-header') { flush(); curHunk = row.hunkId; }
    else if (row.kind === 'del')   delBuf.push(row.text!);
    else if (row.kind === 'ins')   insBuf.push(row.text!);
  }
  flush();
  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function numCell(n: number | undefined, extra: string): React.ReactNode {
  return (
    <span className={`select-none text-right pr-2 shrink-0 w-10 text-gray-400 dark:text-gray-600 text-[10px] leading-5 ${extra}`}>
      {n ?? ''}
    </span>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  filename?: string;
  leftLabel?: string;
  rightLabel?: string;
  // Provide content directly OR via async loaders.
  leftContent?: string;
  rightContent?: string;
  loadLeft?: () => Promise<string>;
  loadRight?: () => Promise<string>;
  onApply?: (result: string) => void;
  onDiscard?: () => void;
  onClose: () => void;
  // When true: skip diff computation and show only "use original" / "use modified" buttons.
  binaryMode?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DiffViewerModal({
  filename, leftLabel = 'Original', rightLabel = 'Modified', binaryMode = false,
  leftContent: leftProp, rightContent: rightProp,
  loadLeft, loadRight,
  onApply, onDiscard, onClose,
}: Props) {
  const [leftContent, setLeftContent] = useState(leftProp ?? '');
  const [rightContent, setRightContent] = useState(rightProp ?? '');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!(loadLeft || loadRight));

  const [hunks, setHunks] = useState<Map<number, HunkChoice>>(new Map());
  const [layout, setLayout] = useState<'side' | 'stack'>('side');
  const [leftVisible, setLeftVisible] = useState(true);
  const [rightVisible, setRightVisible] = useState(true);

  // Vertical-mode scroll sync refs.
  const topRef = useRef<HTMLDivElement>(null);
  const botRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false);

  // ── Binary mode: skip loading and diff entirely ───────────────────────────

  if (binaryMode) return (
    <div className="fixed inset-0 z-[60] bg-white dark:bg-gray-900 flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white truncate flex-1" title={filename}>
          Compare{filename ? `: ${filename}` : ''}
        </h2>
        <button onClick={onClose} className="p-1.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4"><path d="M3.3 3.3a1 1 0 011.4 0L8 6.6l3.3-3.3a1 1 0 111.4 1.4L9.4 8l3.3 3.3a1 1 0 01-1.4 1.4L8 9.4l-3.3 3.3a1 1 0 01-1.4-1.4L6.6 8 3.3 4.7a1 1 0 010-1.4z"/></svg>
        </button>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center gap-6 text-center px-8">
        <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-10 h-10 text-gray-300 dark:text-gray-600"><path d="M8 6h16l8 8v20a2 2 0 01-2 2H8a2 2 0 01-2-2V8a2 2 0 012-2z"/><path d="M24 6v8h8"/></svg>
        <p className="text-sm text-gray-500 dark:text-gray-400 max-w-xs">
          This is a binary file. Choose which version to keep.
        </p>
        <div className="flex gap-3">
          {onDiscard && (
            <button onClick={onDiscard}
              className="px-4 py-2 text-sm bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-lg hover:bg-blue-200 dark:hover:bg-blue-800/40 transition-colors">
              ← Use {leftLabel}
            </button>
          )}
          <button onClick={onClose}
            className="px-4 py-2 text-sm bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded-lg hover:bg-green-200 dark:hover:bg-green-800/40 transition-colors">
            → Use {rightLabel}
          </button>
        </div>
      </div>
    </div>
  );

  // Load async content on mount if loaders were provided.
  useEffect(() => {
    if (!loadLeft && !loadRight) return;
    setLoading(true);
    Promise.all([
      loadLeft ? loadLeft() : Promise.resolve(leftProp ?? ''),
      loadRight ? loadRight() : Promise.resolve(rightProp ?? ''),
    ]).then(([l, r]) => {
      setLeftContent(l); setRightContent(r);
    }).catch((e) => {
      setLoadError(e instanceof Error ? e.message : String(e));
    }).finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { rows, hunkCount } = useMemo(() => {
    if (loading) return { rows: [], hunkCount: 0 };
    const ops = computeDiff(leftContent.split('\n'), rightContent.split('\n'));
    return buildRows(ops);
  }, [leftContent, rightContent, loading]);

  // Initialise hunks to 'right' (keep modified) when rows are built.
  useEffect(() => {
    if (hunkCount === 0) return;
    setHunks((prev) => {
      if (prev.size === hunkCount) return prev;
      const m = new Map<number, HunkChoice>();
      for (let i = 0; i < hunkCount; i++) m.set(i, prev.get(i) ?? 'right');
      return m;
    });
  }, [hunkCount]);

  const setChoice = useCallback((id: number, choice: HunkChoice) => {
    setHunks((prev) => { const m = new Map(prev); m.set(id, choice); return m; });
  }, []);

  const acceptAll  = () => setHunks((prev) => { const m = new Map(prev); for (const k of m.keys()) m.set(k, 'right'); return m; });
  const rejectAll  = () => setHunks((prev) => { const m = new Map(prev); for (const k of m.keys()) m.set(k, 'left');  return m; });
  const handleApply   = () => onApply?.(computeResult(rows, hunks));
  const handleDiscard = () => onDiscard?.();

  // Vertical scroll sync.
  const onTopScroll = () => {
    if (syncingRef.current || !botRef.current || !topRef.current) return;
    syncingRef.current = true;
    const ratio = topRef.current.scrollTop / (topRef.current.scrollHeight - topRef.current.clientHeight || 1);
    botRef.current.scrollTop = ratio * (botRef.current.scrollHeight - botRef.current.clientHeight);
    syncingRef.current = false;
  };
  const onBotScroll = () => {
    if (syncingRef.current || !botRef.current || !topRef.current) return;
    syncingRef.current = true;
    const ratio = botRef.current.scrollTop / (botRef.current.scrollHeight - botRef.current.clientHeight || 1);
    topRef.current.scrollTop = ratio * (topRef.current.scrollHeight - topRef.current.clientHeight);
    syncingRef.current = false;
  };

  const isDiff = hunkCount > 0;

  // ── Row renderers ─────────────────────────────────────────────────────────

  const renderHunkHeader = (row: Row) => {
    const choice = hunks.get(row.hunkId) ?? 'right';
    const btn = (c: HunkChoice, label: string, title: string, color: string) => (
      <button
        key={c}
        onClick={() => setChoice(row.hunkId, c)}
        title={title}
        className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
          choice === c
            ? `${color} font-semibold`
            : 'text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
        }`}
      >{label}</button>
    );
    return (
      <div key={`hh-${row.hunkId}`} className="flex items-center gap-1 px-2 py-0.5 bg-gray-100 dark:bg-gray-800 border-y border-gray-200 dark:border-gray-700 text-[11px] select-none sticky top-0 z-10">
        <span className="text-gray-400 dark:text-gray-500 mr-1">Change {row.hunkId + 1}</span>
        {btn('left',  '← Original', 'Keep the original version', 'text-blue-600 dark:text-blue-400')}
        {btn('both',  '↔ Both',     'Keep both versions',        'text-purple-600 dark:text-purple-400')}
        {btn('right', '→ Modified', 'Keep the modified version', 'text-green-600 dark:text-green-400')}
      </div>
    );
  };

  // ── Horizontal mode: single scroll container ──────────────────────────────

  const renderHorizontal = () => (
    <div className="flex-1 overflow-y-auto overflow-x-auto">
      {rows.map((row, idx) => {
        if (row.kind === 'hunk-header') return renderHunkHeader(row);
        if (row.kind === 'same') return (
          <div key={idx} className="flex min-h-[20px] border-b border-gray-100 dark:border-gray-800/60">
            {leftVisible && (
              <div className="flex shrink-0 w-1/2 border-r border-gray-200 dark:border-gray-700">
                {numCell(row.ln, '')}
                <span className="flex-1 px-1 font-mono text-xs leading-5 whitespace-pre text-gray-700 dark:text-gray-300 overflow-hidden">{row.text}</span>
              </div>
            )}
            {rightVisible && (
              <div className="flex shrink-0 w-1/2">
                {numCell(row.rn, '')}
                <span className="flex-1 px-1 font-mono text-xs leading-5 whitespace-pre text-gray-700 dark:text-gray-300 overflow-hidden">{row.text}</span>
              </div>
            )}
          </div>
        );
        if (row.kind === 'del') return (
          <div key={idx} className="flex min-h-[20px] border-b border-red-100 dark:border-red-900/30">
            {leftVisible && (
              <div className="flex shrink-0 w-1/2 bg-red-50 dark:bg-red-900/20 border-r border-gray-200 dark:border-gray-700">
                {numCell(row.ln, 'text-red-400')}
                <span className="flex-1 px-1 font-mono text-xs leading-5 whitespace-pre text-red-700 dark:text-red-300 overflow-hidden">{row.text}</span>
              </div>
            )}
            {rightVisible && (
              <div className="flex shrink-0 w-1/2 bg-gray-50 dark:bg-gray-800/40">
                {numCell(undefined, '')}
                <span className="flex-1" />
              </div>
            )}
          </div>
        );
        // ins
        return (
          <div key={idx} className="flex min-h-[20px] border-b border-green-100 dark:border-green-900/30">
            {leftVisible && (
              <div className="flex shrink-0 w-1/2 bg-gray-50 dark:bg-gray-800/40 border-r border-gray-200 dark:border-gray-700">
                {numCell(undefined, '')}
                <span className="flex-1" />
              </div>
            )}
            {rightVisible && (
              <div className="flex shrink-0 w-1/2 bg-green-50 dark:bg-green-900/20">
                {numCell(row.rn, 'text-green-500')}
                <span className="flex-1 px-1 font-mono text-xs leading-5 whitespace-pre text-green-700 dark:text-green-300 overflow-hidden">{row.text}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  // ── Vertical mode: two stacked panels with JS scroll sync ─────────────────

  const renderPanel = (side: 'left' | 'right', ref: React.RefObject<HTMLDivElement | null>, onScroll: () => void) => {
    const isLeft = side === 'left';
    return (
      <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto overflow-x-auto border-b border-gray-200 dark:border-gray-700">
        {rows.map((row, idx) => {
          if (row.kind === 'hunk-header') return isLeft ? renderHunkHeader(row) : null;
          if (row.kind === 'same') return (
            <div key={idx} className="flex min-h-[20px] border-b border-gray-100 dark:border-gray-800/60">
              {numCell(isLeft ? row.ln : row.rn, '')}
              <span className="flex-1 px-1 font-mono text-xs leading-5 whitespace-pre text-gray-700 dark:text-gray-300 overflow-hidden">{row.text}</span>
            </div>
          );
          if (row.kind === 'del' && isLeft) return (
            <div key={idx} className="flex min-h-[20px] border-b border-red-100 dark:border-red-900/30 bg-red-50 dark:bg-red-900/20">
              {numCell(row.ln, 'text-red-400')}
              <span className="flex-1 px-1 font-mono text-xs leading-5 whitespace-pre text-red-700 dark:text-red-300 overflow-hidden">{row.text}</span>
            </div>
          );
          if (row.kind === 'ins' && !isLeft) return (
            <div key={idx} className="flex min-h-[20px] border-b border-green-100 dark:border-green-900/30 bg-green-50 dark:bg-green-900/20">
              {numCell(row.rn, 'text-green-500')}
              <span className="flex-1 px-1 font-mono text-xs leading-5 whitespace-pre text-green-700 dark:text-green-300 overflow-hidden">{row.text}</span>
            </div>
          );
          return null;
        })}
      </div>
    );
  };

  const renderVertical = () => (
    <div className="flex-1 flex flex-col overflow-hidden">
      {leftVisible && renderPanel('left',  topRef, onTopScroll)}
      {rightVisible && renderPanel('right', botRef, onBotScroll)}
    </div>
  );

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-[60] bg-white dark:bg-gray-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white truncate flex-1" title={filename}>
          Compare{filename ? `: ${filename}` : ''}
        </h2>
        {/* Layout toggle */}
        <button
          onClick={() => setLayout((l) => l === 'side' ? 'stack' : 'side')}
          title={layout === 'side' ? 'Switch to top/bottom layout' : 'Switch to side-by-side layout'}
          className="p-1.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          {layout === 'side'
            ? <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="2" width="6" height="12" rx="1"/><rect x="9" y="2" width="6" height="12" rx="1"/></svg>
            : <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4"><rect x="1" y="2" width="14" height="5" rx="1"/><rect x="1" y="9" width="14" height="5" rx="1"/></svg>
          }
        </button>
        <button onClick={onClose} className="p-1.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4"><path d="M3.3 3.3a1 1 0 011.4 0L8 6.6l3.3-3.3a1 1 0 111.4 1.4L9.4 8l3.3 3.3a1 1 0 01-1.4 1.4L8 9.4l-3.3 3.3a1 1 0 01-1.4-1.4L6.6 8 3.3 4.7a1 1 0 010-1.4z"/></svg>
        </button>
      </div>

      {/* Panel labels + collapse toggles */}
      <div className={`flex shrink-0 border-b border-gray-200 dark:border-gray-700 text-xs ${layout === 'stack' ? 'flex-col' : ''}`}>
        {layout === 'side' ? (
          <>
            <div className="w-1/2 flex items-center gap-2 px-3 py-1 border-r border-gray-200 dark:border-gray-700">
              <span className="font-medium text-gray-600 dark:text-gray-400 flex-1">{leftLabel}</span>
              <button onClick={() => setLeftVisible((v) => !v)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">{leftVisible ? '▼' : '▶'}</button>
            </div>
            <div className="w-1/2 flex items-center gap-2 px-3 py-1">
              <span className="font-medium text-gray-600 dark:text-gray-400 flex-1">{rightLabel}</span>
              <button onClick={() => setRightVisible((v) => !v)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">{rightVisible ? '▼' : '▶'}</button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 py-1 border-b border-gray-100 dark:border-gray-800">
              <span className="font-medium text-gray-600 dark:text-gray-400 flex-1">{leftLabel}</span>
              <button onClick={() => setLeftVisible((v) => !v)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">{leftVisible ? '▲' : '▼'}</button>
            </div>
            <div className="flex items-center gap-2 px-3 py-1">
              <span className="font-medium text-gray-600 dark:text-gray-400 flex-1">{rightLabel}</span>
              <button onClick={() => setRightVisible((v) => !v)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">{rightVisible ? '▲' : '▼'}</button>
            </div>
          </>
        )}
      </div>

      {/* Action bar */}
      {!loading && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-gray-100 dark:border-gray-800 shrink-0 flex-wrap">
          {isDiff ? (
            <>
              <button onClick={acceptAll} className="px-2 py-1 text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded hover:bg-green-200 dark:hover:bg-green-800/40 transition-colors">
                → Accept all
              </button>
              <button onClick={rejectAll} className="px-2 py-1 text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200 dark:hover:bg-blue-800/40 transition-colors">
                ← Reject all
              </button>
            </>
          ) : (
            <span className="text-xs text-gray-400 dark:text-gray-500 italic">No differences</span>
          )}
          <div className="flex-1" />
          {onDiscard && (
            <button onClick={handleDiscard} className="px-2 py-1 text-xs bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded hover:bg-red-200 dark:hover:bg-red-800/40 transition-colors">
              Discard changes
            </button>
          )}
          {onApply && (
            <button onClick={handleApply} disabled={!isDiff} className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40 transition-colors">
              Apply
            </button>
          )}
        </div>
      )}

      {/* Body */}
      {loading && (
        <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500 text-sm">Loading…</div>
      )}
      {loadError && (
        <div className="flex-1 flex items-center justify-center text-red-500 text-sm px-8 text-center">{loadError}</div>
      )}
      {!loading && !loadError && (
        layout === 'side' ? renderHorizontal() : renderVertical()
      )}
    </div>
  );
}
