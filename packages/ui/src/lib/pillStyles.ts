import type { CSSProperties } from 'react';

export const primaryPillStyle: CSSProperties = {
  background: 'linear-gradient(135deg, #38bdf8, #3b82f6, #d946ef)',
  color: 'white',
  border: 0,
};

export const dangerPillStyle: CSSProperties = {
  color: '#f87171',
  backgroundColor: 'color-mix(in oklab, #ef4444 12%, transparent)',
  border: 0,
};
