import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { decryptPocketSnapshotPayload, parsePocketSyncFile, type PocketSnapshotPayload } from 'pocket-shared';
import { quickCryptoPocketAdapter } from '../crypto/quickCryptoAdapter';
import { hasStoredPairing, loadPairing, savePairing, clearPairing, type StoredPairing } from '../storage/secureKeyStore';
import { loadCachedSnapshotFile, saveCachedSnapshotFileAtomically, clearCachedSnapshotFile } from '../storage/snapshotStorage';
import { refreshSnapshot, type RefreshOutcome } from '../sync/refreshSnapshot';
import { resolvePocketFileId, downloadDriveFile } from '../drive/driveClient';
import { getGoogleAccessToken, isSignedInToGoogle, signInToGoogle } from '../auth/googleAuth';
import { clearClipboardNow } from '../lib/clipboardAutoClear';
import { POCKET_SYNC_FILE_NAME } from 'pocket-shared';

export type SessionPhase =
  | { kind: 'loading' }
  | { kind: 'needs_pairing' }
  | { kind: 'locked' }
  | { kind: 'unlocking' }
  | {
      kind: 'unlocked';
      payload: PocketSnapshotPayload;
      revision: number;
      lastGoodGeneratedAt: string;
      lastOutcome: RefreshOutcome | null;
      refreshing: boolean;
    }
  | { kind: 'auth_failed'; message: string };

interface PocketSessionApi {
  phase: SessionPhase;
  /** Pairing just scanned from a QR — persists it and immediately loads the first snapshot. */
  completePairing: (pairing: StoredPairing) => Promise<void>;
  /** Reads the stored pairing (triggers the OS biometric/passcode prompt) and loads/decrypts the cached or fresh snapshot. */
  unlock: () => Promise<void>;
  /** Re-checks Drive for a newer revision. No-op if not currently unlocked. */
  refreshNow: () => Promise<void>;
  /** "Olvidar este dispositivo" — local only, does not touch Desktop's pairing/revocation state. */
  forgetDevice: () => Promise<void>;
}

interface CachedSnapshot {
  payload: PocketSnapshotPayload;
  revision: number;
  generatedAt: string;
}

/**
 * How long the app may sit backgrounded and still resume without a fresh
 * biometric prompt — the "copy a value, switch to another app, paste,
 * come back" flow this whole session's real usage revolves around. Chosen
 * directly by the user as the balance between security (an unattended,
 * unlocked phone left backgrounded for a while should still re-lock) and
 * not fighting the actual usage pattern with a prompt on every app switch.
 */
const GRACE_PERIOD_MS = 5 * 60 * 1000;

/**
 * Matches react-native-keychain's own raw exception text for the cold-start
 * "native Activity not attached yet" race — see `unlock()`'s own comment
 * for the full story. A narrow, specific match on purpose: this must never
 * accidentally swallow a real user cancellation or biometric failure into a
 * silent retry.
 */
function looksLikeActivityNotReadyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return message.includes('not assigned current activity') || message.includes("activity doesn't exist");
}

const PocketSessionContext = createContext<PocketSessionApi | null>(null);

export function usePocketSession(): PocketSessionApi {
  const ctx = useContext(PocketSessionContext);
  if (!ctx) throw new Error('usePocketSession() must be used inside <PocketSessionProvider>.');
  return ctx;
}

