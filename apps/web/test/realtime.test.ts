import { describe, expect, it } from 'vitest';

import type { ProgramSnapshot } from '@mizar/protocol/program';
import { programSnapshotSchema } from '@mizar/protocol/program';
import type { RadarSnapshot } from '@mizar/protocol/radar';
import { radarSnapshotSchema } from '@mizar/protocol/radar';
import { PROGRAM_SCHEMA_VERSION, RADAR_SCHEMA_VERSION } from '@mizar/protocol/version';
import {
  createLocalChannelClient,
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
  });
});
