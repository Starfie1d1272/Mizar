import { describe, expect, it } from 'vitest';
import {
  normalizeObserverGameEvent,
  type ObserverSourceIdentity,
} from '../src/normalize/observer.js';
import type { GameEventNormalizationContext } from '../src/normalize/events.js';

const owner: ObserverSourceIdentity = {
  source: 'ahead:fixture',
  role: 'ahead',
  channel: 1,
  world: 2,
};
const context: GameEventNormalizationContext = {
  cursor: {
    kind: 'cs2-cstv',
    role: 'lookahead',
    generation: 3,
    sequence: 0,
    tick: 100,
    observedAt: '2026-10-20T08:00:00Z',
    observedMonotonicMs: 10,
  },
};
function fixture() {
  return {
    type: 'raw-event',
    source: owner.source,
    channel: 1,
    world: 2,
    sequence: 7,
    name: 'weapon_fire',
    tick: 100,
    committedTick: 99,
    fields: { userid: 0, weapon: 'ak47', silenced: false },
    players: {
      userid: {
        domain: 'player-controller-slot',
        slot: 0,
        userId: 42,
        steamId: '76561198000000123',
        controller: { index: 1, serial: 100000 },
      },
    },
  };
}
describe('ordinary observer event adaptation', () => {
  it('uses resolved userinfo userid, never controller slot zero', () => {
    const event = normalizeObserverGameEvent(fixture(), owner, context);
    expect(event.kind).toBe('weapon-fire');
    if (event.kind !== 'weapon-fire') throw new Error('Wrong event');
    expect(event.player).toEqual({ sourceUserId: 42, sourcePlayerId: '76561198000000123' });
    expect(event.cursor.role).toBe('lookahead');
  });
  it.each(['source', 'channel', 'world', 'tick'] as const)(
    'rejects a stale or other-source %s',
    (key) => {
      const row = { ...fixture(), [key]: key === 'source' ? 'ahead:other' : -1 };
      expect(() => normalizeObserverGameEvent(row, owner, context)).toThrow();
    },
  );
  it('never admits ahead evidence into program', () => {
    expect(() =>
      normalizeObserverGameEvent(fixture(), owner, {
        cursor: { ...context.cursor, role: 'program' },
      }),
    ).toThrow();
  });
  it('does not invent userid when only slot and Steam64 are available', () => {
    const row = fixture();
    row.players.userid.userId = 0;
    expect(() => normalizeObserverGameEvent(row, owner, context)).toThrow();
  });
  it('rejects mismatched controller ownership', () => {
    const row = fixture();
    row.players.userid.controller.index = 2;
    expect(() => normalizeObserverGameEvent(row, owner, context)).toThrow();
  });
  it('rejects events before an accepted full snapshot', () => {
    const row = fixture();
    row.committedTick = -1;
    expect(() => normalizeObserverGameEvent(row, owner, context)).toThrow();
  });
  it('copies scalar identity without retaining mutable input objects', () => {
    const row = fixture();
    const event = normalizeObserverGameEvent(row, owner, context);
    row.players.userid.userId = 500;
    row.fields.weapon = 'knife';
    expect(event.kind).toBe('weapon-fire');
    if (event.kind !== 'weapon-fire') throw new Error('Wrong event');
    expect(event.player.sourceUserId).toBe(42);
    expect(event.weapon).toBe('ak47');
  });
});
