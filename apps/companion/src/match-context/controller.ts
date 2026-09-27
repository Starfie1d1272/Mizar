import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  BroadcastManifestConversionError,
  toMatchContext,
  validateBroadcastManifest,
  type BroadcastManifestV1,
  type ContractDiagnostic,
} from '@rivalhub-broadcast/rivalhub';

import { SerialCommitQueue } from './serial-commit.js';
import { SourceLoadError } from './source-error.js';
import {
  type ContextFreshness,
  type ContextOrigin,
  type MatchContextBinding,
  type MatchContextStoreIssue,
  type MatchManifestLkgSaveOptions,
  type MatchManifestLkgStore,
  type LocalAuthoringMode,
  isLocalBinding,
  isStandaloneLocalMatch,
} from './lkg-store.js';

export interface MatchContextSource {
  readonly kind: Exclude<ContextOrigin, 'cache'>;
  /** Expected network/source failures must reject with SourceLoadError. */
  readonly load: () => Promise<unknown>;
}

export type MatchContextControllerIssueCode =
  | 'source_load_failed'
  | 'source_invalid'
  | 'source_match_mismatch'
  | 'source_conversion_failed'
  | 'lkg_fallback'
  | 'memory_fallback'
  | 'lkg_unavailable'
  | 'lkg_persistence_failed'
  | 'rivalhub_candidate_pending'
  | 'local_identity_mismatch'
  | 'selection_stale';

export interface MatchContextControllerIssue {
  readonly code: MatchContextControllerIssueCode;
  readonly message: string;
  readonly diagnostics?: readonly ContractDiagnostic[];
  readonly storeIssue?: MatchContextStoreIssue;
}

export interface MatchContextSelectionSuccess {
  readonly ok: true;
  readonly binding: MatchContextBinding;
  readonly diagnostics: readonly MatchContextControllerIssue[];
}

export interface MatchContextSelectionFailure {
  readonly ok: false;
  readonly requestedMatchId: string;
  readonly diagnostics: readonly MatchContextControllerIssue[];
}

export type MatchContextSelectionResult =
  MatchContextSelectionSuccess | MatchContextSelectionFailure;

export interface MatchContextControllerOptions {
  readonly lkgStore: MatchManifestLkgStore;
  readonly initialBinding?: MatchContextBinding;
  readonly onBindingChanged?: (binding: MatchContextBinding | undefined) => void;
}

export interface PendingOnlineMatchCandidate {
  readonly binding: MatchContextBinding;
  readonly revision: string;
}

function controllerIssue(
  code: MatchContextControllerIssueCode,
  message: string,
  details: Omit<MatchContextControllerIssue, 'code' | 'message'> = {},
): MatchContextControllerIssue {
  return { code, message, ...details };
}

function isPlayedMap(map: BroadcastManifestV1['maps'][number]): boolean {
  return map.scoreA !== null || map.scoreB !== null || map.completedAt !== null;
}

function preservesLocalMatchIdentity(
  current: BroadcastManifestV1,
  candidate: BroadcastManifestV1,
): boolean {
  const stableMatch = (match: BroadcastManifestV1['match']) => ({
    ...match,
    competition: { ...match.competition, name: '', slug: '' },
    format: 'bo1',
    stage: '',
  });
  const stableEntrants = (manifest: BroadcastManifestV1) => ({
    a: { entryId: manifest.entrants.a.entryId, roster: manifest.entrants.a.roster },
    b: { entryId: manifest.entrants.b.entryId, roster: manifest.entrants.b.roster },
  });
  if (
    current.match.matchId !== candidate.match.matchId ||
    current.match.competition.competitionId !== candidate.match.competition.competitionId ||
    !isDeepStrictEqual(stableMatch(current.match), stableMatch(candidate.match)) ||
    !isDeepStrictEqual(stableEntrants(current), stableEntrants(candidate)) ||
    !isDeepStrictEqual(current.commentators, candidate.commentators)
  )
    return false;

  const candidateMaps = new Map(candidate.maps.map((map) => [map.mapOrder, map]));
  return current.maps
    .filter(isPlayedMap)
    .every((map) => isDeepStrictEqual(map, candidateMaps.get(map.mapOrder)));
}

