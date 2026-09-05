import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import {
  fetchReplicationTargets,
  createReplicationTarget,
  updateReplicationTarget,
  removeReplicationTarget,
  authorizeReplicationTarget,
  authorizeDriveInApp,
  onRcloneAuthUrl,
  canAuthorizeInApp,
  testReplicationTarget,
  runReplicationTarget,
  pullReplicationTarget,
  fetchReplicationTargetCryptPassword,
  fetchReplicationRuns,
  type ReplicationContent,
  type ReplicationTarget,
  type ReplicationRun,
} from '../lib/replicationClient';
import { fetchFileBackupRepository } from '../lib/fileBackupClient';
import { fetchConnections, type TransportWithClientName } from '../lib/connectionsClient';
import { StatusChip } from './StatusChip';
import { Switch } from './Switch';
import { Modal } from './Modal';
import { Spinner } from './Spinner';
import { inputStyle } from './TaskCreateWizard';
import { primaryPillStyle } from '../lib/pillStyles';
import { formatDateTime, formatSize } from '../lib/format';

const CONTENT_LABEL: Record<ReplicationContent, string> = {
  restic_repo: 'Archivos (repositorio restic)',
  db_dumps: 'Bases de datos (dumps)',
};

interface SlotBusy {
  test?: boolean;
  run?: boolean;
  toggle?: boolean;
}

export function ReplicationPanel({ clientId }: { clientId: string }) {
  const [targets, setTargets] = useState<ReplicationTarget[]>([]);
  const [hasResticRepo, setHasResticRepo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [list, repo] = await Promise.all([
        fetchReplicationTargets(clientId),
        fetchFileBackupRepository(clientId),
      ]);
      setTargets(list);
      setHasResticRepo(Boolean(repo?.initializedAt));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const slots: ReplicationContent[] = hasResticRepo ? ['restic_repo', 'db_dumps'] : ['db_dumps'];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        Copia opcional de los backups de este cliente a un destino externo (Google Drive, u otro servidor por SFTP/FTP
        — vía rclone). Corre automáticamente después de cada backup exitoso. Cada tipo se configura por separado — nada
        es obligatorio.
      </p>
      {error && (
        <p className="text-sm" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {loading ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Cargando…
        </p>
      ) : (
        slots.map((content) => (
          <ReplicationSlot
            key={content}
            content={content}
            target={targets.find((t) => t.content === content) ?? null}
            clientId={clientId}
            onChange={refresh}
          />
        ))
      )}
      {!hasResticRepo && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          El slot de archivos aparece cuando el cliente tiene un repositorio restic (pestaña «Repositorio»).
        </p>
      )}
    </div>
  );
}

