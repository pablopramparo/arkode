import { Button } from '@heroui/react';
import { Modal } from './Modal';
import { DatabaseIcon, FolderIcon } from './icons';

/**
 * First step of the unified "+ Agregar backup" flow: pick which kind of
 * backup to create. A DB-dump task and a restic-backed folder task have
 * genuinely different creation forms, so this routes to one or the other
 * rather than trying to be a single mega-wizard.
 */
export function AddBackupChoiceModal({
  onChoose,
  onClose,
}: {
  onChoose: (kind: 'db' | 'file') => void;
  onClose: () => void;
}) {
  return (
    <Modal title="¿Qué querés respaldar?" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => onChoose('db')}
          className="flex items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors"
          style={{ borderColor: 'var(--border)' }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--surface-secondary)')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
        >
          <span className="mt-0.5 h-5 w-5 [&>svg]:h-5 [&>svg]:w-5" style={{ color: 'var(--accent)' }}>
            <DatabaseIcon />
          </span>
          <span>
            <span className="block text-sm font-medium">Base de datos</span>
            <span className="block text-xs" style={{ color: 'var(--muted)' }}>
              Dump de PostgreSQL / MySQL / MariaDB — por SFTP existente, SSH remoto o conexión directa.
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={() => onChoose('file')}
          className="flex items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors"
          style={{ borderColor: 'var(--border)' }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--surface-secondary)')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
        >
          <span className="mt-0.5 h-5 w-5 [&>svg]:h-5 [&>svg]:w-5" style={{ color: 'var(--accent)' }}>
            <FolderIcon />
          </span>
          <span>
            <span className="block text-sm font-medium">Carpeta de archivos</span>
            <span className="block text-xs" style={{ color: 'var(--muted)' }}>
              Respaldo incremental de una carpeta (local o remota) con restic — snapshots y restauración.
            </span>
          </span>
        </button>

        <div className="mt-1 flex justify-end">
          <Button size="sm" variant="ghost" className="rounded-full px-4" onPress={onClose}>
            Cancelar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
