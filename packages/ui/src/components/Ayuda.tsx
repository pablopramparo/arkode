import { useMemo, useState } from 'react';
import { Button } from '@heroui/react';
import type { Screen } from './AppShell';
import { SshSetupGuide } from './SshSetupGuide';
import { primaryPillStyle } from '../lib/pillStyles';

interface Step {
  text: string;
  detail?: string;
}
interface Guide {
  id: string;
  group: string;
  title: string;
  /** "¿Cuándo lo uso?" one-liner. */
  when?: string;
  steps: Step[];
  /** Exact fields to fill, with what each one means. */
  fields?: { name: string; help: string }[];
  notes?: string[];
  warnings?: string[];
  goto?: { label: string; screen: Screen }[];
  /** Show a button that opens the full in-app SSH guide. */
  sshGuide?: boolean;
}

const GROUPS = [
  'Primeros pasos',
  'Backups',
  'Conexiones y herramientas',
  'Programación',
  'Off-site y recuperación',
  'Bóveda',
  'Extras',
] as const;

const GUIDES: Guide[] = [
  {
    id: 'intro',
    group: 'Primeros pasos',
    title: 'Cómo está organizado Arkode',
    when: 'Empezá por acá si es la primera vez.',
    steps: [
      { text: 'Dashboard observa', detail: 'Estado general, qué necesita atención, próximos backups y actividad reciente. No se configura nada acá.' },
      { text: 'Clientes administra', detail: 'Cada cliente = un proyecto. Su ficha tiene tres dominios: Resumen, Backups (Tareas · Conexiones · Repositorio · Backups · Historial · Copia externa) y Proyecto (Credenciales · URLs · Snippets · Procesos · Notas).' },
      { text: 'Logs = diagnóstico técnico', detail: 'Líneas de log por corrida, con filtros. Distinto del Historial de ejecuciones de cada cliente.' },
      { text: 'Configuración = la app y la recuperación', detail: 'Versión y actualizaciones, servicio de backups, herramientas de dump, y "Recuperación de Arkode" (el backup .arkvault).' },
    ],
    notes: [
      'Orden recomendado de configuración: crear un cliente → crear su conexión → crear la tarea de backup → ponerle horario → (opcional) replicación off-site → configurar el backup .arkvault de recuperación.',
    ],
    goto: [
      { label: 'Ir a Clientes', screen: 'clientes' },
      { label: 'Ir a Configuración', screen: 'configuracion' },
    ],
  },
  {
    id: 'cliente',
    group: 'Backups',
    title: 'Crear un cliente',
    when: 'Antes de cualquier backup: todo se organiza por cliente.',
    steps: [
      { text: 'Clientes → "+ Nuevo cliente".' },
      { text: 'Completá nombre y carpeta local.' },
      { text: 'Definí la retención por defecto (cantidad y/o días). Cada tarea puede tener su propia retención después.' },
    ],
    fields: [
      { name: 'Nombre', help: 'Identifica al proyecto en todo Arkode.' },
      { name: 'Carpeta local', help: 'Dónde se guardan los backups de este cliente en esta PC. Usá "Elegir…" para el selector nativo. Puede ser una carpeta sincronizada por OneDrive/Drive.' },
      { name: 'Retención', help: 'Máximo de backups a conservar por cantidad, por antigüedad en días, o ambos (se aplica la regla más conservadora). Vacío = sin retención.' },
    ],
    goto: [{ label: 'Ir a Clientes', screen: 'clientes' }],
  },
  {
    id: 'db-backup',
    group: 'Backups',
    title: 'Backup de base de datos',
    when: 'Para hacer dumps de PostgreSQL / MySQL / MariaDB.',
    steps: [
      { text: 'Abrí el cliente → pestaña Backups → subsección Tareas → "+ Agregar backup" → "Base de datos".' },
      {
        text: 'Elegí la estrategia',
        detail:
          'fetch_existing: ya hay un dump en el servidor y lo bajás por SFTP/FTP. remote_dump: Arkode corre un comando por SSH que genera el dump y lo baja. direct_dump: Arkode se conecta directo a la base desde esta PC y corre pg_dump/mysqldump/mariadb-dump localmente.',
      },
      { text: 'Creá o elegí la conexión (transporte SFTP/SSH/FTP para las dos primeras; "conexión de base de datos" para direct_dump).' },
      { text: 'Completá los campos de la estrategia (ruta/patrón remoto, o comando remoto + plantilla de salida, o motor + nombre de base).' },
      { text: 'Opcional: asignala a un set de backup y ponele horario en el mismo paso.' },
    ],
    notes: [
      'Para remote_dump, en el comando remoto usá el placeholder {outputPath} en vez de armar la fecha con $(date …): Arkode sustituye ahí la ruta exacta donde después va a buscar el archivo.',
      'direct_dump necesita la herramienta de dump correcta para la versión del servidor — ver "Herramientas de dump".',
    ],
    goto: [{ label: 'Ir a Clientes', screen: 'clientes' }],
  },
  {
    id: 'file-backup',
    group: 'Backups',
    title: 'Backup de archivos (restic)',
    when: 'Para respaldar una carpeta entera (uploads, documentos, etc.), con deduplicación.',
    steps: [
      { text: 'Abrí el cliente → pestaña Backups → subsección Repositorio → creá el repositorio restic del cliente.' },
      { text: 'Guardá la clave de recuperación que se muestra UNA vez, en un lugar fuera de esta PC. (Se puede volver a mostrar, pero la recuperación no debe depender solo de esta máquina.)' },
      { text: 'Volvé a Tareas → "+ Agregar backup" → "Carpeta de archivos".' },
      { text: 'Elegí local_folder (ruta absoluta en esta PC) o remote_folder (carpeta en un servidor SFTP/FTP: Arkode la espeja localmente y después la respalda).' },
      { text: 'Ponele retención y horario.' },
    ],
    notes: [
      'Todas las tareas de archivos de un cliente comparten un único repositorio restic, así la deduplicación funciona entre carpetas relacionadas.',
      'El mantenimiento (prune / check) es aparte y no automático dentro de una corrida normal: hay un barrido programado a nivel repositorio.',
    ],
    goto: [{ label: 'Ir a Clientes', screen: 'clientes' }],
  },
  {
    id: 'sets',
    group: 'Backups',
    title: 'Sets de backup',
    when: 'Para agrupar visualmente tareas relacionadas (la base de un sitio + su carpeta de uploads).',
    steps: [
      { text: 'Abrí el cliente → pestaña Backups: ahí se crean y administran los sets.' },
      { text: 'Asigná una tarea a un set al crearla o editándola.' },
    ],
    notes: [
      'Un set es solo una etiqueta para reportes: NO comparte horario ni hace "correr todo". Cada tarea sigue con su propio schedule y corre sola.',
      'Un mismo set puede agrupar tareas de base de datos y de archivos del mismo cliente.',
    ],
  },
  {
    id: 'conexiones',
    group: 'Conexiones y herramientas',
    title: 'Conexión SSH / SFTP / FTP',
    when: 'Para fetch_existing (SFTP/FTP), remote_dump (SSH) o remote_folder (SFTP/FTP).',
    steps: [
      { text: 'Se crean desde el cliente → pestaña Backups → subsección Conexiones, o dentro del asistente "+ Agregar backup".' },
      { text: 'SFTP/SSH: generá un par de claves, subí la pública al servidor y usá un usuario dedicado con permisos mínimos (no root).' },
      { text: 'FTP: usuario + contraseña (FTP plano, sin TLS).' },
      { text: 'La primera conexión pide confirmar la huella del host (TOFU). Si la clave del host cambia después, Arkode avisa fuerte antes de dejar confiar de nuevo.' },
    ],
    fields: [
      { name: 'Host / Puerto / Usuario', help: 'Datos del servidor.' },
      { name: 'Clave privada (SFTP/SSH)', help: 'Arkode copia el archivo a su propio almacenamiento y lo endurece por ACL. La passphrase, si tiene, va cifrada.' },
      { name: 'Ruta / patrón remoto (fetch_existing)', help: 'Dónde y con qué nombre está el dump en el servidor.' },
      { name: 'Comando remoto + plantilla de salida (remote_dump)', help: 'El comando que genera el dump y la ruta resultante. Usá {outputPath} en el comando.' },
    ],
    sshGuide: true,
  },
  {
    id: 'db-tools',
    group: 'Conexiones y herramientas',
    title: 'Herramientas de dump (pg_dump / mysqldump / mariadb-dump)',
    when: 'Para direct_dump: la herramienta local tiene que ser compatible con la versión del servidor.',
    steps: [
      { text: 'Configuración → pestaña Herramientas.' },
      { text: 'Registrá una ruta por versión de servidor (ej. PostgreSQL 16 → un pg_dump 16), o usá "Descargar automáticamente" (Postgres y MariaDB) indicando la versión exacta.' },
      { text: 'También podés "Detectar herramientas instaladas" para registrar de un clic un binario ya presente (Program Files / WAMP / XAMPP / Laragon).' },
      { text: 'Al activar el horario de una tarea direct_dump, Arkode corre un chequeo de compatibilidad (conexión + versión + herramienta usable). Se puede forzar si hace falta.' },
    ],
    notes: [
      'Arkode ya trae vendorizados el cliente y el dumper de MariaDB (hablan el protocolo MySQL para ambos motores), así que muchos casos funcionan sin registrar nada.',
      'MySQL de Oracle (mysqldump) no viene incluido por licencia; se registra a mano si se prefiere sobre el de MariaDB.',
    ],
    goto: [{ label: 'Ir a Configuración', screen: 'configuracion' }],
  },
  {
    id: 'scheduler',
    group: 'Programación',
    title: 'Horarios y el servicio arkode-scheduler',
    when: 'Para que los backups corran solos, con la app cerrada.',
    steps: [
      { text: 'Ponele horario a cada tarea (hora + frecuencia: diaria, semanal con días, o mensual con día del mes).' },
      { text: 'No hay nada más que registrar: un servicio de Windows (arkode-scheduler, LocalSystem) revisa cada 60 s qué tarea corresponde y la ejecuta.' },
      { text: 'Si el servicio se detiene, en Configuración → "Servicio de backups" están Reiniciar y Reinstalar.' },
    ],
    notes: [
      'Cambiar el horario de una tarea no requiere reinstalar nada: el servicio lo toma en el próximo ciclo.',
      'No hay prompts de UAC por tarea: el instalador ya deja el servicio configurado. Un "Ejecutar ahora" manual no suprime el backup programado de esa noche.',
    ],
    goto: [{ label: 'Ir a Configuración', screen: 'configuracion' }],
  },
  {
    id: 'replicacion',
    group: 'Off-site y recuperación',
    title: 'Replicar backups a Google Drive / SFTP / FTP',
    when: 'Para tener una copia de los backups reales fuera de esta PC (regla 3-2-1).',
    steps: [
      { text: 'Abrí el cliente → pestaña Copia externa.' },
      { text: 'Configurá una copia por contenido: "Archivos (repositorio restic)" y/o "Bases de datos (dumps)". Son independientes.' },
      { text: 'Elegí destino: Google Drive (autorización OAuth con la cuenta), o una conexión SFTP/FTP existente del cliente.' },
      { text: 'Para "Bases de datos (dumps)" se envuelve la subida en un cifrado rclone con su propia contraseña (los dumps no están cifrados en disco). El repositorio restic ya está cifrado, se sube tal cual.' },
      { text: 'Probá la conexión y usá "Copiar ahora"; después corre sola tras cada backup exitoso.' },
    ],
    notes: [
      'Es una capa opcional que corre DESPUÉS de que el backup terminó; no toca los orquestadores de backup ni restic.',
      'Guardá la contraseña de cifrado de los dumps fuera de esta PC: no se incluye en un export de configuración.',
    ],
    goto: [{ label: 'Ir a Clientes', screen: 'clientes' }],
  },
  {
    id: 'arkvault',
    group: 'Off-site y recuperación',
    title: 'Recuperación de Arkode (.arkvault)',
    when: 'El archivo que reconstruye Arkode entero en una máquina nueva.',
    steps: [
      { text: 'Configuración → "Recuperación de Arkode".' },
      { text: 'Agregá un destino: "Carpeta local" (puede ser una sincronizada por OneDrive/Drive) y/o "Google Drive".' },
      { text: 'Para Google Drive: conectá una cuenta (o reutilizá una ya conectada en Replicación) y definí la carpeta remota (por defecto Arkode/Vault).' },
      { text: 'Definí la retención por destino y probá con "Crear backup ahora".' },
      { text: 'Se genera solo con Arkode abierto y la bóveda desbloqueada: al abrir/desbloquear, cada destino sin una copia exitosa reciente (~20 h) se genera; abrir y cerrar varias veces no genera copias de más.' },
    ],
    notes: [
      'El .arkvault lleva la configuración y TODOS los secretos operativos (transportes, conexiones, tareas, horarios, claves restic, config y tokens de rclone, claves SSH, contraseña de la bóveda). Está cifrado con la contraseña maestra: tratá el archivo como sensible.',
      'NO incluye los backups reales de tus clientes — esos quedan afuera, en su carpeta / replicación.',
      'El token de Google del destino .arkvault viaja cifrado dentro del propio .arkvault, así que tras un restore el backup remoto se reanuda solo, sin volver a autorizar Google.',
    ],
    warnings: [
      'Restauración en máquina nueva: entrás a drive.google.com a mano, bajás el último .arkvault, instalás Arkode, "Restaurar desde archivo .arkvault", ingresás la contraseña maestra. Arkode NO necesita acceso a Drive para restaurar.',
      'Si perdés la contraseña maestra no hay forma de recuperar el .arkvault: no hay backdoor. Guardala aparte.',
    ],
    goto: [{ label: 'Ir a Configuración', screen: 'configuracion' }],
  },
  {
    id: 'boveda',
    group: 'Bóveda',
    title: 'Contraseña maestra, bloqueo y credenciales',
    when: 'Para guardar credenciales, URLs, snippets, procesos y notas de cada proyecto, cifrados.',
    steps: [
      { text: 'La primera vez, definí la contraseña maestra (chip de candado en la barra lateral, o Configuración).' },
      { text: 'Desbloqueá la bóveda para ver/copiar secretos; se bloquea sola por inactividad y al cerrar la app.' },
      { text: 'Cargá credenciales y demás desde el cliente → pestaña Proyecto (Credenciales · URLs · Snippets · Procesos · Notas).' },
      { text: 'Usá la búsqueda global (barra lateral) para encontrar cualquier ítem por nombre/host/entorno; funciona aun con la bóveda bloqueada (los metadatos son texto plano; solo el valor secreto está cifrado).' },
    ],
    notes: [
      'La contraseña maestra no se guarda en ningún lado y no tiene reset. Cambiarla es O(1) (no re-cifra todo).',
      'Los backups programados NO usan la bóveda: una bóveda bloqueada no los afecta.',
    ],
  },
  {
    id: 'boveda-bridge',
    group: 'Bóveda',
    title: 'Usar una credencial de la bóveda para un backup',
    when: 'Para tener una sola fuente de verdad de una credencial que además usa una tarea programada.',
    steps: [
      { text: 'En una credencial de tipo ssh/sftp/ftp o postgres/mysql/mariadb, activá "usar para backups".' },
      { text: 'Arkode crea (o vincula) la conexión correspondiente y copia el secreto a su almacenamiento operativo cifrado por máquina (DPAPI), que el servicio puede leer sin la contraseña maestra.' },
      { text: 'Editar la credencial en la bóveda actualiza también esa copia operativa.' },
      { text: 'Si la sincronización operativa queda en error, usá "Reparar" (por credencial, o el global en Configuración → Bóveda).' },
    ],
    notes: [
      'Tras un restore de .arkvault, "re-sincronizar secretos operativos" regenera todas esas copias (DPAPI + archivos de clave SSH) desde la bóveda.',
    ],
  },
  {
    id: 'config-export',
    group: 'Extras',
    title: 'Exportar / importar configuración',
    when: 'Para mover definiciones de clientes entre máquinas, SIN secretos.',
    steps: [
      { text: 'Configuración → exportar (todos los clientes o uno).' },
      { text: 'En la otra máquina, importar el archivo. Importar siempre crea filas nuevas: un cliente con nombre repetido falla con un error claro por cliente, sin abortar el resto.' },
      { text: 'Después de importar, volvé a ingresar los secretos que el resultado lista (passphrases, contraseñas de base).' },
    ],
    notes: [
      'Esto NO es el mecanismo de disaster recovery: para eso está el .arkvault, que sí incluye los secretos. El export de configuración es a propósito libre de secretos.',
      'Las claves privadas SSH sí se incluyen (bytes en base64) si el archivo era legible al exportar — tratá ese export como sensible en ese caso.',
    ],
    goto: [{ label: 'Ir a Configuración', screen: 'configuracion' }],
  },
  {
    id: 'updates',
    group: 'Extras',
    title: 'Actualizaciones e inicio automático',
    when: 'Solo en la app de escritorio (Tauri).',
    steps: [
      { text: 'Configuración → "Buscar actualizaciones" → "Descargar e instalar" → "Reiniciar ahora".' },
      { text: 'El instalador cierra la app y el sidecar, actualiza en el lugar y conserva datos, historial y configuración.' },
      { text: 'Opcional: "Iniciar Arkode automáticamente al iniciar Windows". Solo abre el Dashboard al prender la PC; los backups programados corren igual (los ejecuta el servicio).' },
    ],
    goto: [{ label: 'Ir a Configuración', screen: 'configuracion' }],
  },
];

