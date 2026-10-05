import type { ProgramProjection } from '@mizar/core/projection';
import type { ProgramSceneId, ProgramSceneState } from '@mizar/protocol/program-scenes';
import type { BpSession } from '../bp/controller.js';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import type { ProgramSceneController } from './controller.js';
import { isRegulationHalftime } from './presentation.js';

export const DEFAULT_PROGRAM_TIMINGS = Object.freeze({
  bpFinalMs: 10_000,
  introMs: 6_000,
  shortIntroMs: 2_000,
  hudLeadMs: 9_000,
  halftimeLeadMs: 5_000,
  mapResultMs: 12_000,
  ggHoldMs: 3_000,
  warmupFinalMs: 2_000,
});
type DirectorView = NonNullable<ProgramSceneState['director']>;

/** Choreography only: never mutates Runtime or SeriesProgress. One in-flight request, no queue. */
export class ProgramDirector {
  private view: DirectorView = {
    mode: 'preparation',
    next: null,
    reason: null,
    introDurationMs: 6000,
    sceneElapsedMs: 0,
  };
  private manual = false;
  private failure: string | null = null;
  private inFlight = false;
  private lastTime: number | null = null;
  private elapsed = 0;
  private scene: ProgramSceneId = 'waiting';
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
    return { ...this.view, sceneElapsedMs: this.elapsed };
  }
  hold(): void {
    this.ggStartedAt = null;
    this.view.gg = null;
    this.manual = true;
    this.generation++;
    this.view = { ...this.view, mode: 'manual', next: null, reason: '手动保持，恢复自动后继续。' };
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
  private contextKey(p: ProgramProjection): string {
    return JSON.stringify([
      p.match?.matchId,
      p.series?.entrants.a.entryId,
      p.series?.entrants.b.entryId,
      p.series?.format,
      p.series?.maps.map((map) => [map.mapOrder, map.mapName]),
    ]);
  }
  private executionKey(p: ProgramProjection): string {
    return `${this.contextKey(p)}:${p.cursor.producerInstanceId}:${p.cursor.liveSessionId}:${p.cursor.programSourceGeneration}:${p.cursor.mapEpoch}:${p.series?.currentMapOrder}`;
  }
  async tick(): Promise<void> {
    if (this.inFlight) return;
    const time = this.now();
    const delta = this.lastTime === null ? 0 : Math.min(1000, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    const { program: p, operator } = this.projections.getCurrent();
    this.view.gg = null;
    const production = this.production() && operator.matchContext.origin !== 'fixture';
    this.bp.setPaused(
      production &&
        (!this.safe(p) || ['paused', 'timeout_ct', 'timeout_t'].includes(p.clock?.phase ?? '')),
    );
    if (!production) {
      this.wasProduction = false;
      this.view = { ...this.view, mode: 'preparation', next: null, reason: null };
      return;
    }
    if (!this.wasProduction) {
      this.wasProduction = true;
      this.resume();
    }
    if (this.failure && !this.manual) {
      this.view = { ...this.view, mode: 'blocked', reason: this.failure };
      return;
    }
    const matchKey = this.contextKey(p);
    if (matchKey !== this.matchKey) {
      this.matchKey = matchKey;
      this.mapKey = '';
      this.warmupPlayed = false;
      this.warmupFinalElapsed = 0;
    }
    const mapKey = this.executionKey(p);
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
        next: null,
        reason: '比赛数据过期或归属未确认，保持当前画面。',
      };
      return;
    }
    if (paused && !halftime && !this.halftimeSeen) {
      this.view = {
        ...this.view,
        mode: this.manual ? 'manual' : 'blocked',
        next: null,
        reason: '比赛暂停，保持当前画面。',
      };
      return;
    }
    this.view = {
      ...this.view,
      mode: this.manual ? 'manual' : 'auto',
      reason: this.manual ? '手动保持，恢复自动后继续。' : null,
      next: null,
    };
    if (!paused && !this.manual) this.elapsed += delta;
    const seconds = p.clock?.phase === 'freezetime' ? p.clock.endsInSeconds : null;
    const remaining = seconds === null ? 0 : seconds * 1000;
    let target: ProgramSceneId | null = null;
    let finalBp = false;
    const cueMap = `${matchKey}:${p.cursor.liveSessionId}:${p.cursor.mapEpoch}`;
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
        this.view.next = 'map_result';
        if (!this.view.gg) target = 'map_result';
      } else if (active === 'map_result') {
        this.view.next = p.series.status === 'completed' ? 'match_result' : 'intermap';
        if (this.elapsed >= this.timings.mapResultMs) target = this.view.next;
      }
    } else if (halftime) {
      this.halftimeSeen = true;
      target = 'halftime';
    } else if (this.halftimeSeen && active === 'halftime') {
      this.view.next = 'gameplay';
      if (
        p.round?.phase === 'live' ||
        (seconds !== null && seconds > 0 && remaining <= this.timings.halftimeLeadMs)
      )
        target = 'gameplay';
    } else if (p.map.phase === 'warmup') {
      if (!this.warmupPlayed && this.projections.getBpAssessment().readiness === 'ready')
        target = 'bp';
      else if (active === 'bp' && this.bp.get().state === 'shown') {
        if (!this.manual) this.warmupFinalElapsed += delta;
        this.view.next = 'waiting';
        if (this.warmupFinalElapsed >= this.timings.warmupFinalMs) target = 'waiting';
      }
    } else if (p.map.phase === 'live') {
      const firstFreeze =
        p.map.roundNumber === 0 &&
        p.round?.phase === 'freezetime' &&
        seconds !== null &&
        seconds > 0;
      if (!firstFreeze || this.introFinished || remaining <= this.timings.hudLeadMs) {
        if (!this.manual) this.introFinished = true;
        target = 'gameplay';
      } else if (active === 'matchup' && this.introStarted) {
        this.view.next = 'gameplay';
        if (this.elapsed >= this.view.introDurationMs) {
          if (!this.manual) this.introFinished = true;
          target = 'gameplay';
        }
      } else if (active === 'bp' && this.introStarted) {
        this.view.next = 'matchup';
        if (
          this.elapsed >= this.timings.bpFinalMs ||
          remaining <= this.timings.introMs + this.timings.hudLeadMs
        )
          target = 'matchup';
      } else if (!this.introStarted) {
        const budget = remaining - this.timings.hudLeadMs;
        if (
          budget >= this.timings.bpFinalMs + this.timings.introMs &&
          this.projections.getBpAssessment().readiness === 'ready'
        ) {
          target = 'bp';
          finalBp = true;
        } else if (budget >= this.timings.shortIntroMs) target = 'matchup';
        else {
          if (!this.manual) this.introFinished = true;
          target = 'gameplay';
        }
      }
      if (target === 'matchup')
        this.view.introDurationMs =
          remaining >= this.timings.introMs + this.timings.hudLeadMs
            ? this.timings.introMs
            : this.timings.shortIntroMs;
    }
    if (!target) return;
    this.view.next = target === active ? this.view.next : target;
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
    this.inFlight = true;
    const generation = this.generation;
    const key = mapKey;
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
                this.timings.hudLeadMs + this.timings.shortIntroMs)) &&
          key === this.executionKey(this.projections.getCurrent().program),
        finalBp,
      );
      if (!result.ok) {
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
    } finally {
      this.inFlight = false;
    }
  }
}
