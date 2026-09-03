import { useState, type ReactNode } from 'react';
import { CheckCircleIcon, AlertTriangleIcon } from './icons';

type Method = 'ssh' | 'docker';

/**
 * Contextual help for setting up a remote_dump connection — surfaced from
 * the SSH connection form itself (Conexiones and the task wizard's inline
 * "create connection" flow), not as a separate top-level screen: it's only
 * useful exactly when someone is filling out that form. Covers both
 * remote_dump exec modes: 'ssh' (a dump binary installed directly on the
 * host — the original guide) and 'docker' (the database runs inside a
 * container, e.g. Coolify — added 2026-08-27 alongside that feature, mirrors
 * ops/arkode-dump/README.md's setup steps in the app's own step-list style).
 * Steps 1-6 (the SSH connection itself) are identical for both methods —
 * only what happens once you're connected to the server differs.
 */
export function SshSetupGuide({ onClose }: { onClose: () => void }) {
  const [method, setMethod] = useState<Method>('ssh');

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
          <h2 className="text-base font-semibold">Backup remoto, paso a paso</h2>
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

          <SectionLabel>¿Cómo corre la base de datos en el servidor?</SectionLabel>
          <div className="mb-4 flex gap-2">
            <MethodButton
              active={method === 'ssh'}
              onClick={() => setMethod('ssh')}
              title="Directo en el host"
              subtitle="pg_dump / mysqldump instalado en el servidor mismo"
            />
            <MethodButton
              active={method === 'docker'}
              onClick={() => setMethod('docker')}
              title="Dentro de un contenedor Docker"
              subtitle="Coolify u otro panel basado en Docker"
            />
          </div>

          <p className="mb-6" style={{ color: 'var(--muted)' }}>
            {method === 'ssh' ? (
              <>
                Al terminar vas a tener un usuario Linux dedicado, sin privilegios de root, que solo puede escribir en
                su propia carpeta y correr el comando de dump — conectado por clave SSH, sin contraseñas guardadas en
                ningún lado del servidor.
              </>
            ) : (
              <>
                Al terminar vas a tener un wrapper instalado en el servidor que arkode invoca para correr el dump{' '}
                <em>dentro</em> del contenedor — nunca <Code>docker exec</Code> directo, y el usuario SSH nunca
                necesita pertenecer al grupo <Code>docker</Code> (eso equivale a acceso root sobre todo el servidor).
              </>
            )}
          </p>

          <SectionLabel>Antes de empezar</SectionLabel>
          <ul className="mb-2 grid gap-1.5 text-xs" style={{ color: 'var(--muted)' }}>
            <li>Acceso root al servidor (por SSH, con usuario y contraseña o clave)</li>
            {method === 'ssh' ? (
              <li>Usuario y contraseña de la base de datos que querés respaldar</li>
            ) : (
              <>
                <li>Nombre o ID del contenedor de la base de datos (ej. desde Coolify, o <Code>docker ps</Code>)</li>
                <li>Usuario de la base de datos dentro del contenedor, y contraseña si el motor la requiere</li>
              </>
            )}
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
              carpeta —{' '}
              {method === 'ssh'
                ? 'nunca root para esto.'
                : 'y nunca queda en el grupo docker, que equivaldría a acceso root sobre todo el servidor (ver paso 8).'}
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

          {method === 'ssh' ? (
            <>
              <Step n={7} where="remote-user" title="Guardar las credenciales de la base">
                <CodeBlock>{`cat > ~/.my.cnf << 'EOF'\n[client]\nuser=USUARIO_BD\npassword=CONTRASEÑA_BD\nEOF\nchmod 600 ~/.my.cnf`}</CodeBlock>
                <Why>
                  <strong style={{ color: 'inherit' }}>
                    Por qué así y no <Code>mysqldump -p...</Code> directo:
                  </strong>{' '}
                  una contraseña en la línea de comando queda visible, aunque sea un instante, en la lista de procesos
                  del servidor. <Code>mysqldump</Code> lee <Code>~/.my.cnf</Code> solo, sin exponer nada.
                </Why>
                <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
                  Para Postgres, el equivalente es un archivo <Code>~/.pgpass</Code> (mismo <Code>chmod 600</Code>) en
                  vez de <Code>.my.cnf</Code>.
                </p>
              </Step>

              <Step n={8} where="remote-user" title="Probar el dump a mano">
                <CodeBlock>{`mysqldump --single-transaction --quick --no-tablespaces NOMBRE_BASE > ~/test_dump.sql\ntail -3 ~/test_dump.sql`}</CodeBlock>
                <Check>
                  Tiene que aparecer una línea <Code>-- Dump completed on ...</Code> al final — confirma que el dump no
                  quedó cortado.
                </Check>
                <Why>
                  <strong style={{ color: 'inherit' }}>
                    <Code>--no-tablespaces</Code>:
                  </strong>{' '}
                  en MySQL 8.x un usuario de backup sin el privilegio global <Code>PROCESS</Code> hace fallar{' '}
                  <Code>mysqldump</Code> con <em>"you need (at least one of) the PROCESS privilege(s)"</em>. Casi ningún
                  backup necesita volcar tablespaces, así que se saltean.{' '}
                  <Code>--single-transaction --quick</Code> hacen el dump consistente sin bloquear las tablas y sin
                  cargarlo entero en memoria. Para Postgres nada de esto aplica — <Code>pg_dump -Fc NOMBRE_BASE</Code>{' '}
                  alcanza.
                </Why>
                <CodeBlock>{`rm ~/test_dump.sql\nexit`}</CodeBlock>
              </Step>

              <Step n={9} where="app" title="Crear la conexión SSH en arkode" last>
                <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>
                  Con estos datos completá el formulario de conexión SSH, con modo de ejecución{' '}
                  <strong style={{ color: 'inherit' }}>Directo en el host</strong>:
                </p>
                <table className="w-full border-collapse text-xs">
                  <tbody>
                    <FieldRow label="Host">servidor / IP del cliente</FieldRow>
                    <FieldRow label="Usuario">arkode-backup</FieldRow>
                    <FieldRow label="Ruta de clave privada">C:\Users\vos\.ssh\arkode_cliente_key — sin .pub</FieldRow>
                    <FieldRow label="Passphrase">vacío, salvo que le hayas puesto una en el paso 1</FieldRow>
                    <FieldRow label="Comando remoto">
                      mysqldump --single-transaction --quick --no-tablespaces NOMBRE_BASE {'>'} {'{outputPath}'}
                    </FieldRow>
                    <FieldRow label="Plantilla de ruta de salida">
                      /home/arkode-backup/dump_{'{date:YYYYMMDD_HHmm}'}.sql
                    </FieldRow>
                    <FieldRow label="Eliminar archivo remoto">tildado — si no, se van acumulando en el servidor</FieldRow>
                  </tbody>
                </table>
                <Why>
                  <strong style={{ color: 'inherit' }}>
                    Por qué <Code>{'{outputPath}'}</Code> y no <Code>$(date ...)</Code> en el comando:
                  </strong>{' '}
                  arkode resuelve la <em>plantilla de ruta de salida</em> una sola vez (contra el reloj del servidor) y
                  reemplaza <Code>{'{outputPath}'}</Code> por esa ruta exacta, ya entrecomillada. Así el comando escribe
                  justo donde arkode después busca el archivo. Si en cambio el comando arma el nombre por su cuenta con{' '}
                  <Code>$(date ...)</Code>, los dos nombres pueden no coincidir —desfasaje de reloj entre las máquinas, un
                  dump que cruza el cambio de minuto, u otro formato de fecha— y la descarga falla con{' '}
                  <Code>No such file</Code>.
                </Why>
                <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
                  Alternativa más simple: usá una ruta fija sin fecha. Comando{' '}
                  <Code>mysqldump --single-transaction --quick --no-tablespaces NOMBRE_BASE &gt; /home/arkode-backup/web.sql</Code>,
                  plantilla <Code>/home/arkode-backup/web.sql</Code>, con "Eliminar archivo remoto" tildado — cada corrida
                  pisa el archivo anterior y arkode ya se lo llevó.
                </p>
                <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
                  Después creás la tarea con estrategia <strong style={{ color: 'inherit' }}>SSH remoto</strong> sobre
                  esta conexión, y probás "Probar conexión" antes de la primera corrida real.
                </p>
              </Step>
            </>
          ) : (
            <>
              <Step n={7} where="remote" title="Identificar el contenedor">
                <CodeBlock>{`docker ps`}</CodeBlock>
                <p className="text-xs" style={{ color: 'var(--muted)' }}>
                  Anotá el nombre o ID exacto del contenedor de la base de datos (columna <Code>NAMES</Code> o{' '}
                  <Code>CONTAINER ID</Code>) — lo vas a necesitar dos veces: en el allowlist del paso siguiente y en
                  el formulario de arkode.
                </p>
              </Step>

              <Step n={8} where="remote" title="Instalar el wrapper arkode-dump">
                <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>
                  Copiá <Code>ops/arkode-dump/arkode-dump.sh</Code> (del repo de arkode) al servidor como{' '}
                  <Code>/usr/local/sbin/arkode-dump</Code>, dueño <Code>root</Code>, sin permisos para nadie más:
                </p>
                <CodeBlock>{`install -o root -g root -m 700 arkode-dump.sh /usr/local/sbin/arkode-dump`}</CodeBlock>
                <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>
                  Después, la lista de contenedores permitidos — el control real de seguridad: ni arkode ni el
                  usuario SSH pueden pedir un contenedor que no esté acá, sin importar qué les pidan:
                </p>
                <CodeBlock>{`mkdir -p /etc/arkode-dump\necho 'NOMBRE_DEL_CONTENEDOR' > /etc/arkode-dump/allowed-containers.conf\nchmod 644 /etc/arkode-dump/allowed-containers.conf`}</CodeBlock>
                <Why>
                  <strong style={{ color: 'inherit' }}>Por qué un wrapper y no </strong>
                  <Code>docker exec</Code>
                  <strong style={{ color: 'inherit' }}> directo:</strong> el usuario SSH nunca necesita pertenecer al
                  grupo <Code>docker</Code> (equivalente a root sobre todo el servidor) ni tener permiso de{' '}
                  <Code>sudo</Code> para <Code>docker exec</Code> sin restricciones. El wrapper valida motor,
                  contenedor y nombres antes de tocar Docker — es el único programa con permiso para eso, y ni
                  siquiera el usuario SSH puede leerlo o modificarlo.
                </Why>
              </Step>

              <Step n={9} where="remote" title="Dar permiso de sudo, acotado a ese único programa">
                <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>
                  Solo hace falta si <Code>arkode-backup</Code> es un usuario sin privilegios (lo recomendado). Si en
                  cambio arkode se conecta directamente como <Code>root</Code> en este servidor, este paso no es
                  necesario — <Code>sudo</Code> no hace nada especial cuando ya sos root.
                </p>
                <CodeBlock>{`echo 'arkode-backup ALL=(root) NOPASSWD: /usr/local/sbin/arkode-dump' > /etc/sudoers.d/arkode-dump\nchmod 440 /etc/sudoers.d/arkode-dump`}</CodeBlock>
                <Why>
                  Sin argumentos restringidos a propósito: la validación real vive dentro del wrapper (paso 8), no en
                  un patrón de <Code>sudoers</Code> — un <Code>docker exec ... *</Code> con comodín seguiría dejando
                  pasar cualquier argumento final.
                </Why>
              </Step>

              <Step n={10} where="remote" title="Probar el wrapper a mano">
                <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>
                  Sin contraseña (ej. Postgres con autenticación por socket, el caso más común):
                </p>
                <CodeBlock>{`printf '' | sudo /usr/local/sbin/arkode-dump --engine postgres \\\n  --container NOMBRE_DEL_CONTENEDOR --database NOMBRE_BASE --user USUARIO_BD \\\n  > /tmp/test.dump`}</CodeBlock>
                <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>
                  Con contraseña (MySQL/MariaDB, normalmente sí la piden):
                </p>
                <CodeBlock>{`printf '%s' 'LA_CONTRASEÑA' | sudo /usr/local/sbin/arkode-dump --engine mysql \\\n  --container NOMBRE_DEL_CONTENEDOR --database NOMBRE_BASE --user USUARIO_BD \\\n  > /tmp/test.sql`}</CodeBlock>
                <Check>
                  Revisá el tamaño del archivo (<Code>ls -la /tmp/test.dump</Code>) — si tiene un tamaño razonable
                  (no 0 bytes), funcionó. Borralo después: <Code>rm /tmp/test.dump</Code>.
                </Check>
              </Step>

              <Step n={11} where="app" title="Crear la conexión y tarea en arkode" last>
                <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>
                  La conexión SSH se completa igual que en el modo directo (Host, Usuario, Ruta de clave privada,
                  Passphrase — pasos 1 a 6). Al crear la tarea, elegí modo de ejecución{' '}
                  <strong style={{ color: 'inherit' }}>Dentro de un contenedor Docker</strong> y completá:
                </p>
                <table className="w-full border-collapse text-xs">
                  <tbody>
                    <FieldRow label="Contenedor">el nombre/ID exacto del paso 7 (y del allowlist del paso 8)</FieldRow>
                    <FieldRow label="Base de datos">NOMBRE_BASE</FieldRow>
                    <FieldRow label="Usuario de BD">USUARIO_BD</FieldRow>
                    <FieldRow label="Contraseña de BD">
                      vacío para Postgres si no la pidió en el paso 10; la contraseña real para MySQL/MariaDB
                    </FieldRow>
                    <FieldRow label="Plantilla de ruta de salida">
                      /home/arkode-backup/dump_{'{date:YYYYMMDD_HHmm}'}.sql — arkode crea la carpeta sola
                    </FieldRow>
                    <FieldRow label="Eliminar archivo remoto">tildado — si no, se van acumulando en el servidor</FieldRow>
                  </tbody>
                </table>
                <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
                  La contraseña viaja cifrada y nunca queda expuesta como argumento de un proceso, ni en este servidor
                  ni dentro del contenedor — ver el detalle en{' '}
                  <Code>ops/arkode-dump/README.md</Code> del repo si te interesa el mecanismo exacto.
                </p>
              </Step>
            </>
          )}

          <SectionLabel>Si algo no anda</SectionLabel>
          <div className="grid gap-2.5">
            <FaqItem q={'"This account is currently not available" al conectar'}>
              El login anduvo, pero esa cuenta tiene el shell deshabilitado (típico en cuentas de paneles tipo cPanel,
              no en un usuario creado con <Code>useradd -s /bin/bash</Code>). Confirmá que estás usando el usuario
              dedicado del paso 4, no una cuenta de panel existente.
            </FaqItem>
            <FaqItem q="La conexión pide contraseña en vez de entrar con la clave">
              Revisá permisos: <Code>chmod 700</Code> en <Code>~/.ssh</Code> y <Code>chmod 600</Code> en{' '}
              <Code>authorized_keys</Code> (paso 5) — SSH ignora la clave si los permisos son más abiertos que eso.
            </FaqItem>
            {method === 'ssh' ? (
              <>
                <FaqItem q={'"command not found" al correr mysqldump'}>
                  Probá <Code>which mysqldump</Code>. Si no aparece nada, el motor de base de datos no tiene sus
                  herramientas de cliente instaladas en el servidor — hay que instalarlas ahí (paquete{' '}
                  <Code>mysql-client</Code> o <Code>mariadb-client</Code> según la distro).
                </FaqItem>
                <FaqItem q={'"No such file" al ejecutar la tarea (la conexión SSH sí funciona)'}>
                  El comando remoto está armando el nombre del archivo por su cuenta —casi siempre con{' '}
                  <Code>$(date ...)</Code>— y ese nombre no coincide con el que arkode calcula desde la plantilla de ruta
                  de salida. Poné <Code>{'{outputPath}'}</Code> en el comando, en lugar de repetir la ruta o la fecha:
                  arkode lo reemplaza por la ruta exacta que resolvió (paso 9). O usá una ruta fija sin fecha en ambos
                  campos.
                </FaqItem>
                <FaqItem q={'mysqldump: "you need (at least one of) the PROCESS privilege(s)"'}>
                  MySQL 8.x y un usuario de backup sin <Code>PROCESS</Code> global. Agregá <Code>--no-tablespaces</Code>{' '}
                  al comando <Code>mysqldump</Code> — no hace falta volcar tablespaces para un backup lógico normal.
                </FaqItem>
              </>
            ) : (
              <>
                <FaqItem q={'"container ... is not in the allowlist"'}>
                  El nombre/ID que puso arkode no coincide, carácter por carácter, con la línea de{' '}
                  <Code>/etc/arkode-dump/allowed-containers.conf</Code> (paso 8). Copialo directo de{' '}
                  <Code>docker ps</Code> en vez de escribirlo a mano.
                </FaqItem>
                <FaqItem q="La tarea falla pero el wrapper a mano (paso 10) funcionó bien">
                  Confirmá que el usuario de la conexión SSH en arkode es exactamente el mismo que probaste a mano, y
                  que tiene el permiso de <Code>sudo</Code> del paso 9 (o es <Code>root</Code> directamente).
                </FaqItem>
                <FaqItem q="Permissions are too open al revisar la clave privada con ssh-keygen">
                  No es un problema del servidor — es la copia que arkode guarda de la clave en esta PC
                  (<Code>%PROGRAMDATA%\arkode\keys\</Code>). arkode la corrige solo al arrancar; si persiste, es un
                  bug para reportar.
                </FaqItem>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MethodButton({ active, onClick, title, subtitle }: { active: boolean; onClick: () => void; title: string; subtitle: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 rounded-lg border px-3 py-2 text-left transition-colors"
      style={{
        borderColor: active ? 'var(--accent)' : 'var(--border)',
        backgroundColor: active ? 'color-mix(in oklab, var(--accent) 10%, transparent)' : 'var(--surface)',
      }}
    >
      <div className="text-xs font-semibold" style={{ color: active ? 'var(--accent)' : 'var(--foreground)' }}>
        {title}
      </div>
      <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
        {subtitle}
      </div>
    </button>
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
