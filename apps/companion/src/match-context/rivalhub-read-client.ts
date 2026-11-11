import { createHash, randomUUID } from 'node:crypto';
import type { MatchContext, ScheduleWindowV1 } from '@mizar/core/match-context';
import {
  toScheduleWindowV1,
  validateBroadcastScheduleWindow,
  validateBroadcastManifest,
} from '@mizar/rivalhub';
import { broadcastStatsSchema, type BroadcastStats } from '@mizar/protocol/broadcast-stats';
import { createOnlineManifestSource, readOnlineManifestResponse } from './http-source.js';
import { RivalHubLibrary } from './rivalhub-library.js';
import { SourceLoadError } from './source-error.js';
import { CONTROL_TIMEOUT_MS, type Installation } from './rivalhub-authorization.js';

export type StatsTarget = {
  matchId: string;
  competitionId: string;
  entrantIds: readonly [string, string];
};

/** Bind the cache to the currently active match identity, independent of side order. */
export function statsTarget(
  context: Pick<MatchContext, 'matchId' | 'competition' | 'entrants'>,
): StatsTarget | null {
  const competitionId = context.competition?.competitionId;
  const entrantIds = [context.entrants.a.entryId, context.entrants.b.entryId] as const;
  if (!competitionId || !entrantIds[0] || !entrantIds[1] || entrantIds[0] === entrantIds[1])
    return null;
  return { matchId: context.matchId, competitionId, entrantIds };
}

const statsTargetKey = (target: StatsTarget) =>
  JSON.stringify([target.matchId, target.competitionId, ...[...target.entrantIds].sort()]);
const STATS_RETRY_MS = 30_000;

function statsRetryDelay(header: string | null): number {
  if (!header) return STATS_RETRY_MS;
  const value = header.trim();
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  if (delay === Infinity) return Number.MAX_VALUE;
  return Number.isFinite(delay) && delay >= 0 ? Math.max(STATS_RETRY_MS, delay) : STATS_RETRY_MS;
}

/** Owns cached RivalHub reads within the current installation scope. */
export class RivalHubReadClient {
  constructor(
    private readonly path: string,
    private readonly fetchImpl: typeof fetch,
    private readonly currentInstallation: () => Installation | null,
    private readonly request: (operation: string, init?: RequestInit) => Promise<Response>,
    private readonly readJson: (response: Response) => Promise<unknown>,
    private readonly monotonicNow: () => number,
    private readonly rememberViewer: (installation: Installation, viewer: unknown) => Promise<void>,
  ) {}

  private get installation() {
    return this.currentInstallation();
  }

  private scheduleGeneration = 0;
  scheduleWarning: string | null = null;
  private scheduleCache: {
    competitionId: string;
    value: ScheduleWindowV1;
    acquiredAt: number;
  } | null = null;
  getSchedule(): ScheduleWindowV1 | null {
    return this.installation &&
      this.scheduleCache?.competitionId === this.installation.competitionId &&
      this.monotonicNow() - this.scheduleCache.acquiredAt < 60_000
      ? this.scheduleCache.value
      : null;
  }
  invalidate(loaded?: Installation) {
    const blocked = this.statsAuthorizationBlocked;
    const sameBlockedInstallation =
      blocked &&
      loaded &&
      blocked.baseUrl === loaded.baseUrl &&
      blocked.installationId === loaded.installationId &&
      blocked.competitionId === loaded.competitionId &&
      blocked.credential === loaded.credential;
    this.clearStats();
    this.statsAuthorizationBlocked = sameBlockedInstallation ? loaded : null;
    this.scheduleCache = null;
    this.scheduleWarning = null;
    this.browsingLibrary = null;
    this.manifestScope?.abort.abort();
    this.manifestScope = null;
  }
  private statsAuthorizationBlocked: Installation | null = null;
  private statsScope: {
    installation: Installation;
    targetKey: string;
    value: BroadcastStats | null;
    etag: string | null;
    pending: Promise<BroadcastStats | null> | null;
    generation: number;
    fetchedAt: string | null;
    retryAt: number;
    blocked: 'authorization' | null;
    abort: AbortController;
  } | null = null;

