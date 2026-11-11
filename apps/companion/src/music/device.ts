import type { MixerChannelStatus } from '@mizar/protocol/mixer';
import type { MusicSourceState, MusicStore } from './store.js';

export type MusicLayer = 'bgm' | 'stinger';
export type MonitorRelationship = 'independent' | 'same' | 'different' | 'unknown';
type Source = { sourceId: string | null | undefined };
type SourceState = { readonly state: MusicSourceState };
export type MusicSourceSetup = SourceState &
  Pick<MusicStore, 'commitSourceReplacement'> & {
    update(change: (state: MusicSourceState) => void): Promise<void>;
  };
export type MusicMonitorMode = 'off' | 'monitor-only' | 'monitor-and-output';
export type MusicMediaState =
  | 'playing'
  | 'paused'
  | 'opening'
  | 'buffering'
  | 'stopped'
  | 'ended'
  | 'empty'
  | 'error'
  | 'unknown';

export type MusicMonitorOriginal = {
  sourceId: string;
  mode: MusicMonitorMode;
  applied?: MusicMonitorMode;
};
export type MusicMonitorOriginals = Record<MusicLayer, MusicMonitorOriginal | null>;
export type MusicMonitorChange = {
  sourceId: string;
  before: MusicMonitorMode;
  applied: MusicMonitorMode;
};
export type MusicMonitorPlan = {
  changes: MusicMonitorChange[];
  managedSources: string[];
  musicBefore: MusicMonitorOriginals;
  musicAfter: MusicMonitorOriginals;
};

export interface MusicDevice {
  mediaStatus(source: Source): Promise<{
    state: MusicMediaState;
    cursorMs: number | null;
    durationMs: number | null;
  }>;
  volume(source: Source): Promise<number | undefined>;
  mute(source: Source): Promise<boolean | undefined>;
  monitorMode(source: Source): Promise<MusicMonitorMode | undefined>;
  mediaFile(source: Source): Promise<string | undefined>;
  setVolume(source: Source & { gain: number }): Promise<void>;
  setMute(source: Source & { muted: boolean }): Promise<void>;
  setMonitorMode(
    source: Source & { mode: MusicMonitorMode },
    onDispatch?: () => void,
  ): Promise<void>;
  setMediaCursor(source: Source & { cursorMs: number }): Promise<void>;
  loadMedia(source: Source & { path: string }): Promise<void>;
  controlMedia(source: Source & { action: 'stop' | 'restart' | 'play' | 'pause' }): Promise<void>;
  readonly reportsDispatch: boolean;
  guardWrites(guard: () => void): MusicDevice;
  checkCalls(guard: () => void, checkAfter?: boolean): MusicDevice;
  ownershipScope(): Promise<string | undefined>;
  readManagedMonitorModes(): Promise<readonly (MusicMonitorMode | undefined)[]>;
  hasSource(store: SourceState, layer: MusicLayer, valid: () => boolean): Promise<boolean>;
  verifyPlayback(store: SourceState, layer: MusicLayer, valid: () => boolean): Promise<void>;
  prepareResources(store: MusicSourceSetup, layer: MusicLayer, valid: () => boolean): Promise<void>;
  outputsStopped(): Promise<boolean>;
  monitorSafe(): Promise<boolean>;
  monitorRelationship(): Promise<MonitorRelationship>;
}

export interface MusicDeviceProvider {
  session<T>(run: (device: MusicDevice, epoch: number) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface MusicAudioRecovery {
  withAudioModeRecovery<T>(run: (current: () => boolean) => Promise<T>): Promise<T>;
  commitDesktopMonitorOriginals(
    before: MusicMonitorOriginals,
    after: MusicMonitorOriginals,
    side: 'before' | 'after',
  ): Promise<void>;
  monitorPlanCompatible(relationship: MonitorRelationship, after: MusicMonitorOriginals): boolean;
}

export interface MusicAudioMode extends MusicAudioRecovery {
  wantsMonitor(): boolean;
  prepareDesktopMix<T>(
    device: MusicDevice,
    relationship: MonitorRelationship,
    apply: (plan: MusicMonitorPlan) => Promise<T>,
  ): Promise<T>;
}

export interface MusicMixerControl {
  mixerStatus(): { channel: MixerChannelStatus; desktopIncludesMusic: boolean };
  setMixer(volume: number | undefined, muted: boolean | undefined): Promise<boolean>;
}
