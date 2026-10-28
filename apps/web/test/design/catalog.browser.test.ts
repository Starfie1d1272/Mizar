import { expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { composeStories } from '@storybook/react-vite';
import axe from 'axe-core';
import * as primitives from '../../src/ui/primitives.stories.js';
import * as patterns from '../../src/patterns/workbench.stories.js';
import * as libraries from '../../src/patterns/LibraryWorkspace.stories.js';
import * as tools from '../../src/patterns/tool-shell.stories.js';

const stories = {
  ...composeStories(primitives),
  ...composeStories(patterns),
  ...composeStories(tools),
  ...composeStories(libraries),
};
for (const [name, story] of Object.entries(stories)) {
  test(`${name}: render, interaction and WCAG 2.2 a11y`, async () => {
    if (name === 'LibraryLongSchedule') await page.viewport(1440, 1080);
    await story.run();
    const result = await axe.run(document.body, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
      rules: { 'target-size': { enabled: true } },
    });
    expect(
      result.violations.map(({ id, nodes }) => ({ id, nodes: nodes.map((node) => node.target) })),
    ).toEqual([]);
  });
}

test('native modal traps focus, Escape closes, and trigger regains focus', async () => {
  await stories.Modal.run();
  const trigger = page.getByRole('button', { name: '打开设置' });
  await trigger.click();
  await expect.element(page.getByRole('textbox', { name: '预览名称' })).toHaveFocus();
  expect((await axe.run('dialog')).violations).toEqual([]);
  await userEvent.tab({ shift: true });
  await expect.element(page.getByRole('button', { name: '关闭' })).toHaveFocus();
  await userEvent.keyboard('{Escape}');
  await expect.poll(() => document.querySelector('dialog')?.open).toBe(false);
  await expect.element(trigger).toHaveFocus();
});

test('native option list supports keyboard selection with visible focus', async () => {
  await stories.SelectionList.run();
  const select = page.getByRole('listbox', { name: '赛制选项' });
  await page.getByRole('textbox', { name: '队伍名称' }).click();
  await userEvent.tab();
  await expect.element(select).toHaveFocus();
  await expect.element(select).toHaveValue('bo3');
  await userEvent.keyboard('[ArrowUp]');
  await expect.element(select).toHaveValue('bo1');
  await userEvent.keyboard('[ArrowDown]');
  await expect.element(select).toHaveValue('bo3');
});

test('hover changes the primary recipe in a real pointer interaction', async () => {
  await stories.Buttons.run();
  const button = page.getByRole('button', { name: '确认' });
  await page.getByRole('button', { name: '取消' }).hover();
  const before = getComputedStyle(button.element()).backgroundColor;
  await button.hover();
  await expect.poll(() => getComputedStyle(button.element()).backgroundColor).not.toBe(before);
});

test('pause ALL chat aligns with timeout cards and clears the player dock in all HUD designs', async () => {
  const { createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ProgramVisualFixturePage } =
    await import('../../src/program/testing/ProgramVisualFixturePage');
  await page.viewport(1920, 1080);
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  const root = createRoot(container);
  try {
    for (const design of ['current', 'ewc', 'iem', 'perfectworld', 'esl']) {
      for (const phase of ['timeout-ct', 'timeout-t', 'paused']) {
        const fixtureId = `all-chat-${design}-${phase}`;
        root.render(createElement(ProgramVisualFixturePage, { fixtureId }));
        await expect
          .poll(() =>
            container
              .querySelector('[data-program-fixture-id]')
              ?.getAttribute('data-program-fixture-id'),
          )
          .toBe(fixtureId);
        const chat = container.querySelector('.all-chat')!.getBoundingClientRect();
        const dock = container.querySelector('.broadcast-pause__dock')!.getBoundingClientRect();
        expect(chat.bottom).toBeLessThan(dock.top);
        expect(chat.top).toBeGreaterThan(0);
        if (phase !== 'paused') {
          const notice = container
            .querySelector('.broadcast-pause__notice')!
            .getBoundingClientRect();
          expect(chat.width).toBeCloseTo(notice.width, 0);
          expect(chat.left).toBeCloseTo(notice.left, 0);
          expect(chat.bottom).toBeLessThanOrEqual(notice.top);
        }
      }
    }
  } finally {
    root.unmount();
    container.remove();
  }
});
