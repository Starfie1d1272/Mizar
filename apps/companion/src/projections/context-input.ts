import type { ContractDiagnostic } from '@mizar/rivalhub';
import type { MatchContext } from '@mizar/core/match-context';

import type { ContextOrigin, MatchContextBinding } from '../match-context/index.js';

export interface ProjectionContextInput {
  readonly context: MatchContext | undefined;
  readonly state: 'unbound' | 'bound';
  readonly origin: ContextOrigin | null;
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
    freshness: binding.freshness,
    storedAt: binding.storedAt ?? null,
    cachedFrom: binding.cachedFrom ?? null,
    diagnostics: binding.diagnostics.slice(),
  };
}
