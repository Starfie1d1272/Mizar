import { z } from 'zod';

/** Local operator output control, never part of the public program projection. */
export const obsOutputCommandSchema = z
  .object({
    output: z.enum(['stream', 'record']),
    action: z.enum(['start', 'stop']),
    expectedRevision: z.string().uuid(),
  })
  .strict();
export type ObsOutputCommand = z.infer<typeof obsOutputCommandSchema>;
export type ObsOutputKind = ObsOutputCommand['output'];
export type ObsOutputPhase =
  'unknown' | 'idle' | 'starting' | 'active' | 'stopping' | 'reconnecting' | 'paused';
export interface ObsOutputStatus {
  readonly phase: ObsOutputPhase;
  readonly active: boolean | null;
  readonly pending: 'start' | 'stop' | null;
  readonly revision: string;
}
export interface ObsOutputsStatus {
  readonly stream: ObsOutputStatus;
  readonly record: ObsOutputStatus;
}
