import { test, expect } from './companion-isolation.js';

test('explicitly selects an OBS source and reports stale bindings', async ({ page }, testInfo) => {
  const revision = '00000000-0000-4000-8000-000000000001';
  const status = {
    revision,
    endpoint: 'ws://127.0.0.1:4455',
    collection: 'Mizar',
    bindings: { game: null, remoteCommentary: null, microphone: null },
    candidates: [
      {
        selectionId: '00000000-0000-4000-8000-000000000002',
        name: 'TeamSpeak 3',
        kind: 'wasapi_process_output_capture',
        uuid: 'one',
      },
      {
        selectionId: '00000000-0000-4000-8000-000000000003',
        name: 'TeamSpeak 6',
        kind: 'wasapi_process_output_capture',
        uuid: 'two',
      },
    ],
    findings: ['桌面音频可能包含应用音频和音乐监听；请在 OBS 中核对并自行迁移。'],
  };
  await page.route('**/local/v1/obs/audio-routing', (route) => route.fulfill({ json: status }));
  await page.route('**/operator/obs/audio-routing', (route) => {
    expect(route.request().postDataJSON()).toEqual({
      role: 'remoteCommentary',
      selectionId: status.candidates[1]!.selectionId,
      revision,
    });
    return route.fulfill({
      json: {
        ...status,
        bindings: {
          ...status.bindings,
          remoteCommentary: {
            inputUuid: 'two',
            inputKind: status.candidates[1]!.kind,
            collection: 'Mizar',
            endpoint: status.endpoint,
            valid: true,
            name: 'TeamSpeak 6',
          },
        },
      },
    });
  });
  await page.goto('/settings?tab=obs');
  await page.getByRole('button', { name: '刷新 OBS 音频来源' }).click();
  await expect(page.getByText(/当前 OBS：ws:/)).toBeVisible();
  await page.getByLabel('远端解说（TeamSpeak）').selectOption(status.candidates[1]!.selectionId);
  await expect(page.getByText('已绑定：TeamSpeak 6')).toBeVisible();
  await expect(page.getByText(/桌面音频可能包含/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('audio-routing.png'), fullPage: true });
});
