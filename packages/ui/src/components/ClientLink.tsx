/** A client's name rendered as a link to its ficha (ClienteDetalle) — same look everywhere a client name appears in a table. */
export function ClientLink({ clientId, name, onSelect }: { clientId: string; name: string; onSelect: (clientId: string) => void }) {
  return (
    <button type="button" className="hover:underline" style={{ color: 'inherit' }} onClick={() => onSelect(clientId)}>
      {name}
    </button>
  );
}
