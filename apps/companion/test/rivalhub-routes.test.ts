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
        displayName: '主舞台制播机',
        activeSourceMatchId: null,
        activeDeviceName: null,
      }),
      schedule: vi.fn(),
      pair: vi.fn(),
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
        displayName: '主舞台制播机',
        activeSourceMatchId: null,
        activeDeviceName: null,
        activeMatchId: null,
      });

      // Refuses mutation from untrusted origin
      const pairRes = await app.inject({
        method: 'POST',
        url: '/operator/rivalhub/pair',
        headers: { origin: 'https://evil.attacker.com' },
        payload: {
          baseUrl: 'https://rivalhub.example',
          code: 'a'.repeat(22),
          displayName: '主舞台',
        },
      });
      expect(pairRes.statusCode).toBe(403);
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
        displayName: paired ? '主舞台' : null,
        activeSourceMatchId: null,
        activeDeviceName: null,
      }),
      schedule: vi.fn(() =>
        Promise.resolve({
          competition: { name: '2026 南京 Major' },
          matches: [],
        }),
      ),
      pair: vi.fn(() => {
        paired = true;
        return Promise.resolve();
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

      // Incomplete pair body returns 400
      const pairBad = await app.inject({
        method: 'POST',
        url: '/operator/rivalhub/pair',
        headers: { origin: 'http://127.0.0.1:43120' },
        payload: { baseUrl: 'https://rivalhub.example' },
      });
      expect(pairBad.statusCode).toBe(400);

      // Successful pair
      const pairOk = await app.inject({
        method: 'POST',
        url: '/operator/rivalhub/pair',
        headers: { origin: 'http://127.0.0.1:43120' },
        payload: {
          baseUrl: 'https://rivalhub.example',
          code: 'b'.repeat(22),
          displayName: '主舞台',
        },
      });
      expect(pairOk.statusCode).toBe(200);

      // When paired, schedule returns 200
      const scheduleRes2 = await app.inject({
        method: 'GET',
        url: '/local/v1/rivalhub-schedule',
      });
      expect(scheduleRes2.statusCode).toBe(200);
      expect(scheduleRes2.json()).toMatchObject({
        competition: { name: '2026 南京 Major' },
      });
    } finally {
      await app.close();
    }
  });

  it('enforces claim prerequisites and fails with 409 when snapshot not ready', async () => {
    const app = Fastify();
    const mockConnection = {
      view: () => ({
        paired: true,
        competitionId: 'comp-1',
        displayName: '主舞台',
        activeSourceMatchId: null,
        activeDeviceName: null,
      }),
      claim: vi.fn(),
      release: vi.fn(async () => {}),
    } as unknown as RivalHubConnection;

    // Snapshot is null (e.g. gameplay/CS2 telemetry not connected yet)
    registerRivalHubConnectionRoutes(app, {
      connection: mockConnection,
      controller: null,
      currentSnapshot: () => null,
      originPolicy,
    });

    try {
      const claimRes = await app.inject({
        method: 'POST',
        url: '/operator/rivalhub/source/claim',
        headers: { origin: 'http://127.0.0.1:43120' },
        payload: {},
      });
      expect(claimRes.statusCode).toBe(409);
      expect(claimRes.json()).toEqual({ message: '请先在工作区加载赛事比赛。' });

      const releaseRes = await app.inject({
        method: 'POST',
        url: '/operator/rivalhub/source/release',
        headers: { origin: 'http://127.0.0.1:43120' },
        payload: {},
      });
      expect(releaseRes.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
