// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
vi.mock('../src/operator/RivalHubSyncControls', () => ({ RivalHubSyncControls: () => null }));
vi.mock('../src/debug/SupportExport', () => ({ SupportExport: () => null }));
const command = vi.fn(async () => ({ ok: true }));
vi.mock('../src/preparation/client', () => ({ command: (...args: unknown[]) => command(...args) }));
import { SyncHealthAlert, type SyncHealth } from '../src/workspace/SyncHealthAlert';

it('shows recovery progress and does not offer unsafe replay for stale sequence', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const health: SyncHealth = {
    status: 'attention',
    reason: 'context_refreshing',
    incidentId: 'one',
    deviceName: null,
  };
  const render = async (value: SyncHealth) =>
    act(async () => {
      root.render(
        <SyncHealthAlert health={value} matchId="match" isSource onOpen={async () => undefined} />,
      );
    });
  try {
    await render(health);
    expect(document.body.textContent).toContain('正在刷新比赛资料');
    expect(document.body.textContent).not.toContain('立即重试同步');
    await render({ ...health, reason: 'sequence_stale' });
    expect(document.body.textContent).toContain('网站记录的比赛进度与本机不一致');
    expect(document.body.textContent).not.toContain('立即重试同步');
    await render({ ...health, reason: 'context_stale' });
    const button = [...document.body.querySelectorAll('button')].find(
      (item) => item.textContent === '刷新比赛资料',
    );
    expect(button).toBeTruthy();
    await act(async () => button!.click());
    expect(command).toHaveBeenCalledWith('/operator/rivalhub/refresh');
    expect(document.body.textContent).toContain('等待网站接收本场新数据确认');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
