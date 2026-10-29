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
  expect(host.querySelector('.stats-insert__key--left')?.parentElement?.textContent).toContain('A');
  expect(host.querySelector('.stats-insert__key--right')?.parentElement?.textContent).toContain(
    'B',
  );
  const image = host.querySelector('img')!;
  await act(async () => image.dispatchEvent(new Event('error')));
  expect(image.style.visibility).toBe('hidden');
  await act(async () => image.dispatchEvent(new Event('load')));
  expect(image.style.visibility).toBe('');
  await act(async () => root.unmount());
});
