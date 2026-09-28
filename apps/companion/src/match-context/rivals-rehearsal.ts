import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import {
  validateBroadcastManifest,
  validateBroadcastScheduleWindow,
  type BroadcastManifestV1,
  type BroadcastScheduleWindowV1,
} from '@mizar/rivalhub';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { MatchContextController } from './controller.js';
import type { ProgramSceneController } from '../program-scenes/controller.js';

const STAGES = [
  { label: '赛前等待', scene: 'waiting', completedMaps: 0 },
  { label: '对阵', scene: 'matchup', completedMaps: 0 },
  { label: 'BP', scene: 'bp', completedMaps: 0 },
  { label: '第一图 · 比赛中', scene: 'gameplay', completedMaps: 0 },
  { label: '第一图 · 半场', scene: 'halftime', completedMaps: 0 },
  { label: '第一图 · 结果', scene: 'map_result', completedMaps: 1 },
  { label: '图间 · 第二图', scene: 'intermap', completedMaps: 1 },
  { label: '第二图 · 比赛中', scene: 'gameplay', completedMaps: 1 },
  { label: '第二图 · 半场', scene: 'halftime', completedMaps: 1 },
  { label: '第二图 · 结果', scene: 'map_result', completedMaps: 2 },
  { label: '图间 · 决胜图', scene: 'intermap', completedMaps: 2 },
  { label: '决胜图 · 比赛中', scene: 'gameplay', completedMaps: 2 },
  { label: '决胜图 · 半场', scene: 'halftime', completedMaps: 2 },
  { label: '决胜图 · 结果', scene: 'map_result', completedMaps: 3 },
  { label: '整场结果', scene: 'match_result', completedMaps: 3 },
] as const;

type RehearsalFile = {
  schemaVersion: string;
  focusMatchId: string;
  provenance: {
    competitionSource: string;
    gameplaySource: string;
    gameplayRelationship: string;
  };
  schedule: unknown;
  manifests: Record<string, unknown>;
};

export class RivalsRehearsal {
  private fixture: {
    focusMatchId: string;
    schedule: BroadcastScheduleWindowV1;
    manifests: Map<string, BroadcastManifestV1>;
    provenance: RehearsalFile['provenance'];
  } | null = null;
  private selectedMatchId: string | null = null;
  private stageIndex = 0;

  constructor(
    private readonly path: string,
    private readonly controller: MatchContextController,
    private readonly sceneController?: ProgramSceneController,
  ) {}

  private async readFixture() {
    if (this.fixture) return this.fixture;
    const input = JSON.parse(await readFile(this.path, 'utf8')) as RehearsalFile;
    if (input.schemaVersion !== 'mizar.rivals-rehearsal.v1')
      throw new Error('Rivals 示例版本不兼容。');
    const schedule = validateBroadcastScheduleWindow(input.schedule);
    if (!schedule.ok) throw new Error('Rivals 示例赛程无效。');
    const manifests = new Map<string, BroadcastManifestV1>();
    for (const match of schedule.value.matches) {
      const checked = validateBroadcastManifest(input.manifests[match.matchId]);
      if (!checked.ok || checked.value.match.matchId !== match.matchId)
        throw new Error('Rivals 示例比赛资料无效。');
      manifests.set(match.matchId, checked.value);
    }
    if (!manifests.has(input.focusMatchId)) throw new Error('Rivals 示例焦点比赛缺失。');
    this.fixture = {
      focusMatchId: input.focusMatchId,
      schedule: schedule.value,
      manifests,
      provenance: input.provenance,
    };
    return this.fixture;
  }

  view() {
    return {
      loaded: this.selectedMatchId !== null,
      focusMatchId: this.fixture?.focusMatchId ?? null,
      selectedMatchId: this.selectedMatchId,
      stageIndex: this.stageIndex,
      stages: STAGES.map(({ label, scene }) => ({ label, scene })),
      provenance: this.fixture?.provenance ?? null,
    };
  }

