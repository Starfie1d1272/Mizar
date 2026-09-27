import type {
  ObservedMatchStats,
  ObservedPlayer,
  ObservedPlayerState,
  ObservedWeapon,
  SourceSide,
  WeaponState,
} from '@mizar/core/telemetry';
import type { DiagnosticCollector } from '../diagnostics/collector.js';
import { optionalEnum } from '../parse/enum.js';
import { asSourceRecord, compareSourceKeys } from '../parse/record.js';
import {
  optionalBoolean,
  optionalInteger,
  optionalNumber,
  optionalString,
} from '../parse/scalar.js';
import { optionalVector } from '../parse/vector.js';
import { finishBlock, type ParsedBlock } from './types.js';

function normalizeSide(value: string): SourceSide | undefined {
  switch (value.toUpperCase()) {
    case 'CT':
      return 'CT';
    case 'T':
      return 'T';
    case 'UNKNOWN':
      return 'unknown';
    default:
      return undefined;
  }
}

function normalizeWeaponState(value: string): WeaponState | undefined {
  switch (value.toLowerCase()) {
    case 'active':
      return 'active';
    case 'holstered':
      return 'holstered';
    case 'reloading':
      return 'reloading';
    case 'unknown':
      return 'unknown';
    default:
      return undefined;
  }
}

function parsePlayerState(
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
): ObservedPlayerState | undefined {
  const record = asSourceRecord(value);
  if (record === undefined) {
    diagnostics.add('UNEXPECTED_BLOCK_SHAPE', 'error', path);
    return undefined;
  }

  const health = optionalNumber(record, 'health', diagnostics, `${path}.health`);
  const armor = optionalNumber(record, 'armor', diagnostics, `${path}.armor`);
  const hasHelmet = optionalBoolean(record, 'helmet', diagnostics, `${path}.helmet`);
  const hasDefuser = optionalBoolean(record, 'defusekit', diagnostics, `${path}.defusekit`);
  const flashed = optionalNumber(record, 'flashed', diagnostics, `${path}.flashed`);
  const smoked = optionalNumber(record, 'smoked', diagnostics, `${path}.smoked`);
  const burning = optionalNumber(record, 'burning', diagnostics, `${path}.burning`);
  const money = optionalNumber(record, 'money', diagnostics, `${path}.money`);
  const roundTotalDamage = optionalNumber(
    record,
    'round_totaldmg',
    diagnostics,
    `${path}.round_totaldmg`,
  );
  const roundKills = optionalInteger(record, 'round_kills', diagnostics, `${path}.round_kills`);
  const roundKillHeadshots = optionalInteger(
    record,
    'round_killhs',
    diagnostics,
    `${path}.round_killhs`,
  );
  const equipValue = optionalNumber(record, 'equip_value', diagnostics, `${path}.equip_value`);

  return {
    ...(health === undefined ? {} : { health }),
    ...(armor === undefined ? {} : { armor }),
    ...(hasHelmet === undefined ? {} : { hasHelmet }),
    ...(hasDefuser === undefined ? {} : { hasDefuser }),
    ...(flashed === undefined ? {} : { flashed }),
    ...(smoked === undefined ? {} : { smoked }),
    ...(burning === undefined ? {} : { burning }),
    ...(money === undefined ? {} : { money }),
    ...(roundTotalDamage === undefined ? {} : { roundTotalDamage }),
    ...(roundKills === undefined ? {} : { roundKills }),
    ...(roundKillHeadshots === undefined ? {} : { roundKillHeadshots }),
    ...(equipValue === undefined ? {} : { equipValue }),
  };
}

function parseMatchStats(
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
): ObservedMatchStats | undefined {
  const record = asSourceRecord(value);
  if (record === undefined) {
    diagnostics.add('UNEXPECTED_BLOCK_SHAPE', 'error', path);
    return undefined;
  }

  const kills = optionalInteger(record, 'kills', diagnostics, `${path}.kills`);
  const assists = optionalInteger(record, 'assists', diagnostics, `${path}.assists`);
  const deaths = optionalInteger(record, 'deaths', diagnostics, `${path}.deaths`);
  const mvps = optionalInteger(record, 'mvps', diagnostics, `${path}.mvps`);
  const score = optionalInteger(record, 'score', diagnostics, `${path}.score`);

  return {
    ...(kills === undefined ? {} : { kills }),
    ...(assists === undefined ? {} : { assists }),
    ...(deaths === undefined ? {} : { deaths }),
    ...(mvps === undefined ? {} : { mvps }),
    ...(score === undefined ? {} : { score }),
  };
}