function preservesBoundMatch(
  current: MatchContextBinding,
  candidate: BroadcastManifestV1,
): boolean {
  if (isStandaloneLocalMatch(current))
    return preservesLocalMatchIdentity(current.manifest, candidate);
  return (
    isDeepStrictEqual(current.manifest.match, candidate.match) &&
    isDeepStrictEqual(current.manifest.entrants, candidate.entrants) &&
    isDeepStrictEqual(current.manifest.commentators, candidate.commentators) &&
    current.manifest.maps.filter(isPlayedMap).every((map) =>
      isDeepStrictEqual(
        map,
        candidate.maps.find((candidateMap) => candidateMap.mapOrder === map.mapOrder),
      ),
    )
  );
}

export class MatchContextController {
  private readonly lkgStore: MatchManifestLkgStore;
  private readonly onBindingChanged:
    ((binding: MatchContextBinding | undefined) => void) | undefined;
  private readonly commitQueue = new SerialCommitQueue();
  private activeBinding: MatchContextBinding | undefined;
  private pendingOnlineCandidate: PendingOnlineMatchCandidate | undefined;
  private bindingRevision = 0;
  private readonly revisionEpoch = randomUUID();
  private activeSelectionGeneration = 0;
  private onlineCandidateGeneration = 0;
  private onlineCandidateAcquisition: number | undefined;

  constructor(options: MatchContextControllerOptions) {
    this.lkgStore = options.lkgStore;
    this.onBindingChanged = options.onBindingChanged;
    this.activeBinding = options.initialBinding;
    this.bindingRevision = options.initialBinding === undefined ? 0 : 1;
  }

  getActiveBinding(): MatchContextBinding | undefined {
    return this.activeBinding;
  }

  getActiveRevision(): string {
    return `${this.revisionEpoch}:${this.bindingRevision}`;
  }

  getPendingOnlineCandidate(): PendingOnlineMatchCandidate | undefined {
    const candidate = this.pendingOnlineCandidate;
    return candidate === undefined
      ? undefined
      : { binding: candidate.binding, revision: candidate.revision };
  }

  clearActive(): void {
    this.activeSelectionGeneration += 1;
    this.onlineCandidateGeneration += 1;
    this.onlineCandidateAcquisition = undefined;
    this.pendingOnlineCandidate = undefined;
    this.clearActiveBinding();
  }

  private clearActiveBinding(): void {
    if (this.activeBinding === undefined) return;
    if (isLocalBinding(this.activeBinding)) {
      this.onlineCandidateGeneration += 1;
      this.onlineCandidateAcquisition = undefined;
      this.pendingOnlineCandidate = undefined;
    }
    this.activeBinding = undefined;
    this.bindingRevision += 1;
    this.onBindingChanged?.(undefined);
  }

  private setActive(binding: MatchContextBinding): void {
    if (isLocalBinding(this.activeBinding) && !isLocalBinding(binding)) {
      this.onlineCandidateGeneration += 1;
      this.onlineCandidateAcquisition = undefined;
      this.pendingOnlineCandidate = undefined;
    }
    this.activeBinding = binding;
    this.bindingRevision += 1;
    this.onBindingChanged?.(binding);
  }

