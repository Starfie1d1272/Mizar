import { isRegulationHalftime } from './presentation.js';
import type { ProgramDirector } from './director.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  PROGRAM_SCENES,
  programSceneIdSchema,
  programSceneStateSchema,
  programTransition,
  type ProgramSceneId,
} from '@mizar/protocol/program-scenes';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import type { BpSession } from '../bp/controller.js';
import type { ObsSceneSwitchOptions } from '../obs/reconcile.js';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';

export class ProgramSceneController {
  private director: ProgramDirector | undefined;
  attachDirector(director: ProgramDirector): void {
    this.director = director;
  }
  resumeAutomatic(expectedRevision: string): boolean {
    if (expectedRevision !== this.revision) return false;
    this.director?.resume();
    this.revision = randomUUID();
    return true;
  }
  private active: ProgramSceneId = 'waiting';
  private revision = randomUUID();
  private queue: Promise<unknown> = Promise.resolve();
  private automaticSwitch: AbortController | undefined;
  private preparing: { target: ProgramSceneId; revision: string } | undefined;

  constructor(
    private readonly projections: ProjectionCoordinator,
    private readonly bpSession: BpSession,
    private readonly switchObs?: (
      id: ProgramSceneId,
      options: ObsSceneSwitchOptions,
    ) => Promise<void>,
  ) {}

