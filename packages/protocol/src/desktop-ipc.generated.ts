// Generated from desktop/src-tauri/ipc_contract.rs. Do not edit.
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
const FrameRateAction = z.enum(['inspect', 'apply', 'restore']);
const PinAction = z.enum(['prepare', 'commit', 'release']);
const PinKind = z.enum(['incident', 'export', 'delivery', 'active']);
const ObserverAction = z.enum([
  'connection-mode',
  'start-configured',
  'stop',
  'restore-hud',
  'preflight',
  'start',
]);
const MulnxAction = z.enum(['update']);
const Cs2HostStatus = z.object({
  found: z.boolean(),
  managed: z.boolean(),
  layoutAligned: z.boolean(),
  generation: z.number().int().nonnegative(),
  geometry: z.record(z.string(), z.unknown()),
  message: z.string().nullable(),
  layoutPending: z.boolean(),
  visible: z.boolean(),
});
const ObsConfigurationContext = z.object({
  documentGeneration: z.string(),
  message: z.string(),
});
const ObsConfigurationResult = z.object({
  reason: z.string(),
  message: z.string(),
});
const SelectedDemo = z.object({
  token: z.string(),
  name: z.string(),
});
const DemoPhase = z.enum(['idle', 'starting', 'playing', 'stopping', 'recovery']);
const DemoTestView = z.object({
  active: z.boolean(),
  phase: DemoPhase,
  requestId: z.string().nullable(),
  teamAName: z.string(),
  teamBName: z.string(),
  dataReady: z.boolean(),
});
const ObserverResult = z.object({
  pending: z.boolean().optional(),
  useMulnx: z.boolean().nullish(),
  warning: z.string().nullish(),
});
const ConsoleStatus = z.object({
  enabled: z.boolean(),
  generation: z.string().nullable(),
  revocationPending: z.boolean(),
  version: z.uint32().optional(),
  changedAt: z.string().optional(),
  warning: z.string().optional(),
  runtime: z.record(z.string(), z.unknown()).nullable(),
});
const FrameRateStatus = z.enum(['confirmed', 'unsupported', 'unconfirmed']);
const FrameRateTransaction = z.enum([
  'idle',
  'pending',
  'applied',
  'restored',
  'relinquished',
  'ended',
]);
const FrameRateReading = z.object({
  status: FrameRateStatus,
  current: z.number().nullable(),
  transaction: FrameRateTransaction,
  canApply: z.boolean(),
  canRestore: z.boolean(),
  message: z.string(),
});
const DiagnosticReceipt = z.object({
  eventIds: z.array(z.string()),
});
const PinReleasedState = z.enum(['released']);
const PinActiveState = z.enum(['prepared', 'committed']);
const PinReleased = z.object({
  pinId: z.string(),
  state: PinReleasedState,
});
const PinSegment = z.object({
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
});
const PinActive = z.object({
  sourceState: z.record(z.string(), z.unknown()),
  schema: z.string(),
  pinId: z.string(),
  producerKind: z.string(),
  producerRunId: z.string(),
  kind: z.string(),
  state: PinActiveState,
  expiresAt: z.string().nullable(),
  segments: z.array(PinSegment),
  deliveryOwner: z.record(z.string(), z.unknown()).optional(),
});
const DiagnosticPin = z.union([PinReleased, PinActive]);
const GsiIssue = z.object({
  code: z.string(),
  message: z.string(),
});
const GsiOperation = z.object({
  code: z.string().nullable(),
  stage: z.string().nullable(),
});
const GsiStatus = z.object({
  detected: z.boolean(),
  installed: z.boolean(),
  conflict: z.boolean(),
  fileConflict: z.boolean(),
  endpointConflict: z.boolean(),
  readFailed: z.boolean(),
  cfgPath: z.string().nullable(),
  candidateCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  issues: z.array(GsiIssue),
  conflictFiles: z.array(z.string()),
  lastOperation: GsiOperation.nullable(),
});

