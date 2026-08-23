Quiero desarrollar una aplicación local para Windows llamada provisionalmente **Codebius Backup Manager**.

Soy desarrollador web y trabajo principalmente con TypeScript, React/Next.js, Tailwind, PostgreSQL/MySQL. Quiero mantener el proyecto dentro de ese ecosistema siempre que sea razonable.

## Objetivo

La aplicación debe centralizar los backups de bases de datos de distintos clientes y servidores.

NO quiero que la aplicación sea responsable inicialmente de administrar servidores ni de hacer deploys.

Su responsabilidad principal es:

**conectarse a servidores → obtener backups de bases de datos → almacenarlos localmente → verificar que sean válidos → aplicar políticas de retención → mostrar claramente su estado.**

Debe ser una herramienta interna, simple y extremadamente confiable.

## Arquitectura

El resultado final debe distribuirse como una aplicación Windows ejecutable/instalable, pensada para uso cotidiano sin entorno de desarrollo.

Requisitos:

generar un .exe y preferentemente un instalador para Windows;
no requerir Node.js, npm, Rust ni herramientas de desarrollo instaladas en la PC destino;
poder iniciarse desde el menú Inicio/acceso directo como cualquier aplicación;
persistir configuración, SQLite y logs en ubicaciones apropiadas de Windows (AppData/directorio configurable), no dentro de la carpeta de instalación;
contemplar actualización futura de la aplicación sin perder configuración ni historial;
el motor de backups debe poder ejecutarse de forma desatendida por Windows Task Scheduler aunque la interfaz gráfica esté cerrada;
el empaquetado final debe incluir o resolver correctamente cualquier dependencia necesaria para validar dumps (pg_restore, etc.), sin asumir que PostgreSQL está instalado globalmente.

Durante desarrollo puede utilizarse el tooling habitual, pero la arquitectura debe diseñarse desde el principio teniendo esta distribución final en cuenta.

Preferencia:

- React + TypeScript para UI.
- Tailwind CSS.
- Heroui
- Tauri como shell desktop si resulta adecuado.
- SQLite para configuración, historial y logs.
- Evitar dependencias innecesarias.
- La lógica de backups debe estar separada de la UI.
- Debe ser posible ejecutar el motor de backups sin tener abierta la interfaz.

Antes de implementar, proponé una arquitectura concreta y justificá cualquier desviación respecto de este stack.

## Entidades

### Clientes

Cada cliente debe tener:

- nombre;
- descripción opcional;
- activo/inactivo;
- carpeta local base;
- política de retención;
- uno o más servidores/conexiones;
- una o más tareas de backup.

### Conexiones

Inicialmente soportar:

#### SFTP

Para servidores donde el backup ya existe.

Configuración:

- host;
- puerto;
- usuario;
- autenticación mediante SSH key;
- ruta de private key;
- remote path.

Funcionamiento:

1. conectar;
2. listar backups remotos;
3. identificar cuáles no existen localmente;
4. descargarlos;
5. verificar que la transferencia haya terminado correctamente;
6. registrar tamaño, fecha y estado.

Nunca volver a descargar innecesariamente un backup existente y validado.

#### SSH

Para servidores donde necesitamos generar el backup.

Configuración:

- host;
- puerto;
- usuario;
- autenticación mediante SSH key;
- ruta de private key;
- comando remoto configurable.

Funcionamiento:

1. conectar por SSH;
2. ejecutar el comando de backup;
3. comprobar exit code;
4. localizar el archivo generado;
5. descargarlo;
6. verificarlo;
7. opcionalmente eliminar el temporal remoto.

No asumir que todos los servidores usan Coolify.

## Bases de datos

Diseñar la arquitectura para soportar adaptadores.

Inicialmente:

- PostgreSQL
- MySQL

Pero NO implementar veinte proveedores hipotéticos.

Para PostgreSQL, los backups podrán ser generados con `pg_dump`.

Para MySQL, `mysqldump`.

Cuando SFTP sea utilizado, la aplicación simplemente obtiene dumps previamente generados y no necesita conocer las credenciales de la DB.

## Seguridad

Prioridad alta.

- Nunca guardar private keys dentro de SQLite.
- Guardar solamente referencias/rutas cuando corresponda.
- No guardar passwords en texto plano.
- Evaluar Windows Credential Manager para secretos.
- No loguear credenciales.
- Validar fingerprints SSH y evitar aceptar hosts silenciosamente.
- Permitir registrar/confirmar hosts conocidos.
- Aplicar principio de mínimo privilegio.
- Un usuario de backup no debería necesitar acceso root.

## Almacenamiento local

Estructura conceptual:

`Backups/{cliente}/{database}/{YYYY}/{MM}/`

Ejemplo:

`D:\CodebiusBackups\Winners\postgres\2026\08\winners_2026-08-23_0300.dump`

