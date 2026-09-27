import Fastify from 'fastify';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { BpProjection } from '@mizar/core/projection';
import { getBpDemoManifest, toMatchContext, validateBroadcastManifest } from '@mizar/rivalhub';
import { bpSnapshotSchema, bpWorkspaceSchema } from '@mizar/protocol/bp';
import { buildApp } from '../src/app.js';
import { registerBpRoutes } from '../src/bp/controller.js';
import { registerBpDemoRoute } from '../src/bp/demo-controller.js';
import { BpDemoStateController } from '../src/bp/demo-state.js';
import { createLocalWebOriginPolicy } from '../src/local-web/origin-policy.js';

const realProjection: BpProjection = {
  matchId: 'real-a',
  competition: '真实比赛 A',
  stage: '决赛',
  format: 'bo1',
  entrants: {
    a: { entryId: 'real-a-entry', name: '真实队 A', logoUrl: null },
    b: { entryId: 'real-b-entry', name: '真实队 B', logoUrl: null },
  },
  cards: Array.from({ length: 7 }, (_, index) => ({
    mapName: `de_real_${index}`,
    kind: index === 6 ? ('decider' as const) : ('ban' as const),
    entrant: index === 6 ? null : ('a' as const),
    sideChoice: null,
  })),
  steps: Array.from({ length: 7 }, (_, cardIndex) => ({ cardIndex, kind: 'card' as const })),
};

const demoProjection: BpProjection = {
  ...realProjection,
  matchId: 'demo-bo1',
  competition: '2026 NJU Rivals',
  entrants: {
    a: { entryId: 'demo-a', name: 'Team Clarys', logoUrl: null },
    b: { entryId: 'demo-b', name: 'Team Plasma', logoUrl: null },
  },
};

const localOrigin = { origin: 'http://127.0.0.1' };

