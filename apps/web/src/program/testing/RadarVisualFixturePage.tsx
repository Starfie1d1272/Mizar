import { getBuiltinResolvedPreset } from '@mizar/hud-config';
import { Radar } from '../widgets/radar/Radar';
import {
  RADAR_VISUAL_FIXTURES,
  radarVisualFixture,
  type RadarVisualFixture,
} from '../fixtures/radar-fixtures';
import { themeStyle } from '../GameplayHud';

export function RadarVisualFixturePage({ id }: { readonly id: string }) {
  if (!(RADAR_VISUAL_FIXTURES as readonly string[]).includes(id)) return <p>雷达场景不存在</p>;
  const fixture = radarVisualFixture(id as RadarVisualFixture);
  return (
    <div
      data-radar-fixture={id}
      data-provenance={fixture.provenance.kind}
      style={{
        ...themeStyle(getBuiltinResolvedPreset().theme),
        width: fixture.size,
        height: fixture.size,
      }}
    >
      <Radar snapshot={fixture.snapshot} zoomMode={fixture.zoomMode} />
    </div>
  );
}
