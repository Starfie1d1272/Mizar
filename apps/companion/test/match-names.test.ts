import { afterEach, expect, it, vi } from 'vitest';
import type { MatchContextBinding } from '../src/match-context/lkg-store.js';
import { matchNames, MatchNameSync, nameWire } from '../src/telemetry/match-names.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('selects unique website Steam64 names within the native byte limit', () => {
  const binding = {
    origin: 'online',
    context: {
      entrants: {
        a: {
          players: [
            { steam64: '76561198000000001', displayName: '中文 "名"\\字' },
            { steam64: '76561198000000002', displayName: 'a'.repeat(128) },
            { steam64: '76561198000000003', displayName: 'a\0b' },
            { steam64: '76561198000000004', displayName: 'one' },
          ],
        },
        b: { players: [{ steam64: '76561198000000004', displayName: 'two' }] },
      },
    },
  } as unknown as MatchContextBinding;
  expect([...matchNames(binding)]).toEqual([['76561198000000001', '中文 "名"\\字']]);
  expect(JSON.parse(nameWire('76561198000000001', '中文 "名"\\字'))).toEqual({
    type: 'Name/Player/Set',
    payload: '"中文 \\"名\\"\\\\字" 76561198000000001',
  });
  expect(matchNames({ ...binding, origin: 'local', localAuthoringMode: 'standalone' }).size).toBe(
    0,
  );
});
it('replays after reconnect and clears only sent IDs on roster changes and finish', async () => {
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const sent: { type: string; payload: string }[] = [];
  const sockets: Socket[] = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    send(wire: string) {
      sent.push(JSON.parse(wire) as { type: string; payload: string });
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent('message', { data: '已投入消息总线' + wire })),
      );
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  vi.stubGlobal('WebSocket', Socket);
  let entries = new Map([
    ['76561198000000001', 'First'],
    ['76561198000000002', 'Second'],
  ]);
  const sync = new MatchNameSync(() => ({ session: 'game', names: entries }));
  await sync.tick();
  sockets[0]!.close();
  now += 3001;
  await sync.tick();
  expect(sent.map((x) => x.payload)).toEqual([
    '"First" 76561198000000001',
    '"Second" 76561198000000002',
    '"First" 76561198000000001',
    '"Second" 76561198000000002',
  ]);
  entries = new Map([['76561198000000002', 'Changed']]);
  await sync.tick();
  entries = new Map();
  await sync.tick();
  await sync.close();
  expect(sent.slice(4).map((x) => x.payload)).toEqual([
    '"" 76561198000000001',
    '"Changed" 76561198000000002',
    '"" 76561198000000002',
  ]);
});

it('does not claim an unsent UID when the socket closes between requests', async () => {
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const sent: string[] = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    constructor() {
      super();
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    send(wire: string) {
      sent.push((JSON.parse(wire) as { payload: string }).payload);
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent('message', { data: '已投入消息总线' + wire }));
        if (sent.length === 1) this.close();
      });
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  vi.stubGlobal('WebSocket', Socket);
  let entries = new Map([
    ['76561198000000001', 'First'],
    ['76561198000000002', 'Second'],
  ]);
  const sync = new MatchNameSync(() => ({ session: 'game', names: entries }));
  await sync.tick();
  entries = new Map();
  now = 3001;
  await sync.tick();
  await sync.close();
  expect(sent).toEqual(['"First" 76561198000000001', '"" 76561198000000001']);
});

it('stops an obsolete batch when the roster changes while awaiting acknowledgement', async () => {
  const sent: string[] = [];
  let entries = new Map([
    ['76561198000000001', 'First'],
    ['76561198000000002', 'Second'],
  ]);
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    constructor() {
      super();
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    send(wire: string) {
      sent.push((JSON.parse(wire) as { payload: string }).payload);
      queueMicrotask(() => {
        if (sent.length === 1) entries = new Map([['76561198000000003', 'New']]);
        this.dispatchEvent(new MessageEvent('message', { data: '已投入消息总线' + wire }));
      });
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  vi.stubGlobal('WebSocket', Socket);
  const sync = new MatchNameSync(() => ({ session: 'game', names: entries }));
  await sync.tick();
  expect(sent).toEqual(['"First" 76561198000000001']);
  await sync.tick();
  expect(sent).toEqual([
    '"First" 76561198000000001',
    '"" 76561198000000001',
    '"New" 76561198000000003',
  ]);
  await sync.close();
});
