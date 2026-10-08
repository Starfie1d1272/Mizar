import { expect, test } from './companion-isolation.js';

test('unmocked Companion HTTP and WebSocket requests stay offline in the browser harness', async ({
  page,
}) => {
  const navigation = await page.goto('/operator/hud?mode=fixture');
  expect(navigation?.status()).toBe(200);
  expect(navigation?.headers()['content-type']).toContain('text/html');
  const http = await page.evaluate(async () => {
    const response = await fetch('/local/v1/bp');
    return { status: response.status, body: await response.text() };
  });
  expect(http).toEqual({ status: 503, body: '{"error":"companion_offline"}' });

  const websocket = await page.evaluate(
    () =>
      new Promise<{ readonly code: number; readonly state: string }>((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/local/v1/program`);
        const timeout = window.setTimeout(() => resolve({ code: 0, state: 'timeout' }), 1000);
        socket.addEventListener(
          'close',
          (event) => {
            window.clearTimeout(timeout);
            resolve({ code: event.code, state: 'closed' });
          },
          { once: true },
        );
      }),
  );
  expect(websocket).toEqual({ code: 1001, state: 'closed' });
});
