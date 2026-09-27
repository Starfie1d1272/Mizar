import { describe, expect, it } from 'vitest';

import type {
  CstvParserSessionFactory,
  CstvParserSessionFactoryOptions,
  CstvSessionRunResult,
} from '@mizar/telemetry-cstv';

import {
  CSTV_RECENT_DIAGNOSTICS_MAX,
  CSTV_RECENT_GAME_EVENTS_MAX,
  createCstvSourceManager,
  createCstvSourceManagers,
  parseCstvSourceUrl,
  type CstvScheduler,
} from '../src/telemetry/cstv-source-manager.js';

class FakeScheduler implements CstvScheduler {
  readonly delays: number[] = [];
  private readonly callbacks: Array<() => void> = [];

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.delays.push(delayMs);
    this.callbacks.push(callback);
    return callback;
  }

  clearTimeout(handle: unknown): void {
    const index = this.callbacks.indexOf(handle as () => void);
    if (index >= 0) this.callbacks.splice(index, 1);
  }

  runNext(): void {
    this.callbacks.shift()?.();
  }
}

interface FakeSession {
  readonly options: CstvParserSessionFactoryOptions;
  resolveRun(result: CstvSessionRunResult): void;
  rejectRun(error?: Error): void;
  setTailTick(tick: number): void;
}

interface FakeSessionPlan {
  readonly start?: 'ready' | 'throw' | 'cancelled';
  readonly emitSync?: boolean;
}

