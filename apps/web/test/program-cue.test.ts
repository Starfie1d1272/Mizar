import { describe, expect, it } from 'vitest';

import type {
  ProgramCueBaselineV1,
  ProgramCueLaneCursor,
  ProgramCueMessageV1,
} from '@mizar/protocol/program-cue';
import { getProgramFixture } from '../src/program/fixtures';
import {
  createProgramCueClient,
  type BrowserWebSocketLike,
  type WebSocketFactory,
} from '../src/realtime';
import { ProgramCueEffectStore } from '../src/program/program-cue-effects';

const laneCursor: ProgramCueLaneCursor = {
  producerInstanceId: 'fixture-producer',
  liveSessionId: 'fixture-session',
  mapEpoch: 1,
  cstvProgramGeneration: 9,
};

function baseline(cursor: ProgramCueLaneCursor = laneCursor, channelSeq = 1): ProgramCueBaselineV1 {
  return {
    type: 'cue-baseline',
    protocolVersion: 1,
    channel: 'program-cue',
    schemaVersion: 1,
    channelSeq,
    cursor,
  };
}

function cue(
  channelSeq: number,
  sourceSequence = channelSeq,
  cursor: ProgramCueLaneCursor = laneCursor,
  id = `pc:${cursor.producerInstanceId}:${cursor.cstvProgramGeneration}:${sourceSequence}`,
): ProgramCueMessageV1 {
  return {
    type: 'cue',
    protocolVersion: 1,
    channel: 'program-cue',
    schemaVersion: 1,
    channelSeq,
    cursor,
    cue: {
      id,
      mapEpoch: cursor.mapEpoch,
      source: {
        generation: cursor.cstvProgramGeneration,
        sequence: sourceSequence,
        tick: sourceSequence * 64,
      },
      kind: 'player-impact',
      effect: 'sniper',
      targetSourcePlayerId: '76561198000000001',
      attackerSourcePlayerId: null,
      weapon: 'awp',
      damageHealth: 100,
      healthRemaining: 0,
      hitgroup: 1,
      lethal: true,
    },
  };
}

function programSnapshot(
  overrides: Partial<{
    producerInstanceId: string;
    mapEpoch: number;
    programSourceGeneration: number;
  }>,
) {
  const snapshot = getProgramFixture('live-neutral');
  if (snapshot === null) throw new Error('fixture missing');
  return {
    ...snapshot,
    cursor: {
      ...snapshot.cursor,
      ...(overrides.producerInstanceId === undefined
        ? {}
        : { producerInstanceId: overrides.producerInstanceId }),
      ...(overrides.mapEpoch === undefined ? {} : { mapEpoch: overrides.mapEpoch }),
      ...(overrides.programSourceGeneration === undefined
        ? {}
        : { programSourceGeneration: overrides.programSourceGeneration }),
    },
  };
}

class FakeWebSocket implements BrowserWebSocketLike {
  readyState = 0;
  protocol = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
  readonly closeCalls: Array<{ readonly code: number; readonly reason: string }> = [];

  open(): void {
    this.readyState = 1;
    this.protocol = 'mizar.local.v1';
    this.onopen?.();
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  close(code = 1000, reason = ''): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  send(): void {}

  serverClose(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: '' });
  }
}

function socketFactory(): {
  readonly factory: WebSocketFactory;
  readonly sockets: FakeWebSocket[];
} {
  const sockets: FakeWebSocket[] = [];
  return {
    sockets,
    factory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
  };
}

