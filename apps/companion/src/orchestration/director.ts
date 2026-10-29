import { randomInt, randomUUID } from 'node:crypto';
import type { CameraShot, OrchestrationStatus } from '@mizar/protocol/orchestration';
import { musicCue, musicMapKey, musicPause, musicSafe, type MusicTruth } from '../music/cues.js';
import type { MulnxProvider, TrackedState } from './provider.js';
import type { OrchestrationStore } from './store.js';

export interface CameraTruth extends MusicTruth {
  /** Present only during an isolated external Demo trial; true requires fresh map/player data. */
  demoAudition?: boolean | undefined;
}
/** Consume authoritative projections; never become a second match / timing authority. */
export class CameraDirector {
  private host = '';
  private controlEpoch = 0;
  private native: { lease: string; host: string; until: number; blocked: boolean } | null = null;
  private context = '';
  private execution = '';
  private connection = -1;
  private held = true;
  private intentRevision = 0;
  private readonly unsubscribeTracked: () => void;
  private preparation: OrchestrationStatus['preparation'] = 'waiting';
  private preparationKey = '';
  private preparationEpoch = 0;
  private preparing: Promise<void> | null = null;
  private closed = false;
  private revision = 0;
  private lastEdge = '';
  private pauseId = 0;
  private paused = false;
  private seen = new Set<string>();
  private highestRound = -1;
  private previousMacro = '';
  private current: {
    key: string;
    macro: string;
    until: number;
    edge: string;
    id: number;
    generation: number;
    connection: number;
  } | null = null;
  private trackedGeneration: number | null = null;
  private otherCurrent = false;
  private cameraExecution: OrchestrationStatus['execution'] = 'unconfirmed';
  private stopping: Promise<boolean> | null = null;
  private cancelBlocked = false;
  private pauseRemaining: { edge: string; shots: CameraShot[] } | null = null;
  private pendingContinuation: { key: string; edge: string } | null = null;
  private handoff: {
    shot: CameraShot;
    key: string;
    edge: string;
    context: string;
    connection: number;
    until: number;
  } | null = null;
  private clearing = false;
  private request: OrchestrationStatus['request'] = 'idle';
  private message = '未启用';
  constructor(
    readonly store: OrchestrationStore,
    readonly provider: Pick<
      MulnxProvider,
      | 'generation'
      | 'connected'
      | 'send'
      | 'connect'
      | 'close'
      | 'packStatus'
      | 'trackedStatus'
      | 'cancelTracked'
      | 'playTracked'
      | 'onTracked'
    >,
    private readonly truth: () => CameraTruth,
    private readonly diagnostic: (stage: string, evidence: unknown) => void = () => {},
    private readonly now = () => performance.now(),
    private readonly random = Math.random,
    private readonly isolated: (pack: string) => boolean = () => false,
    private nativeMode = false,
  ) {
    this.unsubscribeTracked = this.provider.onTracked((state) => this.trackedState(state));
  }
  /** Authenticated Host lifecycle; never a source of match or upstream execution facts. */
  hostStarted(host: string) {
    this.host = host;
    this.diagnostic('camera_host_session', { action: 'host-start', host });
    if (this.nativeMode) this.invalidateNative();
  }
  beginNative(host: string) {
    if (!host || host !== this.host) throw new Error('camera_host_changed');
    this.nativeMode = true;
    this.invalidateNative();
    const lease = randomUUID();
    this.native = { lease, host, until: this.now() + 6000, blocked: false };
    this.message = '原生借用已确认，请重新连接并确认隔离包。';
    this.diagnostic('camera_host_session', { action: 'begin', host, lease });
    return lease;
  }
  pulseNative(host: string, lease: string) {
    if (
      !this.nativeReady() ||
      !this.nativeMode ||
      !this.native ||
      this.native.host !== host ||
      this.native.lease !== lease ||
      host !== this.host
    )
      throw new Error('camera_native_session_invalid');
    this.native.until = this.now() + 6000;
  }
  revokeNative(host: string, lease: string) {
    // Delayed packets from an old borrow cannot touch its replacement or browser mode.
    if (this.nativeMode && this.native?.host === host && this.native.lease === lease)
      this.invalidateNative();
  }
  useBrowser() {
    this.invalidateNative();
    this.nativeMode = false;
    this.native = null;
    this.message = '浏览器联调，请重新连接并确认隔离包。';
  }
  beginProduction() {
    this.intentRevision++;
    this.held = !this.store.ready || !this.store.automaticEnabled;
  }
  finishProduction() {
    if (this.nativeMode) this.invalidateNative();
    else this.hold('正在结束制作；已停用自动运镜，停止结果未确认。');
  }
  private invalidateNative() {
    this.diagnostic('camera_host_session', {
      action: 'invalidate',
      host: this.host,
      lease: this.native?.lease,
    });
    if (this.native) this.native.blocked = true;
    this.controlEpoch++;
    this.hold('原生游戏交接待确认；请结束制作后重新借用，或在准备阶段选择浏览器联调。');
    this.provider.close();
  }
  private nativeReady() {
    if (!this.nativeMode) return true;
    if (this.native && !this.native.blocked && this.now() >= this.native.until)
      this.invalidateNative();
    return Boolean(this.native && !this.native.blocked);
  }
  private executionIdentity(t: CameraTruth) {
    const c = t.program.cursor;
    return JSON.stringify([musicMapKey(t.program), c.producerInstanceId, c.liveSessionId]);
  }
  private identity(t: CameraTruth) {
    return JSON.stringify([
      this.executionIdentity(t),
      t.program.cursor.programSourceGeneration,
      this.store.revision,
      this.controlEpoch,
    ]);
  }
  private safe(t: CameraTruth, audition = false) {
    return (
      this.nativeReady() &&
      t.production &&
      (t.demoAudition === undefined ? audition || musicSafe(t.program) : t.demoAudition) &&
      t.program.status.telemetry === 'fresh'
    );
  }
  private edge(t: CameraTruth) {
    const p = t.program;
    const pause = musicPause(p);
    if (pause && !this.paused) this.pauseId++;
    this.paused = pause;
    const cue = musicCue(t, String(this.pauseId));
    if (cue && cue.group !== 'waiting') return { key: cue.key, stage: cue.group };
    if (p.map.phase === 'warmup') return { key: 'warmup', stage: 'warmup' };
    if (p.map.phase === 'live' && p.map.roundNumber !== null) {
      const roundKey = `round:${p.map.roundNumber}`;
      if (p.clock?.phase === 'freezetime' || p.clock?.phase === 'live')
        return { key: roundKey, stage: 'round' };
    }
    return { key: '', stage: '' };
  }
  get(): OrchestrationStatus {
    const ready = this.nativeReady();
    const t = this.truth();
    return {
      control: { mode: this.nativeMode ? 'native' : 'browser', state: ready ? 'ready' : 'blocked' },
      connected: this.provider.connected,
      connection: this.provider.generation,
      context: this.identity(t),
      map: t.program.map.name,
      pack: this.store.map(t.program.map.name)?.pack ?? null,
      isolated: this.packReady(),
      held: this.held,
      preparation: this.preparation,
      request: this.request,
      execution: this.cameraExecution,
      current: this.current?.macro ?? null,
      otherCurrent: this.otherCurrent,
      message: this.message,
    };
  }
  private packReady() {
    const pack = this.store.map(this.truth().program.map.name)?.pack;
    return Boolean(pack && this.isolated(pack));
  }
  private consume(key: string) {
    if (this.seen.size >= 1024) return;
    this.seen.add(key);
    // Fail closed rather than evicting identities and allowing old cues to play again.
    if (this.seen.size >= 1024) this.hold('本图触发记录已达上限，请核对比赛状态。');
  }
  tick() {
    if (this.closed) return;
    this.nativeReady();
    const t = this.truth();
    const context = this.identity(t);
    if (context !== this.context || this.connection !== this.provider.generation) {
      if (this.connection !== this.provider.generation) {
        this.revision++;
        this.current = null;
        this.otherCurrent = false;
        this.trackedGeneration = null;
        this.cameraExecution = 'unconfirmed';
        this.clearing = false;
        this.stopping = null;
        this.cancelBlocked = false;
        this.request = 'unknown';
      }
      const execution = this.executionIdentity(t);
      const mapChanged = execution !== this.execution;
      this.execution = execution;
      this.invalidatePreparation('地图或连接已变化，正在准备运镜。');
      this.context = context;
      this.connection = this.provider.generation;
      if (mapChanged) {
        this.seen.clear();
        this.highestRound = -1;
        this.pauseId = 0;
        this.paused = false;
        if (t.program.map.phase !== 'warmup' && t.program.map.roundNumber !== 0)
          this.consume('opening');
      }
      this.lastEdge = this.edge(t).key; // Baseline, not a newly witnessed event.
      if (this.lastEdge) this.consume(this.lastEdge);
      this.highestRound = Math.max(this.highestRound, t.program.map.roundNumber ?? -1);
      return;
    }
    if (!this.canPrepare()) {
      if (this.preparation !== 'waiting')
        this.invalidatePreparation('运镜已暂停，请检查连接和游戏状态。');
      else if (this.current) this.stop('运镜已暂停，请检查连接和游戏状态。');
    } else if (this.current && !this.safe(t, this.current.key === 'audition')) {
      this.stop('运镜已暂停，请检查比赛状态。');
    }
    this.prepareAutomatically();
    const edge = this.edge(t);
    if (
      this.current &&
      !this.clearing &&
      (this.now() >= this.current.until ||
        (this.current.key !== 'audition' && this.current.edge !== edge.key))
    )
      this.stop('镜头窗口已结束，已请求清空；停止结果未确认。');
    if (this.handoff && (this.now() >= this.handoff.until || this.handoff.edge !== edge.key))
      this.handoff = null;
    if (edge.key === this.lastEdge) return;
    this.lastEdge = edge.key;
    if (!edge.key || this.seen.has(edge.key)) return;
    this.consume(edge.key); // Observe even while held / disconnected; no catch-up on resume.
    const map = this.store.map(t.program.map.name);
    if (!map) return;
    let shot: CameraShot | null = null;
    if (edge.stage === 'round') {
      const round = t.program.map.roundNumber!;
      if (round <= this.highestRound) return;
      this.highestRound = round;
      // Opening owns round zero; a late first observation in live play is not a start.
      if (round === 0 || t.program.clock?.phase !== 'freezetime') return;
      const candidates =
        map.rounds.length > 1
          ? map.rounds.filter((s) => s.macro !== this.previousMacro)
          : map.rounds;
      if (!candidates.length) candidates.push(...map.rounds);
      shot = candidates[Math.floor(this.random() * candidates.length)] ?? null;
    } else if (edge.stage === 'tactical' || edge.stage === 'technical') {
      const candidates = [...map.pauseCandidates[edge.stage]];
      const index = Math.floor(this.random() * candidates.length);
      shot = candidates.splice(index, 1)[0] ?? map.stages[edge.stage];
      this.pauseRemaining = { edge: edge.key, shots: candidates };
    } else if (edge.stage in map.stages) shot = map.stages[edge.stage as keyof typeof map.stages];
    if (shot) this.dispatch(shot, edge.key, edge.key);
  }
  /** Invalidate readiness without changing the operator's automatic/manual choice. */
  invalidatePreparation(message = '正在准备运镜。') {
    this.preparationEpoch++;
    this.pauseRemaining = null;
    this.pendingContinuation = null;
    this.preparationKey = '';
    this.preparation = 'waiting';
    this.stop(message);
  }
  private prepareAutomatically() {
    if (
      this.preparation !== 'waiting' ||
      this.preparing ||
      this.clearing ||
      this.cancelBlocked ||
      this.current ||
      this.request === 'submitted'
    )
      return;
    if (!this.canPrepare()) return;
    void this.prepare().catch(() => {});
  }
  private canPrepare() {
    return (
      !this.closed &&
      this.safe(this.truth(), true) &&
      this.provider.connected &&
      this.store.ready &&
      !this.store.saving &&
      this.packReady()
    );
  }
  private async prepare(retry = false): Promise<void> {
    if (this.preparing) return this.preparing;
    if (this.preparation === 'ready' && this.preparationKey === this.identity(this.truth())) return;
    if (!this.canPrepare() || this.clearing || this.current)
      throw new Error('camera_prepare_unavailable');
    if (this.preparation === 'error' && !retry) throw new Error('camera_pack_unconfirmed');
    const context = this.identity(this.truth());
    const epoch = this.preparationEpoch;
    const generation = this.provider.generation;
    const pack = this.store.map(this.truth().program.map.name)!.pack;
    this.preparation = 'preparing';
    const valid = () =>
      epoch === this.preparationEpoch &&
      context === this.identity(this.truth()) &&
      generation === this.provider.generation &&
      this.canPrepare() &&
      !this.current &&
      !this.clearing;
    const work = async () => {
      try {
        if ((await this.provider.send('CamPack/Apply', pack)) !== 'queued')
          throw new Error('camera_pack_apply_unconfirmed');
        if (!valid()) throw new Error('camera_context_changed');
        const tracked = await this.provider.trackedStatus();
        if (!tracked || !valid()) throw new Error('camera_status_unconfirmed');
        this.otherCurrent = tracked.current !== null;
        if (tracked.current) throw new Error('camera_busy');
        const cancelled = await this.provider.cancelTracked(tracked.generation);
        if (
          !cancelled ||
          cancelled.generation === tracked.generation ||
          cancelled.current ||
          !valid()
        )
          throw new Error('camera_stop_unconfirmed');
        const status = await this.provider.packStatus();
        if (!status || status.active !== pack || !status.empty || !valid())
          throw new Error('camera_pack_unconfirmed');
        this.trackedGeneration = cancelled.generation;
        this.cancelBlocked = false;
        this.cameraExecution = 'unconfirmed';
        this.preparationKey = context;
        this.preparation = 'ready';
        this.message = this.held ? '运镜已准备，可选择镜头。' : '运镜已准备，等待下一次触发。';
      } catch (error) {
        if (
          epoch === this.preparationEpoch &&
          context === this.identity(this.truth()) &&
          generation === this.provider.generation
        ) {
          this.preparation = 'error';
          this.message =
            error instanceof Error && error.message === 'camera_status_unsupported'
              ? '当前运镜工具版本不支持此功能，请更新至支持的版本。'
              : error instanceof Error && error.message === 'camera_busy'
                ? '其他镜头正在播放，请先处理后重试。'
                : '运镜准备未确认，请检查游戏连接后重试。';
        }
        throw error;
      }
    };
    const pending = work();
    this.preparing = pending;
    try {
      await pending;
    } finally {
      if (this.preparing === pending) this.preparing = null;
    }
  }
  /** Only the actual current OBS Take start calls this; snapshots never synthesize openings. */
  opening() {
    this.tick();
    const t = this.truth(),
      map = this.store.map(t.program.map.name);
    if (!map?.opening || this.seen.has('opening')) return;
    this.consume('opening');
    if (this.held) return;
    if (this.current) this.stop('开场交接，已请求清空；停止结果未确认。');
    this.dispatch(map.opening, 'opening', this.edge(t).key);
  }
  async audition(shot: CameraShot, expected: { context: string; connection: number }) {
    this.tick();
    if (
      this.closed ||
      expected.context !== this.context ||
      expected.connection !== this.provider.generation ||
      !this.safe(this.truth(), true) ||
      !this.provider.connected
    )
      throw new Error('camera_audition_unavailable');
    this.held = true;
    this.handoff = null;
    this.pauseRemaining = null;
    this.pendingContinuation = null;
    const intent = ++this.intentRevision;
    if (
      (this.current || this.stopping || (this.request === 'submitted' && !this.preparing)) &&
      !(await this.cancelCurrent(true))
    )
      throw new Error('camera_stop_unconfirmed');
    if (
      intent !== this.intentRevision ||
      expected.context !== this.identity(this.truth()) ||
      expected.connection !== this.provider.generation
    )
      throw new Error('camera_context_changed');
    const revision = this.revision;
    await this.prepare(true);
    if (
      revision !== this.revision ||
      intent !== this.intentRevision ||
      expected.context !== this.identity(this.truth()) ||
      expected.connection !== this.provider.generation ||
      !(await this.play(shot, 'audition', this.edge(this.truth()).key))
    )
      throw new Error('camera_audition_unavailable');
  }
  /** One fresh transition may wait for the clear gateway ACK, never for execution or reconnect. */
  private dispatch(shot: CameraShot, key: string, edge: string) {
    if (this.held || this.preparation !== 'ready' || !this.safe(this.truth()) || !this.packReady())
      return;
    if (this.clearing) {
      this.handoff = {
        shot,
        key,
        edge,
        context: this.context,
        connection: this.provider.generation,
        until: this.now() + 1000,
      };
      return;
    }
    void this.play(shot, key, edge);
  }
  private releaseHandoff() {
    const next = this.handoff;
    this.handoff = null;
    if (
      !next ||
      this.now() >= next.until ||
      next.context !== this.identity(this.truth()) ||
      next.connection !== this.provider.generation ||
      next.edge !== this.edge(this.truth()).key ||
      (next.key.startsWith('round:') && this.truth().program.clock?.phase !== 'freezetime')
    )
      return;
    void this.play(next.shot, next.key, next.edge);
  }
  private async play(shot: CameraShot, key: string, edge: string): Promise<boolean> {
    const t = this.truth();
    if (
      (this.held && key !== 'audition') ||
      this.preparation !== 'ready' ||
      this.closed ||
      !this.safe(t, key === 'audition') ||
      !this.provider.connected ||
      !this.store.ready ||
      this.store.saving ||
      !this.packReady() ||
      this.current ||
      this.clearing ||
      this.request === 'submitted' ||
      this.trackedGeneration === null
    )
      return false;
    const context = this.identity(t),
      connection = this.provider.generation;
    const pack = this.store.map(t.program.map.name)!.pack;
    const revision = ++this.revision,
      intent = this.intentRevision;
    this.request = 'submitted';
    this.message = '正在准备镜头。';
    const valid = () =>
      revision === this.revision &&
      intent === this.intentRevision &&
      context === this.identity(this.truth()) &&
      connection === this.provider.generation &&
      !this.closed &&
      !this.current &&
      !this.clearing &&
      this.preparation === 'ready' &&
      (key === 'audition' ||
        (!this.held &&
          this.edge(this.truth()).key === edge &&
          (!key.startsWith('round:') || this.truth().program.clock?.phase === 'freezetime'))) &&
      this.safe(this.truth(), key === 'audition') &&
      this.canPrepare();
    try {
      const tracked = await this.provider.trackedStatus();
      if (!tracked || !valid()) throw new Error('camera_status_unconfirmed');
      this.otherCurrent = tracked.current !== null;
      if (tracked.current) throw new Error('camera_busy');
      const status = await this.provider.packStatus();
      if (!status || status.active !== pack || !status.empty || !valid())
        throw new Error('camera_pack_unconfirmed');
      const id = randomInt(1, 2 ** 48),
        generation = tracked.generation;
      this.trackedGeneration = generation;
      this.current = {
        key,
        macro: shot.macro,
        until: this.now() + shot.maxMs,
        edge,
        id,
        generation,
        connection,
      };
      this.previousMacro = shot.macro;
      this.cameraExecution = 'unconfirmed';
      this.message = '镜头请求已提交。';
      this.diagnostic('camera_cue', { context: this.context, key, shot, result: 'submitted' });
      const result = await this.provider.playTracked(shot.macro, id, generation);
      if (revision !== this.revision || this.closed || connection !== this.provider.generation)
        return false;
      this.request = result;
      if (result === 'queued') this.continuePause();
      else {
        this.cameraExecution = 'unconfirmed';
        this.preparation = 'error';
        this.message = '镜头请求未确认，请检查连接。';
      }
      return result === 'queued';
    } catch (error) {
      if (revision !== this.revision || connection !== this.provider.generation || this.closed)
        return false;
      this.request = 'unknown';
      if (!valid()) return false;
      this.preparation = 'error';
      this.message =
        error instanceof Error && error.message === 'camera_busy'
          ? '其他镜头正在播放，请先处理后重试。'
          : error instanceof Error && error.message === 'camera_status_unsupported'
            ? '当前运镜工具版本不支持此功能，请更新至支持的版本。'
            : '镜头准备未确认，请检查游戏连接和预设。';
      return false;
    }
  }
  private trackedState(state: TrackedState) {
    const current = this.current;
    if (
      !current ||
      current.id !== state.requestId ||
      current.generation !== state.generation ||
      current.connection !== this.provider.generation ||
      this.context !== this.identity(this.truth())
    )
      return;
    this.cameraExecution = state.state;
    if (state.state === 'started') {
      this.message = '镜头正在播放。';
      return;
    }
    this.current = null;
    if (state.state === 'failed') {
      if (
        ['stale_generation', 'pack_changed', 'pack_mismatch', 'override_disabled', 'busy'].includes(
          state.reason,
        )
      ) {
        this.trackedGeneration = null;
        this.preparation = 'error';
      }
      this.pauseRemaining = null;
      this.message =
        state.reason === 'macro_not_found' || state.reason === 'macro_empty'
          ? '找不到可播放的镜头，请检查预设。'
          : state.reason === 'path_unavailable' || state.reason === 'no_frame'
            ? '镜头资源不可用，请检查游戏中的资源。'
            : '镜头无法播放，请检查游戏连接和运镜设置。';
    } else if (state.state === 'cancelled') {
      this.pauseRemaining = null;
      this.pendingContinuation = null;
      if (!this.clearing) {
        this.trackedGeneration = null;
        this.preparationEpoch++;
        this.preparationKey = '';
        this.preparation = 'waiting';
        this.message = '镜头已停止，正在重新准备。';
      }
    } else if (state.state === 'completed') {
      this.message = '镜头已结束。';
      this.pendingContinuation = { key: current.key, edge: current.edge };
      this.continuePause();
    }
  }
  private continuePause() {
    const current = this.pendingContinuation,
      next = this.pauseRemaining;
    if (this.request === 'submitted') return;
    this.pendingContinuation = null;
    if (
      this.request !== 'queued' ||
      this.held ||
      this.clearing ||
      !current ||
      !next ||
      next.edge !== current.edge ||
      next.edge !== this.edge(this.truth()).key ||
      !next.shots.length
    )
      return;
    const index = Math.floor(this.random() * next.shots.length);
    const shot = next.shots.splice(index, 1)[0]!;
    void this.play(shot, current.key, current.edge);
  }
  private stop(message: string, explicit = false) {
    if (this.cancelBlocked && !explicit) return;
    this.handoff = null;
    this.pauseRemaining = null;
    this.pendingContinuation = null;
    this.message = message;
    if (this.clearing) return;
    if (this.current) {
      this.diagnostic('camera_invalidate', {
        current: this.current,
        context: this.context,
        reason: message,
      });
      void this.cancelCurrent(explicit);
    } else if (this.request === 'submitted') {
      this.revision++;
      this.request = 'unknown';
    }
  }
  private async cancelCurrent(explicit = false): Promise<boolean> {
    if (this.stopping) return this.stopping;
    if ((this.cancelBlocked && !explicit) || !this.provider.connected) return false;
    const connection = this.provider.generation;
    const context = this.identity(this.truth());
    const revision = ++this.revision;
    this.clearing = true;
    this.request = 'submitted';
    this.cameraExecution = 'unconfirmed';
    const work = (async () => {
      let token = this.trackedGeneration;
      if (this.cancelBlocked || token === null || this.current === null) {
        try {
          const status = await this.provider.trackedStatus();
          if (
            !status ||
            revision !== this.revision ||
            connection !== this.provider.generation ||
            context !== this.identity(this.truth()) ||
            this.closed
          )
            throw new Error('camera_status_unconfirmed');
          if (
            status.current &&
            (!this.current ||
              status.current.requestId !== this.current.id ||
              status.current.generation !== this.current.generation)
          ) {
            this.otherCurrent = true;
            if (this.current && status.current.generation !== this.current.generation)
              this.current = null;
            throw new Error('camera_busy');
          }
          this.otherCurrent = false;
          token = status.generation;
        } catch {
          if (
            revision === this.revision &&
            connection === this.provider.generation &&
            !this.closed
          ) {
            this.clearing = false;
            this.cancelBlocked = true;
            this.preparation = 'error';
            this.request = 'unknown';
            this.message = '停止未确认，请检查连接后重试。';
          }
          return false;
        }
      }
      if (
        revision !== this.revision ||
        connection !== this.provider.generation ||
        context !== this.identity(this.truth()) ||
        this.closed
      )
        return false;
      const result = await this.provider.cancelTracked(token);
      if (revision !== this.revision || this.closed) return false;
      if (connection !== this.provider.generation) {
        this.clearing = false;
        this.current = null;
        this.trackedGeneration = null;
        this.request = 'unknown';
        return false;
      }
      this.clearing = false;
      if (!result || result.generation === token || result.current !== null) {
        if (
          result?.current &&
          (!this.current ||
            result.current.requestId !== this.current.id ||
            result.current.generation !== this.current.generation)
        ) {
          this.current = null;
          this.otherCurrent = true;
        }
        this.trackedGeneration = result?.generation ?? null;
        this.cancelBlocked = true;
        this.preparation = 'error';
        this.request = 'unknown';
        this.message = '停止未确认，请检查连接后重试。';
        this.handoff = null;
        return false;
      }
      this.trackedGeneration = result.generation;
      this.otherCurrent = false;
      this.cancelBlocked = false;
      this.current = null;
      if (this.cameraExecution !== 'cancelled') this.cameraExecution = 'unconfirmed';
      this.request = 'queued';
      this.releaseHandoff();
      return true;
    })();
    this.stopping = work;
    try {
      return await work;
    } finally {
      if (this.stopping === work) this.stopping = null;
    }
  }
  hold(message = '人工接管；已请求清空全部运镜槽，停止未确认。') {
    this.intentRevision++;
    this.held = true;
    this.stop(message, true);
  }
  async command(
    action: 'connect' | 'disconnect' | 'resume' | 'hold' | 'skip',
    expected?: { context: string; connection: number },
  ) {
    this.tick();
    this.diagnostic('camera_command', { action, expected, before: this.get(), result: 'begin' });
    if (action === 'connect') {
      if (!this.nativeReady()) throw new Error('camera_native_session_invalid');
      this.invalidatePreparation();
      await this.provider.connect();
      this.tick();
    } else if (action === 'disconnect') {
      this.invalidatePreparation();
      this.provider.close();
    } else if (action === 'hold') {
      this.hold();
      if (
        this.provider.connected &&
        this.trackedGeneration !== null &&
        !(await this.cancelCurrent(true))
      )
        throw new Error('camera_stop_unconfirmed');
    } else if (action === 'skip') {
      this.intentRevision++;
      if (this.lastEdge) this.consume(this.lastEdge);
      this.stop('已跳过本次运镜，停止结果未确认。', true);
    } else {
      if (
        this.closed ||
        this.truth().demoAudition !== undefined ||
        this.seen.size >= 1024 ||
        !expected ||
        expected.context !== this.context ||
        expected.connection !== this.provider.generation ||
        !this.safe(this.truth()) ||
        !this.provider.connected ||
        !this.store.ready ||
        this.store.saving ||
        !this.packReady()
      )
        throw new Error('camera_context_changed');
      this.handoff = null;
      this.pauseRemaining = null;
      this.pendingContinuation = null;
      const intent = ++this.intentRevision;
      if (
        (this.current || this.stopping || (this.request === 'submitted' && !this.preparing)) &&
        !(await this.cancelCurrent(true))
      )
        throw new Error('camera_stop_unconfirmed');
      if (
        intent !== this.intentRevision ||
        expected.context !== this.identity(this.truth()) ||
        expected.connection !== this.provider.generation
      )
        throw new Error('camera_context_changed');
      const revision = this.revision;
      await this.prepare(true);
      if (
        revision !== this.revision ||
        intent !== this.intentRevision ||
        expected.context !== this.identity(this.truth()) ||
        expected.connection !== this.provider.generation ||
        !this.safe(this.truth()) ||
        !this.canPrepare() ||
        this.preparation !== 'ready'
      )
        throw new Error('camera_context_changed');
      this.held = false;
      this.message = '自动运镜已启用，等待下一次触发。';
    }
    this.diagnostic('camera_command', { action, after: this.get(), result: 'success' });
  }
  close() {
    this.hold();
    this.closed = true;
    this.unsubscribeTracked();
    this.provider.close();
  }
}
