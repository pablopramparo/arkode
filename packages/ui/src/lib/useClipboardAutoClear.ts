import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Copies a value to the clipboard and, after `timeoutMs`, overwrites the
 * clipboard with an empty string. Best-effort: a browser can refuse both
 * the write and the later clear, and Windows Clipboard History (Win+V) is
 * outside our reach — the UI documents that. Returns which ref was last
 * copied (so a row can show a transient "copiado" state) and the copy fn.
 */
export function useClipboardAutoClear(timeoutMs = 30_000) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (clearTimer.current) clearTimeout(clearTimer.current);
    },
    []
  );

  const copy = useCallback(
    async (value: string, key: string) => {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        return false;
      }
      setCopiedKey(key);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopiedKey(null), 1500);

      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => {
        navigator.clipboard.writeText('').catch(() => {});
      }, timeoutMs);
      return true;
    },
    [timeoutMs]
  );

  return { copy, copiedKey };
}
