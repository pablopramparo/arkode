import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { fetchTasks, type TaskRow } from '../lib/tasksClient';
import { fetchFileBackupTasks } from '../lib/fileBackupClient';
import { fetchConnections, type ConnectionsData } from '../lib/connectionsClient';
import { mergeTasks } from '../lib/unifiedTasks';
import { Switch } from './Switch';
import { primaryPillStyle } from '../lib/pillStyles';
import { TaskCreateWizard } from './TaskCreateWizard';
import { FileTaskCreateModal } from './FileTaskCreateModal';
import { AddBackupChoiceModal } from './AddBackupChoiceModal';
import { UnifiedTaskTable } from './UnifiedTaskTable';
import { ClientFilter, distinctClients } from './ClientFilter';

export function Tareas({ onSelectClient }: { onSelectClient: (clientId: string) => void }) {
  const [dbTasks, setDbTasks] = useState<TaskRow[] | null>(null);
  const [fileTasks, setFileTasks] = useState<Awaited<ReturnType<typeof fetchFileBackupTasks>> | null>(null);
  const [connections, setConnections] = useState<ConnectionsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [clientFilter, setClientFilter] = useState('');

  const [choosingKind, setChoosingKind] = useState(false);
  const [creatingKind, setCreatingKind] = useState<'db' | 'file' | null>(null);

  const refresh = useCallback(async (includeInactive: boolean) => {
    try {
      const [taskRows, fileRows, connectionsData] = await Promise.all([
        fetchTasks({ includeInactive }),
        fetchFileBackupTasks(undefined, { includeInactive }),
        fetchConnections(),
      ]);
      setDbTasks(taskRows);
      setFileTasks(fileRows);
      setConnections(connectionsData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo conectar con el motor de backups.');
    }
  }, []);

  useEffect(() => {
    refresh(showInactive);
  }, [refresh, showInactive]);

  const allRows = dbTasks && fileTasks ? mergeTasks(dbTasks, fileTasks) : null;
  const clientOptions = distinctClients(allRows, (r) => r.clientId, (r) => r.clientName);
  const rows = allRows && clientFilter ? allRows.filter((r) => r.clientId === clientFilter) : allRows;
  const loading = rows == null;

  return (
    <div className="max-w-[1600px] px-10 py-8">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Tareas</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {loading ? 'Cargando…' : `${rows.length} tarea${rows.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <ClientFilter clients={clientOptions} value={clientFilter} onChange={setClientFilter} />
          <Switch checked={showInactive} onChange={() => setShowInactive((v) => !v)} label="Mostrar inactivas" />
          <Button
            size="sm"
            className="rounded-full px-4"
            style={primaryPillStyle}
            isDisabled={!connections || connections.clients.length === 0}
            onPress={() => setChoosingKind(true)}
          >
            + Agregar backup
          </Button>
        </div>
      </header>

      {error && (
        <div
          className="mb-4 rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)', backgroundColor: 'color-mix(in oklab, var(--danger) 10%, transparent)' }}
        >
          {error}
        </div>
      )}

      {rows && rows.length > 0 && (
        <UnifiedTaskTable rows={rows} onChanged={() => refresh(showInactive)} onSelectClient={onSelectClient} />
      )}

      {rows && rows.length === 0 && (
        <p style={{ color: 'var(--muted)' }}>
          {clientFilter ? 'Este cliente no tiene tareas.' : 'No hay tareas configuradas todavía.'}
        </p>
      )}

      {choosingKind && (
        <AddBackupChoiceModal
          onClose={() => setChoosingKind(false)}
          onChoose={(kind) => {
            setChoosingKind(false);
            setCreatingKind(kind);
          }}
        />
      )}

      {creatingKind === 'db' && connections && (
        <TaskCreateWizard
          connections={connections}
          onClose={() => setCreatingKind(null)}
          onCreated={() => refresh(showInactive)}
        />
      )}

      {creatingKind === 'file' && (
        <FileTaskCreateModal onClose={() => setCreatingKind(null)} onCreated={() => refresh(showInactive)} />
      )}
    </div>
  );
}
