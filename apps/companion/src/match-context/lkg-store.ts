import { readFile } from 'node:fs/promises';

import {
  BroadcastManifestConversionError,
  toMatchDocumentV1,
  validateBroadcastManifest,
  type BroadcastManifest,
  type ContractDiagnostic,
} from '@mizar/rivalhub';
import type { MatchContext } from '@mizar/core/match-context';

import { replaceDurableJson, type DurableJsonFaultInjector } from './durable-json.js';
import { SerialCommitQueue } from './serial-commit.js';

export type ContextOrigin = 'online' | 'local' | 'fixture' | 'cache';
export type ContextFreshness = 'fresh' | 'stale';
export type LocalAuthoringMode = 'standalone' | 'bound-overlay';

export const MATCH_CONTEXT_CACHE_VERSION = 'mizar.match-context-cache.v1' as const;

export interface MatchContextBinding {
  readonly manifest: BroadcastManifest;
  readonly context: MatchContext;
  readonly origin: ContextOrigin;
  readonly freshness: ContextFreshness;
  /** Acquisition metadata; never part of the provider-neutral MatchContext domain. */
  readonly localAuthoringMode?: LocalAuthoringMode;
  readonly storedAt?: string;
  readonly cachedFrom?: Exclude<ContextOrigin, 'cache'>;
  readonly diagnostics: readonly ContractDiagnostic[];
}

export function isLocalBinding(
  binding: Pick<MatchContextBinding, 'origin' | 'cachedFrom'> | undefined,
): boolean {
  return (
    binding?.origin === 'local' || (binding?.origin === 'cache' && binding.cachedFrom === 'local')
  );
}

export function localAuthoringMode(
  binding: Pick<MatchContextBinding, 'origin' | 'cachedFrom' | 'localAuthoringMode'> | undefined,
): LocalAuthoringMode | undefined {
  if (binding === undefined) return undefined;
  // Legacy bindings without provenance fail closed as canonical overlays.
  if (binding.localAuthoringMode === 'standalone' && !isLocalBinding(binding))
    return 'bound-overlay';
  return binding.localAuthoringMode ?? 'bound-overlay';
}

export function isBoundLocalOverride(
  binding: Pick<MatchContextBinding, 'origin' | 'cachedFrom' | 'localAuthoringMode'> | undefined,
): boolean {
  return isLocalBinding(binding) && localAuthoringMode(binding) === 'bound-overlay';
}

export function isStandaloneLocalMatch(
  binding: Pick<MatchContextBinding, 'origin' | 'cachedFrom' | 'localAuthoringMode'> | undefined,
): boolean {
  return isLocalBinding(binding) && localAuthoringMode(binding) === 'standalone';
}

export type MatchContextStoreIssueCode =
  | 'lkg_not_found'
  | 'lkg_read_failed'
  | 'lkg_invalid_json'
  | 'lkg_invalid_envelope'
  | 'lkg_invalid_candidate'
  | 'lkg_match_mismatch'
  | 'lkg_write_failed'
  | 'lkg_commit_stale';

export interface MatchContextStoreIssue {
  readonly code: MatchContextStoreIssueCode;
  readonly message: string;
  readonly diagnostics?: readonly ContractDiagnostic[];
}

export interface MatchContextStoreFailure {
  readonly ok: false;
  readonly issue: MatchContextStoreIssue;
}

export interface MatchContextStoreSuccess<T> {
  readonly ok: true;
  readonly value: T;
  readonly diagnostics: readonly ContractDiagnostic[];
}

export type MatchContextStoreResult<T> = MatchContextStoreSuccess<T> | MatchContextStoreFailure;

export interface MatchManifestLkgStoreOptions {
  readonly filePath: string;
  readonly clock?: () => string;
  /** Test-only hook used to prove failed commits preserve the previous envelope. */
  readonly faultInjector?: DurableJsonFaultInjector;
}

interface MatchManifestCacheMetadata {
  readonly matchId: string;
  readonly origin: Exclude<ContextOrigin, 'cache'>;
  readonly storedAt: string;
  readonly localAuthoringMode: LocalAuthoringMode;
}

interface MatchManifestCacheEnvelope {
  readonly cacheVersion: typeof MATCH_CONTEXT_CACHE_VERSION;
  readonly metadata: MatchManifestCacheMetadata;
  readonly payload: BroadcastManifest;
}

function isSourceOrigin(value: unknown): value is Exclude<ContextOrigin, 'cache'> {
  return value === 'online' || value === 'local' || value === 'fixture';
}

