import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getBuiltinResolvedPreset } from '@mizar/hud-config';
import { ProgramSceneView } from '@mizar/hud-view';
import { expect, it } from 'vitest';
import { presentationPreview } from '../src/program/presentation-preview';

it('highlights the projected map winner and leaves an unknown winner unhighlighted', () => {
  const data = presentationPreview('map_result', null);
  const summary = data.completed.at(-1)!;
  const series = data.series!;
  const map = series.maps.find((item) => item.mapOrder === summary.mapOrder)!;
  summary.score = { a: 13, b: 9 };
  map.winnerEntryId = series.entrants.b.entryId;
  const render = () =>
    renderToStaticMarkup(
      createElement(ProgramSceneView, {
        sceneId: 'map_result',
        data,
        snapshot: null,
        scenes: null,
        resolvedPreset: getBuiltinResolvedPreset(),
        preview: true,
        shortIntro: false,
        previewBackground: false,
        reducedMotion: true,
      }),
    );
  let html = render();
  expect(html).toContain('result-side result-side--a" data-winner="false"');
  expect(html).toContain('result-side result-side--b" data-winner="true"');
  map.winnerEntryId = null;
  html = render();
  expect(html).toContain('result-side result-side--a" data-winner="false"');
  expect(html).toContain('result-side result-side--b" data-winner="false"');
});
