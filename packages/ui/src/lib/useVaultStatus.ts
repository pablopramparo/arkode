import { useCallback, useEffect, useState } from 'react';
import type { VaultStatus } from 'engine-core';
import { VAULT_STATUS_EVENT, fetchVaultStatus } from './vaultClient';

/**
 * Shared vault lock state. Re-fetches on mount, whenever any lifecycle call
 * fires the `arkode:vault-status` event, when the tab regains focus, and on
 * a slow poll (so an idle auto-lock in the backend is reflected).
 */
export function useVaultStatus(pollMs = 30_000) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchVaultStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onEvent = () => void refresh();
    window.addEventListener(VAULT_STATUS_EVENT, onEvent);
    window.addEventListener('focus', onEvent);
    const id = setInterval(() => void refresh(), pollMs);
    return () => {
      window.removeEventListener(VAULT_STATUS_EVENT, onEvent);
      window.removeEventListener('focus', onEvent);
      clearInterval(id);
    };
  }, [refresh, pollMs]);

  return { status, error, refresh };
}
