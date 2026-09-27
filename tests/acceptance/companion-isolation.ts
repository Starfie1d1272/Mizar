import { expect, test as base } from '@playwright/test';

function isCompanionHttpPath(url: URL): boolean {
  return (
    url.pathname === '/local/v1' ||
    url.pathname.startsWith('/local/v1/') ||
    url.pathname === '/operator' ||
    url.pathname.startsWith('/operator/') ||
    url.pathname === '/debug/runtime'
  );
}

function isCompanionWebSocketPath(url: URL): boolean {
  return url.pathname === '/local/v1' || url.pathname.startsWith('/local/v1/');
}

export const test = base.extend<{ readonly companionIsolation: void }>({
  companionIsolation: [
    async ({ context }, use) => {
      await context.route(isCompanionHttpPath, (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'companion_offline' }),
        }),
      );
      await context.routeWebSocket(isCompanionWebSocketPath, (socket) =>
        socket.close({ code: 1001, reason: 'Companion is isolated in acceptance' }),
      );
      await use();
    },
    { auto: true },
  ],
});

export { expect };
