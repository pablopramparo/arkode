import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';

const RELEASES_URL = 'https://github.com/pablopramparo/arkode/releases/latest';

/**
 * Surfaces a partially-broken install (a missing sibling exe — the kind of
 * state a silent auto-update leaves behind when it hits a locked file)
 * instead of letting the app run in a mystery-broken state. Only meaningful
 * for files that survived enough for the app itself to start.
 */
export function InstallHealthBanner() {
  const [problems, setProblems] = useState<string[]>([]);

  useEffect(() => {
    if (!isTauri()) return;
    invoke<{ ok: boolean; problems: string[] }>('check_install_health')
      .then((r) => setProblems(r.ok ? [] : r.problems))
      .catch(() => {});
  }, []);

  if (problems.length === 0) return null;

  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-4 py-2.5 text-sm"
      style={{
        borderColor: 'var(--danger)',
        backgroundColor: 'color-mix(in oklab, var(--danger) 10%, transparent)',
        color: 'var(--danger)',
      }}
    >
      <span>
        ⚠ La instalación de arkode quedó incompleta ({problems.join(' ')}) — probablemente una actualización se cortó a
        mitad. Descargá la última versión y reinstalá (tus datos y configuraciones no se tocan).
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="ml-auto rounded-full px-3"
        onPress={() => openPath(RELEASES_URL).catch(() => {})}
      >
        Abrir descargas
      </Button>
    </div>
  );
}
