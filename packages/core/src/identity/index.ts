export {
  IdentityResolver,
  createIdentityResolver,
  resolveIdentity,
  unboundIdentityResolution,
} from './resolve.js';
export { identityEvidenceFromObservation } from './evidence.js';
export { emptyActiveLineup, resolveActiveLineup } from './active-lineup.js';
export type {
  ActiveLineupInput,
  ActiveLineupOverride,
  ActiveLineupPlayer,
  ActiveLineupResolution,
  ActiveLineupState,
  LineupEvidence,
  LineupIdentityEvidence,
  LineupIssue,
  LineupIssueCode,
} from './active-lineup.js';
export type {
  IdentityCapabilities,
  IdentityIssue,
  IdentityIssueCode,
  IdentityIssueSeverity,
  IdentityObservationInput,
  IdentityResolution,
  IdentitySideMapping,
  IdentityState,
  ResolvedIdentityPlayer,
  UnresolvedObservedPlayer,
} from './types.js';

export { hasObservedLineupDifference } from './lineup-difference.js';
