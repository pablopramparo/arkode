# arkode-dump — Docker-mode `remote_dump` setup

Lets a `remote_dump` task back up a database that runs *inside a Docker container*
(e.g. a Coolify-managed Postgres/MySQL/MariaDB) instead of a binary installed
directly on the host. See `arkode-dump.sh` in this directory for the wrapper
itself and the reasoning behind each design choice — this file is just the
setup steps.

**Why not simpler options:**
- Adding the SSH user (`arkode-backup`) to the `docker` group is *not* used
  here — group membership grants full access to the Docker daemon socket,
  which is equivalent to root on the host.
- A raw `sudoers` rule like `arkode-backup ALL=(root) NOPASSWD: docker exec
  <container> pg_dump *` is *not* used either — the trailing wildcard still
  lets an arbitrary argument vector through; the actual safety boundary
  would be a shell glob, not real validation.

Instead: a root-owned, non-writable wrapper script that validates every
argument (engine, container against an explicit allowlist, database/user
format) before it ever touches `docker`, invoked via a sudoers rule that
permits *only* that one script.

## Setup (run once per server, as root)

1. **Install the wrapper**:
   ```bash
   install -o root -g root -m 700 arkode-dump.sh /usr/local/sbin/arkode-dump
   ```
   Mode `0700`, owned by `root:root` — `arkode-backup` gets zero direct
   filesystem access to this file, not even read. `sudo` elevates before the
   file is opened, so this doesn't block execution via the sudoers rule below.

2. **Create the container allowlist** — the real security boundary. Only
   containers listed here can ever be targeted, regardless of what
   `arkode-backup` (or anything running as it) requests:
   ```bash
   mkdir -p /etc/arkode-dump
   cat > /etc/arkode-dump/allowed-containers.conf <<'EOF'
   u088ggocosggggg4skws8ssc
   EOF
   chown root:root /etc/arkode-dump/allowed-containers.conf
   chmod 644 /etc/arkode-dump/allowed-containers.conf
   ```
   Add one container name/id per line — exactly what you'll put in the
   task's "Container" field in arkode. Update this file (not the wrapper
   script) whenever a task needs to target a new container.

3. **Add the sudoers rule** (`visudo`, or a drop-in under `/etc/sudoers.d/`):
   ```
   arkode-backup ALL=(root) NOPASSWD: /usr/local/sbin/arkode-dump
   ```
   No trailing arguments restricted here on purpose — the wrapper itself is
   the validation layer, not sudoers' own (fragile) glob matching. This rule
   only ever lets `arkode-backup` run this one specific, root-owned,
   non-writable binary.

4. **Test it manually** before wiring up a real task:
   ```bash
   # As arkode-backup, no password (e.g. a Postgres container with trust/peer auth):
   printf '' | sudo /usr/local/sbin/arkode-dump --engine postgres \
     --container u088ggocosggggg4skws8ssc --database grupocarena_erp --user postgres \
     > /tmp/test.dump
   pg_restore --list /tmp/test.dump   # sanity-check the output is a real dump

   # With a password (e.g. MySQL/MariaDB):
   printf '%s' 'the-real-password' | sudo /usr/local/sbin/arkode-dump --engine mysql \
     --container mysql-c1 --database rivera_web --user root \
     > /tmp/test.sql
   ```

5. **Create the task in arkode** with:
   - Strategy: `remote_dump`, exec mode: `docker`
   - Container: the exact name/id from step 2's allowlist
   - Database / DB user: as configured inside the container
   - Password: leave blank for Postgres (unless the container requires one);
     set it for MySQL/MariaDB — stored encrypted via arkode's own SecretStore,
     never written to disk in plaintext, and never passed as a command-line
     argument to anything on the remote host (see `arkode-dump.sh`'s own
     comments for exactly how it travels: over the SSH channel's stdin, then
     a short-lived root-only `--env-file` for `docker exec`, deleted
     immediately after).
   - Remote output path template: same as any other `remote_dump` task
     (e.g. `/home/arkode-backup/rivera_web/dump_{date:YYYYMMDD_HHmm}.sql`) —
     arkode auto-creates the containing folder before running the dump.

## Adding a second container/task later

Just append the new container's name/id to
`/etc/arkode-dump/allowed-containers.conf` — no wrapper script change, no
sudoers change, no service restart needed.
