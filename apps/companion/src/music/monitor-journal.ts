import { z } from 'zod';
import type { MusicMonitorMode, MusicMonitorOriginal, MusicMonitorOriginals } from './device.js';

const legacyModes = {
  off: 'OBS_MONITORING_TYPE_NONE',
  'monitor-only': 'OBS_MONITORING_TYPE_MONITOR_ONLY',
  'monitor-and-output': 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
} as const satisfies Record<MusicMonitorMode, string>;
export const storedMonitorMode = z.enum(Object.values(legacyModes));
export const storedAudibleMonitorMode = storedMonitorMode.exclude([legacyModes.off]);

export function readMonitorMode(value: unknown): MusicMonitorMode | undefined {
  switch (value) {
    case legacyModes.off:
      return 'off';
    case legacyModes['monitor-only']:
      return 'monitor-only';
    case legacyModes['monitor-and-output']:
      return 'monitor-and-output';
    default:
      return undefined;
  }
}

export function writeMonitorMode<T extends MusicMonitorMode>(mode: T): (typeof legacyModes)[T] {
  return legacyModes[mode];
}

export const storedMonitorOriginal = z.object({
  uuid: z.string(),
  mode: storedMonitorMode,
  applied: storedMonitorMode.optional(),
});
type StoredOriginal = z.infer<typeof storedMonitorOriginal>;
type StoredOriginals = Record<keyof MusicMonitorOriginals, StoredOriginal | null>;

export function readMonitorOriginal(value: StoredOriginal | null): MusicMonitorOriginal | null {
  if (!value) return null;
  return {
    sourceId: value.uuid,
    mode: readMonitorMode(value.mode)!,
    ...(value.applied === undefined ? {} : { applied: readMonitorMode(value.applied)! }),
  };
}

export function writeMonitorOriginal(value: MusicMonitorOriginal | null): StoredOriginal | null {
  if (!value) return null;
  return {
    uuid: value.sourceId,
    mode: writeMonitorMode(value.mode),
    ...(value.applied === undefined ? {} : { applied: writeMonitorMode(value.applied) }),
  };
}

export function readMonitorOriginals(value: StoredOriginals): MusicMonitorOriginals {
  return { bgm: readMonitorOriginal(value.bgm), stinger: readMonitorOriginal(value.stinger) };
}

export function writeMonitorOriginals(value: MusicMonitorOriginals): StoredOriginals {
  return { bgm: writeMonitorOriginal(value.bgm), stinger: writeMonitorOriginal(value.stinger) };
}
