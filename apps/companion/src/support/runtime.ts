import { isDocumentDiagnosticEvent } from '@mizar/protocol';
import type { FastifyInstance } from 'fastify';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { ProgramChatNativeInput } from '../program-chat/native-input.js';
import type { ProjectionBundle } from '../projections/projection-coordinator.js';
import type { ProductRuntime } from '../runtime/product-runtime.js';
import type { WorkspaceObserver } from '../telemetry/observer-workspace.js';
import { registerDiagnosticDelivery } from './delivery-routes.js';
import type { PerformanceWindow } from './performance-window.js';
import type { observeRuntime } from './runtime-observation.js';
import { registerSupportRoutes } from './routes.js';
import type { SessionJournal } from './session-journal.js';
import { closeSupportEvidence } from './shutdown.js';

type SupportRoutes = Parameters<typeof registerSupportRoutes>[1];
type DeliveryRoutes = Parameters<typeof registerDiagnosticDelivery>[1];

export function registerSupportRuntime(
  app: FastifyInstance,
  options: Required<
    Pick<
      SupportRoutes,
      | 'runtimeSummary'
      | 'businessLogStatus'
      | 'recorder'
      | 'delivery'
      | 'hosts'
      | 'obs'
      | 'obsAudioDiagnostics'
      | 'program'
      | 'gsiConfigured'
    >
  > & {
    supportLogsDirectory: string | undefined;
    product: ProductRuntime | undefined;
    endpoint: DeliveryRoutes['endpoint'];
    endpointSource: DeliveryRoutes['endpointSource'];
    fetch: DeliveryRoutes['fetch'];
    workspaceObserver: WorkspaceObserver | undefined;
    originPolicy: LocalWebOriginPolicy;
    sessionJournal: SessionJournal | undefined;
    performanceContext: PerformanceWindow | undefined;
    runtimeObservation: ReturnType<typeof observeRuntime>;
    flushOperationDiagnostics: () => void;
    recordConfiguration: () => Promise<void>;
    nativeSource: ProgramChatNativeInput | undefined;
    projection: () => ProjectionBundle;
  },
) {
  const {
    sessionJournal,
    performanceContext,
    runtimeObservation,
    flushOperationDiagnostics,
    recordConfiguration,
  } = options;
  app.post('/debug/control-event', { bodyLimit: 32 * 1024 }, async (request, reply) => {
    if (
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed ||
      options.originPolicy.mode !== 'loopback'
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = request.body;
    if (!isDocumentDiagnosticEvent(body))
      return reply.code(400).send({ error: 'document_event_invalid' });
    if (!sessionJournal) return reply.code(503).send({ error: 'diagnostic_writer_unavailable' });
    await sessionJournal.recordDocumentCommitted(body);
    if (
      ['browser_error', 'browser_unhandled_rejection', 'browser_performance'].includes(body.kind) &&
      (body.kind !== 'browser_performance' ||
        (body.evidence as { anomalyCount?: number } | null)?.anomalyCount)
    )
      performanceContext?.trigger('browser_anomaly', {
        operation: body.kind,
        observedAt: body.observedAt,
        browserDocumentId: body.producerRunId,
        contextCapturedAt: new Date().toISOString(),
        originalEvidence: body.evidence,
      });
    return reply.code(204).send();
  });
  const diagnosticDelivery = registerDiagnosticDelivery(app, {
    ...(options.supportLogsDirectory ? { directory: options.supportLogsDirectory } : {}),
    ...(sessionJournal ? { journal: sessionJournal } : {}),
    originPolicy: options.originPolicy,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.endpointSource ? { endpointSource: options.endpointSource } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    onConsent: async () => {
      // The delivery owner invokes this only after durable consent. Do not let
      // a stable pre-consent group carry its old interval/count into this scope.
      flushOperationDiagnostics();
      await recordConfiguration();
    },
    deliveryParticipants: () => [
      ...(sessionJournal ? [sessionJournal.deliveryParticipant()] : []),
      ...(performanceContext ? [performanceContext.deliveryParticipant()] : []),
    ],
    incidentParticipants: () => [
      ...(sessionJournal ? [sessionJournal.incidentParticipant()] : []),
      ...(performanceContext ? [performanceContext.incidentParticipant()] : []),
    ],
    onReport: () => {
      runtimeObservation.record('problem_report');
      performanceContext?.trigger('problem_report', {
        interpretation:
          'context begins at report receipt; past untriggered buffers are unavailable',
      });
    },
  });
  let captureEnabled = true;
  const consentTime = () => {
    if (!captureEnabled) return null;
    const status = diagnosticDelivery.snapshotStatus().delivery;
    return status?.consent ? status.consentAt : null;
  };
  const unsubscribeObserverEvidence = options.workspaceObserver?.subscribeEvidence((evidence) =>
    sessionJournal?.record('observer_attempt_terminal', evidence),
  );
  registerSupportRoutes(app, {
    originPolicy: options.originPolicy,
    ...(options.supportLogsDirectory === undefined
      ? {}
      : { logsDirectory: options.supportLogsDirectory }),
    ...(options.product === undefined ? {} : { artifact: options.product }),
    observer: () => options.workspaceObserver?.view() ?? null,
    runtimeSummary: options.runtimeSummary,
    exportParticipants: () => {
      // Enqueue completed observations before the journal freezes its export watermark.
      flushOperationDiagnostics();
      return [
        ...(sessionJournal ? [sessionJournal.exportParticipant()] : []),
        ...(performanceContext ? [performanceContext.exportParticipant()] : []),
      ];
    },
    diagnosticDelivery: () => diagnosticDelivery.snapshotStatus(),
    businessLogStatus: options.businessLogStatus,
    recorder: options.recorder,
    delivery: options.delivery,
    hosts: options.hosts,
    obs: options.obs,
    obsAudioDiagnostics: options.obsAudioDiagnostics,
    program: options.program,
    programContext: () => {
      const { operator, program } = options.projection();
      return {
        contextFreshness: operator.matchContext.freshness,
        identity: operator.identity.state,
        binding: program.series?.bindingState ?? null,
      };
    },
    gsiConfigured: options.gsiConfigured,
  });

  return {
    consentTime,
    close: (closeDiagnostic: Parameters<typeof closeSupportEvidence>[1]) =>
      closeSupportEvidence(
        {
          revokeCapture: () => {
            captureEnabled = false;
          },
          closeDelivery: () => diagnosticDelivery.close(),
          closeNativeSource: () => options.nativeSource?.close(),
          performanceContext,
          unsubscribeObserver: unsubscribeObserverEvidence,
          flushOperationDiagnostics,
          sessionJournal,
        },
        closeDiagnostic,
      ),
  };
}
