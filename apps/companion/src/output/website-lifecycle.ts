import type { FastifyBaseLogger } from 'fastify';
import type { MatchContextBinding } from '../match-context/index.js';
import type { BusinessJournal } from '../support/business-journal.js';
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
  onStartupCleanupFailure: (error: unknown) => void,
): Promise<void> {
  await output.start({
    sourceStateAvailable: connection?.view().sourceState !== 'unavailable',
    restoreSourceCapture: async () => {
      await connection?.setSourceCaptureLifecycle?.({
        createReference: (cursor) => output.createCaptureReference(cursor),
        arm: (identity, reference) => output.armSourceCapture(identity, reference),
        activate: (identity) => output.activateSourceCapture(identity),
        restore: (identity, reference) => output.restoreSourceCapture(identity, reference),
        seal: (identity) => output.sealSourceCapture(identity),
        coverage: (identity) => output.sourceCaptureCoverage(identity),
      });
    },
  });
  if (!output.isReliableAvailable()) {
    try {
      await connection?.abortSourceCaptureStartup?.();
    } catch (error) {
      onStartupCleanupFailure(error);
    }
  }
  connection?.setSourceSettlement?.(
    (scope) => output.settleSourceForRelease(scope),
    (scope) => output.resumeSource(scope),
    (identity, disposition) =>
      disposition === 'revoked'
        ? output.isolateRevokedSource(identity)
        : output.archiveConfirmedSource(identity),
    () => output.getReliableActiveSources(),
  );
  connection?.startSourceCleanup?.();
}

export function createWebsiteOutput({
  connection,
  ...options
}: Required<
  Pick<
    OutputServiceOptions,
    'restoreContinuity' | 'isExecutionOwnedBy' | 'managedSourceId' | 'isActiveOnlineBinding'
  >
> & {
  connection: RivalHubConnection | undefined;
  reliableOutboxPath: string | undefined;
  reliableSink: OutputServiceOptions['sink'];
  liveSink: OutputServiceOptions['liveSink'];
  readBinding: () => MatchContextBinding | undefined;
  readLog: () => FastifyBaseLogger;
  readJournal: () => BusinessJournal | undefined;
  recordDiagnostic: (code: string) => void;
}) {
  const { restoreContinuity, isExecutionOwnedBy, managedSourceId, isActiveOnlineBinding } = options;
  const isCurrentOnlineMatch = (matchId: string) => {
    const binding = options.readBinding();
    return binding?.origin === 'online' && binding.context.matchId === matchId;
  };
  const outbox =
    options.reliableOutboxPath === undefined
      ? undefined
      : new ReliableOutbox(
          options.reliableOutboxPath,
          (recovery, error) => {
            // Raw cause stays in the local log; support export applies its existing redaction.
            const evidence = {
              event: 'outbox',
              stage:
                error instanceof Error && error.message.startsWith('capture_sequence_unconfirmed:')
                  ? 'outbox_capture'
                  : 'outbox_load',
              err: outboxLocalError(error),
              recovery: recovery ?? null,
              result:
                recovery === undefined
                  ? 'failure'
                  : recovery.code === 'outbox_recovered'
                    ? 'success'
                    : 'unconfirmed',
            };
            if (recovery === undefined)
              options.readLog().error(evidence, '网站可靠输出操作未确认；原始文件保留。');
            else {
              options.readLog().warn(evidence, recovery.message);
              options.recordDiagnostic(recovery.code);
            }
          },
          (record, reason) => options.readJournal()?.reliable(record, reason),
          (error) => {
            options
              .readLog()
              .error(
                { event: 'outbox', stage: 'worker', err: outboxLocalError(error) },
                '网站发送队列已停止，重启后将按原提交和回执核对。',
              );
            options.recordDiagnostic('outbox_worker_restart_required');
          },
        );
  const outputService: OutputService = new OutputService({
    ...(outbox ? { outbox } : {}),
    restoreContinuity,
    isExecutionOwnedBy,
    managedSourceId,
    isActiveOnlineBinding,
    ...(connection !== undefined
      ? {
          authorityScope: () => connection.reliableAuthorityScope(),
          exactSource: () => connection.reliableExactSource(),
          sink: {
            send: (event, signal, retainedLineup, retainedSource) => {
              if (retainedSource)
                return connection.sendRetainedReliable(
                  event,
                  retainedSource,
                  outputService.current(true),
                  signal,
                  retainedLineup,
                );
              if (connection.view().paired && isCurrentOnlineMatch(event.matchId))
                return connection.sendReliable(
                  event,
                  outputService.current(true),
                  signal,
                  retainedLineup,
                );
              return options.reliableSink?.send(event, signal) ?? Promise.resolve('retry');
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
      options
        .readLog()
        .error(
          { event: 'outbox', stage: 'outbox_load', err: outboxLocalError(error) },
          '发送队列无法打开，网站同步不可用；原始数据保留。',
        ),
    onBoundaryCaptureError: (error, evidence) =>
      options.readLog().error(
        {
          event: 'outbox',
          operation: 'boundary_capture',
          ...evidence,
          err: outboxLocalError(error),
        },
        '网站同步边界尚未确认保存，保留原请求重试；本机画面继续。',
      ),
    onBusinessEvidence: (stage, evidence) => options.readJournal()?.write(stage, evidence),
    onRecoveryProgress: (event, state) => {
      const authority = connection?.reliableAuthorityScope();
      if (authority) connection?.setContextRecoveryProgress(event, authority, state);
    },
  });
  connection?.setBoundaryStatusProvider?.(() => outputService.getBoundaryStatus());
  return { outbox, outputService };
}
