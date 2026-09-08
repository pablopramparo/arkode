import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import type { VaultCredential, VaultCredentialSecret, VaultItem, VaultUrl } from 'engine-core';
import { Modal } from './Modal';
import { CopyField } from './CredencialesTab';
import { CopyIcon } from './icons';
import { useVaultStatus } from '../lib/useVaultStatus';
import { useClipboardAutoClear } from '../lib/useClipboardAutoClear';
import { revealCredential, revealItemBody } from '../lib/vaultClient';

const TYPE_LABEL: Record<VaultItem['type'], string> = {
  snippet: 'Snippet',
  process: 'Proceso',
  note: 'Nota',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-sm">
      <span className="w-28 shrink-0 text-xs" style={{ color: 'var(--muted)' }}>
        {label}
      </span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

function Chips({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <span style={{ color: 'var(--muted)' }}>—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span
          key={t}
          className="rounded-full px-2 py-0.5 text-[11px]"
          style={{ backgroundColor: 'var(--surface-secondary)', color: 'var(--muted)' }}
        >
          {t}
        </span>
      ))}
    </span>
  );
}

function Footer({
  onEdit,
  onDelete,
  onClose,
}: {
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <Button size="sm" variant="ghost" style={{ color: 'var(--danger)' }} onPress={onDelete}>
        Eliminar
      </Button>
      <Button size="sm" variant="ghost" onPress={onEdit}>
        Editar
      </Button>
      <Button size="sm" onPress={onClose}>
        Cerrar
      </Button>
    </div>
  );
}