function createFakeParserFactory(
  sessions: FakeSession[],
  planForSession: (index: number) => FakeSessionPlan = () => ({
    start: 'ready',
    emitSync: true,
  }),
): CstvParserSessionFactory {
  return (options) => {
    const plan = planForSession(sessions.length);
    let resolveRun: ((result: CstvSessionRunResult) => void) | undefined;
    let rejectRun: ((error: Error) => void) | undefined;
    let stopped = false;
    let tailTick = 0;
    const session: FakeSession = {
      options,
      resolveRun: (result) => resolveRun?.(result),
      rejectRun: (error = new Error('fake run failure')) => rejectRun?.(error),
      setTailTick: (tick) => {
        tailTick = tick;
      },
    };
    sessions.push(session);
    return {
      sync: null,
      get tailTick() {
        return tailTick;
      },
      start: () => {
        if (plan.start === 'throw') return Promise.reject(new Error('fake start failure'));
        if (plan.start === 'cancelled') return Promise.resolve({ status: 'cancelled' as const });
        if (plan.emitSync !== false) {
          options.onSync({
            protocol: 5,
            tick: 10,
            ticksPerSecond: 64,
            fragment: 1,
            signupFragment: 1,
          });
        }
        return Promise.resolve({ status: 'ready' as const });
      },
      run: () =>
        new Promise<CstvSessionRunResult>((resolve, reject) => {
          resolveRun = resolve;
          rejectRun = reject;
          if (stopped) resolve({ status: 'cancelled' });
        }),
      stop: () => {
        stopped = true;
        resolveRun?.({ status: 'cancelled' });
      },
    };
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('CSTV source manager', () => {
  it('reconnects timeout sessions with a fresh generation and bounded exponential backoff', async () => {
    const sessions: FakeSession[] = [];
    const scheduler = new FakeScheduler();
    const manager = createCstvSourceManager({
      role: 'program',
      url: 'https://example.test/program/',
      parserSessionFactory: createFakeParserFactory(sessions),
      scheduler,
    });

    manager.start();
    await flush();
    expect(sessions[0]?.options.generation).toBe(0);
    sessions[0]?.resolveRun({ status: 'timeout' });
    await flush();
    expect(manager.getHealth()).toMatchObject({
      state: 'reconnecting',
      generation: 0,
      reconnectAttempt: 1,
      lastErrorCode: 'session-timeout',
      lastTerminalStatus: 'timeout',
    });
    expect(manager.getRecentDiagnostics()).toEqual([
      { code: 'session-timeout', status: 'timeout' },
    ]);
    expect(scheduler.delays).toEqual([1000]);

    scheduler.runNext();
    await flush();
    expect(sessions[1]?.options.generation).toBe(1);
    sessions[1]?.resolveRun({ status: 'complete' });
    await flush();
    expect(manager.getHealth()).toMatchObject({ state: 'ended', generation: 1 });
    expect(scheduler.delays).toEqual([1000]);
    await manager.stop();
  });

  it('uses bounded backoff for pre-sync start failures and resets after a successful sync', async () => {
    const sessions: FakeSession[] = [];
    const scheduler = new FakeScheduler();
    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 10_000, 10_000];
    const manager = createCstvSourceManager({
      role: 'program',
      url: 'https://example.test/program/',
      parserSessionFactory: createFakeParserFactory(sessions, (index) =>
        index < expectedDelays.length
          ? { start: 'throw', emitSync: false }
          : { start: 'ready', emitSync: true },
      ),
      scheduler,
    });

    manager.start();
    await flush();
    for (let index = 0; index < expectedDelays.length; index += 1) {
      expect(sessions[index]?.options.generation).toBe(index);
      expect(manager.getHealth()).toMatchObject({
        state: 'reconnecting',
        generation: index,
        reconnectAttempt: index + 1,
        lastErrorCode: 'session-start-failed',
        lastTerminalStatus: 'failed',
      });
      expect(scheduler.delays[index]).toBe(expectedDelays[index]);
      scheduler.runNext();
      await flush();
    }

    expect(sessions[expectedDelays.length]?.options.generation).toBe(expectedDelays.length);
    expect(manager.getHealth()).toMatchObject({
      state: 'live',
      generation: expectedDelays.length,
      reconnectAttempt: 0,
    });
    expect(manager.getRecentDiagnostics()).toHaveLength(expectedDelays.length);
    expect(
      manager.getRecentDiagnostics().every(({ code }) => code === 'session-start-failed'),
    ).toBe(true);

    sessions[expectedDelays.length]?.resolveRun({ status: 'timeout' });
    await flush();
    expect(manager.getHealth()).toMatchObject({
      state: 'reconnecting',
      generation: expectedDelays.length,
      reconnectAttempt: 1,
      lastErrorCode: 'session-timeout',
      lastTerminalStatus: 'timeout',
    });
    expect(scheduler.delays).toEqual([...expectedDelays, 1_000]);

    scheduler.runNext();
    await flush();
    expect(sessions[expectedDelays.length + 1]?.options.generation).toBe(expectedDelays.length + 1);
    sessions[expectedDelays.length + 1]?.resolveRun({ status: 'complete' });
    await flush();
    expect(manager.getHealth()).toMatchObject({
      state: 'ended',
      generation: expectedDelays.length + 1,
      lastTerminalStatus: 'complete',
    });
    await manager.stop();
  });

  it('keeps parser lifecycle diagnostics single-owned across start, run, and cancellation', async () => {
    const sessions: FakeSession[] = [];
    const scheduler = new FakeScheduler();
    const manager = createCstvSourceManager({
      role: 'program',
      url: 'https://example.test/program/',
      parserSessionFactory: createFakeParserFactory(sessions),
      scheduler,
    });

    manager.start();
    await flush();
    sessions[0]?.rejectRun();
    await flush();
    expect(manager.getHealth()).toMatchObject({
      state: 'reconnecting',
      lastErrorCode: 'session-run-failed',
      lastTerminalStatus: 'failed',
    });
    expect(manager.getRecentDiagnostics()).toEqual([{ code: 'session-run-failed' }]);

    scheduler.runNext();
    await flush();
    sessions[1]?.resolveRun({ status: 'cancelled' });
    await flush();
    expect(manager.getHealth()).toMatchObject({
      state: 'reconnecting',
      lastErrorCode: 'session-cancelled',
      lastTerminalStatus: 'cancelled',
    });
    expect(manager.getRecentDiagnostics()).toEqual([
      { code: 'session-run-failed' },
      { code: 'session-cancelled', status: 'cancelled' },
    ]);
    await manager.stop();
  });

  it('keeps program and lookahead lifecycle state independent', async () => {
    const sessions: FakeSession[] = [];
    const scheduler = new FakeScheduler();
    const managers = createCstvSourceManagers({
      programUrl: 'https://example.test/program/',
      lookaheadUrl: 'https://example.test/lookahead/',
      parserSessionFactory: createFakeParserFactory(sessions),
      scheduler,
    });

    managers.program.start();
    managers.lookahead.start();
    await flush();
    const program = sessions.find(({ options }) => options.role === 'program');
    const lookahead = sessions.find(({ options }) => options.role === 'lookahead');
    program?.resolveRun({ status: 'timeout' });
    await flush();

    expect(managers.program.getHealth().state).toBe('reconnecting');
    expect(managers.lookahead.getHealth().state).toBe('live');
    expect(scheduler.delays).toEqual([1000]);
    lookahead?.resolveRun({ status: 'complete' });
    await flush();
    await managers.program.stop();
    await managers.lookahead.stop();
  });

  it('bounds event and diagnostic evidence while preserving source metadata', async () => {
    const sessions: FakeSession[] = [];
    const manager = createCstvSourceManager({
      role: 'program',
      url: 'https://example.test/program/',
      parserSessionFactory: createFakeParserFactory(sessions),
      scheduler: new FakeScheduler(),
    });

    manager.start();
    await flush();
    const options = sessions[0]?.options;
    const session = sessions[0];
    if (options === undefined || session === undefined)
      throw new Error('fake parser session was not created');
    session.setTailTick(4096);
    expect(manager.getHealth()).toMatchObject({ state: 'live', tailTick: 4096 });
    expect(manager.getHealth()).not.toHaveProperty('lastEventTick');
    for (let index = 0; index < CSTV_RECENT_GAME_EVENTS_MAX + 6; index += 1) {
      options.onEvent(
        'weapon_fire',
        {
          userid: index + 1,
          player: { steamId: `765611980000000${index}`, name: `Player ${index}`, teamNumber: 3 },
          weapon: 'm4a1',
          silenced: false,
        },
        index,
      );
    }
    for (let index = 0; index < CSTV_RECENT_DIAGNOSTICS_MAX + 4; index += 1) {
      options.onDiagnostic({ code: 'normalization-failed', eventName: 'weapon_fire' });
    }

    const snapshot = manager.getSnapshot();
    expect(snapshot.recentGameEvents).toHaveLength(CSTV_RECENT_GAME_EVENTS_MAX);
    expect(snapshot.recentDiagnostics).toHaveLength(CSTV_RECENT_DIAGNOSTICS_MAX);
    expect(snapshot.health).toMatchObject({
      state: 'live',
      lastEventSequence: CSTV_RECENT_GAME_EVENTS_MAX + 5,
      lastEventTick: CSTV_RECENT_GAME_EVENTS_MAX + 5,
      tailTick: 4096,
    });
    await manager.stop();
  });

  it('keeps start bootstrap events in debug evidence but only delivers run events live', async () => {
    const sessions: FakeSession[] = [];
    const liveEvents: number[] = [];
    const manager = createCstvSourceManager({
      role: 'program',
      url: 'https://example.test/program/',
      parserSessionFactory: (options) => {
        const session: FakeSession = {
          options,
          resolveRun: () => {},
          rejectRun: () => {},
          setTailTick: () => {},
        };
        sessions.push(session);
        return {
          sync: null,
          tailTick: 0,
          start: () => {
            options.onEvent(
              'weapon_fire',
              {
                userid: 1,
                player: { steamId: '76561198000000001', name: 'Bootstrap', teamNumber: 3 },
                weapon: 'm4a1',
                silenced: false,
              },
              10,
            );
            return Promise.resolve({ status: 'ready' as const });
          },
          run: () => {
            options.onEvent(
              'weapon_fire',
              {
                userid: 2,
                player: { steamId: '76561198000000002', name: 'Live', teamNumber: 2 },
                weapon: 'ak47',
                silenced: false,
              },
              11,
            );
            return Promise.resolve({ status: 'complete' as const });
          },
          stop: () => {},
        };
      },
    });
    manager.subscribeLiveGameEvents((event) => liveEvents.push(event.cursor.sequence));

    manager.start();
    await flush();
    await flush();

    expect(sessions).toHaveLength(1);
    expect(manager.getHealth().state).toBe('ended');
    expect(manager.getRecentGameEvents().map((event) => event.cursor.sequence)).toEqual([0, 1]);
    expect(liveEvents).toEqual([1]);
  });

  it('does not schedule reconnect after stop and validates explicit source URLs', async () => {
    const sessions: FakeSession[] = [];
    const scheduler = new FakeScheduler();
    const manager = createCstvSourceManager({
      role: 'program',
      url: 'https://example.test/program/',
      parserSessionFactory: createFakeParserFactory(sessions),
      scheduler,
    });

    manager.start();
    await flush();
    sessions[0]?.resolveRun({ status: 'timeout' });
    await flush();
    await manager.stop();
    scheduler.runNext();
    await flush();
    expect(sessions).toHaveLength(1);
    expect(manager.getHealth().state).toBe('stopped');

    expect(parseCstvSourceUrl(' https://example.test/cstv/ ', 'PROGRAM_CSTV_URL')).toBe(
      'https://example.test/cstv/',
    );
    expect(parseCstvSourceUrl(undefined, 'PROGRAM_CSTV_URL')).toBeUndefined();
    expect(() => parseCstvSourceUrl('ftp://example.test/cstv/', 'PROGRAM_CSTV_URL')).toThrow(
      'PROGRAM_CSTV_URL must be a valid http(s) URL',
    );
  });

  it('notifies observers when externally visible source health changes', async () => {
    const sessions: FakeSession[] = [];
    const scheduler = new FakeScheduler();
    const manager = createCstvSourceManager({
      role: 'program',
      url: 'https://example.test/program/',
      parserSessionFactory: createFakeParserFactory(sessions),
      scheduler,
    });
    const states: string[] = [];
    const unsubscribe = manager.subscribe(() => {
      states.push(manager.getHealth().state);
    });

    manager.start();
    await flush();
    sessions[0]?.resolveRun({ status: 'timeout' });
    await flush();

    expect(states).toEqual(expect.arrayContaining(['connecting', 'live', 'reconnecting']));
    const countBeforeUnsubscribe = states.length;
    unsubscribe();
    scheduler.runNext();
    await flush();
    expect(states).toHaveLength(countBeforeUnsubscribe);
    await manager.stop();
  });
});
