import type { ReactNode } from 'react';
import { CheckCircleIcon, AlertTriangleIcon } from './icons';

/**
 * Contextual help for setting up a remote_dump SSH connection — a dedicated
 * Linux user, its key, and the remote dump command — surfaced from the SSH
 * connection form itself (Conexiones and the task wizard's inline "create
 * connection" flow), not as a separate top-level screen: it's only useful
 * exactly when someone is filling out that form. Content mirrors the
 * standalone guide originally written for this (published as an Artifact),
 * adapted to the app's own dense/utilitarian style rather than the
 * artifact's more editorial one — this is an in-app reference panel, not a
 * marketing surface.
 */
export function SshSetupGuide({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4"
      style={{ backgroundColor: 'color-mix(in oklab, black 60%, transparent)' }}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border shadow-xl"
        style={{ backgroundColor: 'var(--background)', borderColor: 'var(--border)' }}
      >
        <div className="flex shrink-0 items-center justify-between border-b px-5 py-4" style={{ borderColor: 'var(--separator)' }}>
          <h2 className="text-base font-semibold">Backup remoto por SSH, paso a paso</h2>
          <button onClick={onClose} className="text-sm" style={{ color: 'var(--muted)' }} aria-label="Cerrar">
            ✕
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 text-sm">
          <p className="mb-2" style={{ color: 'var(--muted)' }}>
            Para un cliente con servidor propio (VPS, cloud) al que tenés acceso SSH: el dump se genera{' '}
            <strong style={{ color: 'inherit' }}>en el servidor mismo</strong> y arkode solo lo descarga — no hace falta{' '}
            <Code>pg_dump</Code> ni <Code>mysqldump</Code> instalado en esta PC.
          </p>
          <p className="mb-6" style={{ color: 'var(--muted)' }}>
            Al terminar vas a tener un usuario Linux dedicado, sin privilegios de root, que solo puede escribir en su
            propia carpeta y correr el comando de dump — conectado por clave SSH, sin contraseñas guardadas en ningún
            lado del servidor.
          </p>

          <SectionLabel>Antes de empezar</SectionLabel>
          <ul className="mb-2 grid gap-1.5 text-xs" style={{ color: 'var(--muted)' }}>
            <li>Acceso root al servidor (por SSH, con usuario y contraseña o clave)</li>
            <li>Usuario y contraseña de la base de datos que querés respaldar</li>
            <li>Windows 10/11 en tu PC — trae el cliente SSH incluido, no hay que instalar nada aparte</li>
          </ul>

          <SectionLabel>Paso a paso</SectionLabel>

          <Step n={1} where="local" title="Generar el par de claves">
            <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>
              Un nombre distinto por cliente evita mezclar claves si alguna vez hay que revocar una sola.
            </p>
            <CodeBlock>{`ssh-keygen -t ed25519 -f "$HOME\\.ssh\\arkode_cliente_key" -N '""'`}</CodeBlock>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Reemplazá <Code>cliente</Code> por algo que identifique a este cliente, ej. <Code>arkode_acme_key</Code>.
            </p>
          </Step>

          <Step n={2} where="local" title="Copiar la clave pública">
            <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>
              Abrí una <strong style={{ color: 'inherit' }}>segunda</strong> ventana de PowerShell para esto — vas a
              necesitar la primera libre para conectarte al servidor en el paso siguiente.
            </p>
            <CodeBlock>{`Get-Content "$HOME\\.ssh\\arkode_cliente_key.pub"`}</CodeBlock>
            <Why>Es un comando de Windows. No sirve pegarlo dentro de una sesión SSH ya conectada al servidor Linux.</Why>
          </Step>

          <Step n={3} where="local" title="Conectarte como root">
            <CodeBlock>{`ssh root@servidor -p PUERTO   # -p solo si no es el 22`}</CodeBlock>
          </Step>

          <Step n={4} where="remote" title="Crear el usuario dedicado">
            <CodeBlock>{`useradd -m -s /bin/bash arkode-backup\nmkdir -p /home/arkode-backup/.ssh\nchmod 700 /home/arkode-backup/.ssh`}</CodeBlock>
            <Why>
              <strong style={{ color: 'inherit' }}>Por qué un usuario nuevo:</strong> con <Code>-s /bin/bash</Code> le
              das terminal real, algo que muchas cuentas de paneles de hosting no tienen habilitado por default. Al
              ser un usuario recién creado, sin privilegios extra, solo puede leer/escribir dentro de su propia
              carpeta — nunca root para esto.
            </Why>
          </Step>

          <Step n={5} where="remote" title="Pegar la clave pública">
            <CodeBlock>{`nano /home/arkode-backup/.ssh/authorized_keys`}</CodeBlock>
            <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>
              Pegá ahí la línea que copiaste en el paso 2 (clic derecho suele pegar en la terminal). Guardar:{' '}
              <Code>Ctrl+O</Code>, Enter. Salir: <Code>Ctrl+X</Code>.
            </p>
            <CodeBlock>{`chmod 600 /home/arkode-backup/.ssh/authorized_keys\nchown -R arkode-backup:arkode-backup /home/arkode-backup`}</CodeBlock>
          </Step>

          <Step n={6} where="local" title="Probar la clave nueva">
            <CodeBlock>{`exit\nssh -i "$HOME\\.ssh\\arkode_cliente_key" arkode-backup@servidor`}</CodeBlock>
            <Check>Si entra sin pedir contraseña, la clave funciona. Si pide passphrase, es porque le pusiste una en el paso 1.</Check>
          </Step>

          <Step n={7} where="remote-user" title="Guardar las credenciales de la base">
            <CodeBlock>{`cat > ~/.my.cnf << 'EOF'\n[client]\nuser=USUARIO_BD\npassword=CONTRASEÑA_BD\nEOF\nchmod 600 ~/.my.cnf`}</CodeBlock>
            <Why>
              <strong style={{ color: 'inherit' }}>Por qué así y no <Code>mysqldump -p...</Code> directo:</strong> una
              contraseña en la línea de comando queda visible, aunque sea un instante, en la lista de procesos del
              servidor. <Code>mysqldump</Code> lee <Code>~/.my.cnf</Code> solo, sin exponer nada.
            </Why>
            <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
              Para Postgres, el equivalente es un archivo <Code>~/.pgpass</Code> (mismo <Code>chmod 600</Code>) en vez
              de <Code>.my.cnf</Code>.
            </p>
          </Step>

          <Step n={8} where="remote-user" title="Probar el dump a mano">
            <CodeBlock>{`mysqldump NOMBRE_BASE > ~/test_dump.sql\ntail -3 ~/test_dump.sql`}</CodeBlock>
            <Check>
              Tiene que aparecer una línea <Code>-- Dump completed on ...</Code> al final — confirma que el dump no
              quedó cortado.
            </Check>
            <CodeBlock>{`rm ~/test_dump.sql\nexit`}</CodeBlock>
          </Step>

          <Step n={9} where="app" title="Crear la conexión SSH en arkode" last>
            <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>
              Con estos datos completá el formulario de conexión SSH:
            </p>
            <table className="w-full border-collapse text-xs">
              <tbody>
                <FieldRow label="Host">servidor / IP del cliente</FieldRow>
                <FieldRow label="Usuario">arkode-backup</FieldRow>
                <FieldRow label="Ruta de clave privada">
                  C:\Users\vos\.ssh\arkode_cliente_key — sin .pub
                </FieldRow>
                <FieldRow label="Passphrase">vacío, salvo que le hayas puesto una en el paso 1</FieldRow>
                <FieldRow label="Comando remoto">
                  mysqldump NOMBRE_BASE {'>'} /home/arkode-backup/dump_$(date +%Y%m%d_%H%M).sql
                </FieldRow>
                <FieldRow label="Plantilla de ruta de salida">/home/arkode-backup/dump_{'{date:YYYYMMDD_HHmm}'}.sql</FieldRow>
                <FieldRow label="Eliminar archivo remoto">tildado — si no, se van acumulando en el servidor</FieldRow>
              </tbody>
            </table>
            <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
              Después creás la tarea con estrategia <strong style={{ color: 'inherit' }}>SSH remoto</strong> sobre esta
              conexión, y probás "Probar conexión" antes de la primera corrida real.
            </p>
          </Step>

          <SectionLabel>Si algo no anda</SectionLabel>
          <div className="grid gap-2.5">
            <FaqItem q={'"This account is currently not available" al conectar'}>
              El login anduvo, pero esa cuenta tiene el shell deshabilitado (típico en cuentas de paneles tipo cPanel,
              no en un usuario creado con <Code>useradd -s /bin/bash</Code>). Confirmá que estás usando el usuario
              dedicado del paso 4, no una cuenta de panel existente.
            </FaqItem>
            <FaqItem q={'"command not found" al correr mysqldump'}>
              Probá <Code>which mysqldump</Code>. Si no aparece nada, el motor de base de datos no tiene sus
              herramientas de cliente instaladas en el servidor — hay que instalarlas ahí (paquete{' '}
              <Code>mysql-client</Code> o <Code>mariadb-client</Code> según la distro).
            </FaqItem>
            <FaqItem q="La conexión pide contraseña en vez de entrar con la clave">
              Revisá permisos: <Code>chmod 700</Code> en <Code>~/.ssh</Code> y <Code>chmod 600</Code> en{' '}
              <Code>authorized_keys</Code> (paso 5) — SSH ignora la clave si los permisos son más abiertos que eso.
            </FaqItem>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3
      className="mb-3 mt-6 border-b pb-2 text-xs font-semibold uppercase tracking-wide first:mt-0"
      style={{ color: 'var(--muted)', borderColor: 'var(--separator)' }}
    >
      {children}
    </h3>
  );
}