  private blockedReason(id: ProgramSceneId, automatic = false): string | null {
    const { operator, program } = this.projections.getCurrent();
    const series = program.series;
    const fresh = operator.runtime.telemetryFreshness === 'fresh';
    const contextReady = operator.matchContext.freshness === 'fresh';
    const isRehearsal = operator.matchContext.origin === 'fixture';
    const bound = series?.bindingState === 'bound' || isRehearsal;
    const identitySafe = operator.identity.state !== 'mismatch';
    if (id === 'waiting') return null;
    // A manual Gameplay Take can broadcast an observed demo without claiming
    // that it belongs to the selected event. Automatic choreography still uses
    // the Director's stricter context / binding / identity gate.
    if (id === 'gameplay')
      return fresh || isRehearsal ? null : '比赛数据未就绪，当前播出场景保持不变。';
    if (id === 'bp') {
      return this.projections.getBpAssessment().readiness === 'ready' &&
        this.bpSession.get().projection !== null
        ? null
        : 'BP 数据尚未就绪，请先在 BP 制作中检查。';
    }
    if (!contextReady) return '请先选择并保存比赛资料；资料过期时请刷新。';
    if (!identitySafe) return '当前游戏选手与所选比赛不一致，请切换比赛或核对名单。';
    if (!bound) return '当前游戏尚未对应到比赛地图，请在比赛资料中核对地图和双方名单。';
    if (id === 'matchup') return null;
    // Manual scene selection is presentation control, never result confirmation.
    // Missing snapshots render an explicit pending board; automatic cues keep their gates.
    if (!automatic) return null;
    if (id === 'halftime')
      return (fresh && isRegulationHalftime(program)) || isRehearsal
        ? null
        : '尚无可信的半场阶段信息。';
    if (id === 'match_result')
      return series?.status === 'completed' || isRehearsal ? null : '整场结果尚未确认。';
    const completed = series?.maps.some((map) => map.status === 'completed' && map.finalScore);
    if (!completed && !isRehearsal) return '尚无已确认的单图结果。';
    if (id === 'intermap' && series?.status === 'completed' && !isRehearsal)
      return '整场比赛已结束。';
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
      schemaVersion: 'mizar.program-scenes.v1',
      active: this.active,
      revision: this.revision,
      ...(this.preparing ? { preparing: this.preparing } : {}),
      ...(this.director ? { director: this.director.get() } : {}),
      available: PROGRAM_SCENES.filter((scene) => !(scene.id in blocked)).map((scene) => scene.id),
      blocked,
    });
  }

  forceScene(id: ProgramSceneId): void {
    this.automaticSwitch?.abort();
    this.director?.hold();
    this.active = id;
    this.revision = randomUUID();
  }

  select(id: ProgramSceneId, expectedRevision: string) {
    if (expectedRevision === this.revision) {
      this.director?.hold();
      this.automaticSwitch?.abort();
    }
    const result = this.queue.then(() => this.selectSerial(id, expectedRevision));
    this.queue = result.catch(() => undefined);
    return result;
  }

  selectAutomatic(
    id: ProgramSceneId,
    expectedRevision: string,
    valid: () => boolean,
    finalBp = false,
  ) {
    const result = this.queue.then(() => this.selectSerial(id, expectedRevision, valid, finalBp));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async selectSerial(
    id: ProgramSceneId,
    expectedRevision: string,
    automaticValid?: () => boolean,
    finalBp = false,
  ) {
    const valid = automaticValid ?? (() => true);
    if (!valid()) return { ok: false as const, message: '自动编排请求已失效，保持当前场景。' };
    if (expectedRevision !== this.revision)
      return { ok: false as const, message: '播出场景已变化，请核对后重试。' };
    const reason = this.blockedReason(id, automaticValid !== undefined);
    if (reason !== null) return { ok: false as const, message: reason };
    if (this.active !== id) {
      const abort = new AbortController();
      if (automaticValid) this.automaticSwitch = abort;
      const previous = this.active;
      const nextRevision = randomUUID();
      let preparedBpRevision: string | undefined;
      const rollback = async () => {
        // A Cut is not delayed by the obsolete automatic transition or its signal.
        await this.switchObs?.(this.active, {
          transition: programTransition(id, this.active, true),
        }).catch(() => undefined);
        if (preparedBpRevision && this.bpSession.get().revision === preparedBpRevision)
          this.bpSession.finishSceneExit();
      };
      try {
        if (id === 'bp') {
          const bp = this.bpSession.get();
          if (bp.state === 'hidden') {
            if (this.bpSession.command('play', bp.revision) === null)
              return { ok: false as const, message: 'BP 播放未能启动，当前场景保持不变。' };
            if (finalBp) this.bpSession.showFinal();
            preparedBpRevision = this.bpSession.get().revision;
          } else if (finalBp) this.bpSession.showFinal();
        }
        const p = this.projections.getCurrent().program;
        const urgent =
          id === 'gameplay' &&
          (p.round?.phase === 'live' ||
            (p.clock?.phase === 'freezetime' && (p.clock.endsInSeconds ?? 0) <= 1));
        this.preparing = { target: id, revision: nextRevision };
        await this.switchObs?.(id, {
          transition: programTransition(previous, id, !automaticValid || urgent),
          signal: abort.signal,
          valid: () =>
            valid() &&
            expectedRevision === this.revision &&
            this.blockedReason(id, automaticValid !== undefined) === null,
        });
        const stillBlocked = this.blockedReason(id, automaticValid !== undefined);
        if (
          stillBlocked !== null ||
          !valid() ||
          abort.signal.aborted ||
          expectedRevision !== this.revision
        ) {
          await rollback();
          return {
            ok: false as const,
            message: stillBlocked ?? '自动编排请求已失效，保持当前场景。',
          };
        }
        if (previous === 'bp') this.bpSession.finishSceneExit();
        this.active = id;
        this.revision = nextRevision;
      } catch {
        await rollback();
        return { ok: false as const, message: 'OBS 场景切换未完成，当前播出场景保持不变。' };
      } finally {
        this.preparing = undefined;
        if (this.automaticSwitch === abort) this.automaticSwitch = undefined;
      }
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
  app.post('/operator/program-director', { bodyLimit: 1024 }, (request, reply) => {
    if (
      options.originPolicy.mode !== 'loopback' ||
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = request.body as Record<string, unknown> | null;
    if (body?.action !== 'resume' || typeof body.expectedRevision !== 'string')
      return reply.code(400).send({ error: 'invalid_director_command' });
    return options.controller.resumeAutomatic(body.expectedRevision)
      ? options.controller.get()
      : reply.code(409).send({ message: '播出状态已变化，请核对后重试。' });
  });
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
