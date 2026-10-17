// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { mutateHudConfig } from '../src/realtime/hud-config-client';
afterEach(() => vi.unstubAllGlobals());
it('links a rejected HUD activation to its task without recording a confirmed outcome', async () => {
  const controls: {
    phase: string;
    evidence: { taskId: string; evidence: { result?: string; error?: { code?: string } } };
  }[] = [];
  let requestTask: string | null = null;
  vi.stubGlobal('fetch', (path: string, init: RequestInit) => {
    if (path === '/debug/control-event') {
      controls.push(JSON.parse(init.body as string) as (typeof controls)[number]);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    requestTask = new Headers(init.headers).get('x-mizar-task-id');
    return Promise.resolve(Response.json({ error: 'revision_conflict' }, { status: 409 }));
  });
  await expect(
    mutateHudConfig({
      kind: 'activate-preset',
      expectedEditorRevision: 'old-editor',
      sourceId: 'custom-preset',
    }),
  ).rejects.toThrow('已在另一页面更新');
  expect(controls.find((event) => event.phase === 'begin')?.evidence.taskId).toBe(requestTask);
  const terminal = controls.find((event) => event.phase === 'terminal');
  expect(terminal?.evidence.taskId).toBe(requestTask);
  expect(terminal?.evidence.evidence).toMatchObject({
    result: 'failed',
    error: { code: 'revision_conflict' },
  });
  expect(controls.some((event) => event.evidence.evidence.result === 'confirmed')).toBe(false);
});
