// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { PROGRAM_SCENES, type ProgramSceneState } from '@mizar/protocol/program-scenes';
import { NextSceneCard } from './NextSceneCard';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeSceneState(director: NonNullable<ProgramSceneState['director']>): ProgramSceneState {
  return {
    schemaVersion: 'mizar.program-scenes.v1',
    active: 'waiting',
    revision: 'rev-1',
    available: ['waiting', 'gameplay', 'bp'],
    director,
    blocked: {},
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
    const gameplay = PROGRAM_SCENES.find((s) => s.id === 'gameplay')!;
    const el = renderCard(
      <NextSceneCard
        sceneState={makeSceneState({
          mode: 'auto',
          next: 'gameplay',
          nextStatus: 'predicted',
          nextReason: '选手已进入游戏',
          reason: null,
          introDurationMs: 0,
          sceneElapsedMs: 1000,
        })}
        next={gameplay}
      />,
    );
    expect(el.querySelector('iframe')).toBeNull();
    expect(el.textContent).toContain('游戏叠加');
    expect(el.textContent).toContain('下一场景');
    expect(el.textContent).toContain('游戏画面');
    expect(el.textContent).toContain('选手已进入游戏');
  });

  it('renders full-screen graphic badge and BP fallback reason when bpActive is true', () => {
    const bp = PROGRAM_SCENES.find((s) => s.id === 'bp')!;
    const el = renderCard(
      <NextSceneCard
        sceneState={makeSceneState({
          mode: 'auto',
          next: 'bp',
          nextStatus: 'predicted',
          nextReason: null,
          reason: null,
          introDurationMs: 0,
          sceneElapsedMs: 1000,
        })}
        next={bp}
        bpActive
      />,
    );
    expect(el.textContent).toContain('全屏图文');
    expect(el.textContent).toContain('BP');
    expect(el.textContent).toContain('正在进行地图禁选');
  });

  it('switches to manual, blocked, and complete states accurately', () => {
    const el = renderCard(
      <NextSceneCard
        sceneState={makeSceneState({
          mode: 'manual',
          next: 'gameplay',
          nextStatus: 'predicted',
          nextReason: null,
          reason: null,
          introDurationMs: 0,
          sceneElapsedMs: 1000,
        })}
        next={PROGRAM_SCENES.find((s) => s.id === 'gameplay')}
      />,
    );
    expect(el.textContent).toContain('手动保持');
    expect(el.textContent).toContain('自动推进已暂停');
    expect(el.textContent).toContain('恢复自动后继续编排');

    act(() => {
      root?.render(
        <NextSceneCard
          sceneState={makeSceneState({
            mode: 'blocked',
            next: null,
            nextStatus: 'awaiting',
            nextReason: null,
            reason: '等待遥测连接',
            introDurationMs: 0,
            sceneElapsedMs: 1000,
          })}
          next={undefined}
        />,
      );
    });
    expect(el.textContent).toContain('自动暂停');
    expect(el.textContent).toContain('处理问题后恢复自动');
    expect(el.textContent).toContain('等待遥测连接');

    act(() => {
      root?.render(
        <NextSceneCard
          sceneState={makeSceneState({
            mode: 'auto',
            next: null,
            nextStatus: 'complete',
            nextReason: null,
            reason: null,
            introDurationMs: 0,
            sceneElapsedMs: 1000,
          })}
          next={undefined}
        />,
      );
    });
    expect(el.textContent).toContain('本场结束');
  });
});
