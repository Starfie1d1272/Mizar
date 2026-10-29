import { z } from 'zod';

/** Operator-only bindings; UUID and collection are checked again against OBS on every use. */
export const obsAudioRoleSchema = z.enum(['game', 'remoteCommentary', 'microphone']);
export const obsAudioBindingSchema = z
  .object({
    inputUuid: z.string().min(1).max(256),
    inputKind: z.string().min(1).max(256),
    collection: z.string().min(1).max(256),
    endpoint: z.string().min(1).max(256),
  })
  .strict();
export const obsAudioBindCommandSchema = z
  .object({
    role: obsAudioRoleSchema,
    selectionId: z.string().uuid().nullable(),
    revision: z.string().uuid(),
  })
  .strict();
export type ObsAudioRole = z.infer<typeof obsAudioRoleSchema>;
export type ObsAudioBinding = z.infer<typeof obsAudioBindingSchema>;
export type ObsAudioBindCommand = z.infer<typeof obsAudioBindCommandSchema>;
export const obsGameAudioPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('keep') }).strict(),
  z.object({ mode: z.literal('mute') }).strict(),
  z.object({ mode: z.literal('attenuate'), db: z.number().finite().positive().max(60) }).strict(),
]);
export const obsGameAudioPolicyCommandSchema = z
  .object({ revision: z.string().uuid(), policy: obsGameAudioPolicySchema })
  .strict();
export const obsGameAudioReleaseSchema = z.object({ revision: z.string().uuid() }).strict();
export interface ObsAudioRoutingStatus {
  revision: string;
  endpoint: string;
  collection: string;
  desktop: ObsAudioBinding | null;
  transition: boolean;
  bindings: Record<
    ObsAudioRole,
    (ObsAudioBinding & { valid: boolean; name: string | null }) | null
  >;
  candidates: { selectionId: string; name: string; kind: string; uuid: string }[];
  findings: string[];
}

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

/** OBS log evidence, never a proof of current visible frames or a black-screen root cause. */
export interface ObsCaptureDiagnostic {
  readonly state: 'unknown' | 'needs_attention' | 'reported_success';
  readonly reason:
    | 'access_denied'
    | 'process_open_failed'
    | 'hook_file_locked'
    | 'hook_pending'
    | 'capture_failed'
    | null;
  readonly code: number | null;
  readonly lastFailure: {
    readonly reason: ObsCaptureDiagnostic['reason'];
    readonly code: number | null;
  } | null;
  readonly owner: 'unknown';
}
