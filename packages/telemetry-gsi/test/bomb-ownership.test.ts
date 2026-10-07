import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptGsiPayload } from '../src/index.js';

interface Frame {
  bomb: { state: string; player?: string; position: string };
  allplayers: Record<
    string,
    {
      team: string;
      state: { health?: number };
      position: string;
      weapons: Record<string, { name: string; state: string }>;
    }
  >;
}
const owner = '76561198000000001';
const receive = { sequence: 1, receivedAt: '2026-10-07T15:00:00Z', receivedMonotonicMs: 0 };
// Minimal excerpt of RC25 capture frame 206; identity replaced consistently.
function fixture(): Frame {
  return JSON.parse(
    readFileSync(new URL('./fixtures/rc25-holstered-c4.json', import.meta.url), 'utf8'),
  ) as Frame;
}
function bomb(frame: unknown) {
  const result = adaptGsiPayload(frame, receive);
  if (!result.ok) throw new Error('Adaptation failed');
  return result.observation.telemetry.bomb;
}

describe('current-frame C4 inventory ownership', () => {
  it.each(['holstered', 'active'])(
    'reconciles recorded dropped C4 with explicit %s ownership',
    (state) => {
      const frame = fixture();
      frame.allplayers[owner]!.weapons.weapon_2!.state = state;
      expect(bomb(frame)).toMatchObject({ state: 'carried', sourcePlayerId: owner });
      expect(frame.bomb.state).toBe('dropped');
    },
  );

  it.each([0, undefined])('keeps dropped when owner health is %s', (health) => {
    const frame = fixture();
    if (health === undefined) delete frame.allplayers[owner]!.state.health;
    else frame.allplayers[owner]!.state.health = health;
    expect(bomb(frame)?.state).toBe('dropped');
  });

  it('requires matching root bomb ownership and never infers it from proximity', () => {
    const frame = fixture();
    delete frame.bomb.player;
    expect(bomb(frame)?.state).toBe('dropped');
    frame.bomb.player = 'another-player';
    expect(bomb(frame)?.state).toBe('dropped');
  });

  it('requires a unique carrier and complete parsed blocks', () => {
    const frame = fixture();
    frame.allplayers['another-player'] = structuredClone(frame.allplayers[owner]!);
    expect(bomb(frame)?.state).toBe('dropped');
    delete frame.allplayers['another-player'];
    frame.bomb.position = 'invalid';
    expect(bomb(frame)?.state).toBe('dropped');
    const other = fixture();
    other.allplayers[owner]!.weapons.weapon_2!.state = 'unsupported-state';
    expect(bomb(other)?.state).toBe('dropped');
  });

  it('does not carry ownership forward after inventory disappears', () => {
    const frame = fixture();
    expect(bomb(frame)?.state).toBe('carried');
    frame.allplayers[owner]!.weapons = {};
    expect(bomb(frame)?.state).toBe('dropped');
    expect(bomb({ bomb: frame.bomb })?.state).toBe('dropped');
  });

  it.each(['carried', 'planting', 'planted', 'defusing', 'exploded', 'defused', 'unknown'])(
    'does not override explicit %s state',
    (state) => {
      const frame = fixture();
      frame.bomb.state = state;
      expect(bomb(frame)?.state).toBe(state);
    },
  );
});
