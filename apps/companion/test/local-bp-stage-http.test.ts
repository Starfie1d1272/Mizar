import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { projectBp, DEFAULT_LOCAL_BP_MAP_POOL } from '@mizar/core/projection';
import { toMatchDocumentV1 } from '@mizar/rivalhub';
import { LocalTournamentStore } from '../src/match-context/local-tournament-store.js';
import { MatchContextController } from '../src/match-context/controller.js';
import { MatchManifestLkgStore } from '../src/match-context/lkg-store.js';
import { registerBpWorkspaceRoutes } from '../src/bp/workspace-controller.js';
import { bpAuthoringDraftFromBinding, createLocalBpManifest } from '../src/bp/local-draft.js';

it('saves the BP stage label without changing its key, including reload and current projection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-bp-stage-'));
  const path = join(directory, 'tournament.json');
  const store = new LocalTournamentStore(path);
  const controller = new MatchContextController({
    lkgStore: new MatchManifestLkgStore({ filePath: join(directory, 'lkg.json') }),
  });
  const app = Fastify();
  registerBpWorkspaceRoutes(app, {
    controller,
    localTournamentStore: store,
    originPolicy: { mode: 'loopback', bindHost: '127.0.0.1', allowedOrigins: [] },
    projections: {} as Parameters<typeof registerBpWorkspaceRoutes>[1]['projections'],
    demoState: {} as Parameters<typeof registerBpWorkspaceRoutes>[1]['demoState'],
  });
  try {
    const document = await store.createMatch({
      teamA: 'A',
      teamB: 'B',
      format: 'bo3',
      mapPool: [...DEFAULT_LOCAL_BP_MAP_POOL],
    });
    controller.activateLocalDocument(document);
    const initial = bpAuthoringDraftFromBinding(controller.getActiveBinding()!);
    expect.soft(initial.stage).toBe('本地比赛');
    // Synthetic BP choices isolate authoring metadata from game observations.
    const pool = initial.mapPool;
    const draft = {
      ...initial,
      stage: '总决赛',
      bans: pool.slice(0, 4),
      picks: pool.slice(4, 6).map((mapName) => ({ mapName, side: 'CT' as const })),
      deciderSide: 'CT' as const,
    };
    const response = await app.inject({
      method: 'POST',
      url: '/operator/bp-local-save',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { draft, expectedContextRevision: controller.getActiveRevision() },
    });
    expect(response.statusCode, response.body).toBe(200);
    const saved = store.getSnapshot().matches[0]!;
    expect(saved.stage).toBe('local');
    expect(saved.stageLabel).toBe('总决赛');
    expect(projectBp(controller.getActiveBinding()!.context)?.stage).toBe('总决赛');
    const restarted = new LocalTournamentStore(path);
    await restarted.load();
    expect(restarted.getSnapshot().matches[0]).toEqual(saved);
    controller.activateLocalDocument(restarted.getSnapshot().matches[0]);
    expect(bpAuthoringDraftFromBinding(controller.getActiveBinding()!).stage).toBe('总决赛');
    expect(projectBp(controller.getActiveBinding()!.context)?.stage).toBe('总决赛');

    const bound = {
      ...controller.getActiveBinding()!,
      localAuthoringMode: 'bound-overlay' as const,
    };
    const recovered = bpAuthoringDraftFromBinding(bound);
    expect(createLocalBpManifest(recovered, bound).ok).toBe(true);
    expect(createLocalBpManifest({ ...recovered, stage: '其他阶段' }, bound)).toMatchObject({
      ok: false,
      code: 'bp_bound_identity_locked',
    });

    // Legacy manifests lack separate stage metadata; explicit keys must not be inferred from labels.
    for (const key of [undefined, null, 'playoffs']) {
      const binding = controller.getActiveBinding()!;
      const legacy = {
        ...binding,
        manifest: {
          ...binding.manifest,
          match: {
            ...binding.manifest.match,
            stage: '旧阶段',
            stageKey: key,
            stageLabel: undefined,
          },
        },
      };
      expect(bpAuthoringDraftFromBinding(legacy).stage).toBe('旧阶段');
      const compiled = createLocalBpManifest({ ...draft, stage: '新阶段' }, legacy);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) throw new Error(compiled.code);
      const converted = toMatchDocumentV1(compiled.manifest);
      expect(converted.stage).toBe(key === undefined ? '新阶段' : (key ?? '旧阶段'));
      expect(converted.stageLabel).toBe('新阶段');
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
