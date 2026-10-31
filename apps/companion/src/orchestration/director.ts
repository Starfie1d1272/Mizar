import { randomUUID } from 'node:crypto';
import type { CameraShot, OrchestrationStatus } from '@mizar/protocol/orchestration';
import { musicCue, musicPause, musicSafe, type MusicTruth } from '../music/cues.js';
import {
  cameraControlScope,
  cameraExecutionScope,
  type CameraControlScope,
  type CameraExecutionScope,
} from '../scope/identities.js';
import type { GatewayResult, MulnxProvider } from './provider.js';
import type { OrchestrationStore } from './store.js';

export interface CameraTruth extends MusicTruth {
  /** False while a requested next map has not been observed yet. */
  mapConfirmed: boolean;
  /** Present only during an isolated external Demo trial; true requires fresh map/player data. */
  demoAudition?: boolean | undefined;
}
/** Consume authoritative projections; never become a second match / timing authority. */
export class CameraDirector {
  private host = '';
  private controlEpoch = 0;
  private native: { lease: string; host: string; until: number; blocked: boolean } | null = null;
  private context: CameraControlScope | '' = '';
  private execution: CameraExecutionScope | '' = '';
  private connection = -1;
  private held = true;
  private intentRevision = 0;
  private preparation: OrchestrationStatus['preparation'] = 'waiting';
  private preparationKey: CameraControlScope | '' = '';
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
  private current: { key: string; macro: string; until: number; edge: string } | null = null;
  private handoff: {
    shot: CameraShot;
    key: string;
    edge: string;
    context: string;
    connection: number;
    until: number;
  } | null = null;
  private clearing = false;
  private clearingRequest: Promise<GatewayResult> | null = null;
  private request: OrchestrationStatus['request'] = 'idle';
  private message = '未启用';
  constructor(
    readonly store: OrchestrationStore,
    readonly provider: Pick<
      MulnxProvider,
      'generation' | 'connected' | 'send' | 'connect' | 'close' | 'packStatus'
    >,
    private readonly truth: () => CameraTruth,
    private readonly diagnostic: (stage: string, evidence: unknown) => void = () => {},
    private readonly now = () => performance.now(),
    private readonly random = Math.random,
    private readonly isolated: (pack: string) => boolean = () => false,
    private nativeMode = false,
    private readonly verifyPack: (map: string, pack: string) => Promise<boolean> = () =>
      Promise.resolve(true),
  ) {}
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
    else this.hold('正在结束制作。');
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
  private identity(t: CameraTruth) {
    return cameraControlScope(t.program, this.store.revision, this.controlEpoch);
  }
  private safe(t: CameraTruth, audition = false) {
    return (
      this.nativeReady() &&
      (audition ? t.mapConfirmed : t.production) &&
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
      current: this.current?.macro ?? null,
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
      const execution = cameraExecutionScope(t.program);
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
      else if (this.current) void this.stop('运镜已暂停，请检查连接和游戏状态。');
    } else if (this.current && !this.safe(t, this.current.key === 'audition')) {
      void this.stop('运镜已暂停，请检查比赛状态。');
    }
    this.prepareAutomatically();
    const edge = this.edge(t);
    if (
      this.current &&
      (this.now() >= this.current.until ||
        (this.current.key !== 'audition' && this.current.edge !== edge.key))
    )
      void this.stop('已发送停止请求。');
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
      const candidates = map.pauseCandidates[edge.stage];
      shot = candidates[Math.floor(this.random() * candidates.length)] ?? map.stages[edge.stage];
    } else if (edge.stage in map.stages) shot = map.stages[edge.stage as keyof typeof map.stages];
    if (shot) this.dispatch(shot, edge.key, edge.key);
  }
  /** Invalidate readiness without changing the operator's automatic/manual choice. */
  invalidatePreparation(message = '正在准备运镜。') {
    this.preparationEpoch++;
    this.preparationKey = '';
    this.preparation = 'waiting';
    void this.stop(message);
  }
  private prepareAutomatically() {
    if (this.preparation !== 'waiting' || this.preparing || this.clearing || this.current) return;
    if (!this.truth().production) return;
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
        if (!(await this.verifyPack(this.truth().program.map.name ?? '', pack)))
          throw new Error('camera_source_changed');
        if (!valid()) throw new Error('camera_context_changed');
        if ((await this.provider.send('CamPack/Apply', pack)) !== 'queued')
          throw new Error('camera_pack_apply_unconfirmed');
        if (!valid()) throw new Error('camera_context_changed');
        const status = await this.provider.packStatus();
        if (!status || status.active !== pack || !status.empty || !valid())
          throw new Error('camera_pack_unconfirmed');
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
            error instanceof Error && error.message === 'camera_source_changed'
              ? '镜头资源已变化，请重新选择或使用方案。'
              : '运镜准备失败，请检查当前地图和连接后重试。';
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
    if (this.current) void this.stop('已发送停止请求。');
    this.dispatch(map.opening, 'opening', this.edge(t).key);
  }
  async audition(shot: CameraShot, expected: { context: string; connection: number }) {
    this.tick();
    if (
      this.closed ||
      expected.context !== this.context ||
      expected.connection !== this.provider.generation ||
      !this.safe(this.truth(), true) ||
      !this.provider.connected ||
      (this.request === 'submitted' && !this.preparing && !this.clearing && !this.current)
    )
      throw new Error('camera_audition_unavailable');
    this.held = true;
    const intent = ++this.intentRevision;
    if ((this.current || this.clearing) && (await this.stop('正在请求停止当前镜头。')) !== 'queued')
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
      !this.play(shot, 'audition', this.edge(this.truth()).key)
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
    this.play(shot, key, edge);
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
    this.play(next.shot, next.key, next.edge);
  }
  private play(shot: CameraShot, key: string, edge: string) {
    const t = this.truth();
    if (
      (this.held && key !== 'audition') ||
      this.preparation !== 'ready' ||
      this.closed ||
      !this.safe(t, key === 'audition') ||
      !this.provider.connected ||
      !this.store.ready ||
      this.store.saving ||
      !this.packReady()
    )
      return false;
    // Only dispatch can retain one bounded transition behind an in-flight clear.
    if (this.current || this.request === 'submitted') return false;
    const maxMs = shot.maxMs;
    const revision = ++this.revision;
    this.current = { key, macro: shot.macro, until: this.now() + maxMs, edge };
    this.previousMacro = shot.macro;
    this.request = 'submitted';
    this.message = '已发送播放请求。';
    this.diagnostic('camera_cue', { context: this.context, key, shot, result: 'submitted' });
    void this.provider.send('CamMacro/Play', shot.macro).then((result) => {
      if (revision !== this.revision || this.closed) return;
      this.request = result;
      this.message =
        result === 'queued'
          ? '已发送播放请求。'
          : result === 'rejected'
            ? '播放请求被拒绝，请检查运镜工具。'
            : '播放请求未得到回应，请检查游戏连接。';
      if (result !== 'queued') {
        this.preparation = 'error';
        void this.stop(this.message);
      }
    });
    return true;
  }
  private stop(message: string): Promise<GatewayResult> {
    this.handoff = null;
    if (this.clearing && !this.current) {
      this.message = message;
      return this.clearingRequest ?? Promise.resolve('unknown');
    }
    this.clearing = false;
    const hadCurrent = this.current !== null;
    if (hadCurrent)
      this.diagnostic('camera_invalidate', {
        current: this.current,
        context: this.context,
        reason: message,
      });
    this.current = null;
    const revision = ++this.revision;
    this.message = message;
    if (!hadCurrent) {
      if (this.request === 'submitted') this.request = 'unknown';
      return Promise.resolve('queued');
    }
    this.request = 'submitted';
    this.clearing = true;
    const generation = this.provider.generation;
    const epoch = this.preparationEpoch;
    const pending = this.provider.send('CamPlay/ClearForce').then((result) => {
      if (revision === this.revision && !this.closed) {
        this.clearing = false;
        if (generation !== this.provider.generation || epoch !== this.preparationEpoch) {
          this.request = 'unknown';
          return 'unknown' as const;
        }
        this.request = result;
        if (result !== 'queued') {
          this.preparation = 'error';
          this.handoff = null;
          this.message =
            result === 'rejected'
              ? '停止请求被拒绝，请检查运镜工具。'
              : '停止请求未得到回应，请检查游戏连接。';
        } else this.releaseHandoff();
      }
      return result;
    });
    this.clearingRequest = pending;
    void pending.finally(() => {
      if (this.clearingRequest === pending) this.clearingRequest = null;
    });
    return pending;
  }
  hold(message = '已发送停止请求。') {
    this.intentRevision++;
    this.held = true;
    void this.stop(message);
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
      const hadCurrent = this.current !== null || this.clearing;
      this.hold();
      if (!this.provider.connected) this.message = '人工接管 · MulNX 未连接，请在游戏内停止运镜。';
      // Explicit takeover also clears slots started outside Mizar.
      if (!hadCurrent) {
        const revision = ++this.revision;
        this.request = 'submitted';
        const result = await this.provider.send('CamPlay/ClearForce');
        if (revision === this.revision) {
          this.request = result;
          if (result !== 'queued')
            this.message =
              result === 'rejected'
                ? '停止请求被拒绝，请检查运镜工具。'
                : '停止请求未得到回应，请检查游戏连接。';
        }
      }
    } else if (action === 'skip') {
      this.intentRevision++;
      if (this.lastEdge) this.consume(this.lastEdge);
      void this.stop('已发送停止请求。');
    } else {
      if (
        this.closed ||
        this.truth().demoAudition !== undefined ||
        this.seen.size >= 1024 ||
        (this.request === 'submitted' && !this.preparing && !this.current && !this.clearing) ||
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
      const intent = ++this.intentRevision;
      if (
        (this.current || this.clearing) &&
        (await this.stop('正在请求停止当前镜头。')) !== 'queued'
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
    this.provider.close();
  }
}
