/**
 * A "filter by client" `<select>` for the top-level screens (Dashboard,
 * Conexiones, Tareas, Historial, Logs). Renders nothing when there's 0–1
 * clients to choose from — the filter would be pointless. `clients` is
 * whatever list the screen already has on hand; `''` = all clients.
 */
export function ClientFilter({
  clients,
  value,
  onChange,
}: {
  clients: { id: string; name: string }[];
  value: string;
  onChange: (clientId: string) => void;
}) {
  if (clients.length <= 1) return null;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        backgroundColor: 'var(--background)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '6px 10px',
        color: 'var(--foreground)',
        fontSize: 13,
      }}
    >
      <option value="">Todos los clientes</option>
      {[...clients]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
    </select>
  );
}

/** Distinct `{ id, name }` clients from rows carrying a client id + name under arbitrary keys. */
export function distinctClients<T>(rows: T[] | null | undefined, idOf: (r: T) => string, nameOf: (r: T) => string): { id: string; name: string }[] {
  const map = new Map<string, string>();
  for (const r of rows ?? []) map.set(idOf(r), nameOf(r));
  return [...map.entries()].map(([id, name]) => ({ id, name }));
}
