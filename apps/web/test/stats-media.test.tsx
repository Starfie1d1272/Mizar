// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { StatsInsertView } from '@mizar/hud-view';

it('labels radar sides and hides a failed image until it loads again', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <StatsInsertView
        insert={{
          title: '画像',
          subtitle: 'PLAYER ATTRIBUTES',
          scope: '本届',
          teams: ['A', 'B'],
          logos: ['https://example.test/a.png', null],
          layout: 'radar',
          rows: [],
        }}
      />,
    ),
  );
  expect(host.querySelector('.stats-radar-key span:first-child')?.textContent).toContain('A');
  expect(host.querySelector('.stats-radar-key span:last-child')?.textContent).toContain('B');
  const image = host.querySelector('img')!;
  await act(async () => image.dispatchEvent(new Event('error')));
  expect(image.style.visibility).toBe('hidden');
  await act(async () => image.dispatchEvent(new Event('load')));
  expect(image.style.visibility).toBe('');
  await act(async () => root.unmount());
});

it('draws the radar from numeric values even when labels are formatted differently', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <StatsInsertView
        insert={{
          title: '画像',
          subtitle: 'PLAYER ATTRIBUTES',
          scope: '本届',
          teams: ['A', 'B'],
          layout: 'radar',
          rows: Array.from({ length: 7 }, (_, i) => ({
            label: String(i),
            values: ['50 分', '75 分'] as const,
            numericValues: [50, 75] as const,
          })),
        }}
      />,
    ),
  );
  const polygons = host.querySelectorAll('.stats-radar polygon');
  expect(polygons[5]?.getAttribute('points')).toContain('400,178');
  expect(polygons[6]?.getAttribute('points')).toContain('400,125');
  expect(host.textContent).toContain('50 分 / 75 分');
  await act(async () => root.unmount());
});