export const desktopIpc = {
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
  restore_layout: { args: z.undefined(), result: z.string() },
  restore_cs2_focus: { args: z.undefined(), result: z.boolean() },
  cs2_host_status: { args: z.undefined(), result: Cs2HostStatus },
  select_obs_executable: { args: z.undefined(), result: z.string().nullable() },
  launch_obs: {
    args: z.strictObject({ executablePath: z.string() }),
    result: z.boolean(),
  },
  begin_obs_configuration: {
    args: z.strictObject({
      executablePath: z.string(),
      sessionId: z.string(),
      documentGeneration: z.string(),
    }),
    result: z.boolean(),
  },
  finish_obs_configuration: {
    args: z.strictObject({ sessionId: z.string() }),
    result: ObsConfigurationResult,
  },
  read_obs_configuration_context: { args: z.undefined(), result: ObsConfigurationContext },
  mulnx_control: {
    args: z.strictObject({ action: MulnxAction }),
    result: unit,
  },
  select_demo_file: { args: z.undefined(), result: SelectedDemo.nullable() },
  start_demo_test: {
    args: z.strictObject({
      token: z.string(),
      teamAName: z.string(),
      teamBName: z.string(),
      preserveSettings: z.boolean().nullish(),
      cameraTrial: z.boolean().nullish(),
    }),
    result: DemoTestView,
  },
  resume_demo_test: {
    args: z.strictObject({ requestId: z.string() }),
    result: DemoTestView,
  },
  finish_demo_test: {
    args: z.strictObject({ requestId: z.string().nullish() }).optional(),
    result: unit,
  },
  cs2_console_status: { args: z.undefined(), result: ConsoleStatus },
  set_cs2_console_capture: {
    args: z.strictObject({
      enabled: z.boolean(),
      expectedGeneration: z.string().nullish(),
    }),
    result: ConsoleStatus,
  },
  set_cs2_preferences: {
    args: z.strictObject({
      qualityPreset: QualityPreset,
      frameRateLimit: FrameRateLimit,
      preferMulnx: z.boolean().nullish(),
    }),
    result: unit,
  },
  open_cs2_backup: { args: z.undefined(), result: unit },
  open_main: {
    args: z.strictObject({ path: z.string().nullish() }).optional(),
    result: unit,
  },
  present_production: {
    args: z.strictObject({
      live: z.boolean(),
      preparationId: z.string().nullish(),
    }),
    result: unit,
  },
  program_overlay_ready: {
    args: z.strictObject({
      generation: z.number().int().nonnegative(),
      documentId: z.number().int().nonnegative(),
    }),
    result: unit,
  },
  recover_program_overlay: { args: z.undefined(), result: z.string() },
  close_review: { args: z.undefined(), result: unit },
  open_tool: {
    args: z.strictObject({
      tool: z.string(),
      presetId: z.string().nullish(),
    }),
    result: unit,
  },
  open_steam_api_key: { args: z.undefined(), result: unit },
  open_issue_report: { args: z.undefined(), result: unit },
  install_update: { args: z.undefined(), result: unit },
  open_music_downloads: { args: z.undefined(), result: unit },
  open_update_page: {
    args: z.strictObject({
      source: z.string(),
      version: z.string().nullish(),
    }),
    result: unit,
  },
  open_update_recovery: { args: z.undefined(), result: unit },
  open_rivalhub_authorization: {
    args: z.strictObject({ url: z.string() }),
    result: unit,
  },
  open_rivalhub_workbench: {
    args: z.strictObject({ url: z.string() }),
    result: unit,
  },
  gsi_status: { args: z.undefined(), result: GsiStatus },
  control_cs2_frame_rate: {
    args: z.strictObject({
      action: FrameRateAction,
      frameRateLimit: FrameRateLimit.nullish(),
    }),
    result: FrameRateReading,
  },
  persist_diagnostic_events: {
    args: z.strictObject({ events: z.array(z.unknown()) }),
    result: DiagnosticReceipt,
  },
  diagnostic_pin: {
    args: z.strictObject({
      action: PinAction,
      pinId: z.string(),
      kind: PinKind,
    }),
    result: DiagnosticPin,
  },
  save_support_bundle: {
    args: z.strictObject({ exportId: z.string() }),
    result: z.boolean(),
  },
  select_cs2_installation: {
    args: z.strictObject({ executable: z.boolean() }),
    result: z.boolean(),
  },
  open_cs2_config_directory: { args: z.undefined(), result: unit },
  configure_gsi: {
    args: z.strictObject({
      restore: z.boolean(),
      choose: z.boolean(),
    }),
    result: unit,
  },
  observer_command: {
    args: z.strictObject({
      action: ObserverAction,
      endpoint: z.string().nullish(),
      password: z.string().nullish(),
      expectedRevision: z.string().nullish(),
    }),
    result: ObserverResult,
  },
};
