/** Bounded fields for the current support snapshot; this module does not read legacy logs. */
export const recorderCodes = [
  'recorder_not_configured',
  'recorder_start_failed',
  'recorder_encode_failed',
  'recorder_overflow',
  'recorder_writer_failed',
  'recorder_finalize_timeout',
  'recorder_finalize_failed',
];
export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function choice(value: unknown, values: readonly string[]): string | null {
  return typeof value === 'string' && values.includes(value) ? value : null;
}

export function digest(value: unknown, length: number): string | null {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(value)
    ? value
    : null;
}
