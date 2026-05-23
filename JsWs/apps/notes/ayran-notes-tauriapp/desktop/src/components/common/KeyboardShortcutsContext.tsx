import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import defaultConfig from '../../defaultKeyboardShortcuts.json';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ShortcutDef {
  name: string;
  keys: string;
}

interface ScopeConfig {
  shortcuts?: string[];
}

interface ParsedChord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  code: string;
}

interface ParsedShortcut {
  id: string;
  chords: ParsedChord[];
  scopeIds: string[];
}

// ── Key → e.code mapping ──────────────────────────────────────────────────────

const KEY_TO_CODE: Record<string, string> = {
  esc: 'Escape', escape: 'Escape',
  enter: 'Enter',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete', del: 'Delete',
  '=': 'Equal', '+': 'Equal',
  '-': 'Minus', _: 'Minus',
  '[': 'BracketLeft', ']': 'BracketRight',
  ';': 'Semicolon', "'": 'Quote',
  ',': 'Comma', '.': 'Period',
  '/': 'Slash', '\\': 'Backslash',
  '`': 'Backquote',
};

function keyToCode(key: string): string {
  const lower = key.toLowerCase();
  if (KEY_TO_CODE[lower]) return KEY_TO_CODE[lower];
  if (lower.length === 1 && lower >= 'a' && lower <= 'z') return `Key${lower.toUpperCase()}`;
  if (lower.length === 1 && lower >= '0' && lower <= '9') return `Digit${lower}`;
  if (/^f\d+$/i.test(lower)) return key.toUpperCase();
  return key;
}

function parseKeysString(keys: string): ParsedChord[] {
  return keys.split(' ').filter(Boolean).map((part) => {
    const pieces = part.split('+');
    const mods = pieces.slice(0, -1).map((p) => p.toLowerCase());
    const key = pieces[pieces.length - 1];
    return {
      ctrl: mods.includes('ctrl'),
      shift: mods.includes('shift'),
      alt: mods.includes('alt'),
      code: keyToCode(key),
    };
  });
}

