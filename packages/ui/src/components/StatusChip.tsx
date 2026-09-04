import { Chip } from '@heroui/react';
import type { DashboardRow } from '../lib/statusClient';
import { isInterruptedRun } from '../lib/runStatus';

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

/**
 * Pass `errorMessage` so a `Failed` run whose process merely died (update /
 * reboot / power cut — see isInterruptedRun) renders as an amber
 * "Interrumpida" instead of a red "Falló": it's not a backup failure and
 * needs no action.
 */
export function StatusChip({ status, errorMessage }: { status: Status; errorMessage?: string | null }) {
  if (isInterruptedRun(status, errorMessage)) {
    return (
      <Chip color="warning" variant="soft" size="sm">
        Interrumpida
      </Chip>
    );
  }
  return (
    <Chip color={COLOR[status]} variant="soft" size="sm">
      {LABEL[status]}
    </Chip>
  );
}
