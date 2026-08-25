import type { ReactNode } from 'react';

/**
 * A plain overlay + panel, not HeroUI's react-aria-backed Modal — same
 * scope call as Dashboard's plain <table>: HeroUI v3's Modal needs an
 * overlay-state hook plus Trigger/Backdrop/Container/Dialog compound
 * components, meaningfully more setup than a form dialog needs here.
 */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4"
      style={{ backgroundColor: 'color-mix(in oklab, black 60%, transparent)' }}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-lg border shadow-xl"
        style={{ backgroundColor: 'var(--background)', borderColor: 'var(--border)' }}
      >
        <div className="flex shrink-0 items-center justify-between px-5 pt-5">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="text-sm" style={{ color: 'var(--muted)' }} aria-label="Cerrar">
            ✕
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
