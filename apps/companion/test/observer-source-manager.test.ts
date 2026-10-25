import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CstvParserSessionFactoryOptions, CstvSessionRunResult } from '@mizar/telemetry-cstv';
import type { GameEventObservation } from '@mizar/core/game-events';
import {
  createCstvSourceManager,
  createObserverSourceManager,
} from '../src/telemetry/cstv-source-manager.js';

// Generated through the actual pinned parser worker and Python pipe, using only synthetic inputs.
const event = JSON.parse(
  readFileSync(new URL('./fixtures/observer-event.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const identity = { source: 'ahead:fixture', role: 'ahead' as const, channel: 1, world: 2 };
const cursor = {
  kind: 'cursor',
  ...identity,
  sequence: 6,
  tick: 99,
  tickInterval: 1 / 64,
  map: 'de_test',
};
function setup() {
  const manager = createObserverSourceManager({
    role: 'lookahead',
    identity,
    clock: { now: () => ({ observedAt: '2026-10-20T08:00:00Z', observedMonotonicMs: 10 }) },
  });
  const received: GameEventObservation[] = [];
  manager.subscribeLiveGameEvents((row) => received.push(row));
  manager.start();
  return { manager, received };
}
describe('observer through the existing source owner', () => {
  it('requires committed cursor readiness and preserves actual userid', () => {
    const { manager, received } = setup();
    manager.consumeObserverRecord({ ...event, sequence: 5 });
    expect(received).toHaveLength(0);
    manager.consumeObserverRecord(cursor);
    manager.consumeObserverRecord(event);
    expect(manager.getHealth().state).toBe('live');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      kind: 'weapon-fire',
      player: { sourceUserId: 42 },
      cursor: { role: 'lookahead' },
    });
    expect(manager.getHealth().lastReceiveMonotonicMs).toBe(10);
    expect(manager.getHealth().lastSync).toBeUndefined(); // Never invent HTTP fragment metadata.
  });
  it('rejects duplicate and out-of-order records', () => {
    const { manager, received } = setup();
    manager.consumeObserverRecord(cursor);
    manager.consumeObserverRecord(event);
    manager.consumeObserverRecord(event);
    manager.consumeObserverRecord({ ...event, sequence: 7 });
    expect(received).toHaveLength(1);
  });
  it('retires alignment and old-world data, then accepts cursor at the reset sequence', () => {
    const { manager, received } = setup();
    manager.consumeObserverRecord(cursor);
    manager.consumeObserverRecord(event);
    const before = manager.getHealth().generation;
    const reset = { kind: 'discontinuity', ...identity, world: 3, sequence: 10 };
    manager.consumeObserverRecord(reset);
    expect(manager.getRecentGameEvents()).toEqual([]);
    expect(manager.getHealth().lastReceiveMonotonicMs).toBeUndefined();
    manager.consumeObserverRecord({ ...event, sequence: 11 });
    expect(received).toHaveLength(1);
    manager.consumeObserverRecord({ ...cursor, world: 3, sequence: 10, tick: 1 });
    manager.consumeObserverRecord({ ...event, world: 3, sequence: 11, tick: 2, committedTick: 1 });
    expect(received).toHaveLength(2);
    expect(received[1]?.cursor.generation).toBe(before + 1);
    manager.consumeObserverRecord(reset);
    expect(manager.getHealth().state).toBe('live');
  });
  it('does not resume on a queued old cursor after disconnect', () => {
    const { manager, received } = setup();
    manager.consumeObserverRecord(cursor);
    manager.disconnectObserver();
    manager.consumeObserverRecord({ ...cursor, sequence: 10 });
    manager.consumeObserverRecord({ ...event, sequence: 11 });
    expect(received).toHaveLength(0);
    expect(manager.getHealth().state).toBe('reconnecting');
    manager.attachObserver({ ...identity, channel: 2 });
    manager.consumeObserverRecord({ ...cursor, channel: 2 });
    manager.consumeObserverRecord({ ...event, channel: 2 });
    expect(received).toHaveLength(1);
  });
  it('does not let unknown records reserve the ordering watermark', () => {
    const { manager, received } = setup();
    manager.consumeObserverRecord({ ...cursor, kind: 'unknown', sequence: 999 });
    manager.consumeObserverRecord({ ...cursor, world: 99, sequence: 999 });
    manager.consumeObserverRecord(cursor);
    manager.consumeObserverRecord(event);
    expect(received).toHaveLength(1);
  });
  it('rejects cross-role attachment and wrong source without disturbing the valid source', () => {
    expect(() => createObserverSourceManager({ role: 'program', identity })).toThrow();
    const { manager, received } = setup();
    manager.consumeObserverRecord({ ...cursor, source: 'ahead:other', sequence: 999 });
    manager.consumeObserverRecord(cursor);
    manager.consumeObserverRecord(event);
    expect(received).toHaveLength(1);
  });
  it('does not deliver after stop', async () => {
    const { manager, received } = setup();
    manager.consumeObserverRecord(cursor);
    await manager.stop();
    manager.consumeObserverRecord(event);
    expect(received).toHaveLength(0);
    expect(manager.getHealth().state).toBe('stopped');
  });
  it('leaves the default unconfigured HTTP source disabled', () => {
    const manager = createCstvSourceManager({ role: 'program' });
    manager.start();
    expect(manager.getHealth().state).toBe('disabled');
  });
});

it('timestamps actual HTTP sync/tail progress without refreshing cached upstream metadata', async () => {
  let now = 100,
    tail = 0;
  let callbacks: CstvParserSessionFactoryOptions | undefined;
  let finish!: (result: CstvSessionRunResult) => void;
  const running = new Promise<CstvSessionRunResult>((resolve) => {
    finish = resolve;
  });
  const manager = createCstvSourceManager({
    role: 'lookahead',
    url: 'http://127.0.0.1:27025',
    clock: { now: () => ({ observedAt: '2026-10-25T00:00:00Z', observedMonotonicMs: now }) },
    parserSessionFactory: (options) => {
      callbacks = options;
      return {
        sync: null,
        get tailTick() {
          return tail;
        },
        start: () => Promise.resolve({ status: 'ready' }),
        run: () => running,
        stop: () => finish({ status: 'cancelled' }),
      };
    },
  });
  manager.start();
  try {
    const sync = {
      protocol: 1,
      tick: 10,
      ticksPerSecond: 64,
      fragment: 1,
      signupFragment: 0,
      mapName: 'de_test',
      receiveAgeSeconds: 9999,
    };
    expect(manager.getHealth().lastReceiveMonotonicMs).toBeUndefined();
    callbacks!.onSync(sync);
    expect(manager.getHealth().lastReceiveMonotonicMs).toBe(100);
    now = 200;
    callbacks!.onSync(sync);
    expect(manager.getHealth().lastReceiveMonotonicMs).toBe(100);
    now = 300;
    tail = 20;
    expect(manager.getHealth().lastReceiveMonotonicMs).toBe(300);
    now = 400;
    callbacks!.onSync({ ...sync, tick: 20, fragment: 2 });
    expect(manager.getHealth().lastReceiveMonotonicMs).toBe(400);
    now = 500;
    expect(manager.getHealth().lastReceiveMonotonicMs).toBe(400);
    expect(manager.getRecentGameEvents()).toEqual([]);
  } finally {
    await manager.stop();
  }
});
