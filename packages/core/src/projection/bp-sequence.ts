import type { MatchFormat } from '../match-context/index.js';

export const LOCAL_BP_MAP_CATALOG = [
  { mapName: 'de_mirage', label: 'Mirage' },
  { mapName: 'de_inferno', label: 'Inferno' },
  { mapName: 'de_nuke', label: 'Nuke' },
  { mapName: 'de_ancient', label: 'Ancient' },
  { mapName: 'de_dust2', label: 'Dust2' },
  { mapName: 'de_anubis', label: 'Anubis' },
  { mapName: 'de_cache', label: 'Cache' },
  { mapName: 'de_overpass', label: 'Overpass' },
  { mapName: 'de_train', label: 'Train' },
  { mapName: 'de_vertigo', label: 'Vertigo' },
] as const;

export const DEFAULT_LOCAL_BP_MAP_POOL = [
  'de_mirage',
  'de_inferno',
  'de_nuke',
  'de_ancient',
  'de_dust2',
  'de_anubis',
  'de_cache',
] as const;

export type BpSequenceAction =
  | { readonly kind: 'ban'; readonly actor: 'a' | 'b'; readonly valueIndex: number }
  | { readonly kind: 'pick'; readonly actor: 'a' | 'b'; readonly valueIndex: number }
  | {
      readonly kind: 'side_pick';
      readonly actor: 'a' | 'b';
      readonly target: 'pick' | 'decider';
      readonly targetIndex: number;
    }
  | { readonly kind: 'decider'; readonly actor: null };

function other(entrant: 'a' | 'b'): 'a' | 'b' {
  return entrant === 'a' ? 'b' : 'a';
}

/**
 * RivalHub Veto sequence rules projected into fixed local authoring slots.
 * Operator input supplies only map/side values; action kind and actor stay fixed.
 */
export function localBpSequence(
  format: MatchFormat,
  vetoA: 'a' | 'b',
): readonly BpSequenceAction[] {
  const a = vetoA;
  const b = other(a);
  if (format === 'bo1') {
    return [
      { kind: 'ban', actor: a, valueIndex: 0 },
      { kind: 'ban', actor: a, valueIndex: 1 },
      { kind: 'ban', actor: b, valueIndex: 2 },
      { kind: 'ban', actor: b, valueIndex: 3 },
      { kind: 'ban', actor: b, valueIndex: 4 },
      { kind: 'ban', actor: a, valueIndex: 5 },
      { kind: 'decider', actor: null },
      { kind: 'side_pick', actor: b, target: 'decider', targetIndex: 0 },
    ];
  }
  if (format === 'bo3') {
    return [
      { kind: 'ban', actor: a, valueIndex: 0 },
      { kind: 'ban', actor: b, valueIndex: 1 },
      { kind: 'pick', actor: a, valueIndex: 0 },
      { kind: 'side_pick', actor: b, target: 'pick', targetIndex: 0 },
      { kind: 'pick', actor: b, valueIndex: 1 },
      { kind: 'side_pick', actor: a, target: 'pick', targetIndex: 1 },
      { kind: 'ban', actor: b, valueIndex: 2 },
      { kind: 'ban', actor: a, valueIndex: 3 },
      { kind: 'decider', actor: null },
      { kind: 'side_pick', actor: b, target: 'decider', targetIndex: 0 },
    ];
  }
  return [
    { kind: 'ban', actor: a, valueIndex: 0 },
    { kind: 'ban', actor: b, valueIndex: 1 },
    { kind: 'pick', actor: a, valueIndex: 0 },
    { kind: 'side_pick', actor: b, target: 'pick', targetIndex: 0 },
    { kind: 'pick', actor: b, valueIndex: 1 },
    { kind: 'side_pick', actor: a, target: 'pick', targetIndex: 1 },
    { kind: 'pick', actor: a, valueIndex: 2 },
    { kind: 'side_pick', actor: b, target: 'pick', targetIndex: 2 },
    { kind: 'pick', actor: b, valueIndex: 3 },
    { kind: 'side_pick', actor: a, target: 'pick', targetIndex: 3 },
    { kind: 'decider', actor: null },
  ];
}
