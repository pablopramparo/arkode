# Third-party components bundled with arkode

## MariaDB client tools — `mariadb-dump.exe`, `mariadb.exe`

arkode bundles two unmodified binaries from the **MariaDB Community Server**
Windows distribution, version **11.4.4**:

- `resources/mariadb/mariadb-dump.exe`
- `resources/mariadb/mariadb.exe`

These are used to produce and verify `direct_dump` backups of MySQL and
MariaDB databases without requiring a separately-installed client on the
machine running arkode.

### License

Both binaries are licensed under the **GNU General Public License, version 2**.
The exact license text that ships with them is at
`resources/mariadb/COPYING` (copied verbatim from the MariaDB 11.4.4
distribution). arkode invokes them only as separate, unmodified child
processes over a plain command-line interface; arkode's own source is not a
derivative work of them and is not licensed under the GPL.

### Corresponding source

The complete corresponding source for these exact binaries is the MariaDB
11.4.4 source release, available from the MariaDB Foundation's own archive:

- https://archive.mariadb.org/mariadb-11.4.4/source/mariadb-11.4.4.tar.gz

Codebius will also, on request, provide the complete corresponding source on
a physical medium for no more than the cost of distribution, for three years
from the date arkode 11.4.4-bundled builds were distributed. Contact:
codebius.com.

## Other bundled components

- `resources/pgsql/bin/*` — PostgreSQL client tools (`pg_dump`, `pg_restore`,
  `psql`) and their libraries, from the PostgreSQL project. Licensed under
  the PostgreSQL License (permissive, BSD-style).
- `resources/restic/restic.exe` — restic, licensed under the BSD 2-Clause
  License.
