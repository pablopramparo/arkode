import * as Clipboard from 'expo-clipboard';

/**
 * Copy-with-auto-clear, mirroring Desktop's own `useClipboardAutoClear`
 * (30s). Deliberately UNCONDITIONAL clears (never reads the clipboard back
 * to check "is it still what we copied" first) — reading the clipboard
 * itself triggers the OS's own "pasted from Arkode Pocket" indicator on
 * recent Android/iOS, which is unnecessary noise for a plain internal
 * clear. The trade-off (a clear could technically stomp something the user
 * copied from a different app inside the same 30s window) is accepted as
 * the honest, simpler behavior — never promise the clipboard couldn't have
 * been read by another app before the clear fires; that's outside this
 * app's control on either platform.
 *
 * `clearClipboardNow()` (called on app backgrounding) only does anything if
 * THIS module is the one that put something on the clipboard and it hasn't
 * auto-cleared yet — backgrounding the app must never wipe clipboard
 * content the user copied from somewhere else entirely.
 */
const AUTO_CLEAR_MS = 30_000;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
let hasPendingCopy = false;

export async function copyWithAutoClear(value: string): Promise<void> {
  if (clearTimer) clearTimeout(clearTimer);
  await Clipboard.setStringAsync(value);
  hasPendingCopy = true;
  clearTimer = setTimeout(() => {
    clearTimer = null;
    hasPendingCopy = false;
    void Clipboard.setStringAsync('').catch(() => {});
  }, AUTO_CLEAR_MS);
}

/** Called on app backgrounding — see App.tsx's AppState listener. No-op if Pocket never copied anything (or it already auto-cleared). */
export function clearClipboardNow(): void {
  if (!hasPendingCopy) return;
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  hasPendingCopy = false;
  void Clipboard.setStringAsync('').catch(() => {});
}
