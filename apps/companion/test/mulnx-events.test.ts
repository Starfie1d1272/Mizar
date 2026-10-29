import { expect, it } from 'vitest';
import { parseMulnxEvent } from '../src/orchestration/mulnx-events.js';

const hurt = {
  eventType: 'player_hurt',
  attackerSteamId: '0',
  victimSteamId: '76561198000000001',
  weapon: 'awp',
  dmgHealth: 40,
  health: 60,
  hitgroup: 1,
};

it('normalizes HSI facts without inventing unavailable values', () => {
  expect(parseMulnxEvent(hurt)).toEqual({
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
    eventType: undefined,
    assistSteamId: '0',
    assistedflash: 0,
    headshot: 1,
    penetrated: 2,
    noscope: 0,
    thrusmoke: 0,
    attackerblind: 0,
    attackerinair: 0,
    capturedAtUnixMs: 1700000000000,
    networkGameClientTick: 90,
  });
  const legacyDeath = {
    attackerSteamId: '0',
    victimSteamId: hurt.victimSteamId,
    weapon: 'awp',
    assistSteamId: '0',
    assistedflash: 0,
    headshot: 1,
    penetrated: 2,
    noscope: 0,
    thrusmoke: 0,
    attackerblind: 0,
    attackerinair: 0,
  };
  expect(parseMulnxEvent(legacyDeath)?.facts.kind).toBe('player-death');
  expect(death?.facts).toMatchObject({
    kind: 'player-death',
    headshot: true,
    penetratedObjects: 2,
  });
  expect(death?.facts).not.toHaveProperty('distance');
  expect(death?.networkGameClientTick).toBe(90);
  expect(death?.capturedAtUnixMs).toBe(1700000000000);
  expect(parseMulnxEvent({ ...hurt, victimSteamId: 0 })).toBeNull();
  expect(parseMulnxEvent({ ...hurt, eventType: 'CamPack/Status' })).toBeNull();
});
