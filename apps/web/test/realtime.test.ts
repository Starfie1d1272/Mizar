import { describe, expect, it } from 'vitest';

import type { ProgramSnapshot } from '@mizar/protocol/program';
import { programSnapshotSchema } from '@mizar/protocol/program';
import type { RadarSnapshot } from '@mizar/protocol/radar';
import { radarSnapshotSchema } from '@mizar/protocol/radar';
import { PROGRAM_SCHEMA_VERSION, RADAR_SCHEMA_VERSION } from '@mizar/protocol/version';
import {
  createLocalChannelClient,
  localWebSocketUrl,
  RECONNECT_BACKOFF_MS,
  type BrowserWebSocketLike,
  type WebSocketFactory,
} from '../src/realtime';

const cursor = {
  producerInstanceId: 'web-realtime-producer',
  liveSessionId: 'live-session-1',
  runtimeSeq: 1,
  programSourceGeneration: 0,
  programReceiveSequence: 1,
  mapEpoch: 0,
};

function snapshot(
  channelSeq: number,
  cursorOverrides: Partial<typeof cursor> = {},
): ProgramSnapshot {
  return programSnapshotSchema.parse({
    type: 'snapshot',
    protocolVersion: 1,
    channel: 'program',
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    channelSeq,
    cursor: { ...cursor, ...cursorOverrides },
    payload: {
      bombDamage: { status: 'unavailable', reason: 'inactive', model: null, players: [] },
      status: { telemetry: 'fresh', context: 'unbound', identity: 'unbound' },
      match: null,
      teams: {
        ct: { mode: 'neutral', entryId: null, name: 'CT', logoUrl: null, seriesScore: null },
        t: { mode: 'neutral', entryId: null, name: 'T', logoUrl: null, seriesScore: null },
      },
      series: null,
      map: {
        name: 'de_mirage',
        mode: null,
        phase: 'live',
        roundNumber: 1,
        score: { ct: 0, t: 0 },
        timeoutsRemaining: { ct: null, t: null },
        consecutiveRoundLosses: { ct: null, t: null },
      },
      round: null,
      clock: null,
      observedPlayerSourceId: null,
      players: [],
      bomb: null,
      coverage: {
        map: 'present',
        round: 'absent',
        phaseCountdowns: 'absent',
        player: 'absent',
        allPlayers: 'absent',
        bomb: 'absent',
      },
    },
  });
}

class FakeWebSocket implements BrowserWebSocketLike {
  readyState = 0;
  protocol = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
  readonly closeCalls: Array<{ readonly code: number; readonly reason: string }> = [];
  sent: string[] = [];

  open(protocol = 'mizar.local.v1'): void {
    this.readyState = 1;
    this.protocol = protocol;
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code: code ?? 1000, reason: reason ?? '' });
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function socketFactory(): {
  readonly factory: WebSocketFactory;
  readonly sockets: FakeWebSocket[];
  readonly urls: string[];
  readonly protocols: string[];
} {
  const sockets: FakeWebSocket[] = [];
  const urls: string[] = [];
  const protocols: string[] = [];
  return {
    sockets,
    urls,
    protocols,
    factory: (url, protocol) => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      urls.push(url);
      protocols.push(protocol);
      return socket;
    },
  };
}

