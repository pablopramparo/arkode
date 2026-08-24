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
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'color-mix(in oklab, black 60%, transparent)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border p-5 shadow-xl"
        style={{ backgroundColor: 'var(--background)', borderColor: 'var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="text-sm" style={{ color: 'var(--muted)' }} aria-label="Cerrar">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
