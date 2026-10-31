import type { ProgramProjection } from '@mizar/core/projection';
import {
  programTransition,
  type ProgramSceneId,
  type ProgramSceneState,
} from '@mizar/protocol/program-scenes';
import type { BpSession } from '../bp/controller.js';
import {
  sceneExecutionScope,
  sceneMatchScope,
  sceneRequestScope,
  sceneResultScope,
} from '../scope/identities.js';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import type { ProgramSceneController } from './controller.js';
import { isRegulationHalftime } from './presentation.js';

export const DEFAULT_PROGRAM_TIMINGS = Object.freeze({
  bpFinalMs: 12_000,
  introMs: 6_000,
  shortIntroMs: 2_000,
  hudLeadMs: 5_000,
  halftimeLeadMs: 5_000,
  mapResultMs: 12_000,
  ggHoldMs: 3_000,
  warmupFinalMs: 10_000,
  bpRevealSettleMs: 450,
  // Reserve the existing OBS completion window; this is budget, never a sleep.
  switchBudgetMs: 1000,
});
type DirectorView = NonNullable<ProgramSceneState['director']>;

/** Choreography only: never mutates Runtime or SeriesProgress. One in-flight request, no queue. */
export class ProgramDirector {
  private view: DirectorView = {
    mode: 'preparation',
    next: null,
    nextStatus: 'awaiting',
    nextReason: '等待编排数据。',
    readyToTake: null,
    reason: null,
    introDurationMs: 6000,
    sceneElapsedMs: 0,
  };
  private manual = false;
  private failure: string | null = null;
  private inFlight: ProgramSceneId | null = null;
  private warmupChoice: 'waiting' | 'gameplay' = 'waiting';
  private warmupChoiceKey = '';
  private lastTime: number | null = null;
  private elapsed = 0;
  private scene: ProgramSceneId = 'waiting';
  private predictionKey = '';
  private matchKey = '';
  private mapKey = '';
  private warmupPlayed = false;
  private warmupFinalElapsed = 0;
  private introStarted = false;
  private introFinished = false;
  private halftimeSeen = false;
  private resultShown = false;
  private wasProduction = false;
  private generation = 0;
  private observedLiveMap: string | null = null;
  private ggStartedAt: number | null = null;
  private ggConsumedMap: string | null = null;
  constructor(
    private readonly projections: ProjectionCoordinator,
    private readonly scenes: ProgramSceneController,
    private readonly bp: BpSession,
    private readonly production: () => boolean,
    private readonly now = () => performance.now(),
    private readonly timings = DEFAULT_PROGRAM_TIMINGS,
  ) {}
  get(): DirectorView {
    return { ...this.view, warmupScene: this.warmupChoice, sceneElapsedMs: this.elapsed };
  }
  setWarmupScene(scene: 'waiting' | 'gameplay'): void {
    this.warmupChoice = scene;
    this.warmupChoiceKey = sceneMatchScope(this.projections.getCurrent().program);
    this.generation++;
  }
  private takeBudget(from: ProgramSceneId, to: ProgramSceneId): number {
    return programTransition(from, to).durationMs + this.timings.switchBudgetMs;
  }
  private hudDue(p: ProgramProjection, active: ProgramSceneId): boolean {
    return (
      p.map.phase === 'live' &&
      (p.round?.phase === 'live' ||
        (p.clock?.phase === 'freezetime' &&
          p.clock.endsInSeconds !== null &&
          p.clock.endsInSeconds * 1000 <=
            this.timings.hudLeadMs + this.takeBudget(active, 'gameplay')))
    );
  }
  hold(): void {
    this.ggStartedAt = null;
    this.view.gg = null;
    this.manual = true;
    this.generation++;
    this.view = {
      ...this.view,
      mode: 'manual',
      blockCause: null,
      readyToTake: null,
      reason: '手动保持，恢复自动后继续。',
    };
  }
  resume(): void {
    this.manual = false;
    this.failure = null;
    this.lastTime = this.now();
    this.generation++;
  }
  private safe(p: ProgramProjection): boolean {
    return (
      p.status.context === 'fresh' &&
      p.status.telemetry === 'fresh' &&
      p.status.identity !== 'mismatch' &&
      p.series?.bindingState === 'bound'
    );
  }
  private predict(p: ProgramProjection, active: ProgramSceneId): void {
    const key = `${sceneRequestScope(p)}:${active}`;
    const previous = key === this.predictionKey ? this.view.next : null;
    this.predictionKey = key;
    this.view.next = null;
    this.view.nextStatus = 'awaiting';
    this.view.nextReason = '比赛阶段待确认。';
    this.view.readyToTake = null;
    if (
      !p.match ||
      !p.series ||
      p.status.context !== 'fresh' ||
      p.status.identity === 'mismatch' ||
      p.series.bindingState !== 'bound'
    ) {
      this.view.nextReason = '等待有效比赛上下文与归属确认。';
      return;
    }
    if (p.status.telemetry !== 'fresh') {
      if (previous) {
        this.setPrediction(previous);
        this.view.nextReason = '沿用同一比赛阶段的最近预告，等待遥测恢复后才可自动切场。';
      } else this.view.nextReason = '缺少当前比赛阶段资料，等待有效遥测。';
      return;
    }
    let next: ProgramSceneId | null = null;
    if (p.map.phase === 'gameover') {
      if (active === 'match_result' && p.series?.status === 'completed') {
        this.view.nextStatus = 'complete';
        this.view.nextReason = '本场节目已结束。';
        return;
      }
      if (active === 'map_result')
        next = p.series?.status === 'completed' ? 'match_result' : 'intermap';
      else if (active === 'intermap') {
        if (p.series?.status === 'completed') next = 'match_result';
        else if (
          p.series.maps.some(
            (map) =>
              map.mapOrder > (p.series!.currentMapOrder ?? 0) &&
              map.status === 'pending' &&
              map.mapName,
          )
        ) {
          next = this.projections.getBpAssessment().readiness === 'ready' ? 'bp' : 'matchup';
        } else {
          this.view.nextReason = '缺少下一图计划。';
          return;
        }
      } else next = 'map_result';
    } else if (isRegulationHalftime(p)) {
      next = active === 'halftime' ? 'gameplay' : 'halftime';
    } else if (active === 'halftime' && this.halftimeSeen) {
      next = 'gameplay';
    } else if (p.map.phase === 'live' || p.map.phase === 'intermission') {
      if (active === 'gameplay') {
        const { ct, t } = p.map.score;
        // Score is completed rounds; 12:12 and every OT half lead to results.
        if (ct !== null && t !== null) next = ct + t < 12 ? 'halftime' : 'map_result';
      } else if (active === 'bp') next = 'matchup';
      else next = 'gameplay';
    } else if (p.map.phase === 'warmup') {
      if (active === 'bp') next = this.warmupChoice;
      else if (!this.warmupPlayed && this.projections.getBpAssessment().readiness === 'ready')
        next = 'bp';
      else next = 'matchup';
    }
    if (next) this.setPrediction(next);
  }
  private setPrediction(next: ProgramSceneId): void {
    this.view.next = next;
    this.view.nextStatus = 'predicted';
    this.view.nextReason = '后续节目预告，实际切换仍需满足比赛与播出条件。';
  }
  async tick(): Promise<void> {
    if (this.inFlight) {
      const current = this.projections.getCurrent().program;
      if (
        this.inFlight !== 'gameplay' &&
        !this.manual &&
        this.safe(current) &&
        this.hudDue(current, this.scenes.get().active)
      )
        this.scenes.cancelAutomatic();
      return;
    }
    const time = this.now();
    const delta = this.lastTime === null ? 0 : Math.min(1000, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    const { program: p, operator } = this.projections.getCurrent();
    const choiceKey = sceneMatchScope(p);
    if (choiceKey !== this.warmupChoiceKey) {
      this.warmupChoiceKey = choiceKey;
      this.warmupChoice = 'waiting';
    }
    this.view.gg = null;
    this.predict(p, this.scenes.get().active);
    const production = this.production() && operator.matchContext.origin !== 'fixture';
    this.bp.setPaused(
      production &&
        (!this.safe(p) || ['paused', 'timeout_ct', 'timeout_t'].includes(p.clock?.phase ?? '')),
    );
    if (!production) {
      this.wasProduction = false;
      this.view = {
        ...this.view,
        mode: 'preparation',
        blockCause: null,
        reason: null,
      };
      return;
    }
    if (!this.wasProduction) {
      this.wasProduction = true;
      if (!this.manual) this.resume();
    }
    if (this.failure && !this.manual) {
      this.view = { ...this.view, mode: 'blocked', reason: this.failure, blockCause: null };
      return;
    }
    const matchKey = sceneMatchScope(p);
    if (matchKey !== this.matchKey) {
      this.matchKey = matchKey;
      this.mapKey = '';
      this.warmupPlayed = false;
      this.warmupFinalElapsed = 0;
    }
    const mapKey = sceneExecutionScope(p);
    if (mapKey !== this.mapKey) {
      this.mapKey = mapKey;
      this.introStarted = false;
      this.introFinished = false;
      this.halftimeSeen = false;
      this.resultShown = false;
      this.elapsed = 0;
      this.ggStartedAt = null;
      this.view.gg = null;
    }
    const active = this.scenes.get().active;
    if (active !== this.scene) {
      this.scene = active;
      this.elapsed = 0;
    }
    const halftime = isRegulationHalftime(p);
    if (active === 'halftime' && p.map.roundNumber === 12 && p.clock?.phase === 'freezetime')
      this.halftimeSeen = true;
    const paused = ['paused', 'timeout_ct', 'timeout_t'].includes(p.clock?.phase ?? '');
    if (!this.safe(p)) {
      this.ggStartedAt = null;
      this.view.gg = null;
      this.view = {
        ...this.view,
        mode: this.manual ? 'manual' : 'blocked',
        blockCause:
          !this.manual &&
          p.status.telemetry !== 'fresh' &&
          p.status.context === 'fresh' &&
          p.status.identity !== 'mismatch' &&
          p.series?.bindingState !== 'needs_operator'
            ? 'telemetry'
            : null,
        reason: '比赛数据过期或归属未确认，保持当前画面。',
      };
      return;
    }
    if (paused && !halftime && !this.halftimeSeen) {
      this.view = {
        ...this.view,
        mode: this.manual ? 'manual' : 'blocked',
        blockCause: null,
        reason: '比赛暂停，保持当前画面。',
      };
      return;
    }
    this.view = {
      ...this.view,
      mode: this.manual ? 'manual' : 'auto',
      blockCause: null,
      reason: this.manual ? '手动保持，恢复自动后继续。' : null,
    };
    if (!paused && !this.manual) this.elapsed += delta;
    const seconds = p.clock?.phase === 'freezetime' ? p.clock.endsInSeconds : null;
    const remaining = seconds === null ? 0 : seconds * 1000;
    let target: ProgramSceneId | null = null;
    let finalBp = false;
    const cueMap = sceneResultScope(p);
    if (p.map.phase === 'live') this.observedLiveMap = cueMap;
    if (
      p.map.phase === 'gameover' &&
      p.series?.maps.some(
        (map) => map.status === 'completed' && map.mapName === p.map.name && map.finalScore,
      )
    ) {
      if (!this.resultShown) {
        if (this.ggConsumedMap !== cueMap) {
          this.ggConsumedMap = cueMap;
          if (active === 'gameplay' && !this.manual && this.observedLiveMap === cueMap)
            this.ggStartedAt = time;
        }
        const remainingMs =
          this.ggStartedAt === null
            ? 0
            : Math.max(0, this.timings.ggHoldMs - (time - this.ggStartedAt));
        this.view.gg =
          remainingMs > 0 && active === 'gameplay' && !this.manual
            ? { mapEpoch: p.cursor.mapEpoch, remainingMs }
            : null;
        this.setPrediction('map_result');
        if (!this.view.gg) target = 'map_result';
      } else if (active === 'map_result') {
        const following = p.series.status === 'completed' ? 'match_result' : 'intermap';
        this.setPrediction(following);
        if (this.elapsed >= this.timings.mapResultMs) target = following;
      }
    } else if (halftime) {
      this.halftimeSeen = true;
      target = 'halftime';
    } else if (this.halftimeSeen && active === 'halftime') {
      this.setPrediction('gameplay');
      if (
        p.round?.phase === 'live' ||
        (seconds !== null &&
          seconds > 0 &&
          remaining <= this.timings.halftimeLeadMs + this.takeBudget(active, 'gameplay'))
      )
        target = 'gameplay';
    } else if (p.map.phase === 'warmup') {
      if (!this.warmupPlayed && this.projections.getBpAssessment().readiness === 'ready')
        target = 'bp';
      else if (active === 'bp') {
        if (this.bp.get().state === 'shown') {
          if (!this.manual) this.warmupFinalElapsed += delta;
          this.setPrediction(this.warmupChoice);
          if (this.warmupFinalElapsed >= this.timings.warmupFinalMs + this.timings.bpRevealSettleMs)
            target = this.warmupChoice;
        } else this.warmupFinalElapsed = 0;
      } else target = this.warmupChoice;
    } else if (p.map.phase === 'live') {
      const firstFreeze =
        p.map.roundNumber === 0 &&
        p.round?.phase === 'freezetime' &&
        seconds !== null &&
        seconds > 0;
      const introBudget =
        remaining -
        this.timings.hudLeadMs -
        this.takeBudget(active, 'matchup') -
        this.takeBudget('matchup', 'gameplay');
      const introDuration =
        introBudget >= this.timings.introMs
          ? this.timings.introMs
          : introBudget >= this.timings.shortIntroMs
            ? this.timings.shortIntroMs
            : null;
      if (!firstFreeze || this.introFinished || this.hudDue(p, active)) {
        if (!this.manual) this.introFinished = true;
        target = 'gameplay';
      } else if (active === 'matchup' && this.introStarted) {
        this.setPrediction('gameplay');
        if (this.elapsed >= this.view.introDurationMs) {
          if (!this.manual) this.introFinished = true;
          target = 'gameplay';
        }
      } else if (active === 'bp' && this.introStarted) {
        this.setPrediction('matchup');
        if (this.elapsed >= this.timings.bpFinalMs || introBudget <= this.timings.introMs) {
          if (introDuration !== null) target = 'matchup';
          else {
            if (!this.manual) this.introFinished = true;
            target = 'gameplay';
          }
        }
      } else if (!this.introStarted) {
        const recapBudget =
          remaining -
          this.timings.hudLeadMs -
          this.takeBudget(active, 'bp') -
          this.takeBudget('bp', 'matchup') -
          this.takeBudget('matchup', 'gameplay') -
          this.timings.introMs;
        if (
          recapBudget >= this.timings.shortIntroMs &&
          this.projections.getBpAssessment().readiness === 'ready'
        ) {
          target = 'bp';
          finalBp = true;
        } else if (introDuration !== null) target = 'matchup';
        else {
          if (!this.manual) this.introFinished = true;
          target = 'gameplay';
        }
      }
      if (target === 'matchup') this.view.introDurationMs = introDuration!;
    }
    if (!target) return;
    this.view.readyToTake = target === active ? null : target;
    if (target !== active) this.setPrediction(target);
    // Manual hold keeps the recommendation live without issuing or consuming a Take.
    if (this.manual) return;
    if (target === active) {
      if (finalBp) {
        this.bp.showFinal();
        this.introStarted = true;
        this.elapsed = 0;
      } else if (target === 'bp' && !this.warmupPlayed) {
        this.warmupPlayed = true;
        this.warmupFinalElapsed = 0;
      }
      if (target === 'matchup' && !this.introStarted) {
        this.introStarted = true;
        this.elapsed = 0;
      }
      if (target === 'map_result' && !this.resultShown) {
        this.resultShown = true;
        this.elapsed = 0;
      }
      return;
    }
    this.inFlight = target;
    const generation = this.generation;
    const key = sceneRequestScope(p);
    try {
      const result = await this.scenes.selectAutomatic(
        target,
        this.scenes.get().revision,
        () =>
          !this.manual &&
          generation === this.generation &&
          this.production() &&
          this.safe(this.projections.getCurrent().program) &&
          (target !== 'matchup' ||
            (this.projections.getCurrent().program.round?.phase === 'freezetime' &&
              this.projections.getCurrent().program.clock?.phase === 'freezetime' &&
              (this.projections.getCurrent().program.clock?.endsInSeconds ?? 0) * 1000 >=
                this.timings.hudLeadMs +
                  this.takeBudget(this.scenes.get().active, 'matchup') +
                  this.takeBudget('matchup', 'gameplay') +
                  this.timings.shortIntroMs)) &&
          key === sceneRequestScope(this.projections.getCurrent().program),
        finalBp,
      );
      if (!result.ok) {
        if ('cancelled' in result && result.cancelled) return;
        // A changed automatic choice or a consumed real freeze budget is a normal
        // cancellation. Re-evaluate current facts instead of permanently blocking.
        const current = this.projections.getCurrent().program;
        if (
          generation !== this.generation ||
          (key === sceneRequestScope(current) &&
            target !== 'gameplay' &&
            this.safe(current) &&
            (this.hudDue(current, this.scenes.get().active) ||
              (target === 'matchup' &&
                (current.clock?.endsInSeconds ?? 0) * 1000 <
                  this.timings.hudLeadMs +
                    this.takeBudget(this.scenes.get().active, 'matchup') +
                    this.takeBudget('matchup', 'gameplay') +
                    this.timings.shortIntroMs)))
        )
          return;
        if (!this.manual) this.failure = result.message;
        return;
      }
      this.scene = target;
      this.elapsed = 0;
      if (target === 'bp') {
        if (finalBp) {
          this.introStarted = true;
        } else {
          this.warmupPlayed = true;
          this.warmupFinalElapsed = 0;
        }
      }
      if (target === 'matchup') this.introStarted = true;
      if (target === 'map_result') this.resultShown = true;
      this.predict(this.projections.getCurrent().program, target);
    } finally {
      this.inFlight = null;
    }
  }
}
