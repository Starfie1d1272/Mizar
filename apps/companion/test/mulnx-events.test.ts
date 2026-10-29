import { expect, it } from 'vitest';
import { MulnxEventSequence, parseMulnxEvent } from '../src/orchestration/mulnx-events.js';

const hurt = {
  eventType: 'player_hurt',
  sequence: 1,
  capturedAtUnixMs: 1700000000000,
  attackerSteamId: '0',
  victimSteamId: '76561198000000001',
  weapon: 'awp',
  dmgHealth: 40,
  health: 60,
  hitgroup: 1,
};

it('normalizes HSI facts without inventing unavailable values', () => {
  expect(parseMulnxEvent(hurt)).toEqual({
    sequence: 1,
    capturedAtUnixMs: 1700000000000,
    facts: {
      kind: 'player-hurt',
      victim: { sourcePlayerId: hurt.victimSteamId },
      weapon: 'awp',
      damageHealth: 40,
      healthRemaining: 60,
      hitgroup: 1,
    },
  });
  const death = parseMulnxEvent({
    ...hurt,
    eventType: 'player_death',
    assistSteamId: '0',
    assistedflash: 0,
    headshot: 1,
    penetrated: 2,
    noscope: 0,
    thrusmoke: 0,
    attackerblind: 0,
    attackerinair: 0,
    eventTime: { timeDomain: 'demo_playback_tick', tick: 42 },
    clientTime: { timeDomain: 'network_game_client_tick', tick: 90 },
  });
  expect(death?.facts).toMatchObject({
    kind: 'player-death',
    headshot: true,
    penetratedObjects: 2,
  });
  expect(death?.facts).not.toHaveProperty('distance');
  expect(death?.eventTime).toEqual({ timeDomain: 'demo_playback_tick', tick: 42 });
  expect(death?.clientTime).toEqual({ timeDomain: 'network_game_client_tick', tick: 90 });
  expect(parseMulnxEvent({ ...hurt, victimSteamId: 0 })).toBeNull();
  expect(parseMulnxEvent({ ...hurt, eventType: 'CamPack/Status' })).toBeNull();
});

it('rejects duplicates and old sequences within a socket', () => {
  const sequence = new MulnxEventSequence();
  expect(sequence.accept(hurt)).not.toBeNull();
  expect(sequence.accept(hurt)).toBeNull();
  expect(sequence.accept({ ...hurt, sequence: 3 })).not.toBeNull();
  expect(sequence.accept({ ...hurt, sequence: 2 })).toBeNull();
  expect(new MulnxEventSequence().accept(hurt)).not.toBeNull();
});