  async schedule() {
    return (await this.readFixture()).schedule;
  }

  async load() {
    const fixture = await this.readFixture();
    this.selectedMatchId = fixture.focusMatchId;
    this.stageIndex = 0;
    this.controller.activateFixture(
      this.stageManifest(fixture.manifests.get(fixture.focusMatchId)!, 0),
    );
    this.sceneController?.forceScene('waiting');
    return this.view();
  }

  async select(matchId: string) {
    const fixture = await this.readFixture();
    const manifest = fixture.manifests.get(matchId);
    if (!manifest || this.selectedMatchId === null) throw new Error('示例中没有这场比赛。');
    this.selectedMatchId = matchId;
    this.stageIndex = 0;
    this.controller.activateFixture(
      matchId === fixture.focusMatchId ? this.stageManifest(manifest, 0) : manifest,
    );
    return this.view();
  }

  async stage(index: number) {
    const fixture = await this.readFixture();
    if (
      this.selectedMatchId !== fixture.focusMatchId ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= STAGES.length
    )
      throw new Error('请先加载焦点比赛，再选择演练阶段。');
    const manifest = fixture.manifests.get(fixture.focusMatchId)!;
    this.controller.activateFixture(this.stageManifest(manifest, index));
    this.stageIndex = index;
    const stage = STAGES[index]!;
    this.sceneController?.forceScene(stage.scene);
    return this.view();
  }

  stop() {
    if (this.controller.getActiveBinding()?.origin === 'fixture') this.controller.clearActive();
    this.selectedMatchId = null;
    this.stageIndex = 0;
    this.sceneController?.forceScene('waiting');
    return this.view();
  }

  private stageManifest(final: BroadcastManifestV1, index: number): BroadcastManifestV1 {
    const stage = STAGES[index]!;
    const completed = final.maps.slice(0, stage.completedMaps);
    const scoreA = completed.filter(
      (map) => map.scoreA !== null && map.scoreB !== null && map.scoreA > map.scoreB,
    ).length;
    const scoreB = completed.filter(
      (map) => map.scoreA !== null && map.scoreB !== null && map.scoreB > map.scoreA,
    ).length;
    const finished = index === STAGES.length - 1;
    return {
      ...final,
      revision: `${final.revision}:rehearsal:${index}`,
      match: {
        ...final.match,
        status: finished ? 'finished' : index < 3 ? 'scheduled' : 'in_progress',
        scoreA: scoreA,
        scoreB: scoreB,
        completedAt: finished ? final.match.completedAt : null,
      },
      maps: final.maps.map((map) =>
        map.mapOrder <= stage.completedMaps
          ? map
          : {
              ...map,
              scoreA: null,
              scoreB: null,
              completedAt: null,
            },
      ),
    };
  }
}

export function registerRivalsRehearsalRoutes(
  app: FastifyInstance,
  options: {
    rehearsal: RivalsRehearsal;
    originPolicy: LocalWebOriginPolicy;
    beforeLoad?: () => Promise<void>;
  },
) {
  const allowed = (origin: string | undefined) =>
    options.originPolicy.mode === 'loopback' &&
    checkLocalWebOrigin(options.originPolicy, origin).allowed;
  app.get('/local/v1/rivals-rehearsal', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(options.rehearsal.view()),
  );
  app.post('/operator/rivals-rehearsal/load', async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    try {
      await options.beforeLoad?.();
      return await options.rehearsal.load();
    } catch {
      return reply.code(409).send({ message: 'Rivals 示例暂时无法加载。' });
    }
  });
  app.post('/operator/rivals-rehearsal/stage', async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    try {
      return await options.rehearsal.stage(
        (request.body as { index?: number } | null)?.index ?? -1,
      );
    } catch {
      return reply.code(400).send({ message: '演练阶段无法切换。' });
    }
  });
  app.post('/operator/rivals-rehearsal/stop', async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    return options.rehearsal.stop();
  });
}
