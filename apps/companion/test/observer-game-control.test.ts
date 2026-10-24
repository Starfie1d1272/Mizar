import { afterEach, expect, it, vi } from 'vitest';
import {
  observerConnectCommand,
  observerHudQuery,
  sendObserverGameCommand,
} from '../src/telemetry/observer-game-control.js';
afterEach(() => vi.unstubAllGlobals());
it('uses the existing quoted command queue and waits for its exact acknowledgement', async () => {
  const sent: string[] = [];
  class Socket extends EventTarget {
    constructor(url: string) {
      super();
      expect(url).toBe('ws://127.0.0.1:55202');
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(wire: string) {
      sent.push(wire);
      this.dispatchEvent(new MessageEvent('message', { data: 'unrelated status' }));
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent('message', { data: '已投入消息总线' + wire })),
      );
    }
    close() {}
  }
  vi.stubGlobal('WebSocket', Socket);
  const command = observerConnectCommand(
    {
      earlyEndpoint: '127.0.0.1:27025',
      programEndpoint: '127.0.0.1:27026',
      password: 'synthetic-only',
    },
    true,
  );
  await sendObserverGameCommand(command);
  expect(sent).toHaveLength(1);
  const envelope = JSON.parse(sent[0]!) as { type: string; payload: string };
  expect(envelope.type).toBe('Game/Command/NoReport');
  expect(JSON.parse(envelope.payload)).toBe(
    'password "synthetic-only";connect 127.0.0.1:27026;cl_draw_only_deathnotices 1',
  );
  expect(observerHudQuery('MIZAR_HUD_' + 'a'.repeat(32), 0)).toBe(
    'echo MIZAR_HUD_' + 'a'.repeat(32) + ';cl_draw_only_deathnotices 0;cl_draw_only_deathnotices',
  );
  expect(() => observerHudQuery('marker;quit')).toThrow();
});
it('returns a bounded transport cause after a send failure', async () => {
  class Socket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send() {
      throw new Error('synthetic-secret');
    }
    close() {}
  }
  vi.stubGlobal('WebSocket', Socket);
  await expect(sendObserverGameCommand('fixed')).rejects.toThrow(
    'observer_game_control_unavailable',
  );
});
