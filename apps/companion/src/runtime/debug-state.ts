import {
  getProgramSourceFreshness,
  type RuntimeContinuityPolicy,
  type RuntimeDisposition,
  type RuntimeState,
  type RuntimeTransition,
} from '@mizar/core/runtime';
import type { TelemetryObservation } from '@mizar/core/telemetry';

import type { LatestWinsConsumerHealth } from './latest-wins.js';
import type { ProgramRuntimeSnapshot } from './program-runtime.js';
import type { RecorderHealth } from '../telemetry/capture-recorder.js';
import type { GsiDiagnosticBatch } from '@mizar/telemetry-gsi';
import type { CstvSourceSnapshot } from '../telemetry/cstv-source-manager.js';

export const DEBUG_RECENT_TRANSITIONS_MAX = 32;
export const DEBUG_RECENT_DIAGNOSTICS_MAX = 32;

export interface AcceptedRawEvidence {
  readonly sequence: number;
  readonly receivedAt: string;
  readonly receivedMonotonicMs: number;
  readonly payload: Record<string, unknown>;
}

export interface CompanionRuntimeDiagnostic {
  readonly code: string;
}

export interface DebugRuntimeResponseOptions {
  readonly nowMonotonicMs: number;
  readonly recorderHealth: RecorderHealth;
  readonly deliveryHealth: readonly LatestWinsConsumerHealth[];
  readonly cstvSources?: {
    readonly program: CstvSourceSnapshot;
    readonly lookahead: CstvSourceSnapshot;
  };
}

export interface DebugRuntimeClock {
  nowMonotonicMs(): number;
}

export interface DebugRuntimeResponse {
  readonly producerInstanceId: string | null;
  readonly sourceGeneration: number | null;
  readonly freshness: 'awaiting' | 'fresh' | 'stale';
  readonly raw: {
    readonly current: {
      readonly sequence: number;
      readonly receivedAt: string;
      readonly receivedMonotonicMs: number;
      readonly payload: Record<string, unknown>;
    } | null;
  };
  readonly normalized: {
    readonly current: unknown;
  };
  readonly runtime: {
    readonly current: unknown;
    readonly lastDisposition: RuntimeDisposition | null;
  };
  readonly recentTransitions: readonly unknown[];
  readonly latestGsiDiagnostics: GsiDiagnosticBatch | null;
  readonly recentRuntimeDiagnostics: readonly CompanionRuntimeDiagnostic[];
  readonly cstvSources: {
    readonly program: CstvSourceSnapshot['health'];
    readonly lookahead: CstvSourceSnapshot['health'];
  };
  readonly recentGameEvents: {
    readonly program: readonly unknown[];
    readonly lookahead: readonly unknown[];
  };
  readonly diagnostics: {
    readonly program: readonly unknown[];
    readonly lookahead: readonly unknown[];
  };
  readonly recorderHealth: RecorderHealth;
  readonly deliveryHealth: readonly LatestWinsConsumerHealth[];
}

const REDACTED = '[REDACTED]';
const steam64Pattern = /\b\d{17}\b/g;
const steamIdPattern = /\bSTEAM_[0-5]:[01]:\d+\b/gi;
const identityKeys = new Set([
  'steamid',
  'steam64',
  'sourceplayerid',
  'displayname',
  'steamname',
  'username',
  'accountid',
  'xuid',
  'playerid',
  'userid',
  'sourceuserid',
  'sourcepawnid',
]);

type RedactionContext = 'none' | 'player-object';

function compactKey(key: string): string {
  return key.replaceAll('_', '').replaceAll('-', '').toLowerCase();
}

function isAllPlayersKey(key: string): boolean {
  return compactKey(key) === 'allplayers';
}

function isPlayerKey(key: string): boolean {
  return compactKey(key) === 'player';
}

function isAuthKey(key: string): boolean {
  const normalized = compactKey(key);
  return normalized === 'auth' || normalized.endsWith('token');
}

function isIdentityKey(key: string): boolean {
  return identityKeys.has(compactKey(key));
}

function isSteamLikeKey(key: string): boolean {
  return /^\d{17}$/.test(key) || /^STEAM_[0-5]:[01]:\d+$/i.test(key);
}

function redactIdentityText(value: string): string {
  return value.replace(steam64Pattern, REDACTED).replace(steamIdPattern, REDACTED);
}

