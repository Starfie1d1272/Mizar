/**
 * Mizar-owned CS2 map name normalization.
 *
 * This deliberately contains only explicit display aliases. It is shared by
 * Core series binding and the Radar provider so the two consumers cannot
 * silently develop different map identities.
 */
const CS2_MAP_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  ancient: 'de_ancient',
  anubis: 'de_anubis',
  cache: 'de_cache',
  dust2: 'de_dust2',
  'dust 2': 'de_dust2',
  'dust ii': 'de_dust2',
  inferno: 'de_inferno',
  mirage: 'de_mirage',
  nuke: 'de_nuke',
  overpass: 'de_overpass',
  train: 'de_train',
  vertigo: 'de_vertigo',
});

export function canonicalizeCs2MapName(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized.length === 0) return null;
  return CS2_MAP_ALIASES[normalized] ?? normalized;
}

export function cs2MapNamesEqual(left: string, right: string): boolean {
  const canonicalLeft = canonicalizeCs2MapName(left);
  const canonicalRight = canonicalizeCs2MapName(right);
  return canonicalLeft !== null && canonicalLeft === canonicalRight;
}

export { CS2_MAP_ALIASES };
