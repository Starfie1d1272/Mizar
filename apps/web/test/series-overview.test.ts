import { describe, expect, it } from 'vitest';
import { getProgramFixture } from '../src/program/fixtures';
import { SeriesOverview } from '../src/program/widgets/match-header/SeriesOverview';

describe('freeze-only series detail', () => {
  it('shows canonical map details only during a fresh freeze and clears immediately at live', () => {
    const base = getProgramFixture('real-live-rich')!;
    const snapshot = {
      ...base,
      payload: { ...base.payload, round: { ...base.payload.round!, phase: 'freezetime' as const } },
    };
    expect(SeriesOverview({ snapshot })).not.toBeNull();
    expect(SeriesOverview({ snapshot: base })).toBeNull();
    expect(
      SeriesOverview({
        snapshot: {
          ...snapshot,
          payload: {
            ...snapshot.payload,
            status: { ...snapshot.payload.status, telemetry: 'stale' },
          },
        },
      }),
    ).toBeNull();
  });
});
