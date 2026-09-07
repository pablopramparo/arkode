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

  // Background → clear decrypted state from memory + the clipboard;
  // foreground while locked → re-attempt unlock automatically for a fast
  // "just works" feel, with a manual retry available if it fails/cancels.
  // Deliberately NOT an idle timeout while the app stays foregrounded/active
  // — see docs/pocket.md's lifecycle section for why that distinction matters.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') {
        pairingRef.current = null;
        clearClipboardNow();
        setPhase((p) => (p.kind === 'unlocked' || p.kind === 'unlocking' ? { kind: 'locked' } : p));
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
      setPhase({ kind: 'auth_failed', message: err instanceof Error ? err.message : String(err) });
      return;
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
