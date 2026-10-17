import type { CameraShot, OrchestrationStatus } from '@mizar/protocol/orchestration';
import { musicCue, musicMapKey, musicPause, musicSafe, type MusicTruth } from '../music/cues.js';
import type { MulnxProvider } from './provider.js';
import type { OrchestrationStore } from './store.js';

export interface CameraTruth extends MusicTruth {
  manual: boolean;
}
/** Consume authoritative projections; never become a second match / timing authority. */
export class CameraDirector {
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
  private request: OrchestrationStatus['request'] = 'idle';
  private message = '未启用';
  constructor(
    readonly store: OrchestrationStore,
    readonly provider: Pick<
      MulnxProvider,
      'generation' | 'connected' | 'send' | 'connect' | 'close'
    >,
    private readonly truth: () => CameraTruth,
    private readonly diagnostic: (stage: string, evidence: unknown) => void = () => {},
    private readonly now = () => performance.now(),
    private readonly random = Math.random,
  ) {}
  private executionIdentity(t: CameraTruth) {
    const c = t.program.cursor;
    return JSON.stringify([musicMapKey(t.program), c.producerInstanceId, c.liveSessionId]);
  }
  private identity(t: CameraTruth) {
    return JSON.stringify([
      this.executionIdentity(t),
      t.program.cursor.programSourceGeneration,
      this.store.revision,
    ]);
  }
  private safe(t: CameraTruth) {
    return (
      t.production && !t.manual && musicSafe(t.program) && t.program.status.telemetry === 'fresh'
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
    if (p.map.phase === 'live' && p.clock?.phase === 'freezetime' && p.map.roundNumber !== null)
      return { key: `round:${p.map.roundNumber}`, stage: 'round' };
    return { key: '', stage: '' };
  }
  get(): OrchestrationStatus {
    const t = this.truth();
    return {
      connected: this.provider.connected,
      connection: this.provider.generation,
      context: this.identity(t),
      map: t.program.map.name,
      pack: this.store.map(t.program.map.name)?.pack ?? null,
      held: this.held,
      request: this.request,
      execution: 'unconfirmed',
      current: this.current?.macro ?? null,
      message: this.message,
    };
  }
  private consume(key: string) {
    if (this.seen.size >= 1024) return;
    this.seen.add(key);
    // Fail closed rather than evicting identities and allowing old cues to play again.
    if (this.seen.size >= 1024) this.hold('本图触发记录已达上限，请核对比赛状态。');
  }
  tick() {
    if (this.closed) return;
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
    if (!this.safe(t) || !this.provider.connected || !this.store.ready || this.store.saving) {
      if (!this.held || this.current) this.hold('自动运镜已暂停，请核对连接和比赛状态。');
    }
    const edge = this.edge(t);
    if (t.program.map.phase === 'live' && t.program.clock?.phase !== 'freezetime')
      this.highestRound = Math.max(this.highestRound, t.program.map.roundNumber ?? -1);
    if (
      this.current &&
      (this.now() >= this.current.until ||
        this.current.edge !== edge.key ||
        (t.program.map.phase === 'live' &&
          t.program.clock?.phase === 'freezetime' &&
          (t.program.clock.endsInSeconds ?? 0) <= 5))
    )
      this.stop('镜头窗口已结束，已请求清空；停止结果未确认。');
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
      // Opening owns round zero. Never launch a late shot near the live boundary.
      if (round === 0 || (t.program.clock?.endsInSeconds ?? 0) <= 5) return;
      const candidates =
        map.rounds.length > 1
          ? map.rounds.filter((s) => s.macro !== this.previousMacro)
          : map.rounds;
      if (!candidates.length) candidates.push(...map.rounds);
      shot = candidates[Math.floor(this.random() * candidates.length)] ?? null;
    } else if (edge.stage in map.stages) shot = map.stages[edge.stage as keyof typeof map.stages];
    if (shot) this.play(shot, edge.key, edge.key);
  }
  /** Only the actual current OBS Take start calls this; snapshots never synthesize openings. */
  opening() {
    this.tick();
    const t = this.truth(),
      map = this.store.map(t.program.map.name);
    if (!map?.opening || this.seen.has('opening')) return;
    this.consume('opening');
    this.play(map.opening, 'opening', this.edge(t).key);
  }
  audition(shot: CameraShot, expected: { context: string; connection: number }) {
    this.tick();
    if (
      this.closed ||
      expected.context !== this.context ||
      expected.connection !== this.provider.generation ||
      !this.safe(this.truth()) ||
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
  private play(shot: CameraShot, key: string, edge: string) {
    const t = this.truth();
    if (
      this.held ||
      this.closed ||
      !this.safe(t) ||
      !this.provider.connected ||
      !this.store.ready ||
      this.store.saving
    )
      return false;
    // An unresolved request is never queued locally behind another shot.
    if (this.current || this.request === 'submitted') return false;
    if (t.program.map.phase === null) return false;
    let maxMs = shot.maxMs;
    if (t.program.map.phase === 'live' && !musicPause(t.program)) {
      if (t.program.clock?.phase !== 'freezetime' || (t.program.clock.endsInSeconds ?? 0) <= 5)
        return false;
      maxMs = Math.min(maxMs, (t.program.clock.endsInSeconds! - 5) * 1000);
    }
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
    void this.provider.send('CamPlay/ClearForce').then((result) => {
      if (revision === this.revision && !this.closed) {
        this.request = result;
        if (result !== 'queued') this.held = true;
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
        this.seen.size >= 1024 ||
        this.request === 'submitted' ||
        !expected ||
        expected.context !== this.context ||
        expected.connection !== this.provider.generation ||
        !this.safe(this.truth()) ||
        !this.provider.connected ||
        !this.store.ready ||
        this.store.saving ||
        !this.store.map(this.truth().program.map.name)
      )
        throw new Error('camera_context_changed');
      this.held = false;
      this.message = '自动 · 等待下一个阶段';
    }
    this.diagnostic('camera_command', { action, after: this.get(), result: 'success' });
  }
  close() {
    this.hold();
    this.closed = true;
    this.provider.close();
  }
}