  /** Called at production entry and maintenance ticks, never by a local reader. */
  async stats(target: StatsTarget | null, refresh = false): Promise<BroadcastStats | null> {
    const installation = this.installation;
    if (
      !installation ||
      !target ||
      target.competitionId !== installation.competitionId ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(target.matchId) ||
      !target.entrantIds[0] ||
      !target.entrantIds[1] ||
      target.entrantIds[0] === target.entrantIds[1]
    ) {
      this.clearStats();
      return null;
    }
    const { matchId } = target;
    const entrantIds = [...target.entrantIds] as [string, string];
    const targetKey = statsTargetKey(target);
    if (this.statsScope?.installation !== installation || this.statsScope.targetKey !== targetKey) {
      this.clearStats();
      this.statsScope = {
        installation,
        targetKey,
        value: null,
        etag: null,
        pending: null,
        generation: 0,
        fetchedAt: null,
        retryAt: 0,
        blocked: this.statsAuthorizationBlocked === installation ? 'authorization' : null,
        abort: new AbortController(),
      };
    }
    const scope = this.statsScope;
    if (scope.pending) return scope.pending;
    if (scope.blocked === 'authorization') return null;
    if (!refresh && scope.value) return scope.value;
    if (this.monotonicNow() < scope.retryAt) return refresh ? null : scope.value;
    if (refresh) scope.blocked = null;
    const generation = ++scope.generation;
    const current = () =>
      this.statsScope === scope &&
      this.installation === installation &&
      scope.generation === generation &&
      !scope.abort.signal.aborted;
    const retry = (header: string | null = null) => {
      if (current()) scope.retryAt = this.monotonicNow() + statsRetryDelay(header);
    };
    const invalid = () => retry();
    const pending = (async () => {
      try {
        const response = await this.request(`stats?matchId=${encodeURIComponent(matchId)}`, {
          headers: scope.etag ? { 'if-none-match': scope.etag } : {},
          signal: AbortSignal.any([scope.abort.signal, AbortSignal.timeout(CONTROL_TIMEOUT_MS)]),
        });
        if (!current()) return null;
        if (response.status === 304 && scope.value) {
          scope.fetchedAt = new Date().toISOString();
          scope.retryAt = 0;
          scope.blocked = null;
          return scope.value;
        }
        if (response.status === 401 || response.status === 403) {
          scope.value = null;
          scope.etag = null;
          scope.fetchedAt = null;
          scope.blocked = 'authorization';
          this.statsAuthorizationBlocked = installation;
          return null;
        }
        if (!response.ok) {
          if ([408, 429, 500, 502, 503, 504].includes(response.status))
            retry(response.headers.get('retry-after'));
          else invalid();
          return null;
        }
        const parsed = broadcastStatsSchema.safeParse(await readOnlineManifestResponse(response));
        if (!current()) return null;
        if (
          !parsed.success ||
          parsed.data.matchId !== matchId ||
          parsed.data.competitionId !== installation.competitionId ||
          parsed.data.entrants.length !== 2 ||
          !entrantIds.every((id) => parsed.data.entrants.some((entry) => entry.entryId === id))
        ) {
          invalid();
          return null;
        }
        scope.value = parsed.data;
        scope.etag = response.headers.get('etag');
        scope.fetchedAt = new Date().toISOString();
        scope.retryAt = 0;
        scope.blocked = null;
        return scope.value;
      } catch (error) {
        if (!current()) return null;
        if (error instanceof SourceLoadError && error.code === 'invalid_response') invalid();
        else retry();
        return null;
      }
    })().finally(() => {
      if (scope.pending === pending) scope.pending = null;
    });
    scope.pending = pending;
    return pending;
  }
  clearStats(): void {
    this.statsScope?.abort.abort();
    this.statsScope = null;
  }
  statsFetchedAt(target: StatsTarget | null): string | null {
    return this.statsScope?.installation === this.installation &&
      target &&
      this.statsScope.targetKey === statsTargetKey(target)
      ? this.statsScope.fetchedAt
      : null;
  }
  /** Read the current snapshot without waiting for or starting a website request. */
  getStatsSnapshot(target: StatsTarget | null): BroadcastStats | null {
    const scope = this.statsScope;
    return scope &&
      target &&
      scope.installation === this.installation &&
      scope.targetKey === statsTargetKey(target)
      ? scope.value
      : null;
  }
  async getStats(target: StatsTarget | null): Promise<BroadcastStats | null> {
    const scope = this.statsScope;
    if (
      !scope ||
      !target ||
      scope.installation !== this.installation ||
      scope.targetKey !== statsTargetKey(target)
    )
      return null;
    return scope.value ?? (scope.pending ? await scope.pending : null);
  }
  async schedule(from: string, to: string) {
    const generation = ++this.scheduleGeneration;
    const installation = this.installation;
    const response = await this.request(
      `schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    if (!response.ok) throw new Error('赛事赛程暂时无法获取。');
    const result = validateBroadcastScheduleWindow(await this.readJson(response));
    if (!result.ok) throw new Error('赛事赛程格式不兼容。');
    if (
      this.installation &&
      result.value.competition.competitionId === this.installation.competitionId &&
      installation === this.installation &&
      generation === this.scheduleGeneration
    ) {
      // The operator list keeps all provider rows. The internal adjacent-schedule
      // schema has a separate 256-row contract; never serve an older cache as fresh.
      this.scheduleCache = null;
      this.scheduleWarning = null;
      if (result.value.matches.length > 256) {
        this.scheduleWarning = '赛事超过 256 场，完整列表仍可浏览和载入；相邻比赛推荐暂不可用。';
      } else {
        // Schema or identity failures propagate instead of being mistaken for a size limit.
        this.scheduleCache = {
          competitionId: installation.competitionId,
          value: toScheduleWindowV1(result.value),
          acquiredAt: this.monotonicNow(),
        };
      }
      await this.rememberViewer(installation, result.value.viewer);
    }
    return result.value;
  }

  private browsingLibrary: { installation: Installation; value: RivalHubLibrary } | null = null;
  private libraryScopeId = randomUUID();
  private libraryForCurrentScope() {
    const installation = this.installation;
    if (!installation) throw new Error('请先连接 RivalHub。');
    if (this.browsingLibrary?.installation !== installation) {
      this.libraryScopeId = randomUUID();
      this.scheduleWarning = null;
      this.scheduleCache = null;
      const scope = createHash('sha256')
        .update(
          JSON.stringify([
            installation.baseUrl,
            installation.competitionId,
            installation.installationId,
          ]),
        )
        .digest('hex');
      const current = () => {
        if (this.installation !== installation) throw new Error('赛事连接已变化。');
      };
      this.browsingLibrary = {
        installation,
        value: new RivalHubLibrary(
          `${this.path}.${scope}.library.json`,
          installation.competitionId,
          async (from, to) => {
            current();
            const result = await this.schedule(from, to);
            current();
            return result;
          },
          (matchId, fresh) => {
            current();
            return this.matchSource(matchId, fresh).load();
          },
        ),
      };
    }
    return this.browsingLibrary.value;
  }

  async library() {
    const installation = this.installation;
    const result = await this.libraryForCurrentScope().view();
    if (this.installation !== installation) throw new Error('赛事连接已变化。');
    return {
      ...result,
      library: {
        ...result.library,
        scopeId: this.libraryScopeId,
        scheduleWarning: this.scheduleWarning,
      },
    };
  }

  async libraryDetail(matchId: string, fresh = true) {
    const installation = this.installation;
    const result = await this.libraryForCurrentScope().detail(matchId, fresh);
    if (this.installation !== installation) throw new Error('赛事连接已变化。');
    return result;
  }

  private manifestScope: {
    installation: Installation;
    pending: Map<string, Promise<unknown>>;
    retryState: { notBefore: number };
    abort: AbortController;
    recent: Map<string, { value: unknown; at: number }>;
  } | null = null;

  matchSource(matchId: string, fresh = true) {
    const installation = this.installation;
    if (!installation) throw new Error('请先连接 RivalHub。');
    if (this.manifestScope?.installation !== installation)
      this.manifestScope = {
        installation,
        pending: new Map(),
        retryState: { notBefore: 0 },
        abort: new AbortController(),
        recent: new Map(),
      };
    const scope = this.manifestScope;
    const source = createOnlineManifestSource(matchId, {
      urlTemplate: `${installation.baseUrl}/api/mizar/match?matchId={matchId}`,
      readToken: installation.credential,
      fetchImpl: this.fetchImpl,
      retryState: scope.retryState,
      signal: scope.abort.signal,
      isCurrent: () => this.installation === installation,
    });
    return {
      kind: source.kind,
      load: async () => {
        if (this.installation !== installation)
          throw new SourceLoadError('赛事连接已变化。', undefined, 'authorization');
        let pending = scope.pending.get(matchId);
        const recent = scope.recent.get(matchId);
        // Only overlapping automatic ticks may reuse a just-validated online entity.
        // Explicit browsing, refresh and activation always read fresh (or join an in-flight read).
        if (
          !pending &&
          !fresh &&
          recent &&
          Date.now() >= recent.at &&
          Date.now() - recent.at < 1000
        )
          return structuredClone(recent.value);
        if (!pending) {
          if (scope.pending.size >= 3)
            throw new SourceLoadError('比赛资料正在读取，请稍后重试。', undefined, 'unavailable');
          pending = source
            .load()
            .then((input) => {
              if (this.installation !== installation)
                throw new SourceLoadError('赛事连接已变化。', undefined, 'authorization');
              const valid = validateBroadcastManifest(input);
              if (!valid.ok)
                throw new SourceLoadError('比赛资料格式无效。', undefined, 'invalid_manifest');
              if (
                valid.value.match.matchId !== matchId ||
                valid.value.match.competition?.competitionId !== installation.competitionId
              )
                throw new SourceLoadError('比赛资料不匹配。', undefined, 'match_mismatch');
              scope.recent.delete(matchId);
              scope.recent.set(matchId, { value: valid.value, at: Date.now() });
              while (scope.recent.size > 2) scope.recent.delete(scope.recent.keys().next().value!);
              return valid.value;
            })
            .catch((error: unknown) => {
              scope.recent.delete(matchId);
              throw error;
            })
            .finally(() => scope.pending.delete(matchId));
          scope.pending.set(matchId, pending);
        }
        // Consumers own their entity; never share a one-shot Response or a mutable document.
        return structuredClone(await pending);
      },
    };
  }
}
