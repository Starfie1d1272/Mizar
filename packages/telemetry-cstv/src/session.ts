import { createCs2ParserSession } from './cs2parser/binding.js';
import { normalizeGameEvent } from './normalize/events.js';
import {
  CSTV_MAX_DIAGNOSTICS,
  type CstvDiagnostic,
  type CstvDiagnosticBatch,
  type CstvLiveSession,
  type CstvLiveSessionOptions,
  type CstvObservationClock,
  type CstvObservationClockSample,
  type CstvParserSession,
  type CstvSessionRunResult,
  type CstvSessionStartResult,
  type CstvSyncMetadata,
} from './types.js';
import type { RoleScopedGameEventObservation } from '@mizar/core/game-events';

function defaultClock(): CstvObservationClock {
  return {
    now(): CstvObservationClockSample {
      return {
        observedAt: new Date().toISOString(),
        observedMonotonicMs: globalThis.performance?.now() ?? Date.now(),
      };
    },
  };
}

function copyDiagnostic(diagnostic: CstvDiagnostic): CstvDiagnostic {
  return {
    code: diagnostic.code,
    ...(diagnostic.eventName === undefined ? {} : { eventName: diagnostic.eventName }),
    ...(diagnostic.status === undefined ? {} : { status: diagnostic.status }),
  };
}

/** Adapt one parser session into the parser-neutral Core observation contract. */
export function createCstvLiveSession<R extends CstvLiveSessionOptions['role']>(
  options: CstvLiveSessionOptions<R>,
): CstvLiveSession<R> {
  const clock = options.clock ?? defaultClock();
  const diagnostics: CstvDiagnostic[] = [];
  let suppressedDiagnosticCount = 0;
  let sequence = 0;
  let lastSync: CstvSyncMetadata | null = null;
  let started = false;
  let runStarted = false;
  let stopped = false;

  const reportDiagnostic = (diagnostic: CstvDiagnostic): void => {
    const safeDiagnostic = copyDiagnostic(diagnostic);
    if (diagnostics.length >= CSTV_MAX_DIAGNOSTICS) {
      diagnostics.shift();
      suppressedDiagnosticCount += 1;
    }
    diagnostics.push(safeDiagnostic);
    try {
      options.onDiagnostic?.(safeDiagnostic);
    } catch {
      // Diagnostics are observational and must never interrupt parser callbacks.
    }
  };

  const reportSync = (sync: NonNullable<CstvParserSession['sync']>): void => {
    lastSync = sync;
    try {
      options.onSync?.(sync);
    } catch {
      reportDiagnostic({ code: 'sync-sink-failed' });
    }
  };

  const parserSession = (options.parserSessionFactory ?? createCs2ParserSession)({
    role: options.role,
    generation: options.generation,
    url: options.url,
    onSync: reportSync,
    onEvent: (eventName, event, tick) => {
      const sample = clock.now();
      try {
        const observation = normalizeGameEvent(eventName, event, {
          cursor: {
            kind: 'cs2-cstv',
            role: options.role,
            generation: options.generation,
            sequence,
            tick,
            observedAt: sample.observedAt,
            observedMonotonicMs: sample.observedMonotonicMs,
            ...(lastSync?.mapName === undefined ? {} : { mapName: lastSync.mapName }),
            ...(lastSync?.ticksPerSecond === undefined
              ? {}
              : { ticksPerSecond: lastSync.ticksPerSecond }),
          },
        });
        sequence += 1;
        try {
          options.onObservation(observation as RoleScopedGameEventObservation<R>);
        } catch {
          reportDiagnostic({ code: 'event-sink-failed', eventName });
        }
      } catch {
        reportDiagnostic({ code: 'normalization-failed', eventName });
      }
    },
    onDiagnostic: reportDiagnostic,
  });

  const liveSession: CstvLiveSession<R> & { readonly diagnostics: () => CstvDiagnosticBatch } = {
    role: options.role,
    generation: options.generation,
    get sync() {
      return lastSync ?? parserSession.sync;
    },
    get tailTick() {
      return parserSession.tailTick;
    },
    start: async (): Promise<CstvSessionStartResult> => {
      if (started) throw new Error('CSTV live session already started');
      started = true;
      try {
        const result = await parserSession.start();
        if (result.status !== 'ready' && result.status === 'cancelled') {
          reportDiagnostic({ code: 'session-cancelled', status: result.status });
        }
        return result;
      } catch {
        reportDiagnostic({ code: 'session-start-failed' });
        throw new Error('CSTV session start failed');
      }
    },
    run: async (): Promise<CstvSessionRunResult> => {
      if (!started) throw new Error('CSTV live session must start before run');
      if (runStarted) throw new Error('CSTV live session already running');
      runStarted = true;
      try {
        const result = await parserSession.run();
        if (result.status === 'cancelled' && !stopped) {
          reportDiagnostic({ code: 'session-cancelled', status: result.status });
        }
        return result;
      } catch {
        reportDiagnostic({ code: 'session-run-failed' });
        throw new Error('CSTV session run failed');
      }
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      parserSession.stop();
    },
    diagnostics: () => ({
      entries: diagnostics.slice(),
      suppressedCount: suppressedDiagnosticCount,
    }),
  };

  return liveSession;
}

export type CstvLiveSessionWithDiagnostics = CstvLiveSession & {
  readonly diagnostics: () => CstvDiagnosticBatch;
};