  async selectMatch(
    requestedMatchId: string,
    source: MatchContextSource,
  ): Promise<MatchContextSelectionResult> {
    if (source.kind === 'online' && this.hasLocalOverride()) {
      const candidateGeneration = ++this.onlineCandidateGeneration;
      this.onlineCandidateAcquisition = candidateGeneration;
      const isLatestCandidate = () => candidateGeneration === this.onlineCandidateGeneration;
      try {
        return await this.stageOnlineCandidate(requestedMatchId, source, isLatestCandidate);
      } finally {
        if (this.onlineCandidateAcquisition === candidateGeneration)
          this.onlineCandidateAcquisition = undefined;
      }
    }
    const generation = ++this.activeSelectionGeneration;
    const isCurrent = () => generation === this.activeSelectionGeneration;
    if (this.activeBinding?.context.matchId !== requestedMatchId) this.clearActiveBinding();

    let candidate: unknown;
    try {
      candidate = await source.load();
    } catch (error: unknown) {
      if (!(error instanceof SourceLoadError)) throw error;
      return this.useFallback(generation, requestedMatchId, [
        controllerIssue('source_load_failed', 'Manifest source 加载失败。'),
      ]);
    }

    const validated = validateBroadcastManifest(candidate);
    if (!validated.ok) {
      return this.useFallback(generation, requestedMatchId, [
        controllerIssue('source_invalid', 'Manifest source 未通过 validation。', {
          diagnostics: validated.diagnostics,
        }),
      ]);
    }
    if (validated.value.match.matchId !== requestedMatchId) {
      return this.useFallback(generation, requestedMatchId, [
        controllerIssue('source_match_mismatch', 'Manifest source matchId 与请求不一致。'),
      ]);
    }

    let context;
    try {
      context = toMatchContext(validated.value);
    } catch (error: unknown) {
      if (!(error instanceof BroadcastManifestConversionError)) throw error;
      return {
        ok: false,
        requestedMatchId,
        diagnostics: [
          controllerIssue(
            'source_conversion_failed',
            'Manifest candidate 无法转换为 MatchContext。',
            { diagnostics: error.diagnostics },
          ),
        ],
      };
    }

    return this.commitQueue.run(async () => {
      if (!isCurrent()) return this.staleSelectionResult(requestedMatchId);

      const saveOptions: MatchManifestLkgSaveOptions = { canCommit: isCurrent };
      const saved = await this.lkgStore.save(validated.value, source.kind, saveOptions);
      if (!isCurrent() || (!saved.ok && saved.issue.code === 'lkg_commit_stale')) {
        return this.staleSelectionResult(requestedMatchId);
      }

      const diagnostics: MatchContextControllerIssue[] = [];
      if (!saved.ok) {
        diagnostics.push(
          controllerIssue(
            'lkg_persistence_failed',
            '当前 candidate 有效，但未能更新 Manifest LKG。',
            {
              storeIssue: saved.issue,
            },
          ),
        );
      }
      const binding: MatchContextBinding = {
        manifest: validated.value,
        context,
        origin: source.kind,
        freshness: 'fresh',
        localAuthoringMode: 'bound-overlay',
        diagnostics: validated.diagnostics,
      };
      this.setActive(binding);
      return { ok: true, binding, diagnostics };
    });
  }

  async selectLocalMatch(
    candidate: unknown,
    expectedBindingRevision: string,
  ): Promise<MatchContextSelectionResult> {
    const generation = ++this.activeSelectionGeneration;
    const isCurrent = () => generation === this.activeSelectionGeneration;
    const validated = validateBroadcastManifest(candidate);
    if (!validated.ok) {
      return {
        ok: false,
        requestedMatchId: '',
        diagnostics: [
          controllerIssue('source_invalid', '本地 BP 未通过 Manifest validation。', {
            diagnostics: validated.diagnostics,
          }),
        ],
      };
    }
    let context;
    try {
      context = toMatchContext(validated.value);
    } catch (error: unknown) {
      if (!(error instanceof BroadcastManifestConversionError)) throw error;
      return {
        ok: false,
        requestedMatchId: validated.value.match.matchId,
        diagnostics: [
          controllerIssue('source_conversion_failed', '本地 BP 无法转换为比赛上下文。', {
            diagnostics: error.diagnostics,
          }),
        ],
      };
    }

    return this.commitQueue.run(async () => {
      if (!isCurrent() || expectedBindingRevision !== this.getActiveRevision())
        return this.staleSelectionResult(validated.value.match.matchId);
      const current = this.activeBinding;
      if (current !== undefined && !preservesBoundMatch(current, validated.value))
        return {
          ok: false,
          requestedMatchId: validated.value.match.matchId,
          diagnostics: [
            controllerIssue(
              'local_identity_mismatch',
              '本地 BP 只能更新当前比赛的 BP，不能替换已绑定的比赛或参赛身份。',
            ),
          ],
        };
      const authoringMode: LocalAuthoringMode =
        current === undefined || isStandaloneLocalMatch(current) ? 'standalone' : 'bound-overlay';
      const canCommit = () => isCurrent() && expectedBindingRevision === this.getActiveRevision();
      const saved = await this.lkgStore.save(validated.value, 'local', {
        canCommit,
        localAuthoringMode: authoringMode,
      });
      if (!canCommit() || (!saved.ok && saved.issue.code === 'lkg_commit_stale'))
        return this.staleSelectionResult(validated.value.match.matchId);
      if (!saved.ok) {
        return {
          ok: false,
          requestedMatchId: validated.value.match.matchId,
          diagnostics: [
            controllerIssue('lkg_persistence_failed', '本地 BP 未能安全保存，当前比赛保持不变。', {
              storeIssue: saved.issue,
            }),
          ],
        };
      }
      const binding: MatchContextBinding = {
        manifest: validated.value,
        context,
        origin: 'local',
        freshness: 'fresh',
        localAuthoringMode: authoringMode,
        diagnostics: validated.diagnostics,
      };
      this.setActive(binding);
      return { ok: true, binding, diagnostics: [] };
    });
  }

