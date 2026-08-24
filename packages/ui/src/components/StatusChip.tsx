import { Chip } from '@heroui/react';
import type { DashboardRow } from '../lib/statusClient';

type Status = DashboardRow['status'];

const LABEL: Record<Status, string> = {
  Success: 'Éxito',
  Warning: 'Advertencia',
  Failed: 'Falló',
  Pending: 'Pendiente',
  Running: 'Ejecutando',
  Producing: 'Generando',
  Validating: 'Validando',
  NeverRun: 'Sin ejecutar',
};

const COLOR: Record<Status, 'success' | 'warning' | 'danger' | 'accent' | 'default'> = {
  Success: 'success',
  Warning: 'warning',
  Failed: 'danger',
  Pending: 'accent',
  Running: 'accent',
  Producing: 'accent',
  Validating: 'accent',
  NeverRun: 'default',
};

export function StatusChip({ status }: { status: Status }) {
  return (
    <Chip color={COLOR[status]} variant="soft" size="sm">
      {LABEL[status]}
    </Chip>
  );
}
