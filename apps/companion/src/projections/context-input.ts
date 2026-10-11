import type { ContractDiagnostic } from '@mizar/rivalhub';
import type { MatchContext } from '@mizar/core/match-context';

import {
  isStandaloneLocalMatch,
  type ContextOrigin,
  type MatchContextBinding,
} from '../match-context/index.js';
import type { SourceFailureCode } from '../match-context/source-error.js';

export interface ProjectionContextInput {
  readonly context: MatchContext | undefined;
  readonly state: 'unbound' | 'bound';
  readonly origin: ContextOrigin | null;
  readonly rosterAuthority: 'local-server' | 'rivalhub' | 'fixture' | 'unknown';
  readonly sourceFailure: SourceFailureCode | null;
  readonly freshness: 'unbound' | 'fresh' | 'stale';
  readonly storedAt: string | null;
  readonly cachedFrom: Exclude<ContextOrigin, 'cache'> | null;
  readonly diagnostics: readonly ContractDiagnostic[];
}

export function projectionContextFromBinding(
  binding: MatchContextBinding | undefined,
): ProjectionContextInput {
  if (binding === undefined) {
    return {
      context: undefined,
      state: 'unbound',
      origin: null,
      rosterAuthority: 'unknown',
      sourceFailure: null,
      freshness: 'unbound',
      storedAt: null,
      cachedFrom: null,
      diagnostics: [],
    };
  }

  return {
    context: binding.context,
    state: 'bound',
    origin: binding.origin,
    rosterAuthority: isStandaloneLocalMatch(binding)
      ? 'local-server'
      : binding.origin === 'fixture' || binding.cachedFrom === 'fixture'
        ? 'fixture'
        : 'rivalhub',
    sourceFailure: binding.sourceFailure ?? null,
    freshness: binding.freshness,
    storedAt: binding.storedAt ?? null,
    cachedFrom: binding.cachedFrom ?? null,
    diagnostics: binding.diagnostics.slice(),
  };
}
