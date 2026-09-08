import { useEffect, useRef, useState } from 'react';
import { searchVault } from '../lib/vaultClient';

export type ClientVaultTab = 'credenciales' | 'urls' | 'snippets' | 'procesos' | 'notas';

type Hit = {
  kind: 'credencial' | 'url' | 'snippet' | 'proceso' | 'nota';
  tab: ClientVaultTab;
  id: string;
  title: string;
  subtitle: string;
  url?: string;
};

/**
 * Search box scoped to ONE client's vault content (credentials / URLs /
 * snippets / processes / notes). Metadata-only, so it works while the vault
 * is locked. Picking a hit jumps to that sub-tab.
 */
export function ClientVaultSearch({
  clientId,
  onJump,
}: {
  clientId: string;
  onJump: (tab: ClientVaultTab, itemId?: string) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [searched, setSearched] = useState(false);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      setSearched(false);
      return;
    }
    setOpen(true);
    const t = setTimeout(async () => {
      try {
        const r = await searchVault(q.trim(), clientId);
        const next: Hit[] = [];
        for (const c of r.credentials)
          next.push({ kind: 'credencial', tab: 'credenciales', id: c.id, title: c.name, subtitle: c.kind });
        for (const u of r.urls)
          next.push({ kind: 'url', tab: 'urls', id: u.id, title: u.name, subtitle: u.url, url: u.url });
        for (const it of r.items) {
          const kind = it.type === 'snippet' ? 'snippet' : it.type === 'process' ? 'proceso' : 'nota';
          const tab: ClientVaultTab = it.type === 'snippet' ? 'snippets' : it.type === 'process' ? 'procesos' : 'notas';
          next.push({ kind, tab, id: it.id, title: it.title, subtitle: it.environment ?? '' });
        }
        setHits(next.slice(0, 24));
      } catch {
        setHits([]);
      } finally {
        setSearched(true);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [q, clientId]);

  const go = (h: Hit) => {
    setOpen(false);
    setQ('');
    if (h.kind === 'url' && h.url) window.open(h.url, '_blank', 'noreferrer');
    else onJump(h.tab, h.id);
  };

  const showDropdown = open && q.trim().length >= 2;

  return (
    <div className="relative max-w-md">
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => q.trim().length >= 2 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hits[0]) go(hits[0]);
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Buscar en este cliente (credenciales, URLs, snippets, procesos, notas)…"
        className="w-full rounded-md border px-2.5 py-1.5 text-xs outline-none"
        style={{ backgroundColor: 'var(--field-background)', borderColor: 'var(--border)' }}
      />
      {showDropdown && (
        <div
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-80 overflow-y-auto rounded-md border shadow-xl"
          style={{ backgroundColor: 'var(--background)', borderColor: 'var(--border)' }}
        >
          {hits.length > 0 ? (
            hits.map((h) => (
              <button
                key={`${h.kind}-${h.id}`}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(h)}
                className="flex w-full flex-col items-start px-3 py-2 text-left text-xs hover:opacity-80"
              >
                <span className="font-medium">
                  <span style={{ color: 'var(--muted)' }}>[{h.kind}]</span> {h.title}
                </span>
                {h.subtitle && <span style={{ color: 'var(--muted)' }}>{h.subtitle}</span>}
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
              {searched ? 'Sin resultados en este cliente.' : 'Buscando…'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