function ReplicationSlot({
  content,
  target,
  clientId,
  onChange,
}: {
  content: ReplicationContent;
  target: ReplicationTarget | null;
  clientId: string;
  onChange: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<SlotBusy>({});
  const [message, setMessage] = useState<string | null>(null);
  const [showConfigure, setShowConfigure] = useState(false);
  const [showPasteToken, setShowPasteToken] = useState(false);
  const [showCopyLinkAuth, setShowCopyLinkAuth] = useState(false);
  const [showCryptPw, setShowCryptPw] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  const [showNewCryptPw, setShowNewCryptPw] = useState<string | null>(null);
  const [runs, setRuns] = useState<ReplicationRun[]>([]);

  const loadRuns = useCallback(async () => {
    if (!target) return;
    try {
      setRuns(await fetchReplicationRuns(target.id));
    } catch {
      /* non-fatal */
    }
  }, [target]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  async function act<T>(key: keyof SlotBusy, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy((b) => ({ ...b, [key]: true }));
    setMessage(null);
    try {
      return await fn();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }

  if (!target) {
    return (
      <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">{CONTENT_LABEL[content]}</p>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Sin configurar
            </p>
          </div>
          <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} onPress={() => setShowConfigure(true)}>
            Configurar copia externa
          </Button>
        </div>
        {showConfigure && (
          <ConfigureModal
            content={content}
            clientId={clientId}
            onClose={() => setShowConfigure(false)}
            onCreated={async (generatedCryptPassword) => {
              setShowConfigure(false);
              if (generatedCryptPassword) setShowNewCryptPw(generatedCryptPassword);
              await onChange();
            }}
          />
        )}
        {showNewCryptPw && (
          <CryptPasswordModal
            password={showNewCryptPw}
            isNew
            onClose={() => setShowNewCryptPw(null)}
          />
        )}
      </div>
    );
  }

  const statusForChip = target.lastStatus ?? 'NeverRun';

  return (
    <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="font-medium">{CONTENT_LABEL[content]}</p>
          <StatusChip status={statusForChip} />
          {target.due && (
            <span className="text-xs" style={{ color: 'var(--warning)' }}>
              copia pendiente
            </span>
          )}
        </div>
        <Switch
          checked={target.enabled}
          onChange={() =>
            act('toggle', async () => {
              await updateReplicationTarget(target.id, { enabled: !target.enabled });
              await onChange();
            })
          }
          label={target.enabled ? 'Activa' : 'Pausada'}
        />
      </div>

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--muted)' }}>
        <dt>Destino</dt>
        <dd className="font-mono break-all" style={{ color: 'var(--foreground)' }}>
          {target.remotePath}
        </dd>
        {target.provider === 'rclone_drive' ? (
          <>
            <dt>Cuenta Google</dt>
            <dd style={{ color: target.authorized ? 'var(--foreground)' : 'var(--warning)' }}>
              {target.authorized ? 'conectada' : 'sin conectar'}
            </dd>
          </>
        ) : (
          <>
            <dt>Conexión</dt>
            <dd style={{ color: 'var(--foreground)' }}>
              {target.transportName ?? '—'} ({target.provider === 'rclone_sftp' ? 'SFTP' : 'FTP'})
            </dd>
          </>
        )}
        {target.provider === 'rclone_sftp' && (
          <>
            <dt>Huella SSH</dt>
            <dd className="break-all" style={{ color: target.sftpHostKeyFingerprint ? 'var(--foreground)' : 'var(--muted)' }}>
              {target.sftpHostKeyFingerprint ?? 'se confirma en la primera copia'}
            </dd>
          </>
        )}
        <dt>Cifrado</dt>
        <dd style={{ color: 'var(--foreground)' }}>
          {target.encryptWithCrypt ? 'sí (rclone crypt)' : 'no'}
        </dd>
        <dt>Última copia</dt>
        <dd style={{ color: 'var(--foreground)' }}>
          {target.lastReplicatedAt ? formatDateTime(target.lastReplicatedAt) : '—'}
          {target.lastError ? ` · ${target.lastError}` : ''}
        </dd>
      </dl>

      <div className="mt-3 flex flex-wrap gap-2">
        {target.provider === 'rclone_drive' && !target.authorized && canAuthorizeInApp() && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full px-3"
              onPress={() =>
                act('test', async () => {
                  const token = await authorizeDriveInApp();
                  await authorizeReplicationTarget(target.id, token);
                  setMessage('Cuenta conectada.');
                  await onChange();
                })
              }
            >
              Autorizar con Google
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full px-3"
              onPress={() => setShowCopyLinkAuth(true)}
            >
              Copiar enlace en su lugar
            </Button>
          </>
        )}
        {target.provider === 'rclone_drive' && (
          <Button size="sm" variant="ghost" className="rounded-full px-3" onPress={() => setShowPasteToken(true)}>
            {target.authorized ? 'Reconectar (pegar token)' : 'Pegar token'}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full px-3"
          isDisabled={!target.authorized || busy.test}
          onPress={() =>
            act('test', async () => {
              const r = await testReplicationTarget(target.id);
              setMessage(r.ok ? `OK — ${r.detail?.split('\n')[0] ?? 'conectado'}` : `Error: ${r.error}`);
            })
          }
        >
          {busy.test ? <Spinner /> : 'Probar'}
        </Button>
        <Button
          size="sm"
          className="rounded-full px-4"
          style={primaryPillStyle}
          isDisabled={!target.authorized || !target.enabled || busy.run}
          onPress={() =>
            act('run', async () => {
              const r = await runReplicationTarget(target.id);
              setMessage(
                r.status === 'Skipped'
                  ? `Omitido: ${r.message ?? ''}`
                  : r.status === 'Failed'
                    ? `Falló: ${r.message ?? ''}`
                    : `${r.status} — ${formatSize(r.bytesTransferred ?? 0)} en ${r.filesTransferred ?? 0} archivos`
              );
              await onChange();
              await loadRuns();
            })
          }
        >
          {busy.run ? (
            <>
              <Spinner /> Copiando…
            </>
          ) : (
            'Copiar ahora'
          )}
        </Button>
        <Button size="sm" variant="ghost" className="rounded-full px-3" onPress={() => setShowRestore(true)}>
          Restaurar desde copia externa
        </Button>
        {target.encryptWithCrypt && (
          <Button size="sm" variant="ghost" className="rounded-full px-3" onPress={() => setShowCryptPw(true)}>
            Ver contraseña de cifrado
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full px-3"
          style={{ color: 'var(--danger)' }}
          onPress={() =>
            act('toggle', async () => {
              if (!window.confirm('¿Eliminar esta configuración de copia externa? La copia ya subida a Drive NO se toca.'))
                return;
              await removeReplicationTarget(target.id);
              await onChange();
            })
          }
        >
          Quitar
        </Button>
      </div>

      {target.encryptWithCrypt && (
        <p className="mt-2 text-xs" style={{ color: 'var(--warning)' }}>
          Los dumps se cifran con una contraseña propia antes de subir. Guardala aparte, igual que la clave de
          recuperación — es indispensable para leer estos backups desde Drive y no se incluye en una exportación de
          configuración.
        </p>
      )}

      {message && (
        <p className="mt-2 text-xs" style={{ color: 'var(--foreground)' }}>
          {message}
        </p>
      )}

      {runs.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-lg border" style={{ borderColor: 'var(--border)' }}>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-left" style={{ color: 'var(--muted)' }}>
                <th className="px-3 py-1.5 font-medium">Fecha</th>
                <th className="px-3 py-1.5 font-medium">Origen</th>
                <th className="px-3 py-1.5 font-medium">Estado</th>
                <th className="px-3 py-1.5 font-medium">Transferido</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-1.5">{formatDateTime(r.startedAt)}</td>
                  <td className="px-3 py-1.5">{r.trigger === 'scheduled' ? 'automática' : 'manual'}</td>
                  <td className="px-3 py-1.5">{r.status}</td>
                  <td className="px-3 py-1.5">
                    {r.bytesTransferred != null
                      ? `${formatSize(r.bytesTransferred)} · ${r.filesTransferred ?? 0} arch.${r.errorMessage ? ` · ${r.errorMessage}` : ''}`
                      : r.errorMessage ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showPasteToken && (
        <PasteTokenModal
          onClose={() => setShowPasteToken(false)}
          onSubmit={async (token) => {
            await authorizeReplicationTarget(target.id, token);
            setShowPasteToken(false);
            setMessage('Cuenta conectada.');
            await onChange();
          }}
        />
      )}
      {showCopyLinkAuth && (
        <CopyLinkAuthModal
          onClose={() => setShowCopyLinkAuth(false)}
          onAuthorized={async (token) => {
            await authorizeReplicationTarget(target.id, token);
            setShowCopyLinkAuth(false);
            setMessage('Cuenta conectada.');
            await onChange();
          }}
        />
      )}
      {showCryptPw && <CryptPasswordModalLoader targetId={target.id} onClose={() => setShowCryptPw(false)} />}
      {showRestore && (
        <RestoreModal
          target={target}
          onClose={() => setShowRestore(false)}
          onDone={(msg) => {
            setShowRestore(false);
            setMessage(msg);
          }}
        />
      )}
    </div>
  );
}

type ConfigureProvider = 'drive' | 'sftp' | 'ftp';

function ConfigureModal({
  content,
  clientId,
  onClose,
  onCreated,
}: {
  content: ReplicationContent;
  clientId: string;
  onClose: () => void;
  onCreated: (generatedCryptPassword: string | null) => void | Promise<void>;
}) {
  const [provider, setProvider] = useState<ConfigureProvider>('drive');
  const [remotePath, setRemotePath] = useState(`arkode/${content === 'restic_repo' ? 'repo' : 'dumps'}`);
  const [encrypt, setEncrypt] = useState(content === 'db_dumps');
  const [transports, setTransports] = useState<TransportWithClientName[] | null>(null);
  const [transportId, setTransportId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (provider === 'drive') return;
    let alive = true;
    fetchConnections()
      .then((data) => {
        if (!alive) return;
        const matching = data.transports.filter((t) => t.clientId === clientId && t.type === provider);
        setTransports(matching);
        setTransportId(matching[0]?.id ?? '');
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [provider, clientId]);

  const providerLabel = provider === 'drive' ? 'Google Drive' : provider === 'sftp' ? 'SFTP existente' : 'FTP existente';
  const needsTransport = provider !== 'drive';
  const canSubmit = remotePath.trim() && (!needsTransport || transportId);

  return (
    <Modal title={`Configurar copia externa — ${CONTENT_LABEL[content]}`} onClose={onClose}>
      <label className="mb-1 block text-sm">Destino</label>
      <select
        className="mb-3 w-full rounded-md border px-3 py-2 text-sm"
        style={inputStyle}
        value={provider}
        onChange={(e) => setProvider(e.target.value as ConfigureProvider)}
      >
        <option value="drive">Google Drive</option>
        <option value="sftp">SFTP existente (Conexiones)</option>
        <option value="ftp">FTP existente (Conexiones)</option>
      </select>

      {needsTransport && (
        <>
          <label className="mb-1 block text-sm">Conexión ({providerLabel})</label>
          {transports === null ? (
            <p className="mb-3 text-sm" style={{ color: 'var(--muted)' }}>
              Cargando conexiones…
            </p>
          ) : transports.length === 0 ? (
            <p className="mb-3 text-sm" style={{ color: 'var(--warning)' }}>
              Este cliente no tiene ninguna conexión {provider.toUpperCase()} activa todavía — creá una primero en
              Conexiones.
            </p>
          ) : (
            <select
              className="mb-3 w-full rounded-md border px-3 py-2 text-sm"
              style={inputStyle}
              value={transportId}
              onChange={(e) => setTransportId(e.target.value)}
            >
              {transports.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.host}:{t.port})
                </option>
              ))}
            </select>
          )}
        </>
      )}

      <label className="mb-1 block text-sm">Carpeta de destino</label>
      <input
        className="mb-3 w-full rounded-md border px-3 py-2 text-sm"
        style={inputStyle}
        value={remotePath}
        onChange={(e) => setRemotePath(e.target.value)}
        placeholder="arkode/Cliente/repo"
      />
      {content === 'db_dumps' && (
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} />
          Cifrar antes de subir (recomendado — genera una contraseña propia)
        </label>
      )}
      {err && (
        <p className="mb-2 text-sm" style={{ color: 'var(--danger)' }}>
          {err}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" className="rounded-full px-4" onPress={onClose}>
          Cancelar
        </Button>
        <Button
          size="sm"
          className="rounded-full px-4"
          style={primaryPillStyle}
          isDisabled={busy || !canSubmit}
          onPress={async () => {
            setBusy(true);
            setErr(null);
            try {
              const created = await createReplicationTarget({
                clientId,
                content,
                remotePath: remotePath.trim(),
                provider,
                transportId: needsTransport ? transportId : undefined,
                encrypt,
              });
              await onCreated(created.generatedCryptPassword ?? null);
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Creando…' : 'Crear'}
        </Button>
      </div>
    </Modal>
  );
}

function PasteTokenModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (token: string) => Promise<void> }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="Pegar token de rclone" onClose={onClose}>
      <p className="mb-2 text-sm" style={{ color: 'var(--muted)' }}>
        En una PC con navegador, ejecutá <code>rclone authorize "drive"</code>, aprobá el acceso y pegá acá el bloque
        <code> {'{'}"access_token"...{'}'}</code> que imprime.
      </p>
      <textarea
        className="mb-3 h-28 w-full rounded-md border px-3 py-2 font-mono text-xs"
        style={inputStyle}
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      {err && (
        <p className="mb-2 text-sm" style={{ color: 'var(--danger)' }}>
          {err}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" className="rounded-full px-4" onPress={onClose}>
          Cancelar
        </Button>
        <Button
          size="sm"
          className="rounded-full px-4"
          style={primaryPillStyle}
          isDisabled={busy || !token.trim()}
          onPress={async () => {
            setBusy(true);
            setErr(null);
            try {
              await onSubmit(token.trim());
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
    </Modal>
  );
}

function CopyLinkAuthModal({
  onClose,
  onAuthorized,
}: {
  onClose: () => void;
  onAuthorized: (token: string) => Promise<void>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    onRcloneAuthUrl((u) => {
      if (alive) setUrl(u);
    }).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    authorizeDriveInApp({ noOpenBrowser: true })
      .then((token) => {
        if (alive) void onAuthorized(token);
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [onAuthorized]);

  return (
    <Modal title="Autorizar con Google — copiar enlace" onClose={onClose}>
      <p className="mb-3 text-sm" style={{ color: 'var(--muted)' }}>
        Abrí este enlace en el navegador que quieras <strong>de esta misma PC</strong>, iniciá sesión y aprobá el acceso.
        Al terminar, la cuenta se conecta sola — no cierres esta ventana.
      </p>
      {err ? (
        <p className="mb-2 text-sm" style={{ color: 'var(--danger)' }}>
          {err}
        </p>
      ) : url ? (
        <>
          <div
            className="mb-2 select-all rounded-md border px-3 py-2 font-mono text-xs break-all"
            style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface-secondary)' }}
          >
            {url}
          </div>
          <div className="mb-3 flex items-center gap-3">
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full px-3"
              onPress={async () => {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? 'Copiado ✓' : 'Copiar enlace'}
            </Button>
            <span className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
              <Spinner /> Esperando la autorización…
            </span>
          </div>
        </>
      ) : (
        <p className="mb-3 flex items-center gap-2 text-sm" style={{ color: 'var(--muted)' }}>
          <Spinner /> Generando el enlace…
        </p>
      )}
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" className="rounded-full px-4" onPress={onClose}>
          Cancelar
        </Button>
      </div>
    </Modal>
  );
}

function CryptPasswordModal({ password, isNew, onClose }: { password: string; isNew?: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title="Contraseña de cifrado" onClose={onClose}>
      {isNew && (
        <p className="mb-3 text-sm" style={{ color: 'var(--warning)' }}>
          Guardá esta contraseña en un lugar seguro <strong>fuera de esta PC</strong>. Es indispensable para leer estos
          dumps desde Drive y no se incluye en una exportación de configuración.
        </p>
      )}
      <div
        className="mb-3 select-all rounded-md border px-3 py-2 font-mono text-sm break-all"
        style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface-secondary)' }}
      >
        {password}
      </div>
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full px-4"
          onPress={async () => {
            await navigator.clipboard.writeText(password);
            setCopied(true);
          }}
        >
          {copied ? 'Copiado' : 'Copiar'}
        </Button>
        <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} onPress={onClose}>
          Listo
        </Button>
      </div>
    </Modal>
  );
}

function CryptPasswordModalLoader({ targetId, onClose }: { targetId: string; onClose: () => void }) {
  const [pw, setPw] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetchReplicationTargetCryptPassword(targetId)
      .then(setPw)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [targetId]);
  if (err) {
    return (
      <Modal title="Contraseña de cifrado" onClose={onClose}>
        <p className="text-sm" style={{ color: 'var(--danger)' }}>
          {err}
        </p>
      </Modal>
    );
  }
  if (pw === null) {
    return (
      <Modal title="Contraseña de cifrado" onClose={onClose}>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Cargando…
        </p>
      </Modal>
    );
  }
  return <CryptPasswordModal password={pw} onClose={onClose} />;
}

function RestoreModal({
  target,
  onClose,
  onDone,
}: {
  target: ReplicationTarget;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [dest, setDest] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="Restaurar desde copia externa" onClose={onClose}>
      <p className="mb-2 text-sm" style={{ color: 'var(--muted)' }}>
        Descarga la copia de Drive a una carpeta local.
        {target.content === 'restic_repo'
          ? ' Después, apuntá restic a esa carpeta (restic -r <carpeta>) y restaurá normalmente.'
          : ' Los dumps quedan descifrados en esa carpeta, listos para usar.'}
      </p>
      <label className="mb-1 block text-sm">Carpeta local de destino</label>
      <input
        className="mb-3 w-full rounded-md border px-3 py-2 text-sm"
        style={inputStyle}
        value={dest}
        onChange={(e) => setDest(e.target.value)}
        placeholder="D:\\recuperado"
      />
      {err && (
        <p className="mb-2 text-sm" style={{ color: 'var(--danger)' }}>
          {err}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" className="rounded-full px-4" onPress={onClose}>
          Cancelar
        </Button>
        <Button
          size="sm"
          className="rounded-full px-4"
          style={primaryPillStyle}
          isDisabled={busy || !dest.trim()}
          onPress={async () => {
            setBusy(true);
            setErr(null);
            try {
              const r = await pullReplicationTarget(target.id, dest.trim());
              if (!r.ok) {
                setErr(r.error ?? 'Falló la descarga.');
                return;
              }
              onDone(`Descargado en ${r.dest ?? dest.trim()}`);
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Descargando…' : 'Descargar'}
        </Button>
      </div>
    </Modal>
  );
}