function chordMatches(e: KeyboardEvent, chord: ParsedChord): boolean {
  return (
    e.ctrlKey === chord.ctrl &&
    e.shiftKey === chord.shift &&
    e.altKey === chord.alt &&
    e.code === chord.code
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildParsedShortcuts(
  shortcuts: Record<string, ShortcutDef>,
  scopes: Record<string, ScopeConfig>,
): ParsedShortcut[] {
  const shortcutToScopes: Record<string, string[]> = {};
  for (const [scopeId, scope] of Object.entries(scopes)) {
    for (const id of scope.shortcuts ?? []) {
      if (!shortcutToScopes[id]) shortcutToScopes[id] = [];
      shortcutToScopes[id].push(scopeId);
    }
  }
  return Object.entries(shortcuts).map(([id, def]) => ({
    id,
    chords: parseKeysString(def.keys),
    scopeIds: shortcutToScopes[id] ?? [],
  }));
}

function mergeShortcuts(
  defaults: Record<string, ShortcutDef>,
  overrides: Record<string, string>,
): Record<string, ShortcutDef> {
  const result = { ...defaults };
  for (const [id, keys] of Object.entries(overrides)) {
    if (result[id]) result[id] = { ...result[id], keys };
  }
  return result;
}

// ── Context ───────────────────────────────────────────────────────────────────

export interface KeyboardShortcutsContextValue {
  shortcuts: Record<string, ShortcutDef>;
  defaultShortcuts: Record<string, ShortcutDef>;
  overrides: Record<string, string>;
  registerHandler: (id: string, handler: () => void) => void;
  unregisterHandler: (id: string) => void;
  pushScopes: (scopes: string[]) => () => void;
  updateShortcutKeys: (id: string, keys: string) => void;
  resetShortcutKeys: (id: string) => void;
  saveShortcuts: (currentOverrides: Record<string, string>, syncFilePath?: string | null) => Promise<void>;
}

const defaultShortcuts = defaultConfig.shortcuts as Record<string, ShortcutDef>;
const defaultScopesConfig = defaultConfig.scopes as Record<string, ScopeConfig>;

const KeyboardShortcutsContext = createContext<KeyboardShortcutsContextValue>({
  shortcuts: defaultShortcuts,
  defaultShortcuts,
  overrides: {},
  registerHandler: () => {},
  unregisterHandler: () => {},
  pushScopes: () => () => {},
  updateShortcutKeys: () => {},
  resetShortcutKeys: () => {},
  saveShortcuts: async () => {},
});

export function KeyboardShortcutsProvider({ children }: { children: React.ReactNode }) {
  const [shortcuts, setShortcuts] = useState<Record<string, ShortcutDef>>(defaultShortcuts);
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const parsedRef = useRef<ParsedShortcut[]>(buildParsedShortcuts(defaultShortcuts, defaultScopesConfig));
  const handlersRef = useRef<Map<string, () => void>>(new Map());
  const partialMatchesRef = useRef<Array<{ id: string; chordIndex: number }>>([]);
  const scopeKeyRef = useRef(0);
  const scopeStackRef = useRef<Array<{ key: number; scopes: string[] }>>([]);

  useEffect(() => {
    parsedRef.current = buildParsedShortcuts(shortcuts, defaultScopesConfig);
  }, [shortcuts]);

  // Load user overrides from Rust backend on mount
  useEffect(() => {
    invoke<string | null>('read_keyboard_shortcuts')
      .then((json) => {
        if (!json) return;
        try {
          const data = JSON.parse(json) as Record<string, string>;
          setOverrides(data);
          setShortcuts(mergeShortcuts(defaultShortcuts, data));
        } catch { /* ignore corrupt file */ }
      })
      .catch(() => {});
  }, []);

  // Global keydown handler — reads from refs only (always up to date, no stale closures)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Never intercept bare Enter (textarea submit, button activation, etc.)
      if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) return;

      const topFrame = scopeStackRef.current[scopeStackRef.current.length - 1];
      const activeScopes = new Set<string>(topFrame?.scopes ?? ['global']);
      const candidates = parsedRef.current.filter((s) =>
        s.scopeIds.some((sid) => activeScopes.has(sid)),
      );

      let anyMatch = false;
      let fullMatchId: string | null = null;
      const newPartials: Array<{ id: string; chordIndex: number }> = [];

      // Continue existing partial matches
      for (const pm of partialMatchesRef.current) {
        const s = candidates.find((c) => c.id === pm.id);
        if (!s) continue;
        const chord = s.chords[pm.chordIndex];
        if (!chord) continue;
        if (chordMatches(e, chord)) {
          anyMatch = true;
          const next = pm.chordIndex + 1;
          if (next >= s.chords.length) {
            fullMatchId = pm.id;
            break;
          }
          newPartials.push({ id: pm.id, chordIndex: next });
        }
      }

      // Fresh starts (only if no full match yet)
      if (!fullMatchId) {
        for (const s of candidates) {
          if (newPartials.some((p) => p.id === s.id)) continue; // already continuing
          if (!chordMatches(e, s.chords[0])) continue;
          anyMatch = true;
          if (s.chords.length === 1) {
            fullMatchId = s.id;
            break;
          }
          newPartials.push({ id: s.id, chordIndex: 1 });
        }
      }

      if (anyMatch || fullMatchId !== null) {
        e.preventDefault();
        if (fullMatchId) {
          partialMatchesRef.current = [];
          handlersRef.current.get(fullMatchId)?.();
        } else {
          partialMatchesRef.current = newPartials;
        }
      } else {
        partialMatchesRef.current = [];
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const registerHandler = useCallback((id: string, handler: () => void) => {
    handlersRef.current.set(id, handler);
  }, []);

  const unregisterHandler = useCallback((id: string) => {
    handlersRef.current.delete(id);
  }, []);

  const pushScopes = useCallback((scopes: string[]) => {
    const key = ++scopeKeyRef.current;
    scopeStackRef.current = [...scopeStackRef.current, { key, scopes }];
    return () => {
      scopeStackRef.current = scopeStackRef.current.filter((f) => f.key !== key);
    };
  }, []);

  const updateShortcutKeys = useCallback((id: string, keys: string) => {
    setShortcuts((prev) => {
      const def = defaultShortcuts[id];
      if (!def) return prev;
      return { ...prev, [id]: { ...def, keys } };
    });
    setOverrides((prev) => ({ ...prev, [id]: keys }));
  }, []);

  const resetShortcutKeys = useCallback((id: string) => {
    setShortcuts((prev) => {
      const def = defaultShortcuts[id];
      if (!def) return prev;
      return { ...prev, [id]: def };
    });
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const saveShortcuts = useCallback(
    async (currentOverrides: Record<string, string>, syncFilePath?: string | null) => {
      const json = JSON.stringify(currentOverrides, null, 2);
      await invoke('write_keyboard_shortcuts', { content: json });
      if (syncFilePath) {
        await invoke('write_file_text', { path: syncFilePath, content: json });
      }
    },
    [],
  );

  return (
    <KeyboardShortcutsContext.Provider
      value={{ shortcuts, defaultShortcuts, overrides, registerHandler, unregisterHandler, pushScopes, updateShortcutKeys, resetShortcutKeys, saveShortcuts }}
    >
      {children}
    </KeyboardShortcutsContext.Provider>
  );
}

export function useKeyboardShortcuts() {
  return useContext(KeyboardShortcutsContext);
}

// Register a handler for a shortcut — auto-unregisters on unmount.
// The handler ref pattern ensures the latest closure is always called.
export function useKeyboardShortcut(id: string, handler: () => void) {
  const { registerHandler, unregisterHandler } = useKeyboardShortcuts();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    registerHandler(id, () => handlerRef.current());
    return () => unregisterHandler(id);
  }, [id, registerHandler, unregisterHandler]);
}

// Push scopes while mounted — auto-pops on unmount.
// Scopes are captured once on mount; pass stable literals or useMemo'd arrays.
export function useKeyboardScopes(scopes: string[]) {
  const { pushScopes } = useKeyboardShortcuts();
  const scopesRef = useRef(scopes);

  useEffect(() => {
    return pushScopes(scopesRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushScopes]);
}
