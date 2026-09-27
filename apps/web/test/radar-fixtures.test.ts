import { describe, expect, it } from 'vitest';
import { projectWorldPosition, defaultMapGeometryProvider } from '@mizar/radar';

import { getDefaultHudCompositeFixture } from '../src/program/fixtures/default-hud-composite-fixtures';
import { getProgramFixture } from '../src/program/fixtures';
import { realProgramFixtures } from '../src/program/fixtures/real-program-fixtures';
import {
  radarSnapshotForProgramFixture,
  radarVisualFixture,
} from '../src/program/fixtures/radar-fixtures';

describe('Nuke Radar fixtures', () => {
  const geometry = defaultMapGeometryProvider.resolve('de_nuke');

  it('uses in-bounds canonical calibration anchors for each floor', () => {
    expect(geometry).not.toBeNull();
    for (const [fixture, floor] of [
      ['nuke-upper', 'upper'],
      ['nuke-lower', 'lower'],
    ] as const) {
      const snapshot = radarVisualFixture(fixture).snapshot;
      const points = snapshot.payload.players.map((player) =>
        projectWorldPosition(player.position, geometry!),
      );
      expect(points).toHaveLength(10);
      expect(points.every((point) => point !== null && !point.outOfBounds)).toBe(true);
      expect(points.every((point) => point?.layer === floor)).toBe(true);
      expect(new Set(points.map((point) => `${point!.x}:${point!.y}`)).size).toBe(10);
    }
  });

  it('distributes the composite players across the shared upper and lower image space', () => {
    const fixture = getDefaultHudCompositeFixture('default-nuke-multifloor');
    expect(fixture).not.toBeNull();
    const points = fixture!.radarSnapshot.payload.players.map((player) =>
      projectWorldPosition(player.position, geometry!),
    );
    expect(points.every((point) => point !== null && !point.outOfBounds)).toBe(true);
    expect(points.filter((point) => point?.layer === 'upper')).toHaveLength(5);
    expect(points.filter((point) => point?.layer === 'lower')).toHaveLength(5);
  });
});

describe('paired Program and Radar editor fixtures', () => {
  it('pairs every real Program fixture with its exact Radar frame and cursor', () => {
    for (const [id, record] of Object.entries(realProgramFixtures)) {
      const program = getProgramFixture(id);
      const radar = radarSnapshotForProgramFixture(id);
      expect(program, id).not.toBeNull();
      expect(radar, id).not.toBeNull();
      expect(radar!.cursor).toEqual(program!.cursor);
      expect(radar!.cursor.programReceiveSequence).toBe(record.provenance.targetSequence);
    }
  });

  it('keeps the real Rivals BP cuts paired with their underlying GSI replay frame', () => {
    for (const id of [
      'bp-rivals-final-map4',
      'bp-rivals-final-result',
      'bp-rivals-semi-a-result',
      'bp-rivals-semi-b-result',
    ]) {
      const program = getProgramFixture(id);
      const radar = radarSnapshotForProgramFixture(id);
      expect(program, id).not.toBeNull();
      expect(radar, id).not.toBeNull();
      expect(radar!.cursor).toEqual(program!.cursor);
    }
  });

  it('does not substitute a Radar scene when the Program frame has no exact pair', () => {
    for (const id of ['awaiting-neutral', 'focused-avatar', 'player-rails-eco']) {
      expect(radarSnapshotForProgramFixture(id), id).toBeNull();
    }
  });
});
