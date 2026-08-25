import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon } from './icons';
import arkodeIsotipo from '../assets/arkode-isotipo.png';

/**
 * Replaces the native Windows title bar (`decorations: false` in
 * tauri.conf.json) with one that actually carries the Arkode brand, instead
 * of the plain OS-default bar. Renders nothing outside Tauri — the plain
 * browser dev workflow (`pnpm --filter ui dev` on its own) has no native
 * window to control, and `decorations` doesn't apply there anyway.
 *
 * `data-tauri-drag-region` is Tauri's own mechanism for "clicking here drags
 * the window" (and, for free, double-click toggles maximize) — no drag
 * logic to hand-write. It's on the bar and the brand label, but
 * deliberately not on the three window-control buttons, so clicks there
 * behave like normal buttons instead of starting a drag.
 */
export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    win.isMaximized().then(setIsMaximized);
    win.onResized(() => {
      win.isMaximized().then(setIsMaximized);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => unlisten?.();
  }, []);

  if (!isTauri()) return null;

  const win = getCurrentWindow();

  return (
    <div
      data-tauri-drag-region
      className="relative z-60 flex h-9 shrink-0 items-center justify-between select-none"
      style={{ backgroundColor: 'var(--surface)', borderBottom: '1px solid var(--border)' }}
    >
      <div data-tauri-drag-region className="flex items-center gap-2 pl-3 text-xs" style={{ color: 'var(--muted)' }}>
        <img src={arkodeIsotipo} alt="" className="h-4 w-4" style={{ pointerEvents: 'none' }} />
        arkode by codebius
      </div>
      <div className="flex h-full">
        <button
          type="button"
          title="Minimizar"
          onClick={() => win.minimize()}
          className="flex h-full w-11 items-center justify-center transition-colors hover:bg-white/10"
          style={{ color: 'var(--muted)' }}
        >
          <MinimizeIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={isMaximized ? 'Restaurar' : 'Maximizar'}
          onClick={() => win.toggleMaximize()}
          className="flex h-full w-11 items-center justify-center transition-colors hover:bg-white/10"
          style={{ color: 'var(--muted)' }}
        >
          {isMaximized ? <RestoreIcon className="h-3.5 w-3.5" /> : <MaximizeIcon className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          title="Cerrar"
          onClick={() => win.close()}
          className="flex h-full w-11 items-center justify-center transition-colors hover:bg-[#e81123] hover:text-white"
          style={{ color: 'var(--muted)' }}
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
