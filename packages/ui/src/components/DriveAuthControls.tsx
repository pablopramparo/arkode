import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { Modal } from './Modal';
import { Spinner } from './Spinner';
import { inputStyle } from './TaskCreateWizard';
import { primaryPillStyle } from '../lib/pillStyles';
import { authorizeDriveInApp, canAuthorizeInApp, onRcloneAuthUrl } from '../lib/replicationClient';

/**
 * Shared Google-Drive OAuth UI for rclone-backed features (off-site
 * replication AND the portable .arkvault vault backup). One flow, no
 * duplicated infrastructure: it just hands back the rclone OAuth token
 * blob; the caller persists it via its own endpoint.
 */

export function PasteTokenModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (token: string) => Promise<void> }) {
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

export function CopyLinkAuthModal({
  onClose,
  onAuthorized,
}: {
  onClose: () => void;
  onAuthorized: (token: string) => Promise<void>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // `onAuthorized` is re-created on every render by every caller (it's an
  // inline lambda, e.g. DriveConnectButtons below) — depending on it in the
  // effect's array below used to re-run this effect on every parent
  // re-render (a status-polling tick, for instance), which spawns a SECOND
  // `rclone authorize` process fighting the first one for the same fixed
  // port 53682. The effect's own cleanup only flips a local `alive` flag;
  // it can't kill the already-spawned OS process, so the real bug wasn't
  // "duplicate calls" in the abstract — it was two live rclone.exe
  // processes racing for one port, with the FIRST one (which the user
  // actually completed the Google consent against) silently discarded and
  // the SECOND one's "port already in use" error shown instead. A ref
  // sidesteps this: the effect body always reads the latest callback, but
  // never re-runs because of it.
  const onAuthorizedRef = useRef(onAuthorized);
  onAuthorizedRef.current = onAuthorized;

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
        if (alive) void onAuthorizedRef.current(token);
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
      unlisten?.();
    };
    // Intentionally run once per mount only — see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

/**
 * The "Autorizar con Google / Copiar enlace / Pegar token" button cluster.
 * `onAuthorized` gets the raw rclone token blob; the caller stores it.
 */
export function DriveConnectButtons({
  connected,
  busy,
  onAuthorized,
  onError,
}: {
  connected: boolean;
  busy?: boolean;
  onAuthorized: (token: string) => Promise<void>;
  onError?: (message: string) => void;
}) {
  const [showPaste, setShowPaste] = useState(false);
  const [showCopyLink, setShowCopyLink] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);

  return (
    <>
      {!connected && canAuthorizeInApp() && (
        <>
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full px-3"
            isDisabled={authorizing || busy}
            onPress={async () => {
              setAuthorizing(true);
              try {
                const token = await authorizeDriveInApp();
                await onAuthorized(token);
              } catch (e) {
                onError?.(e instanceof Error ? e.message : String(e));
              } finally {
                setAuthorizing(false);
              }
            }}
          >
            {authorizing ? <Spinner /> : 'Conectar Google Drive'}
          </Button>
          <Button size="sm" variant="ghost" className="rounded-full px-3" onPress={() => setShowCopyLink(true)}>
            Copiar enlace en su lugar
          </Button>
        </>
      )}
      <Button size="sm" variant="ghost" className="rounded-full px-3" onPress={() => setShowPaste(true)}>
        {connected ? 'Reconectar (pegar token)' : 'Pegar token'}
      </Button>

      {showPaste && (
        <PasteTokenModal
          onClose={() => setShowPaste(false)}
          onSubmit={async (token) => {
            await onAuthorized(token);
            setShowPaste(false);
          }}
        />
      )}
      {showCopyLink && (
        <CopyLinkAuthModal
          onClose={() => setShowCopyLink(false)}
          onAuthorized={async (token) => {
            await onAuthorized(token);
            setShowCopyLink(false);
          }}
        />
      )}
    </>
  );
}