  async restoreLatest(): Promise<MatchContextBinding | undefined> {
    const generation = ++this.activeSelectionGeneration;
    return this.commitQueue.run(async () => {
      if (this.activeBinding !== undefined) return this.activeBinding;
      const cached = await this.lkgStore.readLatest();
      if (generation !== this.activeSelectionGeneration || !cached.ok) return undefined;
      this.setActive(cached.value);
      return cached.value;
    });
  }

  async activatePendingOnlineMatch(
    expectedBindingRevision: string,
    expectedPendingRevision: string,
  ): Promise<MatchContextSelectionResult> {
    const pending = this.pendingOnlineCandidate;
    if (
      pending === undefined ||
      pending.revision !== expectedPendingRevision ||
      this.onlineCandidateAcquisition !== undefined ||
      expectedBindingRevision !== this.getActiveRevision() ||
      !this.hasLocalOverride()
    )
      return this.staleSelectionResult(pending?.binding.context.matchId ?? '');
    const generation = ++this.activeSelectionGeneration;
    const candidateGeneration = this.onlineCandidateGeneration;
    const isCurrent = () =>
      generation === this.activeSelectionGeneration &&
      candidateGeneration === this.onlineCandidateGeneration &&
      expectedBindingRevision === this.getActiveRevision() &&
      this.pendingOnlineCandidate?.revision === expectedPendingRevision;
    return this.commitQueue.run(async () => {
      if (!isCurrent()) return this.staleSelectionResult(pending.binding.context.matchId);
      const saved = await this.lkgStore.save(pending.binding.manifest, 'online', {
        canCommit: isCurrent,
      });
      if (!isCurrent() || (!saved.ok && saved.issue.code === 'lkg_commit_stale'))
        return this.staleSelectionResult(pending.binding.context.matchId);
      if (!saved.ok) {
        return {
          ok: false,
          requestedMatchId: pending.binding.context.matchId,
          diagnostics: [
            controllerIssue(
              'lkg_persistence_failed',
              '无法安全切回 RivalHub BP，本地比赛保持不变。',
              {
                storeIssue: saved.issue,
              },
            ),
          ],
        };
      }
      this.pendingOnlineCandidate = undefined;
      this.setActive(pending.binding);
      return { ok: true, binding: pending.binding, diagnostics: [] };
    });
  }

  private hasLocalOverride(): boolean {
    return isLocalBinding(this.activeBinding);
  }