function parseWeapon(
  sourceWeaponId: string,
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
): ObservedWeapon | undefined {
  const record = asSourceRecord(value);
  if (record === undefined) {
    diagnostics.add('INVALID_ENTITY', 'error', path);
    return undefined;
  }

  const name = optionalString(record, 'name', diagnostics, `${path}.name`);
  const paintKit = optionalString(record, 'paintkit', diagnostics, `${path}.paintkit`);
  const type = optionalString(record, 'type', diagnostics, `${path}.type`);
  const ammoClip = optionalInteger(record, 'ammo_clip', diagnostics, `${path}.ammo_clip`);
  const ammoClipMax = optionalInteger(
    record,
    'ammo_clip_max',
    diagnostics,
    `${path}.ammo_clip_max`,
  );
  const ammoReserve = optionalInteger(record, 'ammo_reserve', diagnostics, `${path}.ammo_reserve`);
  const state = optionalEnum(
    record,
    'state',
    normalizeWeaponState,
    'unknown',
    diagnostics,
    `${path}.state`,
  );

  return {
    sourceWeaponId,
    ...(name === undefined ? {} : { name }),
    ...(paintKit === undefined ? {} : { paintKit }),
    ...(type === undefined ? {} : { type }),
    ...(ammoClip === undefined ? {} : { ammoClip }),
    ...(ammoClipMax === undefined ? {} : { ammoClipMax }),
    ...(ammoReserve === undefined ? {} : { ammoReserve }),
    ...(state === undefined ? {} : { state }),
  };
}

function parseWeapons(
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
): ObservedWeapon[] | undefined {
  const record = asSourceRecord(value);
  if (record === undefined) {
    diagnostics.add('UNEXPECTED_BLOCK_SHAPE', 'error', path);
    return undefined;
  }

  const weapons: ObservedWeapon[] = [];
  for (const [sourceWeaponId, weaponValue] of Object.entries(record).sort(([left], [right]) =>
    compareSourceKeys(left, right),
  )) {
    const weapon = parseWeapon(
      sourceWeaponId,
      weaponValue,
      diagnostics,
      `${path}.${sourceWeaponId}`,
    );
    if (weapon !== undefined) weapons.push(weapon);
  }
  return weapons;
}

export function parsePlayer(
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
  sourcePlayerIdHint?: string,
): ParsedBlock<ObservedPlayer> {
  const start = diagnostics.totalCount;
  const record = asSourceRecord(value);
  if (record === undefined) {
    diagnostics.add('UNEXPECTED_BLOCK_SHAPE', 'error', path);
    return finishBlock<ObservedPlayer>(diagnostics, start, undefined);
  }

  const sourcePlayerId =
    sourcePlayerIdHint ?? optionalString(record, 'steamid', diagnostics, `${path}.steamid`);
  if (sourcePlayerId === undefined || sourcePlayerId.length === 0) {
    diagnostics.add('INVALID_FIELD', 'error', `${path}.steamid`);
    return finishBlock<ObservedPlayer>(diagnostics, start, undefined);
  }

  const displayName = optionalString(record, 'name', diagnostics, `${path}.name`);
  const side = optionalEnum(record, 'team', normalizeSide, 'unknown', diagnostics, `${path}.team`);
  const observerSlot = optionalInteger(
    record,
    'observer_slot',
    diagnostics,
    `${path}.observer_slot`,
  );
  const activity = optionalString(record, 'activity', diagnostics, `${path}.activity`);

  const state = Object.hasOwn(record, 'state')
    ? parsePlayerState(record.state, diagnostics, `${path}.state`)
    : undefined;
  const matchStats = Object.hasOwn(record, 'match_stats')
    ? parseMatchStats(record.match_stats, diagnostics, `${path}.match_stats`)
    : undefined;
  const weapons = Object.hasOwn(record, 'weapons')
    ? parseWeapons(record.weapons, diagnostics, `${path}.weapons`)
    : undefined;
  const position = optionalVector(record, 'position', diagnostics, `${path}.position`);
  const forward = optionalVector(record, 'forward', diagnostics, `${path}.forward`);

  return finishBlock(diagnostics, start, {
    sourcePlayerId,
    ...(displayName === undefined ? {} : { displayName }),
    ...(side === undefined ? {} : { side }),
    ...(observerSlot === undefined ? {} : { observerSlot }),
    ...(activity === undefined ? {} : { activity }),
    ...(state === undefined ? {} : { state }),
    ...(matchStats === undefined ? {} : { matchStats }),
    ...(weapons === undefined ? {} : { weapons }),
    ...(position === undefined ? {} : { position }),
    ...(forward === undefined ? {} : { forward }),
  });
}
