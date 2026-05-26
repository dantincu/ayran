import { useState, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const DEFAULT_PAGE_JUMP = 10;

export interface UseListKeyNavOptions {
  totalItems: number;
  pageSize: number;
  page: number;
  onPage: (p: number) => void;
  onOpen: (absIdx: number) => void;
  onNavigateInto?: (absIdx: number) => void;
  onParent?: () => void;
  onOpenSelectPageModal?: () => void;
  onOpenEditPagePopover?: () => void;
  onRefresh?: () => void;
  onHardRefresh?: () => void;
  onClearCache?: () => void;
  containerRef: RefObject<HTMLElement | null>;
  pageJump?: number;
  listKey?: unknown;
  currentAbsIdx?: number;
}

export function useListKeyNav({
  totalItems,
  pageSize,
  page,
  onPage,
  onOpen,
  onNavigateInto,
  onParent,
  onOpenSelectPageModal,
  onOpenEditPagePopover,
  onRefresh,
  onHardRefresh,
  onClearCache,
  containerRef,
  pageJump = DEFAULT_PAGE_JUMP,
  listKey,
  currentAbsIdx,
}: UseListKeyNavOptions) {
  const [focusedAbsIdx, setFocusedAbsIdx] = useState(-1);
  const ctrlMPressedRef = useRef(false);
  const listKeyRef = useRef(listKey);

  useEffect(() => {
    if (!Object.is(listKeyRef.current, listKey)) {
      listKeyRef.current = listKey;
      setFocusedAbsIdx(-1);
    }
  }, [listKey]);

  useEffect(() => {
    if (totalItems === 0) {
      setFocusedAbsIdx(-1);
    } else {
      setFocusedAbsIdx((prev) => (prev >= totalItems ? totalItems - 1 : prev));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalItems]);

  const ps = Math.max(1, pageSize);
  const focusedRelIdx =
    focusedAbsIdx >= 0 &&
    focusedAbsIdx >= page * ps &&
    focusedAbsIdx < (page + 1) * ps
      ? focusedAbsIdx - page * ps
      : -1;

  useEffect(() => {
    if (focusedRelIdx < 0 || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-nav-idx="${focusedRelIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusedAbsIdx, focusedRelIdx, containerRef]);

  function navigate(newAbsIdx: number) {
    if (totalItems === 0) return;
    const clamped = Math.max(0, Math.min(totalItems - 1, newAbsIdx));
    const newPage = Math.floor(clamped / ps);
    if (newPage !== page) onPage(newPage);
    setFocusedAbsIdx(clamped);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable
    ) return;

    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyM') {
      ctrlMPressedRef.current = true;
      return;
    }

    if (ctrlMPressedRef.current) {
      ctrlMPressedRef.current = false;
      if (!e.altKey && !e.metaKey && e.code === 'KeyP') {
        e.preventDefault();
        if (e.shiftKey && !e.ctrlKey) onOpenEditPagePopover?.();
        else if (!e.shiftKey && !e.ctrlKey) onOpenSelectPageModal?.();
      } else if (!e.altKey && !e.metaKey && e.code === 'KeyR') {
        e.preventDefault();
        if (e.ctrlKey && e.shiftKey) onHardRefresh?.();
        else if (e.shiftKey && !e.ctrlKey) onClearCache?.();
        else if (!e.ctrlKey && !e.shiftKey) onRefresh?.();
      }
      return;
    }

    if (totalItems === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        navigate(focusedAbsIdx < 0 ? (currentAbsIdx != null && currentAbsIdx >= 0 ? currentAbsIdx : page * ps) : focusedAbsIdx + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        navigate(focusedAbsIdx < 0 ? (currentAbsIdx != null && currentAbsIdx >= 0 ? currentAbsIdx : Math.min((page + 1) * ps, totalItems) - 1) : focusedAbsIdx - 1);
        break;
      case 'PageDown':
        e.preventDefault();
        navigate(focusedAbsIdx < 0 ? Math.min(page * ps + pageJump - 1, totalItems - 1) : focusedAbsIdx + pageJump);
        break;
      case 'PageUp':
        e.preventDefault();
        navigate(focusedAbsIdx < 0 ? page * ps : focusedAbsIdx - pageJump);
        break;
      case 'Home':
        e.preventDefault();
        navigate(0);
        break;
      case 'End':
        e.preventDefault();
        navigate(totalItems - 1);
        break;
      case 'Enter':
        if (focusedAbsIdx >= 0) {
          e.preventDefault();
          onOpen(focusedAbsIdx);
        }
        break;
      case 'ArrowRight':
        if (focusedAbsIdx >= 0) {
          e.preventDefault();
          (onNavigateInto ?? onOpen)(focusedAbsIdx);
        }
        break;
      case 'ArrowLeft':
        if (onParent) {
          e.preventDefault();
          onParent();
        }
        break;
    }
  }

  return {
    focusedAbsIdx,
    setFocusedAbsIdx,
    focusedRelIdx,
    containerProps: { tabIndex: 0 as const, onKeyDown, 'data-list-nav-container': 'true' },
  };
}