export function PocketSessionProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<SessionPhase>({ kind: 'loading' });
  // Holds the pairing hint (dek, driveFileId, remotePath) only while
  // unlocked — never persisted here, always re-read from Keychain/Keystore
  // on each unlock() call.
  const pairingRef = useRef<StoredPairing | null>(null);

  useEffect(() => {
    let alive = true;
    void hasStoredPairing().then((has) => {
      if (alive) setPhase(has ? { kind: 'locked' } : { kind: 'needs_pairing' });
    });
    return () => {
      alive = false;
    };
  }, []);

  // When the app last went to background/inactive — read+written only by
  // the AppState listener below, never by React rendering, so it's a ref,
  // not state.
  const backgroundedAtRef = useRef<number | null>(null);

  // Background → always clear the clipboard immediately (unrelated to the
  // grace period, plain hygiene), and remember *when*. Foreground → only
  // re-lock (wipe the in-memory DEK, drop back to the biometric gate) if
  // MORE than GRACE_PERIOD_MS actually elapsed while backgrounded;
  // otherwise leave the unlocked session exactly as it was, so switching to
  // another app to paste a copied value and coming right back needs no
  // second biometric prompt.
  //
  // This does NOT weaken how the DEK is stored at rest — Keychain/Keystore,
  // its access-control flags, and the on-disk encrypted cache are all
  // completely unchanged. It only changes how long THIS APP keeps an
  // already-authenticated session's decrypted key in its own process
  // memory before discarding it and forcing a fresh Keystore-gated read —
  // a session-reauthentication policy, not a storage-security one. A killed
  // process (app swiped away, phone rebooted) always loses this in-memory
  // state regardless, so those cases already require biometry again with
  // no extra code needed.
  //
  // Critically, this handler no longer touches `phase` at all on
  // background — the previous version reset straight to 'locked' on ANY
  // 'inactive' event, including the transient 'inactive' Android itself
  // fires while the biometric system prompt overlay is showing. That made
  // an in-flight unlock() call's own biometric prompt able to retrigger
  // BiometricGateScreen's auto-unlock effect (phase bouncing back to
  // 'locked' while already 'unlocking'), a real risk of exactly the
  // duplicate-prompt/loop behavior this pass was asked to avoid. Now a
  // background/inactive blip during the prompt itself just records a
  // timestamp; the very next 'active' event sees a near-zero elapsed time
  // and does nothing.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') {
        clearClipboardNow();
        if (backgroundedAtRef.current == null) backgroundedAtRef.current = Date.now();
        return;
      }
      if (next === 'active') {
        const backgroundedAt = backgroundedAtRef.current;
        backgroundedAtRef.current = null;
        if (backgroundedAt == null) return;
        const elapsed = Date.now() - backgroundedAt;
        if (elapsed <= GRACE_PERIOD_MS) return; // within grace period — stay unlocked, no prompt
        pairingRef.current = null;
        setPhase((p) => (p.kind === 'unlocked' ? { kind: 'locked' } : p));
      }
    });
    return () => sub.remove();
  }, []);

  const loadAndDecryptCache = useCallback(async (pairing: StoredPairing): Promise<CachedSnapshot | { error: string } | null> => {
    const cached = await loadCachedSnapshotFile();
    if (!cached) return null;
    try {
      const file = parsePocketSyncFile(cached);
      const payload = decryptPocketSnapshotPayload(file, pairing.dek, quickCryptoPocketAdapter);
      return { payload, revision: file.revision, generatedAt: file.generatedAt };
    } catch (err) {
      // A corrupted/unreadable local cache is NOT the same as "no cache" —
      // surfaced distinctly so unlock() knows a fresh download is required
      // rather than silently treating this as a first-ever run.
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, []);

  const doRefresh = useCallback(async (pairing: StoredPairing, currentRevision: number | null) => {
    return refreshSnapshot(
      {
        getAccessToken: async () => {
          if (!(await isSignedInToGoogle())) await signInToGoogle();
          return getGoogleAccessToken();
        },
        resolveFileId: (token, hint) => resolvePocketFileId(token, { fileId: hint.fileId, fileName: hint.fileName }),
        downloadFile: downloadDriveFile,
        cryptoAdapter: quickCryptoPocketAdapter,
      },
      { dek: pairing.dek, driveFileId: pairing.driveFileId, fileName: POCKET_SYNC_FILE_NAME },
      currentRevision
    );
  }, []);

  const applyRefreshResult = useCallback(
    (result: Awaited<ReturnType<typeof doRefresh>>, fallback: { payload: PocketSnapshotPayload; revision: number; lastGoodGeneratedAt: string }) => {
      if (result.outcome.kind === 'updated' && result.decision?.kind === 'adopt') {
        if (result.bytes) void saveCachedSnapshotFileAtomically(result.bytes);
        setPhase({
          kind: 'unlocked',
          payload: result.decision.payload,
          revision: result.decision.file.revision,
          lastGoodGeneratedAt: result.decision.file.generatedAt,
          lastOutcome: result.outcome,
          refreshing: false,
        });
        return;
      }
      // Every other outcome: keep the fallback (last-good) data exactly as
      // it was, just record what happened for the freshness banner.
      setPhase({ kind: 'unlocked', ...fallback, lastOutcome: result.outcome, refreshing: false });
    },
    []
  );

  const unlock = useCallback(async () => {
    setPhase({ kind: 'unlocking' });
    let pairing: StoredPairing | null;
    try {
      pairing = await loadPairing('Desbloqueá Arkode Pocket');
    } catch (err) {
      // A real, reproduced cold-start race: on the very first render pass,
      // react-native-keychain's native module doesn't have its "current
      // activity" reference attached yet (that happens slightly later in
      // the Activity lifecycle), so the FIRST automatic unlock attempt can
      // fail with a raw "Not assigned current activity" exception — before
      // the user ever sees or interacts with anything. This is neither a
      // real biometric failure nor a user cancellation, so it gets exactly
      // one silent, short-delayed retry rather than surfacing a technical
      // error and forcing a manual tap for what's really just "too early."
      // Any other failure (a genuine cancel, wrong biometric, etc.) still
      // goes straight to auth_failed with no retry, same as before.
      if (looksLikeActivityNotReadyError(err)) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        try {
          pairing = await loadPairing('Desbloqueá Arkode Pocket');
        } catch (retryErr) {
          setPhase({ kind: 'auth_failed', message: retryErr instanceof Error ? retryErr.message : String(retryErr) });
          return;
        }
      } else {
        setPhase({ kind: 'auth_failed', message: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
    if (!pairing) {
      setPhase({ kind: 'needs_pairing' });
      return;
    }
    pairingRef.current = pairing;

    const cached = await loadAndDecryptCache(pairing);
    if (cached && !('error' in cached)) {
      // We have a usable local copy — show it immediately, refresh in the
      // background using its REAL revision, so an unchanged remote file
      // correctly short-circuits to "no_change" instead of redundantly
      // re-adopting identical bytes.
      const fallback = { payload: cached.payload, revision: cached.revision, lastGoodGeneratedAt: cached.generatedAt };
      setPhase({ kind: 'unlocked', ...fallback, lastOutcome: null, refreshing: true });
      const result = await doRefresh(pairing, cached.revision);
      applyRefreshResult(result, fallback);
      return;
    }

    // No usable cache (first-ever unlock, or a corrupted local file) — the
    // first real snapshot must come from Drive before anything can be shown.
    const result = await doRefresh(pairing, null);
    if (result.outcome.kind === 'updated' && result.decision?.kind === 'adopt') {
      if (result.bytes) await saveCachedSnapshotFileAtomically(result.bytes);
      setPhase({
        kind: 'unlocked',
        payload: result.decision.payload,
        revision: result.decision.file.revision,
        lastGoodGeneratedAt: result.decision.file.generatedAt,
        lastOutcome: result.outcome,
        refreshing: false,
      });
    } else {
      const message =
        'message' in result.outcome
          ? result.outcome.message
          : 'No se pudo descargar la primera actualización de Arkode Pocket.';
      setPhase({ kind: 'auth_failed', message });
    }
  }, [applyRefreshResult, doRefresh, loadAndDecryptCache]);

  const refreshNow = useCallback(async () => {
    const pairing = pairingRef.current;
    setPhase((p) => (p.kind === 'unlocked' ? { ...p, refreshing: true } : p));
    if (!pairing) return;
    setPhase((current) => {
      if (current.kind !== 'unlocked') return current;
      const fallback = { payload: current.payload, revision: current.revision, lastGoodGeneratedAt: current.lastGoodGeneratedAt };
      void doRefresh(pairing, current.revision).then((result) => applyRefreshResult(result, fallback));
      return current;
    });
  }, [applyRefreshResult, doRefresh]);

  const completePairing = useCallback(async (pairing: StoredPairing) => {
    await savePairing(pairing);
    pairingRef.current = pairing;
    setPhase({ kind: 'unlocking' });
    const result = await doRefresh(pairing, null);
    if (result.outcome.kind === 'updated' && result.decision?.kind === 'adopt') {
      if (result.bytes) await saveCachedSnapshotFileAtomically(result.bytes);
      setPhase({
        kind: 'unlocked',
        payload: result.decision.payload,
        revision: result.decision.file.revision,
        lastGoodGeneratedAt: result.decision.file.generatedAt,
        lastOutcome: result.outcome,
        refreshing: false,
      });
    } else {
      const message = 'message' in result.outcome ? result.outcome.message : 'No se pudo descargar el primer snapshot de Arkode Pocket.';
      setPhase({ kind: 'auth_failed', message });
    }
  }, [doRefresh]);

  const forgetDevice = useCallback(async () => {
    pairingRef.current = null;
    await clearPairing();
    await clearCachedSnapshotFile();
    setPhase({ kind: 'needs_pairing' });
  }, []);

  const api = useMemo<PocketSessionApi>(
    () => ({ phase, completePairing, unlock, refreshNow, forgetDevice }),
    [phase, completePairing, unlock, refreshNow, forgetDevice]
  );

  return <PocketSessionContext.Provider value={api}>{children}</PocketSessionContext.Provider>;
}
