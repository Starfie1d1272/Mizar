import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  PROGRAM_SCENES,
  programSceneIdSchema,
  programSceneStateSchema,
  type ProgramSceneId,
} from '@rivalhub-broadcast/protocol/program-scenes';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import type { BpSession } from '../bp/controller.js';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';

export class ProgramSceneController {
  private active: ProgramSceneId = 'waiting';
  private revision = randomUUID();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly projections: ProjectionCoordinator,
    private readonly bpSession: BpSession,
    private readonly switchObs?: (id: ProgramSceneId) => Promise<void>,
  ) {}

  private blockedReason(id: ProgramSceneId): string | null {
    const { operator, program } = this.projections.getCurrent();
    const series = program.series;
    const fresh = operator.runtime.telemetryFreshness === 'fresh';
    const contextReady = operator.matchContext.freshness === 'fresh';
    const bound = series?.bindingState === 'bound';
    const identitySafe = operator.identity.state !== 'mismatch';
    if (id === 'waiting') return null;
    if (id === 'bp') {
      return this.projections.getBpAssessment().readiness === 'ready' &&
        this.bpSession.get().projection !== null
        ? null
        : 'BP 数据尚未就绪，请先在 BP 制作中检查。';
    }
    if (!contextReady || !bound || !identitySafe) return '比赛绑定、地图归属或选手识别尚未确认。';
    if (id === 'matchup') return null;
    if (id === 'gameplay') return fresh ? null : '比赛数据未就绪，当前播出场景保持不变。';
    if (id === 'halftime')
      return fresh && program.map.phase === 'intermission' ? null : '尚无可信的半场阶段信息。';
    if (id === 'match_result') return series?.status === 'completed' ? null : '整场结果尚未确认。';
    const completed = series?.maps.some((map) => map.status === 'completed' && map.finalScore);
    if (!completed) return '尚无已确认的单图结果。';
    if (id === 'intermap' && series?.status === 'completed') return '整场比赛已结束。';
    return null;
  }

  get() {
    const blocked = Object.fromEntries(
      PROGRAM_SCENES.flatMap((scene) => {
        const reason = this.blockedReason(scene.id);
        return reason === null ? [] : [[scene.id, reason]];
      }),
    );
    return programSceneStateSchema.parse({
      schemaVersion: 'rivalhub.program-scenes.v1',
      active: this.active,
      revision: this.revision,
      available: PROGRAM_SCENES.filter((scene) => !(scene.id in blocked)).map((scene) => scene.id),
      blocked,
    });
  }

  select(id: ProgramSceneId, expectedRevision: string) {
    const result = this.queue.then(() => this.selectSerial(id, expectedRevision));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async selectSerial(id: ProgramSceneId, expectedRevision: string) {
    if (expectedRevision !== this.revision)
      return { ok: false as const, message: '播出场景已变化，请核对后重试。' };
    const reason = this.blockedReason(id);
    if (reason !== null) return { ok: false as const, message: reason };
    if (this.active !== id) {
      try {
        await this.switchObs?.(id);
      } catch {
        return { ok: false as const, message: 'OBS 场景切换未完成，当前播出场景保持不变。' };
      }
      const stillBlocked = this.blockedReason(id);
      if (stillBlocked !== null) {
        if (this.switchObs) await this.switchObs(this.active).catch(() => undefined);
        return { ok: false as const, message: stillBlocked };
      }
      if (id === 'bp') {
        const bp = this.bpSession.get();
        if (bp.state === 'hidden' && this.bpSession.command('play', bp.revision) === null) {
          if (this.switchObs) await this.switchObs(this.active).catch(() => undefined);
          return { ok: false as const, message: 'BP 播放未能启动，当前场景保持不变。' };
        }
      } else if (this.active === 'bp') {
        const bp = this.bpSession.get();
        if (bp.state !== 'hidden' && bp.state !== 'hiding')
          this.bpSession.command('hide', bp.revision);
      }
      this.active = id;
      this.revision = randomUUID();
    }
    return { ok: true as const, state: this.get() };
  }
}

export function registerProgramSceneRoutes(
  app: FastifyInstance,
  options: {
    readonly originPolicy: LocalWebOriginPolicy;
    readonly controller: ProgramSceneController;
  },
) {
  app.get('/local/v1/program-scenes', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(options.controller.get()),
  );
  app.post('/operator/program-scene', { bodyLimit: 2048 }, async (request, reply) => {
    if (
      options.originPolicy.mode !== 'loopback' ||
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = request.body as Record<string, unknown> | null;
    const scene = programSceneIdSchema.safeParse(body?.sceneId);
    if (!scene.success || typeof body?.expectedRevision !== 'string')
      return reply.code(400).send({ error: 'invalid_program_scene_command' });
    const result = await options.controller.select(scene.data, body.expectedRevision);
    return result.ok
      ? result.state
      : reply.code(409).send({ error: 'program_scene_unavailable', message: result.message });
  });
}
