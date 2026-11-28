import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { MatchContextBinding, MatchContextController } from '../match-context/index.js';
import type { ProgramRuntime } from '../runtime/program-runtime.js';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import type { createProduction } from '../program-scenes/production.js';
import { diagnosticValue, type SessionJournal } from '../support/session-journal.js';
import type { BusinessJournal } from '../support/business-journal.js';
import { registerOutputRoutes } from './routes.js';
import { ReliableOutbox, outboxLocalError } from './reliable-outbox.js';
import type { RivalHubConnection } from '../match-context/rivalhub-connection.js';
import { OutputService, type OutputServiceOptions } from './service.js';

export async function closeWebsiteOutput(
  connection:
    | Pick<RivalHubConnection, 'prepareSourceShutdown' | 'shutdownSource' | 'closeSourceState'>
    | undefined,
  output: Pick<OutputService, 'close'>,
  onRemoteFailure: (error: unknown) => void,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await connection?.prepareSourceShutdown?.();
  } catch (error) {
    failures.push(error);
  }
  if (!failures.length && connection?.shutdownSource) {
    const remote = new AbortController();
    const timeout = new Error('数据源远端收尾超时');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connection.shutdownSource(remote.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            remote.abort(timeout);
            reject(timeout);
          }, 9000);
        }),
      ]);
    } catch (error) {
      onRemoteFailure(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Both local writers must close even if one reports a failure.
  const local = await Promise.allSettled([
    Promise.resolve().then(() => connection?.closeSourceState?.()),
    Promise.resolve().then(() => output.close()),
  ]);
  for (const result of local) {
    if (result.status === 'rejected') failures.push(result.reason);
  }
  if (failures.length) throw new AggregateError(failures, 'website_local_shutdown_failed');
}

export async function startWebsiteOutput(
  connection: RivalHubConnection | undefined,
  output: OutputService,
  onStartupCleanupFailure?: (error: unknown) => void,
): Promise<void> {
  void onStartupCleanupFailure;
  await output.start();
  connection?.startSourceCleanup?.();
}

export function createWebsiteOutput({
  connection,
  ...options
}: {
  connection: RivalHubConnection | undefined;
  reliableOutboxPath: string | undefined;
  reliableSink: OutputServiceOptions['sink'];
  liveSink: OutputServiceOptions['liveSink'];
  readBinding: () => MatchContextBinding | undefined;
  logger: FastifyBaseLogger;
  journal: BusinessJournal | undefined;
  recordDiagnostic: (code: string) => void;
  runtime: Pick<
    ProgramRuntime,
    'getCurrentState' | 'restoreDeliveryContinuity' | 'isExecutionOwnedBy' | 'getManagedSourceId'
  >;
}) {
  const { runtime, logger, journal } = options;
  type RuntimePeers = {
    projections: Pick<ProjectionCoordinator, 'refresh'>;
    context: Pick<
      MatchContextController,
      'getActiveBinding' | 'getPendingOnlineCandidate' | 'isOnlineCandidateLoading'
    > | null;
    production: Pick<ReturnType<typeof createProduction>, 'isTrialPending' | 'get'>;
  };
  let peers: RuntimePeers | undefined;
  const isCurrentOnlineMatch = (matchId: string) => {
    const binding = options.readBinding();
    return binding?.origin === 'online' && binding.context.matchId === matchId;
  };
  const outbox =
    options.reliableOutboxPath === undefined
      ? undefined
      : new ReliableOutbox(
          options.reliableOutboxPath,
          (code, detail) => {
            logger.warn({ event: 'outbox', code, detail }, '网站可靠事件投递提示');
            options.recordDiagnostic(code);
          },
          (record, reason) => journal?.reliable(record, reason),
        );
  const outputService: OutputService = new OutputService({
    ...(outbox ? { outbox } : {}),
    isExecutionOwnedBy: (binding) =>
      runtime.isExecutionOwnedBy(binding.context.matchId, binding.origin),
    isActiveOnlineBinding: (binding) => {
      const context = peers?.context;
      if (
        !peers ||
        !context ||
        context.getActiveBinding() !== binding ||
        context.getPendingOnlineCandidate() ||
        context.isOnlineCandidateLoading() ||
        peers.production.isTrialPending() ||
        peers.production.get().mode !== 'live'
      )
        return false;
      const source = connection?.view();
      return (
        source?.activeSourceMatchId === binding.context.matchId &&
        source.stoppedMatchId !== binding.context.matchId &&
        !source.activeDeviceName
      );
    },
    ...(connection !== undefined
      ? {
          exactSource: () => connection.reliableExactSource(),
          sink: {
            send: (event, signal) => {
              if (connection.view().paired) return connection.sendReliableV2(event, signal);
              return (
                options.reliableSink?.send(event, signal) ??
                Promise.resolve({ status: 'retry', error: 'sink_unavailable' })
              );
            },
          },
          liveSink: {
            send: (snapshot) =>
              connection.view().paired && isCurrentOnlineMatch(snapshot.matchId)
                ? connection.sendLive(snapshot)
                : (options.liveSink?.send(snapshot) ?? Promise.resolve()),
          },
        }
      : {
          ...(options.reliableSink === undefined ? {} : { sink: options.reliableSink }),
          ...(options.liveSink === undefined ? {} : { liveSink: options.liveSink }),
        }),
    onDiagnostic: options.recordDiagnostic,
    onOutboxLoadError: (error) =>
      logger.error(
        { event: 'outbox', stage: 'outbox_load', err: outboxLocalError(error) },
        '发送队列无法打开，网站同步不可用；原始数据保留。',
      ),
  });
  return {
    outbox,
    outputService,
    connectRuntime(runtimePeers: RuntimePeers) {
      peers = runtimePeers;
    },
  };
}

export function quarantineRecoveredTrial(
  log: FastifyBaseLogger,
  output: Pick<OutputService, 'setQuarantined'>,
): void {
  void output.setQuarantined(true).catch((error: unknown) =>
    log.error(
      {
        event: 'demo-test',
        stage: 'recovery_output_quarantine',
        diagnostic: diagnosticValue(error),
      },
      'Demo test quarantine failed',
    ),
  );
}

export function registerWebsiteOutputRuntime(
  app: FastifyInstance,
  options: {
    connection: RivalHubConnection | undefined;
    outputService: OutputService;
    outbox: ReliableOutbox | undefined;
    businessJournal: BusinessJournal | undefined;
    sessionJournal: SessionJournal | undefined;
    readBinding: () => MatchContextBinding | undefined;
    readProjection: () => ReturnType<ProjectionCoordinator['getCurrent']>;
    readTelemetry: () => ReturnType<ProgramRuntime['getCurrentState']>['programTelemetry'];
    recordConfiguration: () => Promise<void>;
  },
): void {
  const { outputService, businessJournal, sessionJournal } = options;
  app.addHook('onReady', async () => {
    outputService.setCurrent(options.readProjection(), options.readBinding());
    await startWebsiteOutput(options.connection, outputService, (error) =>
      app.log.error({ err: error }, '网站启动所有权清理未确认，本机制作继续；修复后重启。'),
    );
    businessJournal?.runtime(
      options.readProjection(),
      options.readBinding(),
      options.readTelemetry(),
    );
    for (const record of outputService.getReliableRecords())
      businessJournal?.reliable(record, 'restored');
    await businessJournal?.flush();
    await options.recordConfiguration().catch((error: unknown) => {
      sessionJournal?.record('diagnostic_delivery_failure', {
        phase: 'configuration_snapshot',
        error: diagnosticValue(error),
      });
    });
  });
  registerOutputRoutes(app, outputService, () =>
    outputService.setCurrent(options.readProjection(), options.readBinding()),
  );
}
