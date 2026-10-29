import { randomUUID } from 'node:crypto';
import type { CameraShot, OrchestrationStatus } from '@mizar/protocol/orchestration';
import { musicCue, musicMapKey, musicPause, musicSafe, type MusicTruth } from '../music/cues.js';
import type { MulnxProvider } from './provider.js';
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
      request: this.request,
      execution: 'unconfirmed',
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
    const t = this.truth(),
      context = this.identity(t);
    if (context !== this.context || this.connection !== this.provider.generation) {
      const execution = this.executionIdentity(t);
      const mapChanged = execution !== this.execution;
      this.execution = execution;
      this.hold('请确认当前地图与活动运镜包，再启用自动。');
      this.context = context;
      this.connection = this.provider.generation;
      if (mapChanged) {
        this.seen.clear();
        this.highestRound = -1;
        this.pauseId = 0;
        this.paused = false;
        if (t.program.map.phase !== 'warmup') this.consume('opening');
      }
      this.lastEdge = this.edge(t).key; // Baseline, not a newly witnessed event.
      if (this.lastEdge) this.consume(this.lastEdge);
      this.highestRound = Math.max(this.highestRound, t.program.map.roundNumber ?? -1);
      return;
    }
    if (
      !this.safe(t, this.current?.key === 'audition') ||
      !this.provider.connected ||
      !this.store.ready ||
      this.store.saving ||
      !this.packReady()
    ) {
      if (!this.held || this.current) this.hold('自动运镜已暂停，请核对连接和比赛状态。');
    }
    const edge = this.edge(t);
    if (
      this.current &&
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
      // Opening owns round zero.
      if (round === 0) return;
      const candidates =
        map.rounds.length > 1
          ? map.rounds.filter((s) => s.macro !== this.previousMacro)
          : map.rounds;
      if (!candidates.length) candidates.push(...map.rounds);
      shot = candidates[Math.floor(this.random() * candidates.length)] ?? null;
    } else if (edge.stage in map.stages) shot = map.stages[edge.stage as keyof typeof map.stages];
    if (shot) this.dispatch(shot, edge.key, edge.key);
  }
  /** Only the actual current OBS Take start calls this; snapshots never synthesize openings. */
  opening() {
    this.tick();
    const t = this.truth(),
      map = this.store.map(t.program.map.name);
    if (!map?.opening || this.seen.has('opening')) return;
    this.consume('opening');
    if (this.current) this.stop('开场交接，已请求清空；停止结果未确认。');
    this.dispatch(map.opening, 'opening', this.edge(t).key);
  }
  audition(shot: CameraShot, expected: { context: string; connection: number }) {
    this.tick();
    if (
      this.closed ||
      expected.context !== this.context ||
      expected.connection !== this.provider.generation ||
      !this.safe(this.truth(), true) ||
      !this.provider.connected ||
      this.current ||
      this.request === 'submitted'
    )
      throw new Error('camera_audition_unavailable');
    this.held = false;
    try {
      if (!this.play(shot, 'audition', this.edge(this.truth()).key))
        throw new Error('camera_audition_unavailable');
    } finally {
      this.held = true;
    }
  }
  /** One fresh transition may wait for the clear gateway ACK, never for execution or reconnect. */
  private dispatch(shot: CameraShot, key: string, edge: string) {
    if (this.held || !this.safe(this.truth()) || !this.packReady()) return;
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
      next.edge !== this.edge(this.truth()).key
    )
      return;
    this.play(next.shot, next.key, next.edge);
  }
  private play(shot: CameraShot, key: string, edge: string) {
    const t = this.truth();
    if (
      this.held ||
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
    this.message = '请求已提交，执行未确认';
    this.diagnostic('camera_cue', { context: this.context, key, shot, result: 'submitted' });
    void this.provider.send('CamMacro/Play', shot.macro).then((result) => {
      if (revision !== this.revision || this.closed) return;
      this.request = result;
      this.message =
        result === 'queued' ? '请求已入队，执行未确认' : '运镜请求未确认，请在游戏内检查。';
      if (result !== 'queued') this.hold(this.message);
    });
    return true;
  }
  private stop(message: string) {
    this.handoff = null;
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
      return;
    }
    this.request = 'submitted';
    this.clearing = true;
    void this.provider.send('CamPlay/ClearForce').then((result) => {
      if (revision === this.revision && !this.closed) {
        this.clearing = false;
        this.request = result;
        if (result !== 'queued') {
          this.held = true;
          this.handoff = null;
        } else this.releaseHandoff();
      }
    });
  }
  hold(message = '人工接管；已请求清空全部运镜槽，停止未确认。') {
    this.held = true;
    this.stop(message);
  }
  async command(
    action: 'connect' | 'disconnect' | 'resume' | 'hold' | 'skip',
    expected?: { context: string; connection: number },
  ) {
    this.tick();
    this.diagnostic('camera_command', { action, expected, before: this.get(), result: 'begin' });
    if (action === 'connect') {
      if (!this.nativeReady()) throw new Error('camera_native_session_invalid');
      this.hold();
      await this.provider.connect();
      this.tick();
    } else if (action === 'disconnect') {
      this.hold();
      this.provider.close();
    } else if (action === 'hold') {
      const hadCurrent = this.current !== null;
      this.hold();
      if (!this.provider.connected) this.message = '人工接管 · MulNX 未连接，请在游戏内停止运镜。';
      // Explicit takeover also clears slots started outside Mizar.
      if (!hadCurrent) {
        const revision = ++this.revision;
        this.request = 'submitted';
        const result = await this.provider.send('CamPlay/ClearForce');
        if (revision === this.revision) this.request = result;
      }
    } else if (action === 'skip') {
      if (this.lastEdge) this.consume(this.lastEdge);
      this.stop('已跳过本次运镜，停止结果未确认。');
    } else {
      if (
        this.closed ||
        this.truth().demoAudition !== undefined ||
        this.seen.size >= 1024 ||
        this.request === 'submitted' ||
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
      const pack = this.store.map(this.truth().program.map.name)!.pack;
      const revision = this.revision;
      const generation = this.provider.generation;
      const context = this.context;
      if ((await this.provider.send('CamPack/Apply', pack)) !== 'queued')
        throw new Error('camera_pack_apply_unconfirmed');
      const status = await this.provider.packStatus();
      if (
        !status ||
        status.active !== pack ||
        !status.empty ||
        revision !== this.revision ||
        generation !== this.provider.generation ||
        context !== this.identity(this.truth()) ||
        !this.safe(this.truth()) ||
        !this.provider.connected ||
        !this.store.ready ||
        this.store.saving ||
        !this.packReady()
      )
        throw new Error('camera_pack_unconfirmed');
      this.held = false;
      this.message = '活动包和自动列表已核对；资源加载未确认 · 等待下一个阶段';
    }
    this.diagnostic('camera_command', { action, after: this.get(), result: 'success' });
  }
  close() {
    this.hold();
    this.closed = true;
    this.provider.close();
  }
}
