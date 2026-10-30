import { describe, expect, it } from 'vitest';
import type { ProgramPayload } from '@mizar/protocol/program';
import { buildPlayerRailsPresentation } from '../src/widgets/player-rails/presentation.js';
import { buildFocusedPlayerPresentation } from '../src/widgets/focused-player/presentation.js';
import { buildObjectiveCenterPresentation } from '../src/widgets/match-header/objective-presentation.js';

function fixture(): ProgramPayload {
  const statistics = {
    scoreboard: { kills: { value: 7 }, assists: { value: 2 }, deaths: { value: 3 } },
    completed: { adr: { value: null } },
    includingCurrentRound: { adr: { value: null } },
    currentRound: { damage: { value: null }, moneySpent: { value: null } },
  };
  return {
    status: { telemetry: 'fresh' },
    teams: { ct: { mode: 'neutral', name: 'CT' }, t: { mode: 'neutral', name: 'T' } },
    teamEconomy: {
      ct: {
        lineupComplete: true,
        alive: 3,
        money: 1234,
        equipmentValue: 5678,
        lossBonus: 2400,
        utility: { smoke: 2, fire: 1, flash: 3, he: 0 },
      },
      t: {
        lineupComplete: true,
        alive: 5,
        money: null,
        equipmentValue: null,
        lossBonus: null,
        utility: null,
      },
    },
    map: { roundNumber: 4, consecutiveRoundLosses: { ct: 0, t: 0 } },
    round: { phase: 'live' },
    clock: { phase: 'live' },
    series: null,
    observedPlayerSourceId: 'p',
    bomb: null,
    players: [
      {
        sourcePlayerId: 'p',
        lineupEvidence: 'current',
        lifeState: 'alive',
        side: 'CT',
        observerSlot: 1,
        state: { health: 100, armor: 0, hasHelmet: false, hasDefuser: false, money: 1 },
        matchStats: { kills: 99, assists: 99, deaths: 99 },
        statistics,
        equipment: {
          available: true,
          primary: 'rifle',
          secondary: 'pistol',
          heldWeaponId: 'rifle',
          utility: { smoke: 0, fire: 0, flash: 2, he: 0 },
          hasC4: true,
        },
        weaponsAvailable: true,
        weapons: [
          {
            sourceWeaponId: 'rifle',
            name: 'weapon_ak47',
            state: 'holstered',
            ammoClip: 20,
            ammoClipMax: 30,
            ammoReserve: 60,
          },
          {
            sourceWeaponId: 'pistol',
            name: 'weapon_glock',
            state: 'active',
            ammoClip: 20,
            ammoClipMax: 20,
            ammoReserve: 120,
          },
        ],
      },
    ],
  } as unknown as ProgramPayload;
}

describe('Program facts in HUD presentation', () => {
  it('selects projected economy, equipment, and statistics rather than reconstructing them', () => {
    const payload = fixture();
    const rails = buildPlayerRailsPresentation(payload);
    expect(rails.ct.summary).toMatchObject({
      money: 1234,
      equip: 5678,
      lossBonus: 2400,
      utility: { flash: 3 },
    });
    expect(rails.t.summary).toMatchObject({
      money: null,
      equip: null,
      lossBonus: null,
      utility: null,
    });
    expect(rails.ct.players[0]).toMatchObject({
      stats: { kills: 7, assists: 2, deaths: 3 },
      hasC4: true,
      primaryWeapon: { sourceWeaponId: 'rifle', active: true },
      secondaryWeapon: { sourceWeaponId: 'pistol' },
      utility: [{ family: 'flash', count: 2 }],
    });
    expect(buildFocusedPlayerPresentation(payload)).toMatchObject({
      stats: { kills: 7 },
      c4: { canonicalKey: 'objective.c4' },
      activeItem: { sourceWeaponId: 'rifle' },
    });
  });

  it('uses projected alive counts and hides unknown counts', () => {
    const payload = fixture();
    const a = { side: 'CT' } as Parameters<typeof buildObjectiveCenterPresentation>[1];
    const b = { side: 'T' } as Parameters<typeof buildObjectiveCenterPresentation>[2];
    expect(buildObjectiveCenterPresentation(payload, a, b).aliveSample).toBe('3v5');
    payload.teamEconomy.ct.alive = null;
    expect(buildObjectiveCenterPresentation(payload, a, b).aliveSample).toBeNull();
  });
});
