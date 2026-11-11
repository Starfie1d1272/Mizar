// Generated from desktop/src-tauri/ipc_lifecycle_contract.rs. Do not edit.
import { z } from 'zod';

const unit = z.null().transform(() => undefined);
const WorkspaceExitStage = z.enum([
  '',
  'checking',
  'production',
  'restoration',
  'detachment',
  'presentation',
]);
const Cs2ActivityPhase = z.enum(['idle', 'starting', 'checking', 'restoring']);
const Cs2ConfigPhase = z.enum(['idle', 'uncertain', 'running', 'pending']);
const QualityPreset = z.enum(['very-high', 'high', 'medium', 'preserve']);
const BackupAction = z.enum(['select', 'apply', 'cancel']);
const FrameRateLimit = z.union([z.literal(0), z.literal(30), z.literal(60)]);
const Busy = z.literal(true);
const Ready = z.literal(false);
const PreparationSteps = z.object({
  obs: z.boolean(),
  gameConfiguration: z.boolean(),
  game: z.boolean(),
  capture: z.boolean(),
  camera: z.boolean(),
});
const PreparationStatus = z.object({
  id: z.string(),
  running: z.boolean(),
  cancelled: z.boolean(),
  entered: z.boolean(),
  message: z.string(),
  steps: PreparationSteps,
});
const WorkspaceExitStatus = z.object({
  busy: z.boolean(),
  stage: WorkspaceExitStage,
  message: z.string().nullable(),
  windowMessage: z.string().nullable(),
});
const Cs2BusyStatus = z.object({
  busy: Busy,
  phase: Cs2ActivityPhase,
  observerHudPending: z.boolean(),
});
const Cs2ConfigStatus = z.object({
  busy: Ready,
  phase: Cs2ConfigPhase,
  qualityPreset: QualityPreset,
  frameRateLimit: FrameRateLimit,
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
const Cs2Status = z.union([Cs2BusyStatus, Cs2ConfigStatus]);
const BackupSelection = z.object({
  selectionId: z.string(),
  nickname: z.string(),
  avatar: z.string().nullable(),
  sourceName: z.string(),
  targetPath: z.string(),
  includesFrameRate: z.boolean(),
});

export const desktopLifecycle = {
  entry_document: { args: z.undefined(), result: z.string() },
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
  cancel_entry_intent: {
    args: z.strictObject({ intentId: z.string() }),
    result: unit,
  },
  preparation_status: { args: z.undefined(), result: PreparationStatus.nullable() },
  cancel_workspace_entry: {
    args: z.strictObject({ entryId: z.string().nullable() }),
    result: unit,
  },
  retry_workspace_entry: { args: z.undefined(), result: unit },
  finish_workspace: {
    args: z.strictObject({ confirmSteamCancelled: z.boolean().optional() }).optional(),
    result: unit,
  },
  workspace_exit_status: { args: z.undefined(), result: WorkspaceExitStatus },
  finish_managed_cs2: { args: z.undefined(), result: unit },
  cs2_config_status: { args: z.undefined(), result: Cs2Status },
  restore_cs2_backup: {
    args: z.strictObject({ confirmSteamCancelled: z.boolean() }),
    result: unit,
  },
  manage_cs2_backup: {
    args: z.strictObject({
      action: BackupAction,
      selectionId: z.string().nullable(),
    }),
    result: BackupSelection.nullable(),
  },
};
