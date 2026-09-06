import { useEffect, useRef, useState } from 'react';
import { searchVault, type VaultSearchResult } from '../lib/vaultClient';
import { fetchClients, type ClientWithTaskCount } from '../lib/clientsClient';

type Hit = {
  kind: 'cliente' | 'credencial' | 'url' | 'snippet' | 'proceso' | 'nota';
  id: string;
  clientId: string;
  title: string;
  subtitle: string;
  url?: string;
};

function clientHits(clients: ClientWithTaskCount[], tokens: string[]): Hit[] {
  return clients
    .filter((c) => {
      const hay = `${c.name} ${c.description ?? ''} ${c.localBasePath ?? ''}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    })
    .slice(0, 6)
    .map((c) => ({
      kind: 'cliente' as const,
      id: c.id,
      clientId: c.id,
      title: c.name + (c.isActive ? '' : ' (inactivo)'),
      subtitle: c.description || c.localBasePath || 'Cliente',
    }));
}

function vaultHits(r: VaultSearchResult, clientName: (id: string) => string): Hit[] {
  const hits: Hit[] = [];
  for (const c of r.credentials)
    hits.push({ kind: 'credencial', id: c.id, clientId: c.clientId, title: c.name, subtitle: `${clientName(c.clientId)} · ${c.kind}` });
  for (const u of r.urls)
    hits.push({ kind: 'url', id: u.id, clientId: u.clientId, title: u.name, subtitle: `${clientName(u.clientId)} · ${u.url}`, url: u.url });
  for (const it of r.items) {
    const kind = it.type === 'snippet' ? 'snippet' : it.type === 'process' ? 'proceso' : 'nota';
    hits.push({ kind, id: it.id, clientId: it.clientId, title: it.title, subtitle: clientName(it.clientId) });
  }
  return hits;
}

export function GlobalSearch({ onSelectClient }: { onSelectClient?: (clientId: string) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [searched, setSearched] = useState(false);
  const [open, setOpen] = useState(false);
  const clients = useRef<ClientWithTaskCount[]>([]);
  const clientNames = useRef<Map<string, string>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchClients({ includeInactive: true })
      .then((cs) => {
        clients.current = cs;
        cs.forEach((c) => clientNames.current.set(c.id, c.name));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      setSearched(false);
      return;
    }
    const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    // Clients match instantly from the list we already have.
    const cHits = clientHits(clients.current, tokens);
    setHits(cHits);
    setOpen(true);

    const t = setTimeout(async () => {
      try {
        const r = await searchVault(q.trim());
        setHits([...cHits, ...vaultHits(r, (id) => clientNames.current.get(id) ?? id)].slice(0, 24));
      } catch {
        setHits(cHits);
      } finally {
        setSearched(true);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  const go = (h: Hit) => {
    setOpen(false);
    setQ('');
    if (h.kind === 'url' && h.url) window.open(h.url, '_blank', 'noreferrer');
    else onSelectClient?.(h.clientId);
  };

  const showDropdown = open && q.trim().length >= 2;

  return (
    <div className="relative">
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
        placeholder="Buscar cliente, credencial…  ( / )"
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
                <span style={{ color: 'var(--muted)' }}>{h.subtitle}</span>
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
              {searched
                ? 'Sin resultados. Busca clientes y contenido de la bóveda (credenciales, URLs, snippets, procesos, notas).'
                : 'Buscando…'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