describe('BP demo state and command route', () => {
  it('starts inactive, switches only while hidden, refuses visible sessions, and exits without hiding', async () => {
    let now = 0;
    const state = new BpDemoStateController();
    expect(state.getState()).toBeNull();
    let activeRealProjection: BpProjection = realProjection;
    const app = Fastify();
    const session = registerBpRoutes(app, {
      originPolicy: createLocalWebOriginPolicy(),
      getProjection: () =>
        state.getProjection(
          () => activeRealProjection,
          () => demoProjection,
        ),
      now: () => now,
    });
    registerBpDemoRoute(app, {
      originPolicy: createLocalWebOriginPolicy(),
      session,
      state,
    });
    const postDemo = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/operator/bp-demo', headers: localOrigin, payload });
    try {
      const startBo1 = await postDemo({ kind: 'start', format: 'bo1' });
      expect(startBo1.statusCode).toBe(200);
      expect(state.getState()).toBe('bo1');
      const started = await app.inject('/local/v1/bp');
      const startedSnapshot = bpSnapshotSchema.parse(started.json());
      expect(startBo1.json()).toMatchObject({
        ok: true,
        demo: { active: 'bo1' },
        bpRevision: startedSnapshot.revision,
      });
      expect(startedSnapshot.projection).toMatchObject({
        competition: '2026 NJU Rivals',
        entrants: {
          a: { name: 'Team Clarys' },
          b: { name: 'Team Plasma' },
        },
      });
      expect(started.body).not.toContain('manifest');
      expect(started.body).not.toContain('demo-bo1');
      expect(started.body).not.toContain('demo-a');

      const startBo3 = await postDemo({ kind: 'start', format: 'bo3' });
      expect(startBo3.statusCode).toBe(200);
      expect(state.getState()).toBe('bo3');
      const bo3 = await app.inject('/local/v1/bp');
      const bo3Snapshot = bpSnapshotSchema.parse(bo3.json());
      expect(startBo3.json()).toMatchObject({
        demo: { active: 'bo3' },
        bpRevision: bo3Snapshot.revision,
      });
      const play = await app.inject({
        method: 'POST',
        url: '/operator/bp-command',
        headers: localOrigin,
        payload: { kind: 'play', expectedRevision: bo3Snapshot.revision },
      });
      expect(play.statusCode).toBe(200);
      expect((await postDemo({ kind: 'start', format: 'bo5' })).statusCode).toBe(409);
      expect((await postDemo({ kind: 'exit' })).json()).toMatchObject({
        message: '请先收起当前 BP 场景。',
      });
      expect(state.getState()).toBe('bo3');

      now = 1600 * 8;
      const shown = await app.inject('/local/v1/bp');
      const shownSnapshot = bpSnapshotSchema.parse(shown.json());
      expect(shownSnapshot.state).toBe('shown');
      expect((await postDemo({ kind: 'exit' })).statusCode).toBe(409);
      const hide = await app.inject({
        method: 'POST',
        url: '/operator/bp-command',
        headers: localOrigin,
        payload: { kind: 'hide', expectedRevision: shownSnapshot.revision },
      });
      expect(bpSnapshotSchema.parse(hide.json()).state).toBe('hiding');
      expect((await postDemo({ kind: 'exit' })).statusCode).toBe(409);
      expect((await postDemo({ kind: 'start', format: 'bo5' })).statusCode).toBe(409);
      expect(state.getState()).toBe('bo3');
      expect(bpSnapshotSchema.parse((await app.inject('/local/v1/bp')).json()).state).toBe(
        'hiding',
      );

      now += 360;
      const hiddenSnapshot = bpSnapshotSchema.parse((await app.inject('/local/v1/bp')).json());
      expect(hiddenSnapshot.state).toBe('hidden');
      expect((await postDemo({ kind: 'start', format: 'bo5' })).statusCode).toBe(200);
      expect(state.getState()).toBe('bo5');
      const exited = await postDemo({ kind: 'exit' });
      expect(exited.statusCode).toBe(200);
      expect(state.getState()).toBeNull();
      const restoredReal = bpSnapshotSchema.parse((await app.inject('/local/v1/bp')).json());
      expect(exited.json()).toMatchObject({ bpRevision: restoredReal.revision });
      expect(restoredReal.projection).toMatchObject({
        competition: '真实比赛 A',
        entrants: { a: { name: '真实队 A' } },
      });

      activeRealProjection = { ...realProjection, matchId: 'real-b', competition: '真实比赛 B' };
      const newestReal = bpSnapshotSchema.parse((await app.inject('/local/v1/bp')).json());
      expect(newestReal.projection).toMatchObject({
        competition: '真实比赛 B',
        entrants: { a: { name: '真实队 A' } },
      });
      expect(new BpDemoStateController().getState()).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('enforces exact loopback origin, LAN write denial, and the typed bounded command', async () => {
    const state = new BpDemoStateController();
    const app = Fastify();
    const session = registerBpRoutes(app, {
      originPolicy: createLocalWebOriginPolicy(),
      getProjection: () => realProjection,
    });
    registerBpDemoRoute(app, {
      originPolicy: createLocalWebOriginPolicy(),
      session,
      state,
    });
    try {
      for (const origin of [undefined, 'https://evil.example']) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/operator/bp-demo',
              payload: { kind: 'start', format: 'bo1' },
              headers: origin ? { origin } : {},
            })
          ).statusCode,
        ).toBe(403);
      }
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/operator/bp-demo',
            headers: localOrigin,
            payload: { kind: 'start', format: 'bo2' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/operator/bp-demo',
            headers: localOrigin,
            payload: { kind: 'start', format: 'bo1', extra: true },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/operator/bp-demo',
            headers: { ...localOrigin, 'content-type': 'application/json' },
            payload: `{"kind":"start","format":"bo1","padding":"${'x'.repeat(5000)}"}`,
          })
        ).statusCode,
      ).toBe(413);
    } finally {
      await app.close();
    }

    const lanPolicy = createLocalWebOriginPolicy({
      host: '0.0.0.0',
      lanMode: true,
      allowedOrigins: ['http://192.168.1.10'],
    });
    const lan = Fastify();
    const lanSession = registerBpRoutes(lan, {
      originPolicy: lanPolicy,
      getProjection: () => null,
    });
    registerBpDemoRoute(lan, { originPolicy: lanPolicy, session: lanSession, state });
    try {
      expect(
        (
          await lan.inject({
            method: 'POST',
            url: '/operator/bp-demo',
            headers: { origin: 'http://192.168.1.10' },
            payload: { kind: 'start', format: 'bo1' },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await lan.close();
    }
  });

  it('does not change MatchContext or LKG, and a new Companion starts inactive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bp-demo-lkg-'));
    const matchManifestPath = join(directory, 'match-context.json');
    const validated = validateBroadcastManifest(getBpDemoManifest('bo3'));
    if (!validated.ok) throw new Error('BP Demo fixture should validate');
    const app = buildApp({
      matchContextBinding: {
        manifest: validated.value,
        context: toMatchContext(validated.value),
        origin: 'online',
        freshness: 'fresh',
        localAuthoringMode: 'bound-overlay',
        diagnostics: validated.diagnostics,
      },
      matchManifestPath,
    });
    try {
      const initial = bpWorkspaceSchema.parse((await app.inject('/local/v1/bp-workspace')).json());
      expect(initial.demo.active).toBeNull();
      expect(initial.match?.entrants.b.name).toBe("Team D'avenir");
      const result = await app.inject({
        method: 'POST',
        url: '/operator/bp-demo',
        headers: localOrigin,
        payload: { kind: 'start', format: 'bo1' },
      });
      expect(result.statusCode).toBe(200);
      expect(result.body).not.toContain(validated.value.match.matchId);
      expect(result.body).not.toContain(validated.value.entrants.a.entryId);
      const demoManifest = getBpDemoManifest('bo1');
      const presentation = await app.inject('/local/v1/bp');
      const wireProjection = bpSnapshotSchema.parse(presentation.json()).projection;
      expect(wireProjection).not.toBeNull();
      expect(wireProjection).not.toHaveProperty('matchId');
      expect(wireProjection?.entrants).not.toHaveProperty('a.entryId');
      expect(wireProjection?.entrants).not.toHaveProperty('b.entryId');
      expect(wireProjection).not.toHaveProperty('manifest');
      expect(wireProjection?.competition).toBe(demoManifest.match.competition.name);

      const workspace = bpWorkspaceSchema.parse(
        (await app.inject('/local/v1/bp-workspace')).json(),
      );
      expect(workspace.demo.active).toBe('bo1');
      expect(workspace.source).toBe('online');
      expect(workspace.match?.entrants.b.name).toBe("Team D'avenir");
      expect(workspace).not.toHaveProperty('match.matchId');
      expect(workspace).not.toHaveProperty('match.entrants.a.entryId');
      expect(workspace).not.toHaveProperty('match.entrants.b.entryId');
      await expect(readFile(matchManifestPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await app.close();
    }

    const restarted = buildApp({ matchManifestPath });
    try {
      const workspace = bpWorkspaceSchema.parse(
        (await restarted.inject('/local/v1/bp-workspace')).json(),
      );
      expect(workspace.demo.active).toBeNull();
      expect(workspace.source).toBe('none');
    } finally {
      await restarted.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
