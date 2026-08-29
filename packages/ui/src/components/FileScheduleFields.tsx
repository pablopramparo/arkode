import { Field, inputStyle } from './TaskCreateWizard';
import { primaryPillStyle } from '../lib/pillStyles';

export type ScheduleFrequency = 'daily' | 'weekly' | 'monthly';

export interface FileScheduleValue {
  time: string;
  enabled: boolean;
  frequency: ScheduleFrequency;
  daysOfWeek: number[];
  dayOfMonth: string;
}

export const EMPTY_FILE_SCHEDULE: FileScheduleValue = {
  time: '',
  enabled: true,
  frequency: 'daily',
  daysOfWeek: [],
  dayOfMonth: '',
};

const FREQUENCY_LABEL: Record<ScheduleFrequency, string> = { daily: 'Diario', weekly: 'Semanal', monthly: 'Mensual' };
const WEEKDAY_LABEL: { value: number; label: string }[] = [
  { value: 1, label: 'Lun' },
  { value: 2, label: 'Mar' },
  { value: 3, label: 'Mié' },
  { value: 4, label: 'Jue' },
  { value: 5, label: 'Vie' },
  { value: 6, label: 'Sáb' },
  { value: 0, label: 'Dom' },
];

function toggleDay(days: number[], day: number): number[] {
  return days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort();
}

/** True when the schedule is either unset (no time) or internally consistent. */
export function isFileScheduleValid(v: FileScheduleValue): boolean {
  if (!v.time) return true;
  if (v.frequency === 'weekly') return v.daysOfWeek.length > 0;
  if (v.frequency === 'monthly') {
    const n = Number(v.dayOfMonth);
    return Number.isInteger(n) && n >= 1 && n <= 31;
  }
  return true;
}

/** Shared schedule sub-form for file-backup task create/edit modals. `optional` shows the "sin programar" hint. */
export function FileScheduleFields({
  value,
  onChange,
  optional = false,
}: {
  value: FileScheduleValue;
  onChange: (patch: Partial<FileScheduleValue>) => void;
  optional?: boolean;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Hora">
          <input style={inputStyle} type="time" value={value.time} onChange={(e) => onChange({ time: e.target.value })} />
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm" style={{ color: 'var(--muted)' }}>
          <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
          Habilitado
        </label>
      </div>
      {optional && !value.time && (
        <p className="-mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Dejá la hora vacía para crear la tarea sin programar (podés agregarle horario después).
        </p>
      )}

      <Field label="Frecuencia">
        <div className="flex gap-1">
          {(Object.keys(FREQUENCY_LABEL) as ScheduleFrequency[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onChange({ frequency: f })}
              className="rounded-full px-3 py-1 text-xs font-medium"
              style={value.frequency === f ? primaryPillStyle : { color: 'var(--muted)', backgroundColor: 'var(--surface-secondary)' }}
            >
              {FREQUENCY_LABEL[f]}
            </button>
          ))}
        </div>
      </Field>

      {value.frequency === 'weekly' && (
        <Field label="Días de la semana *">
          <div className="flex gap-1">
            {WEEKDAY_LABEL.map((day) => (
              <button
                key={day.value}
                type="button"
                onClick={() => onChange({ daysOfWeek: toggleDay(value.daysOfWeek, day.value) })}
                className="rounded-full px-2.5 py-1 text-xs font-medium"
                style={{
                  backgroundColor: value.daysOfWeek.includes(day.value) ? 'var(--accent)' : 'var(--surface-secondary)',
                  color: value.daysOfWeek.includes(day.value) ? 'white' : 'var(--muted)',
                }}
              >
                {day.label}
              </button>
            ))}
          </div>
        </Field>
      )}

      {value.frequency === 'monthly' && (
        <Field label="Día del mes *">
          <input
            style={inputStyle}
            type="number"
            min={1}
            max={31}
            placeholder="Ej: 15"
            value={value.dayOfMonth}
            onChange={(e) => onChange({ dayOfMonth: e.target.value })}
          />
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Si el mes tiene menos días, se ejecuta el último día del mes.
          </p>
        </Field>
      )}
    </>
  );
}
