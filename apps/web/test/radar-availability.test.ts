import { describe, expect, it } from 'vitest';
import { radarSnapshotSchema } from '@mizar/protocol/radar';
import fixtures from '../src/program/fixtures/generated/real-radar-fixtures.generated.json';
import { hasRadarViewFrame } from '../src/program/widgets/radar/adapter';

describe('radar availability', () => {
  it('shares projection eligibility without traversing players or utilities', () => {
    const snapshot = radarSnapshotSchema.parse(
      fixtures.fixtures['dense-utility'].samples[0]!.snapshot,
    );
    expect(hasRadarViewFrame(snapshot)).toBe(true);
    const payload = { ...snapshot.payload };
    Object.defineProperty(payload, 'players', {
      get() {
        throw new Error('unexpected player projection');
      },
    });
    Object.defineProperty(payload, 'grenades', {
      get() {
        throw new Error('unexpected utility projection');
      },
    });
    expect(hasRadarViewFrame({ ...snapshot, payload })).toBe(true);
    expect(hasRadarViewFrame(null)).toBe(false);
    expect(
      hasRadarViewFrame({
        ...snapshot,
        payload: { ...snapshot.payload, identityState: 'mismatch' },
      }),
    ).toBe(false);
    expect(
      hasRadarViewFrame({
        ...snapshot,
        payload: { ...snapshot.payload, mapName: 'unsupported-map' },
      }),
    ).toBe(false);
  });
});
