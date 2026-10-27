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
import { ObsExitSafetyError, type ObsSceneSwitchOptions } from '../obs/reconcile.js';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';

export class ProgramSceneController {
  private updatePending = false;
  private resourceActivationPending = false;
  private deferredResourceScene: ProgramSceneId | undefined;
  setResourceActivationPending(pending: boolean): void {
    this.resourceActivationPending = pending;
    if (!pending && this.deferredResourceScene !== undefined) {
      const target = this.deferredResourceScene;
      this.deferredResourceScene = undefined;
      this.forceScene(target);
    }
  }
  setUpdatePending(pending: boolean): void {
    this.updatePending = pending;
  }
  private director: ProgramDirector | undefined;
  attachDirector(director: ProgramDirector): void {
    this.director = director;
  }
  resumeAutomatic(expectedRevision: string): boolean {
    if (this.updatePending || this.resourceActivationPending) return false;
    if (expectedRevision !== this.revision) return false;
    this.director?.resume();
    this.revision = randomUUID();
    return true;
  }
  cancelAutomatic(): void {
    this.automaticSwitch?.abort();
  }
  setWarmupScene(scene: 'waiting' | 'gameplay', expectedRevision: string): boolean {
    if (
      this.updatePending ||
      this.resourceActivationPending ||
      !this.director ||
      expectedRevision !== this.revision
    )
      return false;
    this.director.setWarmupScene(scene);
    this.automaticSwitch?.abort();
    this.revision = randomUUID();
    return true;
  }
  private active: ProgramSceneId = 'waiting';
  private bpCompact: 'off' | 'on' | 'unknown' = 'off';
  private bpFallbackReason: string | null = null;
  private compactPreparing = false;
  private bpCompactTarget: 'managed' | 'external' = 'managed';
  private revision = randomUUID();
  private introRevision: string | undefined;
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
    private readonly switchObsForExit?: (options: ObsSceneSwitchOptions) => Promise<void>,
    private readonly switchBpCompact?: (visible: boolean) => Promise<void>,
    private readonly bpPresentationMode: () => 'full' | 'compact' = () => 'full',
    private readonly gameBackgroundReady: () => Promise<boolean> = () => Promise.resolve(false),
  ) {}

  private blockedReason(id: ProgramSceneId, automatic = false): string | null {
    if (this.resourceActivationPending) return '官方素材正在激活，请完成后再切换场景。';
    if (this.updatePending && id !== 'waiting')
      return 'Mizar 正在准备升级，请完成升级后再开始制作。';
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
    if (
      !automatic &&
      id !== 'matchup' &&
      series?.maps.some((map) => map.status === 'completed' && map.finalScore !== null)
    )
      return null;
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
      bpCompact: this.bpCompact,
      bpCompactTarget: this.bpCompactTarget,
      revision: this.revision,
      introRevision:
        this.preparing?.target === 'matchup' ? this.preparing.revision : this.introRevision,
      ...(this.preparing ? { preparing: this.preparing } : {}),
      ...(this.director
        ? {
            director: {
              ...this.director.get(),
              reason: this.bpFallbackReason ?? this.director.get().reason,
            },
          }
        : {}),
      available: PROGRAM_SCENES.filter((scene) => !(scene.id in blocked)).map((scene) => scene.id),
      blocked,
    });
  }

  forceScene(id: ProgramSceneId): void {
    this.automaticSwitch?.abort();
    this.director?.hold();
    if (this.resourceActivationPending) {
      this.deferredResourceScene = id;
      return;
    }
    if (this.bpCompact !== 'off' && id !== this.active) {
      this.bpSession.finishSceneExit();
      this.bpCompact = 'unknown';
      const cleanup = this.queue.then(async () => {
        try {
          if (this.bpCompactTarget === 'managed') {
            if (!this.switchBpCompact) throw new Error('OBS 状态待确认。');
            await this.switchBpCompact(false);
          }
          this.bpCompact = 'off';
        } catch {
          /* Keep the uncertain state until a confirmed close. */
        }
        this.revision = randomUUID();
      });
      this.queue = cleanup.catch(() => undefined);
    }
    if (id === 'matchup' && this.active !== id) this.introRevision = randomUUID();
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

  compactDisconnected(): void {
    if (!this.compactPreparing && (this.bpCompactTarget !== 'managed' || this.bpCompact === 'off'))
      return;
    this.bpSession.finishSceneExit();
    this.bpCompact = 'unknown';
    this.bpFallbackReason = '紧凑 BP 状态待核对，请检查 OBS。';
    this.revision = randomUUID();
  }

  setCompact(
    visible: boolean,
    expectedRevision: string,
    target: 'managed' | 'external' = 'managed',
  ) {
    const result = this.queue.then(async () => {
      if (expectedRevision !== this.revision)
        return { ok: false as const, message: '播出状态已变化，请核对后重试。' };
      const actualTarget = visible ? target : this.bpCompactTarget;
      if (visible && this.bpCompact !== 'off' && actualTarget !== this.bpCompactTarget)
        return { ok: false as const, message: '请先关闭当前底栏再切换输出。' };
      if (actualTarget === 'managed' && !this.switchBpCompact)
        return { ok: false as const, message: 'OBS 未配置，无法确认底栏状态。' };
      if (
        visible &&
        (this.blockedReason('bp') !== null ||
          (actualTarget === 'managed' && this.active !== 'gameplay'))
      )
        return { ok: false as const, message: '请先准备完整 BP；受管比赛输出需要切到比赛画面。' };
      const bp = this.bpSession.get();
      if (visible && this.bpCompact !== 'on' && bp.state !== 'hidden')
        return { ok: false as const, message: 'BP 正在其他画面播放，请先关闭。' };
      try {
        this.compactPreparing = actualTarget === 'managed';
        if (actualTarget === 'managed') await this.switchBpCompact!(visible);
        if (
          expectedRevision !== this.revision ||
          (visible && actualTarget === 'managed' && this.active !== 'gameplay')
        ) {
          if (visible && actualTarget === 'managed') await this.switchBpCompact!(false);
          throw new Error('播出状态已变化，请核对后重试。');
        }
        if (
          visible &&
          bp.state === 'hidden' &&
          this.bpSession.command('play', bp.revision) === null
        ) {
          if (actualTarget === 'managed') await this.switchBpCompact!(false);
          throw new Error('BP 状态已变化，请重试。');
        }
        if (!visible && this.bpCompact !== 'off') this.bpSession.finishSceneExit();
        this.bpCompact = visible ? 'on' : 'off';
        if (visible) this.bpCompactTarget = actualTarget;
        this.director?.hold();
        this.revision = randomUUID();
        return { ok: true as const, state: this.get() };
      } catch (error) {
        if (visible) this.bpSession.finishSceneExit();
        this.bpCompact = actualTarget === 'managed' ? 'unknown' : 'off';
        this.revision = randomUUID();
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : '状态待确认。',
        };
      } finally {
        this.compactPreparing = false;
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Exit has its own OBS safety proof; manual Takes still always verify OBS. */
  selectWaitingForExit(expectedRevision: string) {
    this.director?.hold();
    this.automaticSwitch?.abort();
    const result = this.queue.then(() =>
      this.selectSerial('waiting', expectedRevision, undefined, false, true),
    );
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
    exiting = false,
  ) {
    const switchObs =
      exiting && this.switchObsForExit
        ? async (target: ProgramSceneId, options: ObsSceneSwitchOptions) =>
            target === 'waiting'
              ? this.switchObsForExit!(options)
              : this.switchObs?.(target, options)
        : this.switchObs;
    const valid = automaticValid ?? (() => true);
    if (!valid()) return { ok: false as const, message: '自动编排请求已失效，保持当前场景。' };
    if (expectedRevision !== this.revision)
      return { ok: false as const, message: '播出场景已变化，请核对后重试。' };
    const reason = this.blockedReason(id, automaticValid !== undefined);
    if (reason !== null) return { ok: false as const, message: reason };
    if (this.active === id && !automaticValid) {
      // A manual Take also restores OBS after an external scene change or reconnect.
      // Preserve presentation identity (including BP / matchup) on the same scene.
      const restoreCurrent = async () => {
        const target = this.active;
        const revision = this.revision;
        if (target !== id)
          await switchObs?.(target, {
            transition: programTransition(id, target, true),
            valid: () => this.active === target && this.revision === revision,
          }).catch(() => undefined);
      };
      try {
        let physical = id === 'bp' && this.bpCompact === 'on' ? 'gameplay' : id;
        if (physical === 'gameplay' && id === 'bp' && !(await this.gameBackgroundReady())) {
          try {
            await this.switchBpCompact?.(false);
            this.bpCompact = 'off';
          } catch {
            this.bpCompact = 'unknown';
          }
          this.bpFallbackReason = '游戏画面未就绪，本次使用全屏 BP。';
          physical = 'bp';
        }
        await switchObs?.(physical, {
          transition: programTransition(id, id, true),
          valid: () => expectedRevision === this.revision && this.blockedReason(id) === null,
        });
        if (physical === 'gameplay' && id === 'bp') await this.switchBpCompact?.(true);
        if (expectedRevision !== this.revision || this.blockedReason(id) !== null) {
          await restoreCurrent();
          return { ok: false as const, message: '播出状态已变化，请核对后重试。' };
        }
        this.revision = randomUUID();
      } catch (error) {
        await restoreCurrent();
        return {
          ok: false as const,
          message:
            error instanceof ObsExitSafetyError
              ? error.message
              : 'OBS 场景恢复未完成，请检查连接后重试。',
        };
      }
    }
    if (this.active !== id && this.bpCompact !== 'off') {
      try {
        if (this.bpCompactTarget === 'managed') {
          if (!this.switchBpCompact) throw new Error('OBS 状态待确认。');
          await this.switchBpCompact(false);
        }
        this.bpCompact = 'off';
        this.bpSession.finishSceneExit();
      } catch {
        this.bpCompact = 'unknown';
        this.revision = randomUUID();
        return { ok: false as const, message: '紧凑 BP 关闭未确认，请检查 OBS 后重试。' };
      }
    }
    if (this.active !== id) {
      const abort = new AbortController();
      if (automaticValid) this.automaticSwitch = abort;
      const previous = this.active;
      const nextRevision = randomUUID();
      let preparedBpRevision: string | undefined;
      const rollback = async () => {
        if (this.bpCompact === 'on') {
          try {
            await this.switchBpCompact?.(false);
            this.bpCompact = 'off';
          } catch {
            this.bpCompact = 'unknown';
          }
        }
        // A Cut is not delayed by the obsolete automatic transition or its signal.
        await switchObs?.(this.active, {
          transition: programTransition(id, this.active, true),
        }).catch(() => undefined);
        if (preparedBpRevision && this.bpSession.get().revision === preparedBpRevision)
          this.bpSession.finishSceneExit();
      };
      try {
        // Inspect the game before starting the shared reveal clock. A slow OBS
        // screenshot must not consume steps while the operator is still waiting.
        const wantsCompact = id === 'bp' && this.bpPresentationMode() === 'compact';
        const compactReady =
          wantsCompact &&
          !!switchObs &&
          !!this.switchBpCompact &&
          (await this.gameBackgroundReady());
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
            (p.clock?.phase === 'freezetime' && (p.clock.endsInSeconds ?? 0) <= 5));
        this.preparing = { target: id, revision: nextRevision };
        const options: ObsSceneSwitchOptions = {
          transition: programTransition(previous, id, !automaticValid || urgent),
          signal: abort.signal,
          valid: () =>
            valid() &&
            expectedRevision === this.revision &&
            this.blockedReason(id, automaticValid !== undefined) === null,
        };
        let compactTaken = false;
        this.bpFallbackReason = null;
        if (wantsCompact) {
          if (!compactReady || !switchObs || !this.switchBpCompact) {
            this.bpFallbackReason = '游戏画面未就绪，本次使用全屏 BP。';
          } else {
            try {
              await switchObs('gameplay', options);
              this.compactPreparing = true;
              await this.switchBpCompact(true);
              this.bpCompact = 'on';
              this.bpCompactTarget = 'managed';
              compactTaken = true;
            } catch {
              try {
                await this.switchBpCompact(false);
                this.bpCompact = 'off';
              } catch {
                this.bpCompact = 'unknown';
              }
              this.bpFallbackReason = '游戏画面或底栏未确认，本次使用全屏 BP。';
            } finally {
              this.compactPreparing = false;
            }
          }
        }
        if (!compactTaken) await switchObs?.(id, options);
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
            cancelled: abort.signal.aborted || !valid() || expectedRevision !== this.revision,
            message: stillBlocked ?? '自动编排请求已失效，保持当前场景。',
          };
        }
        if (previous === 'bp') this.bpSession.finishSceneExit();
        if (id !== 'bp') this.bpFallbackReason = null;
        this.active = id;
        this.revision = nextRevision;
        if (id === 'matchup') this.introRevision = nextRevision;
      } catch (error) {
        await rollback();
        return {
          ok: false as const,
          cancelled: abort.signal.aborted || !valid() || expectedRevision !== this.revision,
          message:
            error instanceof ObsExitSafetyError
              ? error.message
              : 'OBS 场景切换未完成，当前播出场景保持不变。',
        };
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
    if (
      body?.action === 'warmup' &&
      typeof body.expectedRevision === 'string' &&
      (body.scene === 'waiting' || body.scene === 'gameplay')
    )
      return options.controller.setWarmupScene(body.scene, body.expectedRevision)
        ? options.controller.get()
        : reply.code(409).send({ message: '播出状态已变化，请核对后重试。' });
    if (body?.action !== 'resume' || typeof body.expectedRevision !== 'string')
      return reply.code(400).send({ error: 'invalid_director_command' });
    return options.controller.resumeAutomatic(body.expectedRevision)
      ? options.controller.get()
      : reply.code(409).send({ message: '播出状态已变化，请核对后重试。' });
  });
  app.post('/operator/bp-compact', { bodyLimit: 1024 }, async (request, reply) => {
    if (
      options.originPolicy.mode !== 'loopback' ||
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = request.body as Record<string, unknown> | null;
    if (typeof body?.visible !== 'boolean' || typeof body.expectedRevision !== 'string')
      return reply.code(400).send({ error: 'invalid_bp_compact_command' });
    if (body.target !== undefined && body.target !== 'managed' && body.target !== 'external')
      return reply.code(400).send({ error: 'invalid_bp_compact_target' });
    const result = await options.controller.setCompact(
      body.visible,
      body.expectedRevision,
      body.target,
    );
    return result.ok ? result.state : reply.code(409).send({ message: result.message });
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
