// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProgramSceneState } from '@mizar/protocol/program-scenes';
import { NextSceneCard } from './NextSceneCard';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Director = NonNullable<ProgramSceneState['director']>;

function makeDirector(overrides: Partial<Director>): Director {
  return {
    mode: 'auto',
    next: 'gameplay',
    nextStatus: 'predicted',
    nextReason: null,
    reason: null,
    introDurationMs: 0,
    sceneElapsedMs: 1000,
    ...overrides,
  };
}

describe('NextSceneCard', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
  });

  function renderCard(element: React.ReactElement) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  }

  it('renders scene type badge, title, and reason in auto mode without an iframe', () => {
    const el = renderCard(
      <NextSceneCard director={makeDirector({ next: 'gameplay', nextReason: '选手已进入游戏' })} />,
    );
    expect(el.querySelector('iframe')).toBeNull();
    expect(el.textContent).toContain('游戏叠加');
    expect(el.textContent).toContain('下一场景');
    expect(el.textContent).toContain('游戏画面');
    expect(el.textContent).toContain('选手已进入游戏');
  });

  it('renders full-screen graphic badge and BP fallback reason when bpActive is true', () => {
    const el = renderCard(<NextSceneCard director={makeDirector({ next: 'bp' })} bpActive />);
    expect(el.textContent).toContain('全屏图文');
    expect(el.textContent).toContain('BP');
    expect(el.textContent).toContain('正在进行地图禁选');
  });

  it('switches to manual, blocked, and complete states accurately', () => {
    const el = renderCard(
      <NextSceneCard director={makeDirector({ mode: 'manual', next: 'gameplay' })} />,
    );
    expect(el.textContent).toContain('手动保持');
    expect(el.textContent).toContain('自动推进已暂停');
    expect(el.textContent).toContain('恢复自动后继续编排');

    act(() => {
      root?.render(
        <NextSceneCard
          director={makeDirector({
            mode: 'blocked',
            next: null,
            nextStatus: 'awaiting',
            reason: '等待遥测连接',
          })}
        />,
      );
    });
    expect(el.textContent).toContain('自动暂停');
    expect(el.textContent).toContain('处理问题后恢复自动');
    expect(el.textContent).toContain('等待遥测连接');

    act(() => {
      root?.render(
        <NextSceneCard director={makeDirector({ next: null, nextStatus: 'complete' })} />,
      );
    });
    expect(el.textContent).toContain('本场结束');
  });
});