function redactDebugValue(
  value: unknown,
  context: RedactionContext = 'none',
  path: readonly string[] = [],
): unknown {
  if (typeof value === 'string') return redactIdentityText(value);
  if (value === null || typeof value !== 'object') return value;

  const currentKey = path.at(-1);
  if (Array.isArray(value)) {
    const itemContext =
      currentKey !== undefined && (isAllPlayersKey(currentKey) || isPlayerKey(currentKey))
        ? 'player-object'
        : 'none';
    return value.map((item, index) =>
      redactDebugValue(item, itemContext, [...path, String(index)]),
    );
  }

  if (currentKey !== undefined && isAllPlayersKey(currentKey)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const players: Record<string, unknown> = {};
    entries.forEach(([sourcePlayerId, player], index) => {
      const redactedPlayer = redactDebugValue(player, 'player-object', [...path, sourcePlayerId]);
      players[`player-${index + 1}`] = redactedPlayer;
    });
    return players;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isAuthKey(key)) continue;

    if (isIdentityKey(key) || (context === 'player-object' && compactKey(key) === 'name')) {
      result[key] = REDACTED;
      continue;
    }

    if (isSteamLikeKey(key)) {
      result[REDACTED] = redactDebugValue(child, 'none', [...path, key]);
      continue;
    }

    const childContext = isPlayerKey(key) ? 'player-object' : 'none';
    result[key] = redactDebugValue(child, childContext, [...path, key]);
  }
  return result;
}

function redactDiagnosticBatch(batch: GsiDiagnosticBatch): GsiDiagnosticBatch {
  return {
    entries: batch.entries.map((entry) => {
      const pathSegments = entry.path.split('.');
      const rawValueIsSensitive = pathSegments.some((segment, index) => {
        const previousSegments = pathSegments.slice(0, index);
        return (
          isAuthKey(segment) ||
          isIdentityKey(segment) ||
          (previousSegments.some(
            (previous) => isPlayerKey(previous) || isAllPlayersKey(previous),
          ) &&
            compactKey(segment) === 'name')
        );
      });
      const path = pathSegments
        .map((segment, index) => {
          const previousSegment = pathSegments[index - 1];
          return isSteamLikeKey(segment) ||
            (previousSegment !== undefined && isAllPlayersKey(previousSegment))
            ? REDACTED
            : redactIdentityText(segment);
        })
        .join('.');
      const rawValue =
        entry.rawValue === undefined
          ? undefined
          : rawValueIsSensitive
            ? REDACTED
            : redactIdentityText(entry.rawValue);
      return {
        code: entry.code,
        severity: entry.severity,
        path,
        ...(rawValue === undefined ? {} : { rawValue }),
      };
    }),
    suppressedCount: batch.suppressedCount,
  };
}

function redactRuntimeDiagnostics(
  diagnostics: readonly CompanionRuntimeDiagnostic[],
): readonly CompanionRuntimeDiagnostic[] {
  return diagnostics.map(({ code }) => ({ code: redactIdentityText(code) }));
}

export class DebugEvidenceStore {
  private currentRaw: AcceptedRawEvidence | undefined;
  private currentObservation: TelemetryObservation | undefined;
  private currentRuntime: RuntimeState | undefined;
  private continuityPolicy: RuntimeContinuityPolicy | undefined;
  private lastDisposition: RuntimeDisposition | undefined;
  private latestGsiDiagnostics: GsiDiagnosticBatch | undefined;
  private recentTransitions: RuntimeTransition[] = [];
  private recentRuntimeDiagnostics: CompanionRuntimeDiagnostic[] = [];

  constructor(initialRuntime?: ProgramRuntimeSnapshot) {
    if (initialRuntime !== undefined) this.recordRuntime(initialRuntime);
  }

  recordAcceptedRaw(input: AcceptedRawEvidence): void {
    this.currentRaw = input;
  }

  recordNormalizedObservation(observation: TelemetryObservation): void {
    this.currentObservation = observation;
  }

  clearCurrentTelemetry(): void {
    this.currentRaw = undefined;
    this.currentObservation = undefined;
    this.latestGsiDiagnostics = undefined;
  }

  recordGsiDiagnostics(diagnostics: GsiDiagnosticBatch): void {
    this.latestGsiDiagnostics = diagnostics;
  }

  recordRuntime(snapshot: ProgramRuntimeSnapshot): void {
    this.currentRuntime = snapshot.current;
    this.continuityPolicy = snapshot.continuityPolicy;
    this.lastDisposition = snapshot.lastDisposition;
    this.recentTransitions = snapshot.recentTransitions
      .slice(-DEBUG_RECENT_TRANSITIONS_MAX)
      .slice();
  }

  recordRuntimeDiagnostic(code: string): void {
    this.recentRuntimeDiagnostics.push({ code });
    const overflow = this.recentRuntimeDiagnostics.length - DEBUG_RECENT_DIAGNOSTICS_MAX;
    if (overflow > 0) this.recentRuntimeDiagnostics.splice(0, overflow);
  }