function scheduler(): {
  readonly scheduler: {
    setTimeout(callback: () => void, delayMs: number): object;
    clearTimeout(handle: object): void;
  };
  readonly delays: number[];
  runNext(): void;
} {
  const timers: Array<{
    readonly callback: () => void;
    readonly delayMs: number;
    cleared: boolean;
  }> = [];
  const delays: number[] = [];
  return {
    delays,
    scheduler: {
      setTimeout(callback, delayMs) {
        delays.push(delayMs);
        const timer = { callback, delayMs, cleared: false };
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

describe('local realtime browser client', () => {
  it('derives same-origin ws URLs and selects the frozen subprotocol', () => {
    expect(
      localWebSocketUrl('/local/v1/program', { protocol: 'http:', host: '127.0.0.1:4173' }),
    ).toBe('ws://127.0.0.1:4173/local/v1/program');
    expect(
      localWebSocketUrl('/local/v1/program', { protocol: 'https:', host: 'broadcast.test' }),
    ).toBe('wss://broadcast.test/local/v1/program');
  });

  it('requires a valid baseline, ignores duplicates, and exposes reset signals', () => {
    const sockets = socketFactory();
    const client = createLocalChannelClient('program', {
      location: { protocol: 'http:', host: '127.0.0.1:4173' },
      webSocketFactory: sockets.factory,
    });

    client.start();
    expect(client.getSnapshot().state).toBe('connecting');
    expect(sockets.sockets).toHaveLength(1);
    expect(sockets.urls[0]).toBe('ws://127.0.0.1:4173/local/v1/program');
    expect(sockets.protocols[0]).toBe('mizar.local.v1');

    sockets.sockets[0]!.open();
    expect(client.getSnapshot().state).toBe('awaiting-baseline');
    sockets.sockets[0]!.message(JSON.stringify(snapshot(1)));
    expect(client.getSnapshot()).toMatchObject({
      state: 'live',
      current: { channelSeq: 1, schemaVersion: PROGRAM_SCHEMA_VERSION },
    });
    const firstSnapshot = client.getSnapshot();
    sockets.sockets[0]!.message(JSON.stringify(snapshot(1)));
    expect(client.getSnapshot()).toBe(firstSnapshot);

    sockets.sockets[0]!.message(JSON.stringify(snapshot(2, { runtimeSeq: 2, mapEpoch: 1 })));
    expect(client.getSnapshot()).toMatchObject({
      state: 'live',
      current: { channelSeq: 2 },
      reset: { mapEpochChanged: true },
    });
    client.dispose();
  });

  it('uses bounded reconnect backoff and resets only after a new valid baseline', () => {
    const sockets = socketFactory();
    const clock = scheduler();
    const client = createLocalChannelClient('program', {
      location: { protocol: 'http:', host: '127.0.0.1:4173' },
      webSocketFactory: sockets.factory,
      scheduler: clock.scheduler,
    });

    client.start();
    sockets.sockets[0]!.open();
    sockets.sockets[0]!.serverClose();
    expect(clock.delays).toEqual([RECONNECT_BACKOFF_MS[0]]);
    clock.runNext();

    sockets.sockets[1]!.open();
    sockets.sockets[1]!.serverClose();
    expect(clock.delays).toEqual([250, 500]);
    clock.runNext();
    sockets.sockets[2]!.open();
    sockets.sockets[2]!.message(JSON.stringify(snapshot(1)));
    sockets.sockets[2]!.serverClose();
    expect(clock.delays).toEqual([250, 500, 250]);
    client.dispose();
  });

  it('treats schema errors as terminal and producer/runtime regressions as reconnectable', () => {
    const sockets = socketFactory();
    const clock = scheduler();
    const client = createLocalChannelClient('program', {
      location: { protocol: 'http:', host: '127.0.0.1:4173' },
      webSocketFactory: sockets.factory,
      scheduler: clock.scheduler,
    });

    client.start();
    sockets.sockets[0]!.open();
    sockets.sockets[0]!.message(JSON.stringify(snapshot(1)));
    sockets.sockets[0]!.message(
      JSON.stringify(snapshot(2, { producerInstanceId: 'different-producer', runtimeSeq: 2 })),
    );
    expect(client.getSnapshot().state).toBe('reconnecting');
    expect(clock.delays).toEqual([250]);
    clock.runNext();
    sockets.sockets[1]!.open();
    sockets.sockets[1]!.message(JSON.stringify(snapshot(1)));
    sockets.sockets[1]!.message(JSON.stringify(snapshot(2, { runtimeSeq: 0 })));
    expect(client.getSnapshot().state).toBe('reconnecting');
    expect(clock.delays).toEqual([250, 250]);
    clock.runNext();
    sockets.sockets[2]!.open();
    sockets.sockets[2]!.message('{not-json');
    expect(client.getSnapshot().state).toBe('protocol-error');
    expect(clock.delays).toEqual([250, 250]);
    expect(sockets.sockets[2]!.closeCalls[0]).toMatchObject({ code: 1002 });
    client.start();
    expect(sockets.sockets).toHaveLength(3);
    client.dispose();
  });

  it('ignores callbacks from stale connections and cancels reconnect on dispose', () => {
    const sockets = socketFactory();
    const clock = scheduler();
    const client = createLocalChannelClient('program', {
      location: { protocol: 'http:', host: '127.0.0.1:4173' },
      webSocketFactory: sockets.factory,
      scheduler: clock.scheduler,
    });

    client.start();
    const staleSocket = sockets.sockets[0]!;
    staleSocket.serverClose();
    clock.runNext();
    const currentSocket = sockets.sockets[1]!;
    currentSocket.open();
    staleSocket.open();
    staleSocket.message(JSON.stringify(snapshot(99)));
    expect(client.getSnapshot().state).toBe('awaiting-baseline');
    expect(client.getSnapshot().current).toBeNull();

    client.dispose();
    expect(client.getSnapshot().state).toBe('closed');
    expect(() => clock.runNext()).toThrow('no scheduled timer');

    const recreated = createLocalChannelClient('program', {
      location: { protocol: 'http:', host: '127.0.0.1:4173' },
      webSocketFactory: sockets.factory,
      scheduler: clock.scheduler,
    });
    recreated.start();
    sockets.sockets[2]!.open();
    sockets.sockets[2]!.message(JSON.stringify(snapshot(1)));
    expect(recreated.getSnapshot()).toMatchObject({ state: 'live', current: { channelSeq: 1 } });
    recreated.dispose();
  });

  describe('dual-channel Program and Radar independent orchestration', () => {
    function radarSnapshot(
      channelSeq: number,
      cursorOverrides: Partial<typeof cursor> = {},
    ): RadarSnapshot {
      return radarSnapshotSchema.parse({
        type: 'snapshot',
        protocolVersion: 1,
        channel: 'radar',
        schemaVersion: RADAR_SCHEMA_VERSION,
        channelSeq,
        cursor: { ...cursor, ...cursorOverrides },
        payload: {
          telemetryFreshness: 'fresh',
          identityState: 'matched',
          mapName: 'de_mirage',
          observedPlayerSourceId: '76561198000000001',
          coverage: {
            allPlayers: 'present',
            bomb: 'present',
            grenades: 'present',
          },
          players: [
            {
              sourcePlayerId: '76561198000000001',
              canonicalPlayerId: 'player-1',
              displayName: 'Player One',
              side: 'CT',
              observerSlot: 1,
              lifeState: 'alive',
              position: { x: 100, y: 200, z: 0 },
              forward: { x: 1, y: 0, z: 0 },
              health: 100,
              flashAmount: 0,
              activeWeapon: { name: 'weapon_m4a1_silencer', ammoClip: 20, state: 'active' },
            },
          ],
          bomb: {
            state: 'carried',
            position: null,
            sourcePlayerId: '76561198000000002',
          },
          grenades: [],
        },
      });
    }

    it('subscribes Program and Radar channels simultaneously with independent baselines', () => {
      const sockets = socketFactory();
      const clock = scheduler();

      const programClient = createLocalChannelClient('program', {
        location: { protocol: 'http:', host: '127.0.0.1:4173' },
        webSocketFactory: sockets.factory,
        scheduler: clock.scheduler,
      });
      const radarClient = createLocalChannelClient('radar', {
        location: { protocol: 'http:', host: '127.0.0.1:4173' },
        webSocketFactory: sockets.factory,
        scheduler: clock.scheduler,
      });

      programClient.start();
      radarClient.start();

      expect(sockets.urls).toEqual([
        'ws://127.0.0.1:4173/local/v1/program',
        'ws://127.0.0.1:4173/local/v1/radar',
      ]);

      const [programSocket, radarSocket] = sockets.sockets;
      programSocket!.open();
      radarSocket!.open();

      const programSnap = snapshot(1);
      const radarSnap = radarSnapshot(1);

      programSocket!.message(JSON.stringify(programSnap));
      radarSocket!.message(JSON.stringify(radarSnap));

      expect(programClient.getSnapshot()).toMatchObject({
        state: 'live',
        current: { channel: 'program', channelSeq: 1 },
      });
      expect(radarClient.getSnapshot()).toMatchObject({
        state: 'live',
        current: { channel: 'radar', channelSeq: 1 },
      });

      programClient.dispose();
      radarClient.dispose();
    });

    it('does not disrupt Program client when Radar channel reconnects', () => {
      const sockets = socketFactory();
      const clock = scheduler();

      const programClient = createLocalChannelClient('program', {
        location: { protocol: 'http:', host: '127.0.0.1:4173' },
        webSocketFactory: sockets.factory,
        scheduler: clock.scheduler,
      });
      const radarClient = createLocalChannelClient('radar', {
        location: { protocol: 'http:', host: '127.0.0.1:4173' },
        webSocketFactory: sockets.factory,
        scheduler: clock.scheduler,
      });

      programClient.start();
      radarClient.start();

      const [programSocket, radarSocket] = sockets.sockets;
      programSocket!.open();
      radarSocket!.open();

      programSocket!.message(JSON.stringify(snapshot(1)));
      radarSocket!.message(JSON.stringify(radarSnapshot(1)));

      expect(programClient.getSnapshot().state).toBe('live');
      expect(radarClient.getSnapshot().state).toBe('live');

      // Radar connection drops
      radarSocket!.serverClose(1006, 'abnormal closure');
      expect(radarClient.getSnapshot().state).toBe('reconnecting');

      // Program client remains unaffected and continues to accept live messages
      expect(programClient.getSnapshot().state).toBe('live');
      expect(programClient.getSnapshot().current?.channelSeq).toBe(1);

      programSocket!.message(JSON.stringify(snapshot(2)));
      expect(programClient.getSnapshot().current?.channelSeq).toBe(2);

      // Radar reconnects with fresh baseline
      clock.runNext();
      const nextRadarSocket = sockets.sockets[2]!;
      nextRadarSocket.open();
      nextRadarSocket.message(JSON.stringify(radarSnapshot(2)));

      expect(radarClient.getSnapshot()).toMatchObject({
        state: 'live',
        current: { channel: 'radar', channelSeq: 2 },
      });
      expect(programClient.getSnapshot().state).toBe('live');

      programClient.dispose();
      radarClient.dispose();
    });

    it('does not allow Program reconnect to spoof or mutate Radar generation', () => {
      const sockets = socketFactory();
      const clock = scheduler();

      const programClient = createLocalChannelClient('program', {
        location: { protocol: 'http:', host: '127.0.0.1:4173' },
        webSocketFactory: sockets.factory,
        scheduler: clock.scheduler,
      });
      const radarClient = createLocalChannelClient('radar', {
        location: { protocol: 'http:', host: '127.0.0.1:4173' },
        webSocketFactory: sockets.factory,
        scheduler: clock.scheduler,
      });

      programClient.start();
      radarClient.start();

      const [programSocket, radarSocket] = sockets.sockets;
      programSocket!.open();
      radarSocket!.open();

      programSocket!.message(JSON.stringify(snapshot(1, { programSourceGeneration: 1 })));
      radarSocket!.message(JSON.stringify(radarSnapshot(1, { programSourceGeneration: 1 })));

      // Program server triggers reset with new generation
      programSocket!.serverClose(1006, 'program disconnect');
      expect(programClient.getSnapshot().state).toBe('reconnecting');

      // Radar remains on its existing generation and baseline
      expect(radarClient.getSnapshot().state).toBe('live');
      expect(radarClient.getSnapshot().current?.cursor.programSourceGeneration).toBe(1);

      // Program reconnects under generation 2
      clock.runNext();
      const nextProgramSocket = sockets.sockets[2]!;
      nextProgramSocket.open();
      nextProgramSocket.message(JSON.stringify(snapshot(1, { programSourceGeneration: 2 })));

      expect(programClient.getSnapshot().current?.cursor.programSourceGeneration).toBe(2);
      // Radar state is NOT mutated or spoofed by Program reconnect
      expect(radarClient.getSnapshot().current?.cursor.programSourceGeneration).toBe(1);

      programClient.dispose();
      radarClient.dispose();
    });
  });
});
