import type { MusicMonitorMode } from './device.js';

const legacyModes = {
  off: 'OBS_MONITORING_TYPE_NONE',
  'monitor-only': 'OBS_MONITORING_TYPE_MONITOR_ONLY',
  'monitor-and-output': 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
} as const satisfies Record<MusicMonitorMode, string>;

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