  private async stageOnlineCandidate(
    requestedMatchId: string,
    source: MatchContextSource,
    isCurrent: () => boolean,
  ): Promise<MatchContextSelectionResult> {
    let candidate: unknown;
    try {
      candidate = await source.load();
    } catch (error: unknown) {
      if (!(error instanceof SourceLoadError)) throw error;
      if (!isCurrent()) return this.staleSelectionResult(requestedMatchId);
      return {
        ok: false,
        requestedMatchId,
        diagnostics: [
          controllerIssue('source_load_failed', 'RivalHub BP 当前不可用，本地比赛仍保持。'),
        ],
      };
    }
    if (!isCurrent()) return this.staleSelectionResult(requestedMatchId);
    const validated = validateBroadcastManifest(candidate);
    if (!validated.ok || validated.value.match.matchId !== requestedMatchId) {
      return {
        ok: false,
        requestedMatchId,
        diagnostics: [
          controllerIssue(
            validated.ok ? 'source_match_mismatch' : 'source_invalid',
            'RivalHub BP 暂不可用，本地比赛仍保持。',
            validated.ok ? {} : { diagnostics: validated.diagnostics },
          ),
        ],
      };
    }
    let context;
    try {
      context = toMatchContext(validated.value);
    } catch (error: unknown) {
      if (!(error instanceof BroadcastManifestConversionError)) throw error;
      return {
        ok: false,
        requestedMatchId,
        diagnostics: [
          controllerIssue('source_conversion_failed', 'RivalHub BP 无法转换，本地比赛仍保持。', {
            diagnostics: error.diagnostics,
          }),
        ],
      };
    }
    return this.commitQueue.run(() => {
      if (!isCurrent() || !this.hasLocalOverride() || this.activeBinding === undefined)
        return this.staleSelectionResult(requestedMatchId);
      const binding: MatchContextBinding = {
        manifest: validated.value,
        context,
        origin: 'online',
        freshness: 'fresh',
        localAuthoringMode: 'bound-overlay',
        diagnostics: validated.diagnostics,
      };
      this.pendingOnlineCandidate = { binding, revision: randomUUID() };
      return {
        ok: true,
        binding: this.activeBinding,
        diagnostics: [
          controllerIssue(
            'rivalhub_candidate_pending',
            'RivalHub BP 已恢复，等待制作人员确认切回。',
          ),
        ],
      };
    });
  }

  private async useFallback(
    generation: number,
    requestedMatchId: string,
    diagnostics: MatchContextControllerIssue[],
  ): Promise<MatchContextSelectionResult> {
    return this.commitQueue.run(async () => {
      if (generation !== this.activeSelectionGeneration)
        return this.staleSelectionResult(requestedMatchId);

      const current = this.activeBinding;
      if (current?.context.matchId === requestedMatchId) {
        const staleBinding: MatchContextBinding = { ...current, freshness: 'stale' };
        diagnostics.push(
          controllerIssue(
            'memory_fallback',
            'Manifest source 失败，继续使用当前同 matchId 的内存 binding，并标记为 stale。',
          ),
        );
        this.setActive(staleBinding);
        return { ok: true, binding: staleBinding, diagnostics };
      }

      const fallback = await this.lkgStore.read(requestedMatchId);
      if (generation !== this.activeSelectionGeneration)
        return this.staleSelectionResult(requestedMatchId);
      if (fallback.ok) {
        diagnostics.push(
          controllerIssue('lkg_fallback', '已使用同一 matchId 的 stale Manifest LKG。'),
        );
        this.setActive(fallback.value);
        return { ok: true, binding: fallback.value, diagnostics };
      }
      diagnostics.push(
        controllerIssue('lkg_unavailable', '没有可用于该 matchId 的 Manifest LKG。', {
          storeIssue: fallback.issue,
        }),
      );
      return { ok: false, requestedMatchId, diagnostics };
    });
  }

  private staleSelectionResult(requestedMatchId: string): MatchContextSelectionFailure {
    return {
      ok: false,
      requestedMatchId,
      diagnostics: [
        controllerIssue(
          'selection_stale',
          'MatchContext selection 已被更新的 selection supersede。',
        ),
      ],
    };
  }
}

export function createMatchContextController(
  options: MatchContextControllerOptions,
): MatchContextController {
  return new MatchContextController(options);
}

export type { ContextFreshness, ContextOrigin };
export type { BroadcastManifestV1 };
