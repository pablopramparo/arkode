import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import QRCode from 'qrcode';
import { Modal } from './Modal';
import { Spinner } from './Spinner';
import { Switch } from './Switch';
import { DriveConnectButtons } from './DriveAuthControls';
import { primaryPillStyle, dangerPillStyle } from '../lib/pillStyles';
import { formatAge, formatDateTime } from '../lib/format';
import {
  fetchPocketStatus,
  configurePocket as configurePocketApi,
  setPocketEnabled,
  connectPocketDrive,
  disconnectPocketDrive,
  testPocketDrive,
  generatePocketPairing,
  publishPocketNow,
  revokePocketDevice,
  type PocketStatus,
} from '../lib/pocketClient';

const inputStyle: React.CSSProperties = {
  backgroundColor: 'var(--background)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '5px 8px',
};

const DEFAULT_DRIVE_PATH = 'Arkode/Pocket';

function pocketStateLabel(status: PocketStatus): { text: string; color: string } {
  if (!status.configured) return { text: 'No configurado', color: 'var(--muted)' };
  if (status.lastError) return { text: 'Error', color: 'var(--danger)' };
  if (status.dirty) return { text: 'Pendiente de publicar', color: 'var(--warning)' };
  return { text: 'Al día', color: 'var(--success)' };
}

/**
 * "Arkode Pocket" — the read-only mobile credential viewer's Desktop-side
 * control panel, deliberately small: this app is the source of truth and
 * Pocket only ever consumes what Desktop publishes. No device-management
 * console, no sync history beyond the single current revision — v1 is one
 * device. See docs/pocket.md for the full model.
 */