Evitar depender del nombre del archivo como única fuente de metadata. SQLite debe mantener el historial.

Guardar:

- cliente;
- database;
- servidor;
- fecha remota;
- fecha de descarga;
- tamaño;
- hash/checksum;
- estado;
- ruta local;
- método utilizado;
- duración;
- errores.

## Validación

Un archivo descargado NO debe considerarse automáticamente un backup válido.

Como mínimo:

- existe;
- tamaño > 0;
- transferencia completa;
- checksum cuando sea posible.

Para PostgreSQL custom dumps, permitir validación mediante:

`pg_restore --list`

Más adelante quiero implementar restauraciones automáticas de prueba, pero NO es requisito de la primera versión.

Estados sugeridos:

- Pending
- Running
- Downloading
- Validating
- Success
- Warning
- Failed

## Retención

Configurable por tarea/cliente.

Por ejemplo:

- últimos 30 backups diarios;
- o X días.

Nunca borrar un backup antes de confirmar que existen backups posteriores válidos.

Registrar cualquier eliminación en el historial.

## Scheduler

La aplicación debe poder ejecutar backups automáticamente aunque la UI esté cerrada.

Preferir integración con **Windows Task Scheduler** antes que mantener permanentemente un proceso propio corriendo.

La UI debe permitir configurar una hora diaria.

Si la PC estaba apagada durante el horario previsto, evaluar ejecutar la tarea pendiente al volver a estar disponible.

## Dashboard

Quiero una UI simple, sobria y orientada a detectar problemas inmediatamente.

Dashboard principal:

| Cliente     | Último backup | Tamaño | Estado | Antigüedad |
| ----------- | ------------- | ------ | ------ | ---------- |
| Winners     | 23/08 03:02   | 142 MB | ✓      | 11 h       |
| Carena      | 23/08 03:05   | 318 MB | ✓      | 11 h       |
| Compagnucci | 22/08 03:04   | 1.2 GB | ⚠      | 35 h       |

Los problemas deben destacar visualmente mucho más que los backups correctos.

No quiero un dashboard SaaS lleno de métricas decorativas.

Necesito poder entrar y responder en cinco segundos:

**¿Todos mis clientes tienen un backup reciente y válido?**

## Pantallas V1

- Dashboard
- Clientes
- Detalle de cliente
- Conexiones
- Tareas de backup
- Historial
- Logs
- Configuración

Desde un cliente:

- Ejecutar backup ahora
- Probar conexión
- Ver backups
- Abrir carpeta local
- Ver último error

## UX

Priorizar densidad de información y claridad.

Desktop first.

No necesito responsive mobile.

Modo oscuro.

Evitar:

- cards gigantes;
- gradientes decorativos;
- gráficos sin utilidad;
- animaciones innecesarias;
- exceso de modales.

Es una herramienta técnica, no una landing page.

## Logging

Necesito logs útiles para diagnóstico.

Cada ejecución debe registrar:

- inicio;
- conexión;
- generación remota si corresponde;
- descarga;
- validación;
- aplicación de retención;
- resultado;
- duración;
- mensaje de error completo si falla.

Los logs deben existir en archivo además de SQLite, para poder diagnosticar problemas aunque la aplicación tenga inconvenientes.

## Comportamiento ante errores

Una falla en un cliente NO debe detener los backups de los demás.

Las tareas deben ser independientes.

No eliminar archivos parciales silenciosamente: usar extensión temporal durante descarga, por ejemplo `.part`, y renombrar únicamente cuando la transferencia y validación hayan terminado.

La aplicación debe poder recuperarse de una ejecución interrumpida.

## Fuera de alcance de V1

NO implementar todavía:

- backups de archivos/uploads;
- S3;
- FTP;
- Google Drive;
- restauración automática completa;
- administración de VPS;
- monitoreo general del servidor;
- notificaciones externas;
- multiusuario;
- cloud sync;
- aplicación móvil.

Pero diseñar adaptadores/interfaces de manera que S3 u otros métodos puedan agregarse posteriormente sin reescribir el motor.

## Primera etapa

NO construyas toda la aplicación de una vez.

Primero:

1. proponé arquitectura;
2. definí estructura del proyecto;
3. definí modelo SQLite;
4. diseñá las interfaces/adaptadores para SFTP y SSH;
5. explicá cómo resolverías scheduler y almacenamiento seguro de secretos en Windows;
6. señalá riesgos o decisiones que consideres incorrectas en este planteo.

Quiero que me contradigas si alguna decisión técnica no tiene sentido.

Una vez acordada esa arquitectura, implementaremos primero un **vertical slice mínimo**:

**un cliente → una conexión SFTP → detectar dump remoto → descargar → validar → registrar resultado → mostrar estado.**

No avances con features adicionales hasta que ese flujo funcione de punta a punta.