  /** Support export never serializes raw telemetry, identities or the full RuntimeState. */
  getSupportSummary(nowMonotonicMs: number) {
    return {
      freshness:
        this.currentRuntime === undefined
          ? 'awaiting'
          : getProgramSourceFreshness(
              this.currentRuntime,
              nowMonotonicMs,
              this.continuityPolicy ?? { staleAfterMs: 20_000 },
            ),
      lastDisposition:
        this.lastDisposition === undefined
          ? null
          : { kind: this.lastDisposition.kind, reason: this.lastDisposition.reason },
      recentTransitions: this.recentTransitions.map(({ kind }) => ({ kind })),
      recentRuntimeDiagnosticCount: this.recentRuntimeDiagnostics.length,
      recentRuntimeDiagnostics: this.recentRuntimeDiagnostics.map(({ code }) => ({
        code: [
          'adapter_unexpected_failure',
          'accepted_raw_sink_failed',
          'gsi_diagnostics_sink_failed',
          'observation_sink_failed',
          'recorder_unexpected_failure',
          'program-schema-validation-failed',
          'radar-schema-validation-failed',
          'operator-schema-validation-failed',
          'assist-schema-validation-failed',
          'program-wire-validation-failed',
          'radar-wire-validation-failed',
          'operator-wire-validation-failed',
          'assist-wire-validation-failed',
        ].includes(code)
          ? code
          : 'other_runtime_diagnostic',
      })),
      gsiDiagnostics: {
        count: this.latestGsiDiagnostics?.entries.length ?? 0,
        suppressedCount: this.latestGsiDiagnostics?.suppressedCount ?? 0,
        recent: (this.latestGsiDiagnostics?.entries ?? [])
          .slice(-32)
          .map(({ code, severity }) => ({ code, severity })),
      },
    };
  }

  getResponse(options: DebugRuntimeResponseOptions): DebugRuntimeResponse {
    const cstvSources =
      options.cstvSources ??
      ({
        program: {
          health: {
            role: 'program' as const,
            state: 'disabled' as const,
            generation: 0,
            reconnectAttempt: 0,
          },
          recentGameEvents: [],
          recentDiagnostics: [],
        },
        lookahead: {
          health: {
            role: 'lookahead' as const,
            state: 'disabled' as const,
            generation: 0,
            reconnectAttempt: 0,
          },
          recentGameEvents: [],
          recentDiagnostics: [],
        },
      } satisfies NonNullable<DebugRuntimeResponseOptions['cstvSources']>);
    const runtime = this.currentRuntime;
    const raw = this.currentRaw;
    const redactedRaw =
      raw === undefined
        ? null
        : {
            sequence: raw.sequence,
            receivedAt: raw.receivedAt,
            receivedMonotonicMs: raw.receivedMonotonicMs,
            payload: redactDebugValue(raw.payload, 'none', ['payload']) as Record<string, unknown>,
          };
    const freshness =
      runtime === undefined
        ? 'awaiting'
        : getProgramSourceFreshness(
            runtime,
            options.nowMonotonicMs,
            this.continuityPolicy ?? { staleAfterMs: 20_000 },
          );

    return {
      producerInstanceId: runtime?.producerInstanceId ?? null,
      sourceGeneration: runtime?.programSource.generation ?? null,
      freshness,
      raw: { current: redactedRaw },
      normalized: {
        current:
          this.currentObservation === undefined ? null : redactDebugValue(this.currentObservation),
      },
      runtime: {
        current: runtime === undefined ? null : redactDebugValue(runtime),
        lastDisposition: this.lastDisposition ?? null,
      },
      recentTransitions: redactDebugValue(this.recentTransitions) as readonly unknown[],
      latestGsiDiagnostics:
        this.latestGsiDiagnostics === undefined
          ? null
          : redactDiagnosticBatch(this.latestGsiDiagnostics),
      recentRuntimeDiagnostics: redactRuntimeDiagnostics(this.recentRuntimeDiagnostics),
      cstvSources: {
        program: { ...cstvSources.program.health },
        lookahead: { ...cstvSources.lookahead.health },
      },
      recentGameEvents: {
        program: redactDebugValue(cstvSources.program.recentGameEvents) as readonly unknown[],
        lookahead: redactDebugValue(cstvSources.lookahead.recentGameEvents) as readonly unknown[],
      },
      diagnostics: {
        program: redactDebugValue(cstvSources.program.recentDiagnostics) as readonly unknown[],
        lookahead: redactDebugValue(cstvSources.lookahead.recentDiagnostics) as readonly unknown[],
      },
      recorderHealth: { ...options.recorderHealth },
      deliveryHealth: options.deliveryHealth.map((health) => ({ ...health })),
    };
  }

  toResponse(options: DebugRuntimeResponseOptions): DebugRuntimeResponse {
    return this.getResponse(options);
  }
}

export { redactDebugValue };
