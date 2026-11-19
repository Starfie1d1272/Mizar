import type { UpdateManager } from './updates/manager.js';
import type { SeriesProgressCheckpointStore } from '@mizar/core/series-progress';
import type { ResourceTrustPolicy } from '@mizar/resource-pack-contract/runtime';
import type { BroadcastRuntimeDependencies } from './broadcast-config/runtime.js';
import type { HudConfigStore } from './hud-config/store.js';
import type { OnlineManifestConfig } from './match-context/http-source.js';
import type { MatchContextBinding } from './match-context/index.js';
import type { RivalHubConnection } from './match-context/rivalhub-connection.js';
import type { SteamAvatars } from './media/steam-avatars.js';
import type { ObsNativeEvidence } from './obs/native-evidence.js';
import type { OutputServiceOptions } from './output/service.js';
import type { ProgramCueCoordinator } from './projections/program-cue-coordinator.js';
import type { ProjectionCoordinator } from './projections/projection-coordinator.js';
import type { QualificationOptions } from './qualification/runtime.js';
import type { DebugEvidenceStore, DebugRuntimeClock } from './runtime/debug-state.js';
import type { LatestWinsConsumerHealth } from './runtime/latest-wins.js';
import type { ProductRuntime } from './runtime/product-runtime.js';
import type { ProgramRuntime } from './runtime/program-runtime.js';
import type { SessionJournal } from './support/session-journal.js';
import type { CaptureRecorder } from './telemetry/capture-recorder.js';
import type { CstvSourceManagers } from './telemetry/cstv-source-manager.js';
import type {
  AcceptedRawSink,
  GsiClock,
  GsiDiagnosticsSink,
  GsiSequenceSource,
  ObservationSink,
} from './telemetry/gsi-ingress.js';
import type { ObjectiveReferenceSource } from './telemetry/objective-reference.js';
import type { WorkspaceObserver } from './telemetry/observer-workspace.js';

export interface CompanionAppOptions extends QualificationOptions {
  readonly resources?: {
    readonly root: string;
    readonly required?: boolean;
    readonly policy?: ResourceTrustPolicy;
    readonly cacheHistory?: readonly ResourceTrustPolicy[];
  };
  readonly updates?: UpdateManager;
  readonly steamAvatars?: SteamAvatars;
  readonly supportLogsDirectory?: string;
  readonly supportJournal?: SessionJournal;
  readonly productRuntime?: ProductRuntime;
  readonly logger?: boolean;
  readonly gsiToken?: string;
  readonly recorder?: CaptureRecorder;
  readonly producerInstanceId?: string;
  readonly gsiSequenceSource?: GsiSequenceSource;
  readonly programRuntime?: ProgramRuntime;
  readonly seriesProgressCheckpointStore?: SeriesProgressCheckpointStore;
  readonly onSeriesProgressDiagnostic?: (diagnostic: { readonly code: string }) => void;
  readonly projectionCoordinator?: ProjectionCoordinator;
  readonly programCueCoordinator?: ProgramCueCoordinator;
  readonly matchContextBinding?: MatchContextBinding;
  readonly matchManifestPath?: string;
  readonly localTournamentPath?: string;
  readonly reliableOutboxPath?: string;
  readonly reliableSink?: OutputServiceOptions['sink'];
  readonly liveSink?: OutputServiceOptions['liveSink'];
  readonly onlineManifestConfig?: OnlineManifestConfig;
  readonly rivalhubConnection?: RivalHubConnection;
  readonly rehearsalFixturePath?: string;
  readonly projectionNowMonotonicMs?: () => number;
  readonly bpNowMonotonicMs?: () => number;
  readonly debugEvidenceStore?: DebugEvidenceStore;
  readonly debugClock?: DebugRuntimeClock;
  readonly deliveryConsumers?: readonly DeliveryHealthSource[];
  readonly cstvSources?: CstvSourceManagers;
  readonly workspaceObserver?: WorkspaceObserver;
  readonly observerSettingsPath?: string;
  readonly diagnosticsEndpoint?: string;
  readonly diagnosticsEndpointSource?: 'product_default' | 'environment_override';
  readonly diagnosticsFetch?: typeof fetch;
  readonly onAcceptedRaw?: AcceptedRawSink;
  readonly onObservation?: ObservationSink;
  readonly onGsiDiagnostics?: GsiDiagnosticsSink;
  readonly clock?: GsiClock;
  readonly broadcastConfig?: BroadcastRuntimeDependencies;
  readonly hudConfigPath?: string;
  readonly hudConfigStore?: HudConfigStore;
  readonly obsConfigPath?: string;
  readonly builtinMusicPack?: string;
  readonly mulnxCamPacksRoot?: string;
  readonly mulnxBundle?: string;
  readonly readObsCaptureEvidence?: () => Promise<ObsNativeEvidence>;
  readonly objectiveReferenceSource?: ObjectiveReferenceSource;
  readonly webRoot?: string;
  readonly host?: string;
  readonly port?: number;
  readonly localWebLanMode?: boolean;
  readonly localWebAllowedOrigins?: readonly string[];
}

export interface DeliveryHealthSource {
  getHealth(): LatestWinsConsumerHealth;
  close(): Promise<void>;
}
