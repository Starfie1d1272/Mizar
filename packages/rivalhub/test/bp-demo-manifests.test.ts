import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectBp } from '@mizar/core/projection';
import { getBpDemoManifest, toMatchContext, validateBroadcastManifest } from '../src/index.js';

describe('BP demo manifests', () => {
  it.each(['bo1', 'bo3', 'bo5'] as const)(
    'validates and projects %s through the production adapter',
    (format) => {
      const manifest = getBpDemoManifest(format);
      const validated = validateBroadcastManifest(manifest);
      expect(validated.ok).toBe(true);
      if (!validated.ok) throw Error('Invalid manifest');
      const inspected = inspectBp(toMatchContext(validated.value));
      expect(inspected.readiness).toBe('ready');
      const projection = inspected.projection!;
      expect(projection.format).toBe(format);
      expect(projection.cards).toHaveLength(7);
      expect(projection.cards.filter((card) => card.kind === 'ban')).toHaveLength(
        format === 'bo1' ? 6 : format === 'bo3' ? 4 : 2,
      );
      expect(projection.cards.filter((card) => card.kind === 'pick')).toHaveLength(
        format === 'bo1' ? 0 : format === 'bo3' ? 2 : 4,
      );
      expect(projection.cards.filter((card) => card.kind === 'decider')).toHaveLength(1);
      expect(projection.steps.filter((step) => step.kind === 'side-choice')).toHaveLength(
        format === 'bo1' ? 1 : format === 'bo3' ? 2 : 4,
      );
    },
  );

  it('matches the sourced EPL match without inventing decider sides or revealing future results', () => {
    const source = JSON.parse(
      readFileSync(
        new URL('../../../fixtures/epl-s24/match-document.json', import.meta.url),
        'utf8',
      ),
    );
    const actual = getBpDemoManifest('bo3');
    expect(actual.match.matchId).toBe(source.matchId);
    expect(actual.match.scheduledAt).toBe(source.scheduledAt);
    expect(actual.match.competition.name).toBe(source.competition.name);
    expect(actual.veto).toEqual(
      source.veto.map((step: { side: string | null }) => ({
        ...step,
        side: step.side?.toLowerCase() ?? null,
      })),
    );
    expect(actual.entrants.a.name).toBe(source.entrants.a.name);
    expect(actual.entrants.b.name).toBe(source.entrants.b.name);
    expect(actual.match.scoreA).toBeNull();
    expect(actual.match.scoreB).toBeNull();
    for (const map of actual.maps) {
      expect(map.scoreA).toBeNull();
      expect(map.scoreB).toBeNull();
    }
    const projection = inspectBp(toMatchContext(actual)).projection;
    expect(projection?.cards.at(-1)).toMatchObject({
      mapName: 'de_mirage',
      kind: 'decider',
      entrant: null,
      sideChoice: null,
    });
  });

  it.each(['bo1', 'bo5'] as const)(
    'labels %s as synthetic instead of claiming an EPL match',
    (format) => {
      const manifest = getBpDemoManifest(format);
      expect(manifest.match.competition.name).toContain('合成');
      expect(manifest.match.scheduledAt).toBeNull();
      expect(manifest.entrants.a.name).toBe('示例队伍 A');
      expect(manifest.entrants.b.name).toBe('示例队伍 B');
      expect(JSON.stringify(manifest)).not.toMatch(/Rivals|Plasma|Clarys|supabase/);
    },
  );
});