// --------------------------------------------------------------- Credential
export function VaultCredentialDetailModal({
  credential: c,
  onEdit,
  onDelete,
  onClose,
}: {
  credential: VaultCredential;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { status } = useVaultStatus();
  const locked = !status?.unlocked;
  const [secret, setSecret] = useState<VaultCredentialSecret | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { copy, copiedKey } = useClipboardAutoClear();

  const reveal = async () => {
    try {
      setSecret(await revealCredential(c.id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const linked = !!(c.linkedTransportId || c.linkedDatabaseConnectionId);

  return (
    <Modal title={c.name} onClose={onClose}>
      <div className="space-y-1">
        <Row label="Tipo">
          <span
            className="rounded-full px-2 py-0.5 text-xs"
            style={{ backgroundColor: 'var(--surface-secondary)', color: 'var(--muted)' }}
          >
            {c.kind}
          </span>
        </Row>
        {c.description && <Row label="Descripción">{c.description}</Row>}
        <Row label="Host / URL">
          {c.host ?? c.url ?? '—'}
          {c.port ? `:${c.port}` : ''}
        </Row>
        {c.username && <Row label="Usuario">{c.username}</Row>}
        {c.databaseName && <Row label="Base de datos">{c.databaseName}</Row>}
        <Row label="Entorno">{c.environment ?? '—'}</Row>
        <Row label="Tags">
          <Chips tags={c.tags} />
        </Row>
        {linked && (
          <Row label="Backups">
            <span style={{ color: c.operationalSyncState === 'error' ? 'var(--danger)' : 'var(--muted)' }}>
              {c.operationalSyncState === 'error'
                ? '⚠ sincronización operativa con error'
                : c.operationalSyncState === 'pending'
                  ? 'sincronización pendiente'
                  : 'usada para backups'}
            </span>
          </Row>
        )}
      </div>

      <div className="mt-3 rounded-md border p-3" style={{ borderColor: 'var(--border)' }}>
        {!secret ? (
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              {locked ? 'Desbloqueá la bóveda para revelar el secreto.' : 'Secreto cifrado con la contraseña maestra.'}
            </span>
            <Button size="sm" variant="ghost" isDisabled={locked} onPress={reveal}>
              Revelar
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3 text-xs">
            {c.username && <CopyField label="usuario" value={c.username} k={`d-${c.id}-u`} copy={copy} copiedKey={copiedKey} />}
            {c.host && <CopyField label="host" value={c.host} k={`d-${c.id}-h`} copy={copy} copiedKey={copiedKey} />}
            {Object.entries(secret).map(([key, val]) =>
              typeof val === 'string' ? (
                <CopyField key={key} label={key} value={val} k={`d-${c.id}-${key}`} copy={copy} copiedKey={copiedKey} secret />
              ) : null
            )}
            {secret.custom &&
              Object.entries(secret.custom).map(([key, val]) => (
                <CopyField key={`c-${key}`} label={key} value={val} k={`d-${c.id}-c-${key}`} copy={copy} copiedKey={copiedKey} secret />
              ))}
          </div>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      <Footer onEdit={onEdit} onDelete={onDelete} onClose={onClose} />
    </Modal>
  );
}

// --------------------------------------------------------------------- URL
export function VaultUrlDetailModal({
  url: u,
  onEdit,
  onDelete,
  onClose,
}: {
  url: VaultUrl;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { copy, copiedKey } = useClipboardAutoClear();
  return (
    <Modal title={u.name} onClose={onClose}>
      <div className="space-y-1">
        <Row label="URL">
          <span className="flex items-center gap-2">
            <a href={u.url} target="_blank" rel="noreferrer" className="min-w-0 break-all underline" style={{ color: 'var(--accent)' }}>
              {u.url}
            </a>
            <button
              type="button"
              onClick={() => void copy(u.url, `d-url-${u.id}`)}
              className="h-3.5 w-3.5 shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5"
              style={{ color: 'var(--muted)' }}
              title="Copiar URL"
            >
              <CopyIcon />
            </button>
            {copiedKey === `d-url-${u.id}` && (
              <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                copiado ✓
              </span>
            )}
          </span>
        </Row>
        {u.description && <Row label="Descripción">{u.description}</Row>}
        <Row label="Entorno">{u.environment ?? '—'}</Row>
        <Row label="Tags">
          <Chips tags={u.tags} />
        </Row>
      </div>
      <Footer onEdit={onEdit} onDelete={onDelete} onClose={onClose} />
    </Modal>
  );
}

// -------------------------------------------------------------------- Item
export function VaultItemDetailModal({
  item: it,
  onEdit,
  onDelete,
  onClose,
}: {
  item: VaultItem;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { status } = useVaultStatus();
  const [body, setBody] = useState<string | null>(it.isSensitive ? null : it.bodyPlaintext);
  const [error, setError] = useState<string | null>(null);
  const { copy, copiedKey } = useClipboardAutoClear();
  const bodyLocked = it.isSensitive && !status?.unlocked;

  useEffect(() => {
    setBody(it.isSensitive ? null : it.bodyPlaintext);
  }, [it.id, it.isSensitive, it.bodyPlaintext]);

  const reveal = async () => {
    try {
      setBody(await revealItemBody(it.id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal title={it.title} onClose={onClose}>
      <div className="space-y-1">
        <Row label="Tipo">{TYPE_LABEL[it.type]}</Row>
        {it.description && <Row label="Descripción">{it.description}</Row>}
        <Row label="Entorno">{it.environment ?? '—'}</Row>
        <Row label="Tags">
          <Chips tags={it.tags} />
        </Row>
        {it.type === 'snippet' && it.metadata.language && <Row label="Lenguaje">{it.metadata.language}</Row>}
        {it.isSensitive && (
          <Row label="Sensible">
            <span style={{ color: 'var(--warning)' }}>sí — cuerpo cifrado</span>
          </Row>
        )}
      </div>

      {it.type === 'process' && it.metadata.steps && it.metadata.steps.length > 0 && (
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
          {it.metadata.steps.map((s, i) => (
            <li key={i}>
              {s.text}
              {s.command && (
                <div className="mt-1 flex items-center gap-2">
                  <code className="rounded px-2 py-1 text-xs" style={{ backgroundColor: 'var(--surface-secondary)' }}>
                    {s.command}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copy(s.command!, `d-step-${it.id}-${i}`)}
                    className="h-3.5 w-3.5 shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5"
                    style={{ color: 'var(--muted)' }}
                    title="Copiar comando"
                  >
                    <CopyIcon />
                  </button>
                  {copiedKey === `d-step-${it.id}-${i}` && (
                    <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                      copiado ✓
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {it.metadata.warnings && (
        <p
          className="mt-2 rounded-md px-2 py-1 text-xs"
          style={{ backgroundColor: 'color-mix(in oklab, var(--warning) 12%, transparent)', color: 'var(--warning)' }}
        >
          ⚠ {it.metadata.warnings}
        </p>
      )}

      <div className="mt-3 rounded-md border p-3" style={{ borderColor: 'var(--border)' }}>
        {body === null ? (
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              {bodyLocked ? 'Desbloqueá la bóveda para ver el contenido.' : 'Sin contenido.'}
            </span>
            {it.isSensitive && (
              <Button size="sm" variant="ghost" isDisabled={bodyLocked} onPress={reveal}>
                Ver contenido
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <pre className="flex-1 overflow-x-auto text-xs" style={{ whiteSpace: 'pre-wrap' }}>
              {body || '(vacío)'}
            </pre>
            {body && (
              <button
                type="button"
                onClick={() => void copy(body, `d-body-${it.id}`)}
                className="h-3.5 w-3.5 shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5"
                style={{ color: 'var(--muted)' }}
                title="Copiar contenido"
              >
                <CopyIcon />
              </button>
            )}
            {copiedKey === `d-body-${it.id}` && (
              <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                copiado ✓
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      <Footer onEdit={onEdit} onDelete={onDelete} onClose={onClose} />
    </Modal>
  );
}
