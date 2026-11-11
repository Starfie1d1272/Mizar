import { z } from 'zod';

const noArgs = z.undefined();
const unit = z.null().transform(() => undefined);
const preparationStatus = z.object({
  id: z.string(),
  running: z.boolean(),
  cancelled: z.boolean(),
  entered: z.boolean(),
  message: z.string(),
  steps: z.object({
    obs: z.boolean(),
    gameConfiguration: z.boolean(),
    game: z.boolean(),
    capture: z.boolean(),
    camera: z.boolean(),
  }),
});
const workspaceExitStatus = z.object({
  busy: z.boolean(),
  stage: z.enum(['', 'checking', 'production', 'restoration', 'detachment', 'presentation']),
  message: z.string().nullable(),
  windowMessage: z.string().nullable(),
});
const cs2ConfigStatus = z.object({
  busy: z.literal(false),
  phase: z.enum(['idle', 'uncertain', 'running', 'pending']),
  qualityPreset: z.enum(['very-high', 'high', 'medium', 'preserve']),
  frameRateLimit: z.union([z.literal(0), z.literal(30), z.literal(60)]),
  preferMulnx: z.boolean(),
  preparationId: z.string().nullable(),
  spectatorRecoveryPending: z.boolean(),
  nativeHudToggle: z.boolean(),
  demoCleanupPending: z.boolean(),
  demoCameraRequestId: z.string().nullable(),
  observerHudPending: z.boolean(),
  spectatorWarning: z.string().nullable(),
  canPreserve: z.boolean(),
  preserveSettings: z.boolean(),
  pending: z.boolean(),
  mulnxLaunchResumable: z.boolean(),
  cameraLeaseReady: z.boolean(),
  running: z.boolean(),
  message: z.string().nullable(),
});
const cs2Status = z.discriminatedUnion('busy', [
  z.object({
    busy: z.literal(true),
    phase: z.enum(['idle', 'starting', 'checking', 'restoring']),
    observerHudPending: z.boolean(),
  }),
  cs2ConfigStatus,
]);
const backupSelection = z.object({
  selectionId: z.string(),
  nickname: z.string(),
  avatar: z.string().nullable(),
  sourceName: z.string(),
  targetPath: z.string(),
  includesFrameRate: z.boolean(),
});

export type PreparationStatus = z.output<typeof preparationStatus>;
export type WorkspaceExitStatus = z.output<typeof workspaceExitStatus>;
export type Cs2ConfigStatus = z.output<typeof cs2ConfigStatus>;
export type Cs2Status = z.output<typeof cs2Status>;

type Contract = {
  args: z.ZodType<Record<string, unknown> | undefined>;
  result: z.ZodType;
};

export const desktopLifecycle = {
  entry_document: { args: noArgs, result: z.string() },
  enter_workspace: {
    args: z.strictObject({
      preparationId: z.string(),
      document: z.string(),
      expectedRevision: z.string().nullable(),
      expectedDemoRequest: z.string().nullable(),
      manual: z.boolean(),
      preserveSettings: z.boolean(),
      externalPid: z.uint32().nullable(),
      externalCreated: z.string().nullable(),
    }),
    result: unit,
  },
  cancel_entry_intent: { args: z.strictObject({ intentId: z.string() }), result: unit },
  preparation_status: { args: noArgs, result: preparationStatus.nullable() },
  cancel_workspace_entry: {
    args: z.strictObject({ entryId: z.string().nullable() }),
    result: unit,
  },
  retry_workspace_entry: { args: noArgs, result: unit },
  finish_workspace: {
    args: z.strictObject({ confirmSteamCancelled: z.boolean().optional() }).optional(),
    result: unit,
  },
  workspace_exit_status: { args: noArgs, result: workspaceExitStatus },
  finish_managed_cs2: { args: noArgs, result: unit },
  cs2_config_status: { args: noArgs, result: cs2Status },
  restore_cs2_backup: {
    args: z.strictObject({ confirmSteamCancelled: z.boolean() }),
    result: unit,
  },
  manage_cs2_backup: {
    args: z.strictObject({
      action: z.enum(['select', 'apply', 'cancel']),
      selectionId: z.string().nullable(),
    }),
    result: backupSelection.nullable(),
  },
} satisfies Record<string, Contract>;

export type DesktopLifecycleCommand = keyof typeof desktopLifecycle;
export type LifecycleArgs<C extends DesktopLifecycleCommand> = z.input<
  (typeof desktopLifecycle)[C]['args']
>;
export type LifecycleResult<C extends DesktopLifecycleCommand> = z.output<
  (typeof desktopLifecycle)[C]['result']
>;

export function desktopLifecycleContract(command: string): Contract | undefined {
  return Object.hasOwn(desktopLifecycle, command)
    ? desktopLifecycle[command as DesktopLifecycleCommand]
    : undefined;
}
