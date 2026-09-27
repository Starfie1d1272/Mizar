import { describe, expect, it } from 'vitest';
import { inspectBp } from '@mizar/core/projection';
import {
  getBpDemoManifest,
  toMatchContext,
  validateBroadcastManifest,
  type BpDemoFormat,
} from '../src/index.js';

describe('checked-in BP Demo Manifests', () => {
  it.each(['bo1', 'bo3', 'bo5'] as const)(
    'validates and projects the %s manifest through the canonical context path',
    (format: BpDemoFormat) => {
      const manifest = getBpDemoManifest(format);
      const validated = validateBroadcastManifest(manifest);
      expect(validated.ok).toBe(true);
      if (!validated.ok) throw new Error(`BP Demo Manifest ${format} should validate`);

      const context = toMatchContext(validated.value);
      const inspected = inspectBp(context);
      expect(inspected.readiness).toBe('ready');
      expect(inspected.projection).not.toBeNull();
      expect(inspected.projection?.format).toBe(format);
      expect(inspected.projection?.cards).toHaveLength(7);
      expect(inspected.projection?.cards.filter((card) => card.kind === 'ban')).toHaveLength(
        format === 'bo1' ? 6 : format === 'bo3' ? 4 : 2,
      );
      expect(inspected.projection?.cards.filter((card) => card.kind === 'pick')).toHaveLength(
        format === 'bo1' ? 0 : format === 'bo3' ? 2 : 4,
      );
      expect(inspected.projection?.cards.filter((card) => card.kind === 'decider')).toHaveLength(1);
      expect(
        inspected.projection?.steps.filter((step) => step.kind === 'side-choice'),
      ).toHaveLength(format === 'bo1' ? 1 : format === 'bo3' ? 3 : 4);
    },
  );

  it('keeps BO1 history as a legacy decider and normalizes Plasma T to its side reveal', () => {
    const manifest = getBpDemoManifest('bo1');
    expect(manifest.match.matchId).toBe('9bf56802-1756-43ae-ae3a-c468d0237edc');
    expect(manifest.match.competition).toMatchObject({
      name: '2026 NJU Rivals',
      slug: '2026-nju-rivals',
      themeColor: '#f97316',
    });
    expect(manifest.entrants.a).toMatchObject({
      entryId: 'f57d3de4-6d7b-4572-a025-e2c04354d3c6',
      name: 'Team Clarys',
      logoUrl:
        'https://sucokfotkypwqkckfynp.supabase.co/storage/v1/object/public/team-logos/f57d3de4-6d7b-4572-a025-e2c04354d3c6/1778985793974.jpg',
    });
    expect(manifest.entrants.b).toMatchObject({
      entryId: 'fbdf2889-db44-4006-a9f6-08ee88628676',
      name: 'Team Plasma',
      logoUrl:
        'https://sucokfotkypwqkckfynp.supabase.co/storage/v1/object/public/team-logos/fbdf2889-db44-4006-a9f6-08ee88628676/1778943880190.png',
    });
    expect(manifest.veto).toHaveLength(7);
    expect(manifest.veto.at(-1)).toMatchObject({
      actionType: 'decider',
      mapName: 'de_ancient',
      entryId: manifest.entrants.b.entryId,
      side: 't',
    });
    expect(manifest.maps[0]).toMatchObject({
      mapName: 'de_ancient',
      pickedByEntryId: null,
      teamAStartSide: 'ct',
      scoreA: 3,
      scoreB: 13,
    });

    const projection = inspectBp(toMatchContext(manifest)).projection;
    expect(projection?.cards).toHaveLength(7);
    expect(projection?.steps.filter((step) => step.kind === 'side-choice')).toHaveLength(1);
    expect(projection?.cards.at(-1)).toMatchObject({
      mapName: 'de_ancient',
      kind: 'decider',
      entrant: null,
      sideChoice: { entrant: 'b', side: 'T' },
    });
  });

  it("keeps the BO3 decider side with Team D'avenir only", () => {
    const projection = inspectBp(toMatchContext(getBpDemoManifest('bo3'))).projection;
    expect(projection?.cards.at(-1)).toMatchObject({
      kind: 'decider',
      entrant: null,
      sideChoice: { entrant: 'b', side: 'T' },
    });
    expect(projection?.cards.at(-1)?.sideChoice?.entrant).toBe('b');
  });

  it('keeps BO5 decider on knife-round semantics without a side choice', () => {
    const projection = inspectBp(toMatchContext(getBpDemoManifest('bo5'))).projection;
    expect(projection?.cards.at(-1)).toMatchObject({
      mapName: 'de_anubis',
      kind: 'decider',
      entrant: null,
      sideChoice: null,
    });
    expect(projection?.steps.filter((step) => step.kind === 'side-choice')).toHaveLength(4);
  });
});