function isLocalAuthoringMode(value: unknown): value is LocalAuthoringMode {
  return value === 'standalone' || value === 'bound-overlay';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEnvelope(value: unknown): MatchManifestCacheEnvelope | undefined {
  if (!isRecord(value) || value.cacheVersion !== MATCH_CONTEXT_CACHE_VERSION) return undefined;
  const metadata = value.metadata;
  if (!isRecord(metadata)) return undefined;
  if (
    typeof metadata.matchId !== 'string' ||
    !isSourceOrigin(metadata.origin) ||
    typeof metadata.storedAt !== 'string' ||
    !isLocalAuthoringMode(metadata.localAuthoringMode) ||
    (metadata.localAuthoringMode !== undefined &&
      !isLocalAuthoringMode(metadata.localAuthoringMode)) ||
    value.payload === undefined
  ) {
    return undefined;
  }
  return {
    cacheVersion: value.cacheVersion,
    metadata: {
      matchId: metadata.matchId,
      origin: metadata.origin,
      storedAt: metadata.storedAt,
      localAuthoringMode:
        metadata.origin === 'local' && isLocalAuthoringMode(metadata.localAuthoringMode)
          ? metadata.localAuthoringMode
          : 'bound-overlay',
    },
    payload: value.payload as BroadcastManifest,
  };
}

function invalidCandidate(diagnostics: readonly ContractDiagnostic[]): MatchContextStoreFailure {
  return {
    ok: false,
    issue: {
      code: 'lkg_invalid_candidate',
      message: 'Manifest candidate 未通过 structural/semantic validation。',
      diagnostics,
    },
  };
}

function invalidEnvelope(): MatchContextStoreFailure {
  return {
    ok: false,
    issue: {
      code: 'lkg_invalid_envelope',
      message: 'Manifest LKG cache envelope 缺少有效的版本、metadata 或 payload。',
    },
  };
}

export interface MatchManifestLkgSaveOptions {
  readonly canCommit?: () => boolean;
  readonly localAuthoringMode?: LocalAuthoringMode;
}

export class MatchManifestLkgStore {
  private readonly filePath: string;
  private readonly clock: () => string;
  private readonly faultInjector: DurableJsonFaultInjector | undefined;
  private readonly commitQueue = new SerialCommitQueue();

  constructor(options: MatchManifestLkgStoreOptions) {
    this.filePath = options.filePath;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.faultInjector = options.faultInjector;
  }

  async save(
    candidate: unknown,
    origin: Exclude<ContextOrigin, 'cache'>,
    options: MatchManifestLkgSaveOptions = {},
  ): Promise<MatchContextStoreResult<BroadcastManifest>> {
    const validated = validateBroadcastManifest(candidate);
    if (!validated.ok) return invalidCandidate(validated.diagnostics);

    return this.commitQueue.run(async () => {
      const envelope: MatchManifestCacheEnvelope = {
        cacheVersion: MATCH_CONTEXT_CACHE_VERSION,
        metadata: {
          matchId: validated.value.match.matchId,
          origin,
          storedAt: this.clock(),
          localAuthoringMode:
            origin === 'local' ? (options.localAuthoringMode ?? 'bound-overlay') : 'bound-overlay',
        },
        payload: validated.value,
      };

      try {
        const committed = await replaceDurableJson(this.filePath, envelope, {
          ...(options.canCommit === undefined ? {} : { canCommit: options.canCommit }),
          ...(this.faultInjector === undefined ? {} : { faultInjector: this.faultInjector }),
        });
        if (!committed) {
          return {
            ok: false,
            issue: {
              code: 'lkg_commit_stale',
              message: 'Manifest LKG candidate 已被更新的 selection supersede。',
            },
          };
        }
      } catch {
        return {
          ok: false,
          issue: {
            code: 'lkg_write_failed',
            message: 'Manifest LKG 原子提交失败，旧 cache envelope 保持不变。',
          },
        };
      }
      return {
        ok: true,
        value: validated.value,
        diagnostics: validated.diagnostics,
      };
    });
  }

  async read(requestedMatchId: string): Promise<MatchContextStoreResult<MatchContextBinding>> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return {
          ok: false,
          issue: { code: 'lkg_not_found', message: '没有可用的 Manifest LKG。' },
        };
      }
      return {
        ok: false,
        issue: { code: 'lkg_read_failed', message: 'Manifest LKG 读取失败。' },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      return {
        ok: false,
        issue: { code: 'lkg_invalid_json', message: 'Manifest LKG 不是有效 JSON。' },
      };
    }

    const envelope = parseEnvelope(parsed);
    if (envelope === undefined) return invalidEnvelope();

    const validated = validateBroadcastManifest(envelope.payload);
    if (!validated.ok) return invalidCandidate(validated.diagnostics);
    if (
      validated.value.match.matchId !== envelope.metadata.matchId ||
      validated.value.match.matchId !== requestedMatchId
    ) {
      return {
        ok: false,
        issue: {
          code: 'lkg_match_mismatch',
          message: 'Manifest LKG matchId 与请求或 envelope metadata 不一致。',
        },
      };
    }

    try {
      const context = toMatchDocumentV1(validated.value);
      const binding: MatchContextBinding = {
        manifest: validated.value,
        context,
        origin: 'cache',
        freshness: 'stale',
        localAuthoringMode: envelope.metadata.localAuthoringMode,
        storedAt: envelope.metadata.storedAt,
        cachedFrom: envelope.metadata.origin,
        diagnostics: validated.diagnostics,
      };
      return {
        ok: true,
        value: binding,
        diagnostics: validated.diagnostics,
      };
    } catch (error: unknown) {
      if (!(error instanceof BroadcastManifestConversionError)) throw error;
      return {
        ok: false,
        issue: {
          code: 'lkg_invalid_candidate',
          message: 'Manifest LKG 无法重新转换为 MatchContext。',
          diagnostics: error.diagnostics,
        },
      };
    }
  }

  async readLatest(): Promise<MatchContextStoreResult<MatchContextBinding>> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return {
          ok: false,
          issue: { code: 'lkg_not_found', message: '没有可用的 Manifest LKG。' },
        };
      }
      return {
        ok: false,
        issue: { code: 'lkg_read_failed', message: 'Manifest LKG 读取失败。' },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      return {
        ok: false,
        issue: { code: 'lkg_invalid_json', message: 'Manifest LKG 不是有效 JSON。' },
      };
    }
    const envelope = parseEnvelope(parsed);
    if (envelope === undefined) return invalidEnvelope();
    return this.read(envelope.metadata.matchId);
  }
}