export function PocketSection() {
  const [status, setStatus] = useState<PocketStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showConfigure, setShowConfigure] = useState(false);
  const [showDrive, setShowDrive] = useState(false);
  const [showPairing, setShowPairing] = useState(false);

  async function refresh() {
    try {
      setStatus(await fetchPocketStatus());
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // Cheap poll — mirrors SchedulerStatusBanner's own cadence for a small
    // status widget with no push-update mechanism.
    const id = setInterval(() => void refresh(), 15000);
    return () => clearInterval(id);
  }, []);

  if (loading) {
    return (
      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        Cargando…
      </p>
    );
  }
  if (!status) {
    return (
      <p className="text-sm" style={{ color: 'var(--danger)' }}>
        {actionError ?? 'No se pudo cargar el estado de Arkode Pocket.'}
      </p>
    );
  }

  const state = pocketStateLabel(status);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-semibold">Arkode Pocket</h2>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          Credenciales en el bolsillo — solo lectura, vía Google Drive
        </span>
      </div>

      {status.configured && (
        <div className="grid grid-cols-[160px_1fr] gap-y-2 text-sm">
          <span style={{ color: 'var(--muted)' }}>Google Drive</span>
          <span>{status.driveConnected ? 'Conectado' : 'No conectado'}</span>

          <span style={{ color: 'var(--muted)' }}>Estado</span>
          <span style={{ color: state.color }}>{state.text}</span>

          <span style={{ color: 'var(--muted)' }}>Última publicación</span>
          <span>{status.lastSuccessfulPublishAt ? `hace ${formatAge(status.lastSuccessfulPublishAt)}` : 'nunca'}</span>

          <span style={{ color: 'var(--muted)' }}>Revisión</span>
          <span>{status.lastConfirmedRevision ?? '—'}</span>

          <span style={{ color: 'var(--muted)' }}>Dispositivo</span>
          <span>
            {status.pairedAt
              ? `Código de vinculación generado el ${formatDateTime(status.pairedAt)}`
              : 'Todavía no se generó un código de vinculación'}
          </span>
          {status.revokedAt && (
            <>
              <span style={{ color: 'var(--muted)' }}>Última revocación</span>
              <span>{formatDateTime(status.revokedAt)}</span>
            </>
          )}
        </div>
      )}

      {status.lastError && (
        <p className="text-sm" style={{ color: 'var(--danger)' }}>
          {status.lastError}
        </p>
      )}
      {actionError && (
        <p className="text-sm" style={{ color: 'var(--danger)' }}>
          {actionError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!status.configured ? (
          <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} onPress={() => setShowConfigure(true)}>
            Configurar Pocket
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" className="rounded-full px-3" onPress={() => setShowDrive(true)}>
              {status.driveConnected ? 'Cambiar cuenta de Drive' : 'Conectar Google Drive'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full px-3"
              isDisabled={!status.driveConnected || busy === 'test'}
              onPress={async () => {
                setBusy('test');
                setActionError(null);
                try {
                  const r = await testPocketDrive();
                  if (!r.ok) setActionError(r.error ?? 'La prueba de conexión con Drive falló.');
                } catch (e) {
                  setActionError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === 'test' ? <Spinner /> : 'Probar Drive'}
            </Button>
            <Button
              size="sm"
              className="rounded-full px-4"
              style={primaryPillStyle}
              isDisabled={busy === 'pair'}
              onPress={() => setShowPairing(true)}
            >
              Vincular dispositivo
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full px-3"
              isDisabled={busy === 'publish'}
              onPress={async () => {
                setBusy('publish');
                setActionError(null);
                try {
                  const r = await publishPocketNow(true);
                  setStatus(r.pocketStatus);
                  if (r.status === 'failed') setActionError(r.error ?? 'La publicación falló.');
                } catch (e) {
                  setActionError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === 'publish' ? <Spinner /> : 'Publicar ahora'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full px-3"
              style={dangerPillStyle}
              isDisabled={busy === 'revoke'}
              onPress={async () => {
                const ok = window.confirm(
                  'Este dispositivo no podrá abrir futuras actualizaciones de Arkode Pocket.\n\n' +
                    'Los datos que ya haya descargado pueden seguir existiendo en él — esto no los borra, ' +
                    'no cierra su sesión de Google ni invalida las contraseñas que ya vio.\n\n' +
                    '¿Revocar de todos modos?'
                );
                if (!ok) return;
                setBusy('revoke');
                setActionError(null);
                try {
                  setStatus(await revokePocketDevice());
                } catch (e) {
                  setActionError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(null);
                }
              }}
            >
              Revocar dispositivo
            </Button>
            <Switch
              checked={status.enabled}
              onChange={async () => {
                setStatus(await setPocketEnabled(!status.enabled));
              }}
              label={status.enabled ? 'Activado' : 'Desactivado'}
            />
          </>
        )}
      </div>

      {showConfigure && (
        <ConfigurePocketModal
          initialPath={status.driveRemotePath ?? DEFAULT_DRIVE_PATH}
          onClose={() => setShowConfigure(false)}
          onDone={async () => {
            setShowConfigure(false);
            await refresh();
          }}
        />
      )}
      {showDrive && (
        <DrivePocketModal
          connected={status.driveConnected}
          onClose={() => setShowDrive(false)}
          onDone={async () => {
            setShowDrive(false);
            await refresh();
          }}
        />
      )}
      {showPairing && (
        <PairingModal
          onClose={() => {
            setShowPairing(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function ConfigurePocketModal({
  initialPath,
  onClose,
  onDone,
}: {
  initialPath: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [path, setPath] = useState(initialPath);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <Modal title="Configurar Arkode Pocket" onClose={onClose}>
      <p className="mb-3 text-sm" style={{ color: 'var(--muted)' }}>
        Arkode Pocket publica un único archivo cifrado en esta carpeta de tu Google Drive. Podés cambiarla más
        adelante.
      </p>
      <label className="mb-1 block text-xs" style={{ color: 'var(--muted)' }}>
        Carpeta en Drive
      </label>
      <input className="mb-3 w-full rounded-md" style={inputStyle} value={path} onChange={(e) => setPath(e.target.value)} />
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
          isDisabled={busy || !path.trim()}
          onPress={async () => {
            setBusy(true);
            setErr(null);
            try {
              await configurePocketApi(path.trim());
              await onDone();
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

function DrivePocketModal({
  connected,
  onClose,
  onDone,
}: {
  connected: boolean;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="Google Drive para Arkode Pocket" onClose={onClose}>
      <p className="mb-3 text-sm" style={{ color: 'var(--muted)' }}>
        Esta cuenta es independiente de la que uses para replicación o para el backup de recuperación — podés usar la
        misma o una distinta.
      </p>
      {err && (
        <p className="mb-2 text-sm" style={{ color: 'var(--danger)' }}>
          {err}
        </p>
      )}
      <div className="mb-3 flex flex-wrap gap-2">
        <DriveConnectButtons
          connected={connected}
          onAuthorized={async (token) => {
            await connectPocketDrive(token);
            await onDone();
          }}
          onError={(m) => setErr(m)}
        />
      </div>
      {connected && (
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full px-3"
          style={dangerPillStyle}
          onPress={async () => {
            await disconnectPocketDrive();
            await onDone();
          }}
        >
          Desconectar
        </Button>
      )}
    </Modal>
  );
}

/**
 * The QR pairing modal. Handles the sensitive-payload requirements
 * deliberately: the pairing payload (which carries the raw Pocket device
 * key) lives only in this component's local state, is never logged, is
 * never copied to the clipboard automatically, and is discarded the moment
 * this modal closes (no image is ever written to disk — the QR is rendered
 * straight to an in-memory data URL). Closing this modal is the ONLY
 * boundary Desktop offers on the QR's lifetime — see docs/pocket.md for why
 * a more elaborate expiry wasn't built for v1.
 */
function PairingModal({ onClose }: { onClose: () => void }) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [generated, setGenerated] = useState(false);

  useEffect(() => {
    return () => {
      // Belt-and-suspenders: drop the rendered QR the instant this unmounts.
      setQrDataUrl(null);
    };
  }, []);

  async function generate() {
    setErr(null);
    try {
      const { payload } = await generatePocketPairing(label.trim() || undefined);
      const text = JSON.stringify(payload);
      const dataUrl = await QRCode.toDataURL(text, { margin: 1, width: 260 });
      setQrDataUrl(dataUrl);
      setGenerated(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal title="Vincular dispositivo" onClose={onClose}>
      {!generated ? (
        <>
          <p className="mb-3 text-sm" style={{ color: 'var(--muted)' }}>
            Quien escanee este código obtiene acceso de lectura a las credenciales publicadas en Arkode Pocket, hasta
            que revoques el dispositivo. Generalo solo cuando tengas el teléfono a mano para escanearlo.
          </p>
          <label className="mb-1 block text-xs" style={{ color: 'var(--muted)' }}>
            Etiqueta del dispositivo (opcional, solo para tu referencia)
          </label>
          <input
            className="mb-3 w-full rounded-md"
            style={inputStyle}
            placeholder="Pablo Pixel"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
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
            <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} onPress={generate}>
              Generar código de vinculación
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mb-3 text-center text-sm font-medium" style={{ color: 'var(--warning)' }}>
            Código de vinculación generado — no lo compartas.
          </p>
          {qrDataUrl && (
            <div className="mb-3 flex justify-center">
              <img src={qrDataUrl} alt="Código QR de vinculación de Arkode Pocket" width={260} height={260} />
            </div>
          )}
          <p className="mb-3 text-center text-xs" style={{ color: 'var(--muted)' }}>
            Abrí Arkode Pocket en el teléfono y escaneá este código. Esta ventana no confirma que el teléfono ya lo
            haya leído — Arkode Desktop no tiene forma de saberlo.
          </p>
          <div className="flex justify-end">
            <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} onPress={onClose}>
              Listo
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