export function Ayuda({ onNavigate }: { onNavigate: (screen: Screen) => void }) {
  const [activeId, setActiveId] = useState<string>(GUIDES[0].id);
  const [showSsh, setShowSsh] = useState(false);
  const guide = useMemo(() => GUIDES.find((g) => g.id === activeId) ?? GUIDES[0], [activeId]);

  return (
    <div className="max-w-[1600px] px-10 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Ayuda</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Elegí qué querés hacer y seguí los pasos.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        {/* selector */}
        <nav className="space-y-4">
          {GROUPS.map((group) => {
            const items = GUIDES.filter((g) => g.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group}>
                <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
                  {group}
                </div>
                <div className="flex flex-col">
                  {items.map((g) => {
                    const active = g.id === activeId;
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => setActiveId(g.id)}
                        className="rounded-md px-2 py-1.5 text-left text-sm"
                        style={{
                          color: active ? 'var(--foreground)' : 'var(--muted)',
                          backgroundColor: active ? 'color-mix(in oklab, var(--accent) 14%, transparent)' : 'transparent',
                          fontWeight: active ? 600 : 400,
                        }}
                      >
                        {g.title}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        {/* guide */}
        <article className="min-w-0 rounded-xl border p-6" style={{ borderColor: 'var(--border)' }}>
          <h2 className="text-lg font-semibold">{guide.title}</h2>
          {guide.when && (
            <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
              {guide.when}
            </p>
          )}

          <ol className="mt-4 space-y-3">
            {guide.steps.map((s, i) => (
              <li key={i} className="flex gap-3">
                <span
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                  style={{ backgroundColor: 'color-mix(in oklab, var(--accent) 18%, transparent)', color: 'var(--accent)' }}
                >
                  {i + 1}
                </span>
                <div className="text-sm">
                  <div>{s.text}</div>
                  {s.detail && (
                    <div className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                      {s.detail}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {guide.fields && guide.fields.length > 0 && (
            <div className="mt-5">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
                Campos
              </div>
              <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-3 gap-y-1 text-sm">
                {guide.fields.map((f) => (
                  <div key={f.name} className="contents">
                    <dt className="font-medium">{f.name}</dt>
                    <dd style={{ color: 'var(--muted)' }}>{f.help}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {guide.notes && guide.notes.length > 0 && (
            <ul className="mt-5 space-y-1.5 text-xs" style={{ color: 'var(--muted)' }}>
              {guide.notes.map((n, i) => (
                <li key={i} className="flex gap-2">
                  <span aria-hidden>·</span>
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          )}

          {guide.warnings && guide.warnings.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-xs" style={{ color: 'var(--warning)' }}>
              {guide.warnings.map((w, i) => (
                <li key={i} className="flex gap-2">
                  <span aria-hidden>⚠</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}

          {(guide.goto?.length || guide.sshGuide) && (
            <div className="mt-6 flex flex-wrap gap-2">
              {guide.sshGuide && (
                <Button size="sm" variant="ghost" className="rounded-full px-4" onPress={() => setShowSsh(true)}>
                  Ver guía SSH completa
                </Button>
              )}
              {guide.goto?.map((g) => (
                <Button
                  key={g.screen}
                  size="sm"
                  className="rounded-full px-4"
                  style={primaryPillStyle}
                  onPress={() => onNavigate(g.screen)}
                >
                  {g.label}
                </Button>
              ))}
            </div>
          )}
        </article>
      </div>

      {showSsh && <SshSetupGuide onClose={() => setShowSsh(false)} />}
    </div>
  );
}