const WHERE_LABEL: Record<string, string> = {
  local: 'PowerShell · tu PC',
  remote: 'Terminal remota · servidor (como root)',
  'remote-user': 'Terminal remota · servidor (como arkode-backup)',
  app: 'App arkode',
};

function Step({
  n,
  where,
  title,
  children,
  last,
}: {
  n: number;
  where: keyof typeof WHERE_LABEL;
  title: string;
  children: ReactNode;
  last?: boolean;
}) {
  return (
    <div className="flex gap-3" style={{ marginBottom: last ? 0 : 20 }}>
      <div className="flex shrink-0 flex-col items-center">
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
          style={{ backgroundColor: 'var(--surface-tertiary)', color: 'var(--foreground)' }}
        >
          {n}
        </div>
        {!last && <div className="mt-1 w-px flex-1" style={{ backgroundColor: 'var(--separator)' }} />}
      </div>
      <div className="min-w-0 flex-1 pb-1">
        <span
          className="mb-1.5 inline-block rounded-full px-2 py-0.5 font-mono text-[11px]"
          style={{
            backgroundColor: where === 'app' ? 'color-mix(in oklab, var(--success) 15%, transparent)' : 'var(--surface-secondary)',
            color: where === 'app' ? 'var(--success)' : 'var(--muted)',
          }}
        >
          {WHERE_LABEL[where]}
        </span>
        <h4 className="mb-1.5 text-sm font-medium">{title}</h4>
        {children}
      </div>
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre
      className="mb-2 overflow-x-auto rounded-md border px-3 py-2 font-mono text-xs"
      style={{ backgroundColor: 'var(--surface-secondary)', borderColor: 'var(--border)', color: 'var(--foreground)' }}
    >
      {children}
    </pre>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code
      className="rounded px-1 py-0.5 font-mono text-[0.9em]"
      style={{ backgroundColor: 'var(--surface-secondary)', border: '1px solid var(--border)' }}
    >
      {children}
    </code>
  );
}

