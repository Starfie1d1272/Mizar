import type { DocumentHandoffCoverage, HostPinCoverage } from '@mizar/protocol';
import type { IncidentParticipant } from './retention.js';
import { SupportExports } from './export-job.js';
import { diagnosticValue } from './session-journal.js';
import type { WorkspaceObserver } from '../telemetry/observer-workspace.js';
import type { registerDiagnosticDelivery } from './delivery-routes.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  checkLocalWebOrigin,
  isLoopbackBindHost,
  type LocalWebOriginPolicy,
} from '../local-web/origin-policy.js';
import type { LocalWebHostDiagnostics } from '../local-web/websocket-transport.js';
import type { ObsStatus } from '../obs/adapter.js';
import type { readAudioDeviceDiagnostics } from '../obs/audio-device-settings.js';
import { audioDiagnosticReadFailure } from '../obs/audio-evidence.js';
import { PROGRAM_SCENES, type ProgramSceneState } from '@mizar/protocol/program-scenes';
import { obsSceneName } from '../obs/desired-state.js';
import type { DebugEvidenceStore } from '../runtime/debug-state.js';
import type { LatestWinsConsumerHealth } from '../runtime/latest-wins.js';
import type { RecorderHealth } from '../telemetry/capture-recorder.js';
import { choice, count, digest, record, recorderCodes } from './logs.js';

const findingCodes = [
  'configuration_unchecked',
  'configuration_check_failed',
  'order_drift',
  'source_disabled',
  'source_missing',
  'transform_drift',
  'scene_missing',
  'source_kind_conflict',
  'url_drift',
  'collection_inactive',
  'video_settings',
  'capture_drift',
  'collection_missing',
];

const cs2IssueCodes = [
  'installation-not-found',
  'multiple-installations',
  'selected-path-missing',
  'selected-path-invalid',
  'metadata-invalid',
  'selection-unreadable',
  'restore-before-selection',
  'gsi-file-missing',
  'gsi-file-changed',
  'record-unreadable',
  'endpoint-conflict',
  'status-unreadable',
  'access-denied',
  'operation-failed',
];
const cs2Stages = ['status', 'selection', 'install', 'restore'];
const collectionStates = ['available', 'failed', 'timeout'];

const rectangle = {
  type: ['array', 'null'],
  minItems: 4,
  maxItems: 4,
  items: { type: 'integer', minimum: -100000, maximum: 100000 },
};
const windowFailure = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    stage: {
      type: ['string', 'null'],
      enum: [
        'restore',
        'restore_timeout',
        'raise',
        'measure',
        'empty_client',
        'minimized',
        'dpi',
        'frame',
        'position',
        'correction',
        'client_mismatch',
        null,
      ],
    },
    api: {
      type: ['string', 'null'],
      enum: [
        'ShowWindowAsync',
        'SetWindowPos',
        'GetClientRect',
        'ClientToScreen',
        'GetDpiForWindow',
        'AdjustWindowRectExForDpi',
        null,
      ],
    },
    lastError: { type: ['integer', 'null'], minimum: 0, maximum: 4294967295 },
    target: { type: ['string', 'null'], enum: ['left', 'dock', 'game', 'group', null] },
  },
};
const elevation = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    elevated: { type: ['boolean', 'null'] },
    lastError: { type: ['integer', 'null'], minimum: 0, maximum: 4294967295 },
  },
};
const windowGeometryProperties = {
  ...Object.fromEntries(
    ['client', 'outer', 'monitorBounds', 'workArea', 'layoutArea', 'target'].map((key) => [
      key,
      rectangle,
    ]),
  ),
  dpi: { type: ['integer', 'null'], minimum: 1, maximum: 10000 },
  alignmentRetries: { type: 'integer', minimum: 0, maximum: 30 },
  preserveSettings: { type: 'boolean' },
  fullscreenLayout: { type: 'boolean' },
  alignmentFailure: windowFailure,
  groupFailure: windowFailure,
  hostElevation: elevation,
  gameElevation: elevation,
};
function windowGeometry(value: unknown) {
  if (value === null || value === undefined) return null;
  const input = record(value);
  return Object.fromEntries(
    Object.keys(windowGeometryProperties).map((key) => [key, input[key] ?? null]),
  );
}

const desktopSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    gsi: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        ...Object.fromEntries(
          [
            'detected',
            'installed',
            'conflict',
            'fileConflict',
            'endpointConflict',
            'readFailed',
          ].map((key) => [key, { type: 'boolean' }]),
        ),
        collectionStatus: { type: 'string', enum: collectionStates },
        candidateCount: { type: 'integer', minimum: 0, maximum: 10000 },
        conflictCount: { type: 'integer', minimum: 0, maximum: 10000 },
        issueCodes: {
          type: 'array',
          maxItems: 16,
          items: { type: 'string', enum: cs2IssueCodes },
        },
        lastOperation: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['code', 'stage'],
          properties: {
            code: { type: 'string', enum: cs2IssueCodes },
            stage: { type: 'string', enum: cs2Stages },
          },
        },
      },
    },
    cs2: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        collectionStatus: { type: 'string', enum: collectionStates },
        found: { type: 'boolean' },
        managed: { type: 'boolean' },
        geometry: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: windowGeometryProperties,
        },
      },
    },
  },
};

export function registerSupportRoutes(
  app: FastifyInstance,
  options: {
    readonly originPolicy: LocalWebOriginPolicy;
    readonly logsDirectory?: string;
    readonly exportParticipants?: () => IncidentParticipant[];
    readonly artifact?: { readonly gitSha: string; readonly artifactSha256: string };
    readonly observer?: () => ReturnType<WorkspaceObserver['view']> | null;
    readonly runtimeSummary: () => ReturnType<DebugEvidenceStore['getSupportSummary']>;
    readonly diagnosticDelivery?: () => ReturnType<
      ReturnType<typeof registerDiagnosticDelivery>['snapshotStatus']
    >;
    readonly businessLogStatus?: () => 'available' | 'write_failed' | 'not_configured';
    readonly recorder: () => RecorderHealth;
    readonly delivery: () => readonly LatestWinsConsumerHealth[];
    readonly hosts: () => LocalWebHostDiagnostics;
    readonly obs: () => Promise<ObsStatus | undefined>;
    readonly obsAudioDiagnostics?: () => Promise<
      Awaited<ReturnType<typeof readAudioDeviceDiagnostics>> | undefined
    >;
    readonly program?: () => ProgramSceneState;
    readonly programContext?: () => {
      contextFreshness: string;
      identity: string;
      binding: string | null;
    };
    readonly gsiConfigured: boolean;
  },
) {
  function captureSnapshot(
    desktop: Record<string, unknown>,
    nativeSummary: unknown,
    obs: ObsStatus | undefined,
    obsAudio: unknown,
  ) {
    const program = options.program?.();
    const context = options.programContext?.();
    const gsi = record(desktop.gsi);
    const cs2 = record(desktop.cs2);
    const bool = (value: unknown) => (typeof value === 'boolean' ? value : null);
    const recorder = options.recorder();
    const hosts = options.hosts();
    return {
      asOf: new Date().toISOString(),
      obsAudio,
      ...{
        diagnosticDelivery: (() => {
          const status = options.diagnosticDelivery?.();
          const available = status?.available ?? false;
          const delivery = status?.delivery;
          const errorCodes = [
            'not_configured',
            'local_queue_unavailable',
            'state_unreadable',
            'consent_policy_changed',
            'delivery_failed',
            'session_budget_waiting_for_capacity',
            'queue_write_unconfirmed',
            'ack_history_release_pending',
            'ack_pin_release_pending',
            'journal_unreadable',
            'queue_budget_local_journal_retained',
            'manifest_budget_local_journal_retained',
            'retired_identity_sync_required',
            'server_retention_expired_local_copy_retained',
            'receipt_size_or_body',
            'receipt_size_budget',
            'invalid_enrollment_ack',
            'invalid_batch_permit',
            'batch_integrity_failed',
            'withdrawal_pending',
          ];
          return {
            available,
            configured: available ? (delivery?.configured ?? null) : null,
            consent: available ? (delivery?.consent ?? null) : null,
            paused: available ? (delivery?.paused ?? null) : null,
            consentAt: available ? (delivery?.consentAt ?? null) : null,
            closedReason: available ? (delivery?.closedReason ?? null) : null,
            lastAttemptAt: available ? (delivery?.lastAttemptAt ?? null) : null,
            lastConfirmedAt: available ? (delivery?.lastConfirmedAt ?? null) : null,
            transportFailure: available ? (delivery?.transportFailure ?? null) : null,
            omitted: available ? (delivery?.omitted ?? null) : null,
            omissionReasons:
              available && delivery
                ? Object.fromEntries(
                    Object.entries(delivery.omissionReasons).filter(([reason]) =>
                      [
                        'consent_policy_changed',
                        'invalid_source_cursor',
                        'chat_not_collected',
                        'event_size_budget',
                        'memory_budget_recoverable_from_local_journal',
                        'unreadable_journal_record',
                        'truncated_sealed_journal_record',
                        'batch_size_budget',
                        'source_sequence_gap',
                        'installation_lease_closed',
                        'server_retention_expired',
                        'batch_retention_expired',
                        'automatic_window_expired',
                        'payload_clock_future',
                        'payload_creation_time_missing',
                      ].includes(reason),
                    ),
                  )
                : null,
            deletionPending: available ? (delivery?.deletionPending ?? null) : null,
            queuedBatches: available ? (delivery?.queuedBatches ?? null) : null,
            retainedAcknowledgedBatches: available
              ? (delivery?.retainedAcknowledgedBatches ?? null)
              : null,
            blockedBatches: available ? (delivery?.blockedBatches ?? null) : null,
            queuedBytes: available ? (delivery?.queuedBytes ?? null) : null,
            pendingBytes: available ? (delivery?.pendingBytes ?? null) : null,
            acknowledged: available ? (delivery?.acknowledged ?? null) : null,
            failures: available ? (delivery?.failures ?? null) : null,
            error: status?.error ? (choice(status.error, errorCodes) ?? 'other') : null,
            nextAttemptAt: available ? (delivery?.nextAttemptAt ?? null) : null,
          };
        })(),
        observer: options.observer?.() ?? null,
        nativeObs: nativeSummary,
        program: program
          ? {
              active: program.active,
              preparing: program.preparing?.target ?? null,
              mode: program.director?.mode ?? null,
              gameplayAvailable: program.available.includes('gameplay'),
              contextFreshness: choice(context?.contextFreshness, ['unbound', 'fresh', 'stale']),
              identity: choice(context?.identity, [
                'unbound',
                'resolving',
                'matched',
                'degraded',
                'mismatch',
              ]),
              binding: choice(context?.binding, ['unbound', 'bound', 'needs_operator']),
            }
          : null,
        runtime: options.runtimeSummary(),
        businessLog: options.businessLogStatus?.() ?? 'not_configured',
        gsi: {
          ingressConfigured: options.gsiConfigured,
          source: 'desktop-host-via-browser',
          detected: bool(gsi.detected),
          installed: bool(gsi.installed),
          conflict: bool(gsi.conflict),
          fileConflict: bool(gsi.fileConflict),
          endpointConflict: bool(gsi.endpointConflict),
          readFailed: bool(gsi.readFailed),
          collectionStatus: choice(gsi.collectionStatus, collectionStates),
          candidateCount: typeof gsi.candidateCount === 'number' ? count(gsi.candidateCount) : null,
          conflictCount: typeof gsi.conflictCount === 'number' ? count(gsi.conflictCount) : null,
          issueCodes: Array.isArray(gsi.issueCodes)
            ? gsi.issueCodes
                .map((code) => choice(code, cs2IssueCodes))
                .filter((code) => code !== null)
            : [],
          lastOperation:
            gsi.lastOperation === null || gsi.lastOperation === undefined
              ? null
              : {
                  code: choice(record(gsi.lastOperation).code, cs2IssueCodes),
                  stage: choice(record(gsi.lastOperation).stage, cs2Stages),
                },
        },
        cs2: {
          source: 'desktop-host-via-browser',
          collectionStatus: choice(cs2.collectionStatus, collectionStates),
          found: bool(cs2.found),
          managed: bool(cs2.managed),
          geometry: windowGeometry(cs2.geometry),
        },
        obs:
          obs === undefined
            ? null
            : {
                connection: choice(obs.connection, [
                  'connected',
                  'unavailable',
                  'password_required',
                  'invalid_password',
                ]),
                streaming: bool(obs.streaming),
                recording: bool(obs.recording),
                connectionFailure: obs.connectionFailure ?? null,
                currentScene:
                  PROGRAM_SCENES.find((scene) => obsSceneName(scene.id) === obs.currentScene)?.id ??
                  null,
                sceneAligned:
                  program && obs.connection === 'connected'
                    ? obs.currentScene === obsSceneName(program.active)
                    : null,
                programEvidence: obs.programEvidence ?? null,
                findings: obs.findings
                  .slice(0, 32)
                  .map(({ code }) => choice(code, findingCodes) ?? 'unknown_finding'),
              },
        browserHosts: {
          active: {
            obs: count(hosts.active.obs),
            browser: count(hosts.active.browser),
            unknown: count(hosts.active.unknown),
          },
          totals: {
            connected: count(hosts.totals.connected),
            disconnected: count(hosts.totals.disconnected),
            connectionLimitRejected: count(hosts.totals.connectionLimitRejected),
            slowConsumerTerminated: count(hosts.totals.slowConsumerTerminated),
          },
        },
        recorder: {
          state: choice(recorder.state, [
            'recording',
            'degraded',
            'failed',
            'finalizing',
            'closed',
          ]),
          pendingFrames: count(recorder.pendingFrames),
          pendingBytes: count(recorder.pendingBytes),
          frameCount: count(recorder.frameCount),
          droppedFrames: count(recorder.droppedFrames),
          incomplete: bool(recorder.incomplete),
          lastErrorCode: choice(recorder.lastErrorCode, recorderCodes),
        },
        delivery: options
          .delivery()
          .slice(0, 32)
          .map((item) => ({
            state: choice(item.state, ['idle', 'sending', 'closing', 'closed']),
            inFlight: bool(item.inFlight),
            hasPendingLatest: bool(item.hasPendingLatest),
            offered: count(item.offered),
            sent: count(item.sent),
            coalesced: count(item.coalesced),
            failed: count(item.failed),
          })),
      },
    };
  }
  const exports = options.logsDirectory
    ? new SupportExports(
        options.logsDirectory,
        options.exportParticipants,
        (error, exportId, stage = 'build') => {
          const evidence = {
            event: 'support_export',
            stage,
            exportId,
            diagnostic: { error: diagnosticValue(error) },
          };
          if (stage === 'cleanup')
            app.log.warn(evidence, 'Support export ready; cleanup unconfirmed');
          else app.log.error(evidence, 'Support export failed');
        },
      )
    : null;
  app.post(
    '/debug/support-exports',
    {
      bodyLimit: 4096,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hostPinId: { type: 'string', maxLength: 36 },
            hostPinCoverage: {
              type: 'object',
              additionalProperties: false,
              required: ['status', 'phase', 'observedAt', 'budgetMs'],
              properties: {
                status: { type: 'string', enum: ['committed', 'failed', 'timeout'] },
                phase: { type: 'string', enum: ['admission', 'prepare', 'commit'] },
                observedAt: { type: 'string', format: 'date-time' },
                budgetMs: { type: 'integer', minimum: 0, maximum: 8000 },
              },
            },
            documentHandoff: {
              type: 'object',
              additionalProperties: false,
              required: [
                'documentId',
                'throughSequence',
                'observedAt',
                'transport',
                'stopReason',
                'pendingRecords',
                'firstPendingSequence',
                'lastPendingSequence',
                'unconfirmedRecordsObserved',
                'deliveryFailureAttemptsObserved',
                'budgetMs',
                'attempts',
              ],
              properties: {
                documentId: { type: ['string', 'null'], format: 'uuid' },
                observedAt: { type: 'string', format: 'date-time' },
                transport: { type: 'string', enum: ['host', 'http'] },
                stopReason: {
                  type: 'string',
                  enum: ['drained', 'deadline', 'attempt-limit', 'no-progress'],
                },
                ...Object.fromEntries(
                  [
                    'throughSequence',
                    'pendingRecords',
                    'unconfirmedRecordsObserved',
                    'deliveryFailureAttemptsObserved',
                  ].map((key) => [
                    key,
                    {
                      type: 'integer',
                      minimum: 0,
                      maximum: Number.MAX_SAFE_INTEGER,
                    },
                  ]),
                ),
                firstPendingSequence: {
                  type: ['integer', 'null'],
                  minimum: 1,
                  maximum: Number.MAX_SAFE_INTEGER,
                },
                lastPendingSequence: {
                  type: ['integer', 'null'],
                  minimum: 1,
                  maximum: Number.MAX_SAFE_INTEGER,
                },
                budgetMs: { type: 'integer', minimum: 0, maximum: 3000 },
                attempts: { type: 'integer', minimum: 0, maximum: 16 },
              },
            },

            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            desktop: desktopSchema,
          },
        },
      },
    },
    async (request, reply) => {
      if (!checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed)
        return reply.code(403).send({ error: 'origin' });
      if (!exports) return reply.code(503).send({ error: 'logs_unavailable' });
      const body = record(request.body);
      if (
        body.hostPinId !== undefined &&
        (typeof body.hostPinId !== 'string' ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.hostPinId))
      )
        return reply.code(400).send({ error: 'host_pin_id_invalid' });
      const range: { from?: string; to?: string } = {};
      for (const key of ['from', 'to'] as const) {
        if (body[key] !== undefined) {
          if (typeof body[key] !== 'string' || !Number.isFinite(Date.parse(body[key] as string)))
            return reply.code(400).send({ error: 'range_invalid' });
          range[key] = new Date(body[key] as string).toISOString();
        }
      }
      if (range.from && range.to && range.from > range.to)
        return reply.code(400).send({ error: 'range_invalid' });
      try {
        return reply.code(202).send(
          await exports.begin(
            range,
            async () => ({
              ...captureSnapshot(
                record(body.desktop),
                null,
                await options.obs().catch(() => undefined),
                (await options
                  .obsAudioDiagnostics?.()
                  .then((value) => value ?? { status: 'not_configured' })
                  .catch(audioDiagnosticReadFailure)) ?? {
                  status: 'not_configured',
                },
              ),
              artifact: {
                gitSha: digest(options.artifact?.gitSha, 40),
                artifactSha256: digest(options.artifact?.artifactSha256, 64),
              },
              pendingEvidence: {
                included: false,
                reason:
                  'memory-only-uncommitted; producer pin sourceState describes the fixed committed boundary',
              },
            }),
            body.hostPinId as string | undefined,
            body.documentHandoff as DocumentHandoffCoverage | undefined,
            body.hostPinCoverage as HostPinCoverage | undefined,
          ),
        );
      } catch (error) {
        // An existing/duplicate job with this ID may still be using its pin.
        // Only these pre-admission failures can supply a cleanup acknowledgement.
        const rejectedHostPinId =
          error instanceof Error &&
          ['export_busy', 'export_cache_job_budget'].includes(error.message) &&
          typeof body.hostPinId === 'string' &&
          exports.canReleaseRejectedHostPin(body.hostPinId)
            ? body.hostPinId
            : undefined;
        return reply.code(409).send({
          error: String(error),
          ...(rejectedHostPinId ? { rejectedHostPinId } : {}),
        });
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    '/debug/support-exports/:id/cancel',
    async (request, reply) => {
      if (!checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed)
        return reply.code(403).send({ error: 'origin' });
      return { cancelled: await exports?.cancel(request.params.id) };
    },
  );
  const allowedExportRead = (request: FastifyRequest) =>
    checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed ||
    (request.headers.origin === undefined &&
      request.headers['sec-fetch-site'] === 'same-origin' &&
      options.originPolicy.mode === 'loopback' &&
      isLoopbackBindHost(request.hostname));
  app.get<{ Params: { id: string } }>('/debug/support-exports/:id', async (request, reply) => {
    if (!allowedExportRead(request)) return reply.code(403).send({ error: 'origin' });
    const job = exports?.status(request.params.id);
    return job ?? reply.code(404).send({ error: 'export_unknown' });
  });
  app.get<{ Params: { id: string; name: string } }>(
    '/debug/support-exports/:id/files/:name',
    async (request, reply) => {
      if (!allowedExportRead(request)) return reply.code(403).send({ error: 'origin' });
      try {
        if (!exports) return reply.code(503).send({ error: 'logs_unavailable' });
        const handle = await exports.attachment(request.params.id, request.params.name);
        const job = exports.status(request.params.id);
        const filename =
          job?.parts?.length === 1 && request.params.name === 'part-1.zip'
            ? (job.downloadName ?? request.params.name)
            : request.params.name;
        reply.header('content-disposition', `attachment; filename="${filename}"`);
        reply.type(request.params.name.endsWith('.zip') ? 'application/zip' : 'application/json');
        return reply.send(handle.createReadStream({ autoClose: true }));
      } catch {
        return reply.code(404).send({ error: 'export_unavailable' });
      }
    },
  );
}
