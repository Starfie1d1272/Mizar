import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { sealOutbox } from './outbox-codec.js';
import { OutboxRepository, type HistoryScope, type OutboxCommit } from './outbox-repository.js';

function operations(repository: OutboxRepository) {
  const readHistory = (scopes: readonly HistoryScope[]) =>
    scopes.map((scope) => repository.forDelivery(scope, false));
  return {
    load: () => ({
      file: repository.active(),
      capture: repository.captureIndex(),
      lost: repository.boundaryCaptureInputLost(),
      staged: repository.pendingBoundaryCaptures(),
      revoked: repository.revokedSummary(),
    }),
    readHistory,
    captureCapacity: repository.captureCapacity.bind(repository),
    archivedInterval: repository.archivedInterval.bind(repository),
    captureInterval: repository.captureInterval.bind(repository),
    forDelivery: repository.forDelivery.bind(repository),
    sourceFences: (scopes: readonly string[]) =>
      scopes.map((scope) => ({
        damaged: repository.isDamaged(scope),
        sources: repository.sourcesByScope(scope),
      })),
    byKeys: (keys: readonly string[]) => keys.map((key) => repository.byKey(key)),
    latestEvent: repository.latestEvent.bind(repository),
    createCaptureInterval: repository.createCaptureInterval.bind(repository),
    sealCaptureInterval: repository.sealCaptureInterval.bind(repository),
    recordUnknownCapture: repository.recordUnknownCapture.bind(repository),
    stageBoundaryCaptures: repository.stageBoundaryCaptures.bind(repository),
    boundaryCaptureReceipt: repository.boundaryCaptureReceipt.bind(repository),
    captureReceipt: repository.captureReceipt.bind(repository),
    commit(value: OutboxCommit, scopes: readonly HistoryScope[], trackIdentity: boolean) {
      const started = performance.now();
      const active = sealOutbox(value.active);
      const activeJson = JSON.stringify(active);
      const activeBytes = Buffer.byteLength(activeJson);
      if (activeBytes > 4_000_000)
        return {
          ok: false as const,
          key: 'outbox_too_large',
          error: new Error('outbox_too_large'),
        };
      const key = trackIdentity
        ? 'snapshot:' +
          createHash('sha256')
            .update(
              JSON.stringify({
                ...active,
                commit: undefined,
                records: active.records.map((record) => ({
                  ...record,
                  updatedAt: undefined,
                  nextAttemptAt: undefined,
                })),
                ...(active.continuity
                  ? { continuity: { ...active.continuity, savedAt: undefined } }
                  : {}),
                history: value.history,
              }),
            )
            .digest('hex')
        : undefined;
      const preparationMs = performance.now() - started;
      try {
        const projection = repository.commit({ ...value, active }, activeJson, () => ({
          history: readHistory(scopes),
          interval: value.capture && repository.captureInterval(value.capture.intervalId),
          revoked: value.history?.some((entry) => entry.disposition === 'revoked')
            ? repository.revokedSummary()
            : undefined,
        }));
        return { ok: true as const, ...projection, key, preparationMs, activeBytes };
      } catch (error) {
        return { ok: false as const, key, error };
      }
    },
    close: () => repository.close(),
  };
}

export type OutboxOperations = ReturnType<typeof operations>;
export type OutboxRequest = {
  [K in keyof OutboxOperations]: {
    id: number;
    operation: K;
    args: Parameters<OutboxOperations[K]>;
  };
}[keyof OutboxOperations];
export type OutboxReply = {
  id: number;
  timing: ReturnType<OutboxRepository['takeTransactionTiming']>;
} & ({ ok: true; value: unknown } | { ok: false; error: Error });

const port = parentPort!;
const legacyPath = workerData as string;
const repository = await OutboxRepository.open(`${legacyPath}.sqlite`, legacyPath);
const handlers = operations(repository);
port.on('message', (request: OutboxRequest) => {
  let reply: OutboxReply;
  try {
    // Request is the discriminated union of handler names and their argument tuples.
    const handler = handlers[request.operation] as (...args: unknown[]) => unknown;
    reply = {
      id: request.id,
      ok: true,
      value: handler(...request.args),
      timing: repository.takeTransactionTiming(),
    };
  } catch (error) {
    reply = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
      timing: repository.takeTransactionTiming(),
    };
  }
  port.postMessage(reply);
  if (request.operation === 'close') port.close();
});