function Why({ children }: { children: ReactNode }) {
  return (
    <div
      className="mb-2 flex gap-2 rounded-r-md border-l-2 px-3 py-2 text-xs"
      style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--accent)', color: 'var(--muted)' }}
    >
      {children}
    </div>
  );
}

function Check({ children }: { children: ReactNode }) {
  return (
    <div
      className="mb-2 flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
      style={{
        backgroundColor: 'color-mix(in oklab, var(--success) 10%, transparent)',
        borderColor: 'color-mix(in oklab, var(--success) 30%, transparent)',
        color: 'var(--success)',
      }}
    >
      <CheckCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr style={{ borderTop: '1px solid var(--separator)' }}>
      <td className="w-1/3 py-2 pr-3 align-top" style={{ color: 'var(--muted)' }}>
        {label}
      </td>
      <td className="py-2 align-top font-mono text-[11px]" style={{ color: 'var(--foreground)', wordBreak: 'break-all' }}>
        {children}
      </td>
    </tr>
  );
}

function FaqItem({ q, children }: { q: string; children: ReactNode }) {
  return (
    <div className="rounded-md border px-3 py-2.5" style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}>
      <p className="mb-1 flex items-start gap-1.5 text-xs font-medium">
        <span className="mt-0.5 shrink-0" style={{ color: 'var(--warning)' }}>
          <AlertTriangleIcon className="h-3.5 w-3.5" />
        </span>
        {q}
      </p>
      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        {children}
      </p>
    </div>
  );
}