function scheduler(): {
  readonly scheduler: {
    setTimeout(callback: () => void, delayMs: number): object;
    clearTimeout(handle: object): void;
  };
  runNext(): void;
} {
  const timers: Array<{ callback: () => void; cleared: boolean }> = [];
  return {
    scheduler: {
      setTimeout(callback) {
        const timer = { callback, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout(handle) {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
    runNext() {
      const timer = timers.find((candidate) => !candidate.cleared);
      if (timer === undefined) throw new Error('no scheduled timer');
      timer.cleared = true;
      timer.callback();
    },
  };
}

describe('ProgramCueClient and renderer seam', () => {
  it('requires baseline, accepts sequence gaps, dedupes ids, and joins only the Program cursor', () => {
    const sockets = socketFactory();
    let currentProgram = programSnapshot({});
    const received: string[] = [];
    const client = createProgramCueClient({
      location: { protocol: 'http:', host: '127.0.0.1:4173' },
      webSocketFactory: sockets.factory,
      getProgramSnapshot: () => currentProgram,
      onCue: (value) => received.push(value.id),
    });
    client.start();
    sockets.sockets[0]!.open();

    sockets.sockets[0]!.message(cue(2));
    expect(client.getSnapshot().state).toBe('awaiting-baseline');
    sockets.sockets[0]!.message(baseline());
    sockets.sockets[0]!.message(cue(3, 3));
    sockets.sockets[0]!.message(cue(5, 3, laneCursor, 'duplicate-cue'));
    sockets.sockets[0]!.message(cue(6, 3, laneCursor, 'duplicate-cue'));

    expect(client.getSnapshot().state).toBe('live');
    expect(received).toEqual(['pc:fixture-producer:9:3', 'duplicate-cue']);

    const mismatchedProgram = programSnapshot({ mapEpoch: 2 });
    currentProgram = mismatchedProgram;
    client.observeProgramSnapshot(mismatchedProgram);
    sockets.sockets[0]!.message(cue(7, 7));
    expect(received).toHaveLength(2);
    client.dispose();
  });

  it('does not compare CSTV generation with the Program GSI generation', () => {
    const sockets = socketFactory();
    const snapshot = {
      ...programSnapshot({}),
      cursor: { ...programSnapshot({}).cursor, programSourceGeneration: 99 },
    };
    const received: string[] = [];
    const client = createProgramCueClient({
      location: { protocol: 'http:', host: '127.0.0.1:4173' },
      webSocketFactory: sockets.factory,
      getProgramSnapshot: () => snapshot,
      onCue: (value) => received.push(value.id),
    });
    client.start();
    sockets.sockets[0]!.open();
    sockets.sockets[0]!.message(baseline());
    sockets.sockets[0]!.message(cue(2));

    expect(received).toEqual(['pc:fixture-producer:9:2']);
    client.dispose();
  });

  it('drops an in-flight old cue across a Program GSI generation reset until a fresh subscription baseline', () => {
    const sockets = socketFactory();
    let currentProgram = programSnapshot({});
    const received: string[] = [];
    const resets: string[] = [];
    const client = createProgramCueClient({
      location: { protocol: 'http:', host: '127.0.0.1:4173' },
      webSocketFactory: sockets.factory,
      getProgramSnapshot: () => currentProgram,
      onCue: (value) => received.push(value.id),
      onReset: (reason) => resets.push(reason),
    });
    client.observeProgramSnapshot(currentProgram);
    client.start();
    sockets.sockets[0]!.open();
    sockets.sockets[0]!.message(baseline());

    const oldInFlightCue = cue(2);
    currentProgram = programSnapshot({ programSourceGeneration: 2 });
    client.observeProgramSnapshot(currentProgram);

    expect(sockets.sockets).toHaveLength(2);
    expect(client.getSnapshot()).toMatchObject({ state: 'connecting', baseline: null });
    expect(resets).toContain('program-snapshot-reset');
    sockets.sockets[0]!.message(oldInFlightCue);
    expect(received).toEqual([]);

    sockets.sockets[1]!.open();
    sockets.sockets[1]!.message(baseline());
    sockets.sockets[1]!.message(cue(3, 3));
    expect(client.getSnapshot().state).toBe('live');
    expect(received).toEqual(['pc:fixture-producer:9:3']);
    client.dispose();
  });

  it('recovers when the cue baseline races ahead of the Program reset snapshot', () => {
    const sockets = socketFactory();
    let currentProgram = programSnapshot({});
    const received: string[] = [];
    const client = createProgramCueClient({
      location: { protocol: 'http:', host: '127.0.0.1:4173' },
      webSocketFactory: sockets.factory,
      getProgramSnapshot: () => currentProgram,
      onCue: (value) => received.push(value.id),
    });
    client.observeProgramSnapshot(currentProgram);
    client.start();
    sockets.sockets[0]!.open();
    sockets.sockets[0]!.message(baseline());

    // The cue socket sees the producer's new reset barrier before the independent
    // Program WebSocket delivers the corresponding GSI-generation reset.
    sockets.sockets[0]!.message(baseline(laneCursor, 2));
    expect(client.getSnapshot().state).toBe('live');

    currentProgram = programSnapshot({ programSourceGeneration: 2 });
    client.observeProgramSnapshot(currentProgram);

    expect(sockets.sockets).toHaveLength(2);
    expect(client.getSnapshot()).toMatchObject({ state: 'connecting', baseline: null });

    // Any late application message from the invalidated socket must be ignored.
    sockets.sockets[0]!.message(cue(3, 3));
    expect(received).toEqual([]);

    // A new subscription is guaranteed to receive the publisher's current baseline.
    sockets.sockets[1]!.open();
    sockets.sockets[1]!.message(baseline(laneCursor, 3));
    sockets.sockets[1]!.message(cue(4, 4));
    expect(client.getSnapshot().state).toBe('live');
    expect(received).toEqual(['pc:fixture-producer:9:4']);
    client.dispose();
  });

  it('resets ephemeral delivery on reconnect and starts the new connection from baseline', () => {
    const sockets = socketFactory();
    const clock = scheduler();
    const resets: string[] = [];
    const client = createProgramCueClient({
      location: { protocol: 'http:', host: '127.0.0.1:4173' },
      webSocketFactory: sockets.factory,
      scheduler: clock.scheduler,
      getProgramSnapshot: () => programSnapshot({}),
      onReset: (reason) => resets.push(reason),
    });
    client.start();
    sockets.sockets[0]!.open();
    sockets.sockets[0]!.message(baseline());
    sockets.sockets[0]!.message(cue(2));
    sockets.sockets[0]!.serverClose();
    expect(resets).toContain('reconnect');
    clock.runNext();
    expect(sockets.sockets).toHaveLength(2);
    sockets.sockets[1]!.open();
    sockets.sockets[1]!.message(baseline({ ...laneCursor, cstvProgramGeneration: 10 }));
    expect(client.getSnapshot().state).toBe('live');
    client.dispose();
  });

  it('keeps visual TTL and reset local to the renderer', () => {
    let now = 0;
    const timers: Array<() => void> = [];
    const store = new ProgramCueEffectStore({
      ttlMs: 500,
      nowMonotonicMs: () => now,
      scheduler: {
        setTimeout(callback) {
          timers.push(callback);
          return callback;
        },
        clearTimeout() {},
      },
    });
    const value = cue(1).cue;
    store.accept(value);
    expect(store.getSnapshot().effects).toHaveLength(1);
    expect(store.getSnapshot().effects[0]?.expiresAtMonotonicMs).toBe(500);
    now = 500;
    timers.shift()?.();
    expect(store.getSnapshot().effects).toHaveLength(0);
    store.accept(value);
    store.reset();
    expect(store.getSnapshot().effects).toEqual([]);
  });
});
