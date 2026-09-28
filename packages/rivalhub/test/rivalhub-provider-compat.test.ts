import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseMatchDocumentV1, parseScheduleWindowV1 } from '@mizar/protocol/context';
import {
  toMatchDocumentV1,
  toScheduleWindowV1,
  validateBroadcastManifest,
  validateBroadcastScheduleWindow,
} from '../src/index.js';

const fixtureRoot = resolve(process.cwd(), 'packages/rivalhub/test/fixtures');
const readFixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(resolve(fixtureRoot, name), 'utf8'));

describe('RivalHub checked-in provider fixtures', () => {
  it('converts match facts through the production adapter and owned parser', async () => {
    const fixture = await readFixture('rivalhub-provider-manifest-v1.json');
    const validated = validateBroadcastManifest(fixture);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(JSON.stringify(validated.diagnostics));

    const document = parseMatchDocumentV1(toMatchDocumentV1(validated.value));
    expect(document.competition.logoUrl).toContain('season-public-assets');
    expect(document.startedAt).toBe('2026-09-16T10:03:00.000Z');
    expect(document.stageLabel).toBe('瑞士赛');
    expect(
      document.entrants.a.players.some((player) => !player.isStarter && player.steam64 === null),
    ).toBe(true);
    expect(validated.value.veto.map((step) => step.actionType)).toContain('side_pick');
    expect(validated.value.veto.map((step) => step.actionType)).toContain('decider');
    expect(JSON.stringify(document)).not.toMatch(
      /credential|studentId|reviewNote|educationEvidence/,
    );
  });

  it.each(['scheduled', 'in_progress', 'finished', 'cancelled'] as const)(
    'accepts %s lifecycle without inventing startedAt',
    async (status) => {
      const fixture = (await readFixture('rivalhub-provider-manifest-v1.json')) as Record<
        string,
        unknown
      >;
      const candidate = structuredClone(fixture) as {
        match: {
          status: string;
          startedAt: string | null;
          competition: { logoUrl: string | null };
        };
      };
      candidate.match.status = status;
      candidate.match.startedAt =
        status === 'scheduled' || status === 'cancelled' ? null : '2026-09-16T10:03:00.000Z';
      candidate.match.competition.logoUrl =
        status === 'scheduled' ? null : candidate.match.competition.logoUrl;
      const validated = validateBroadcastManifest(candidate);
      expect(validated.ok).toBe(true);
      if (!validated.ok) throw new Error(JSON.stringify(validated.diagnostics));
      expect(parseMatchDocumentV1(toMatchDocumentV1(validated.value)).startedAt).toBe(
        candidate.match.startedAt,
      );
    },
  );

  it('converts bounded schedule rows with null scheduledAt and deterministic order', async () => {
    const fixture = await readFixture('rivalhub-provider-schedule-window-v1.json');
    const validated = validateBroadcastScheduleWindow(fixture);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(JSON.stringify(validated.diagnostics));
    const window = parseScheduleWindowV1(toScheduleWindowV1(validated.value));
    expect(window.matches.map((match) => match.matchId)).toEqual([
      'match-m2-01',
      'match-m2-00',
      'match-m2-unknown-time',
    ]);
    expect(window.matches[1]?.scheduledAt).toBeNull();
    expect(window.competition.logoUrl).toContain('season-public-assets');
  });
});
