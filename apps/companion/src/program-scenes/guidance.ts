import type { ProductionGuidance } from '@mizar/protocol/program-scenes';
import type { ProjectionBundle } from '../projections/projection-coordinator.js';
import type { MatchContextBinding } from '../match-context/index.js';
import { OFFICIAL_RIVALHUB_URL } from '../match-context/rivalhub-connection.js';

/** One current-match reminder clock; canonical results stay in SeriesProgress/MatchContext. */
export class ProductionGuidanceStore {
  private scope: string | null = null;
  private completedKey: string | null = null;
  private ended: { key: string; at: number } | null = null;
  private previous: { producer: string; seq: number } | null = null;
  private eventFloor = -1;
  constructor(
    private readonly now = () => performance.now(),
    private readonly utc = () => Date.now(),
  ) {}
  update(bundle: ProjectionBundle, binding?: MatchContextBinding): void {
    const p = bundle.program;
    const scope = p.match
      ? JSON.stringify([p.cursor.producerInstanceId, p.cursor.liveSessionId, p.match.matchId])
      : null;
    const completed = [...(p.series?.maps ?? [])]
      .reverse()
      .find((map) => map.status === 'completed');
    const execution = bundle.operator.seriesProgress?.maps.find(
      (map) =>
        map.mapOrder === completed?.mapOrder &&
        map.mapName === completed.mapName &&
        map.status === 'completed',
    );
    const key =
      scope && completed
        ? JSON.stringify([
            scope,
            completed.mapId,
            completed.mapOrder,
            completed.mapName,
            execution?.executionMapEpoch ?? null,
            p.cursor.programSourceGeneration,
          ])
        : null;
    if (scope !== this.scope || key !== this.completedKey) {
      // Invalidate first: missing evidence for the next completion must never retain the old clock.
      this.ended = null;
      this.eventFloor =
        this.previous?.producer === p.cursor.producerInstanceId
          ? scope !== this.scope
            ? p.cursor.runtimeSeq
            : this.previous.seq
          : -1;
      this.scope = scope;
      this.completedKey = key;
    }
    this.previous = { producer: p.cursor.producerInstanceId, seq: p.cursor.runtimeSeq };
    if (!key || !completed || !p.match || !p.series) return;
    if (this.ended?.key === key) return;
    const transition = [...bundle.operator.runtime.recentTransitions]
      .reverse()
      .find(
        (event) =>
          event.kind === 'map_ended' &&
          event.runtimeSeq > this.eventFloor &&
          event.mapEpoch === execution?.executionMapEpoch &&
          event.mapEpoch === p.cursor.mapEpoch &&
          event.producerInstanceId === p.cursor.producerInstanceId &&
          (event.liveSession.kind === 'bound' ? event.liveSession.liveSessionId : null) ===
            p.cursor.liveSessionId &&
          event.sourceGeneration === p.cursor.programSourceGeneration &&
          Number.isFinite(event.at.monotonicMs) &&
          event.at.monotonicMs <= this.now(),
      );
    if (
      p.status.context === 'fresh' &&
      p.status.identity === 'matched' &&
      p.series.bindingState === 'bound' &&
      completed.mapOrder === p.series.currentMapOrder &&
      transition
    ) {
      this.ended = { key, at: transition.at.monotonicMs };
      return;
    }
    const stamp =
      binding?.context.matchId === p.match.matchId
        ? binding.context.maps.find(
            (map) =>
              map.mapOrder === completed.mapOrder &&
              map.mapName === completed.mapName &&
              map.mapId === completed.mapId,
          )?.completedAt
        : null;
    const time = stamp ? Date.parse(stamp) : NaN;
    const utc = this.utc();
    if (Number.isFinite(time) && time <= utc) this.ended = { key, at: this.now() - (utc - time) };
  }

  get(bundle: ProjectionBundle, binding?: MatchContextBinding): ProductionGuidance {
    this.update(bundle, binding);
    const p = bundle.program;
    const series = p.series;
    const completed = [...(series?.maps ?? [])].reverse().find((map) => map.status === 'completed');
    const current = series?.maps.find((map) => map.status === 'current');
    const next = series?.maps.find((map) => map.status === 'pending');
    const phase =
      series?.status === 'completed'
        ? 'match_end'
        : current && (p.map.phase === 'live' || p.map.phase === 'intermission')
          ? 'live'
          : completed
            ? 'map_end'
            : 'pre_match';
    const online =
      binding?.origin === 'online' ||
      (binding?.origin === 'cache' && binding.cachedFrom === 'online');
    const slug = binding?.manifest.match.competition?.slug;
    const rivalhubUrl =
      online && slug && p.match
        ? `${OFFICIAL_RIVALHUB_URL}/admin/${encodeURIComponent(slug)}/matches/${encodeURIComponent(p.match.matchId)}`
        : null;
    const interMapReminder =
      binding?.origin !== 'fixture' &&
      phase === 'map_end' &&
      completed !== undefined &&
      series?.maps.some(
        (map) =>
          map.mapOrder > completed.mapOrder &&
          (map.status === 'pending' || map.status === 'current'),
      ) === true &&
      this.ended !== null &&
      this.now() - this.ended.at >= 600_000;
    return {
      matchId: p.match?.matchId ?? null,
      phase,
      task:
        phase === 'match_end'
          ? '赛后收尾'
          : phase === 'map_end'
            ? '准备下一图'
            : phase === 'live'
              ? '比赛进行中'
              : '完成开播检查',
      nextStep:
        phase === 'match_end'
          ? '可继续赛后口播，结束后停止直播。'
          : phase === 'map_end'
            ? rivalhubUrl
              ? '核验本图数据，准备下一图房间。'
              : '准备下一图服务器。'
            : phase === 'live'
              ? p.status.telemetry === 'fresh'
                ? ''
                : '检查 CS2 与比赛数据。'
              : p.match
                ? '检查比赛数据与 OBS。'
                : '选择或创建比赛。',
      currentMap: current?.mapName ?? null,
      nextMap: phase === 'match_end' ? null : (current?.mapName ?? next?.mapName ?? null),
      result:
        phase === 'match_end' && series
          ? `${series.score.a} : ${series.score.b}`
          : completed?.finalScore
            ? `${completed.mapName} · ${completed.finalScore.a} : ${completed.finalScore.b}`
            : null,
      interMapReminder,
      rivalhubUrl,
      broadcastAssigned:
        binding?.origin !== 'fixture' && (binding?.context.commentators.length ?? 0) > 0,
      bilibili: 'unconfigured',
    };
  }
}
