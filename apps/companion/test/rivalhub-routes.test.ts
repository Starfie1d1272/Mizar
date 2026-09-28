import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerRivalHubConnectionRoutes } from '../src/match-context/rivalhub-routes.js';
import type { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';
import { createLocalWebOriginPolicy } from '../src/local-web/origin-policy.js';

describe('RivalHub Fastify Routes', () => {
  const originPolicy = createLocalWebOriginPolicy({ host: '127.0.0.1' });

  it('provides connection status and refuses cross-origin mutation', async () => {
    const app = Fastify();
    const mockConnection = {
      view: () => ({
        paired: true,
        competitionId: 'comp-1',
        displayName: '星宇',
        activeSourceMatchId: null,
        activeDeviceName: null,
      }),
      schedule: vi.fn(),
      startPairing: vi.fn(),
      pollPairing: vi.fn(),
      matchSource: vi.fn(),
      claim: vi.fn(),
      release: vi.fn(),
    } as unknown as RivalHubConnection;

    registerRivalHubConnectionRoutes(app, {
      connection: mockConnection,
      controller: null,
      currentSnapshot: () => null,
      originPolicy,
    });

    try {
      // GET connection view
      const res = await app.inject({
        method: 'GET',
        url: '/local/v1/rivalhub-connection',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        paired: true,
        competitionId: 'comp-1',
        displayName: '星宇',
        activeSourceMatchId: null,
        activeDeviceName: null,
        activeMatchId: null,
      });

      // Refuses mutation from untrusted origin
      const pairStartRes = await app.inject({
        method: 'POST',
        url: '/operator/rivalhub/pairing/start',
        headers: { origin: 'https://evil.attacker.com' },
      });
      expect(pairStartRes.statusCode).toBe(403);

      const pairPollRes = await app.inject({
        method: 'POST',
        url: '/operator/rivalhub/pairing/poll',
        headers: { origin: 'https://evil.attacker.com' },
      });
      expect(pairPollRes.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('validates pairing and schedule endpoints', async () => {
    const app = Fastify();
    let paired = false;
    const mockConnection = {
      view: () => ({
        paired,
        competitionId: paired ? 'comp-1' : null,
        displayName: paired ? '星宇' : null,
        activeSourceMatchId: null,
        activeDeviceName: null,
      }),
      schedule: vi.fn(() =>
        Promise.resolve({
          competition: { name: '2026 南京 Major' },
          matches: [],
        }),
      ),
      startPairing: vi.fn(() =>
        Promise.resolve({
          authorizeUrl: 'https://match.starfie1d.top/integrations/mizar/connect?pairingId=abc',
          expiresAt: '2026-05-23T12:00:00.000Z',
        }),
      ),
      pollPairing: vi.fn(() => {
        paired = true;
        return Promise.resolve('authorized' as const);
      }),
      matchSource: vi.fn(),
      claim: vi.fn(),
      release: vi.fn(),
    } as unknown as RivalHubConnection;

    registerRivalHubConnectionRoutes(app, {
      connection: mockConnection,
      controller: null,
      currentSnapshot: () => null,
      originPolicy,
    });

    try {
      // When not paired, schedule returns 404
      const scheduleRes1 = await app.inject({
        method: 'GET',
        url: '/local/v1/rivalhub-schedule',
      });
      expect(scheduleRes1.statusCode).toBe(404);

      // Successful start pairing
      const startRes = await app.inject({
        method: 'POST',
        url: '/operator/rivalhub/pairing/start',
        headers: { origin: 'http://127.0.0.1:43120' },
      });
      expect(startRes.statusCode).toBe(200);
      expect(startRes.headers['cache-control']).toBe('no-store');
      expect(startRes.json()).toEqual({
        authorizeUrl: 'https://match.starfie1d.top/integrations/mizar/connect?pairingId=abc',
        expiresAt: '2026-05-23T12:00:00.000Z',
      });

      // Poll pairing
      const pollRes = await app.inject({
        method: 'POST',
        url: '/operator/rivalhub/pairing/poll',
        headers: { origin: 'http://127.0.0.1:43120' },
      });
      expect(pollRes.statusCode).toBe(200);
      expect(pollRes.headers['cache-control']).toBe('no-store');
      expect(pollRes.json()).toMatchObject({
        status: 'authorized',
        connection: { paired: true, displayName: '星宇' },
      });

      // When paired, schedule returns data
      const scheduleRes2 = await app.inject({
        method: 'GET',
        url: '/local/v1/rivalhub-schedule',
      });
      expect(scheduleRes2.statusCode).toBe(200);
      expect(scheduleRes2.json()).toEqual({
        competition: { name: '2026 南京 Major' },
        matches: [],
      });
    } finally {
      await app.close();
    }
  });
});
