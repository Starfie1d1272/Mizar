import type { MixerChannelStatus } from '@mizar/protocol/mixer';
import type { AudioMonitorChange, MonitorOriginals } from '../obs/audio-monitor-contract.js';
import type { MusicStore } from './store.js';

export type MusicLayer = 'bgm' | 'stinger';
export type MonitorRelationship = 'independent' | 'same' | 'different' | 'unknown';
type Input = { inputUuid: string | null | undefined };
type SourceState = Pick<MusicStore, 'state'>;
export type MusicSourceSetup = SourceState & Pick<MusicStore, 'update'>;
type MonitorMode = AudioMonitorChange['before'];

export interface MusicDevice {
  mediaStatus(
    input: Input,
  ): Promise<{ mediaState?: unknown; mediaCursor?: unknown; mediaDuration?: unknown }>;
  volume(input: Input): Promise<{ inputVolumeMul?: unknown }>;
  mute(input: Input): Promise<{ inputMuted?: unknown }>;
  monitorMode(input: Input): Promise<{ monitorType?: unknown }>;
  inputSettings(input: Input): Promise<{ inputSettings?: unknown }>;
  listInputs(): Promise<{ inputs?: unknown }>;
  setVolume(input: Input & { inputVolumeMul: number }): Promise<unknown>;
  setMute(input: Input & { inputMuted: boolean }): Promise<unknown>;
  setMonitorMode(
    input: Input & { monitorType: MonitorMode },
    onDispatch?: () => void,
  ): Promise<unknown>;
  setMediaCursor(input: Input & { mediaCursor: number }): Promise<unknown>;
  setInputSettings(
    input: Input & { overlay: boolean; inputSettings: Record<string, unknown> },
  ): Promise<unknown>;
  controlMedia(
    input: Input & { mediaAction: 'STOP' | 'RESTART' | 'PLAY' | 'PAUSE' },
  ): Promise<unknown>;
  readonly reportsDispatch: boolean;
  guardWrites(guard: () => void): MusicDevice;
  checkCalls(guard: () => void, checkAfter?: boolean): MusicDevice;
  ownershipScope(): Promise<string | undefined>;
  managedInputIdentity?: (name: string) => Promise<{ uuid: string; kind: string } | null>;
  findInput(store: SourceState, layer: MusicLayer, valid: () => boolean): Promise<string | null>;
  verifyPlayback(store: SourceState, layer: MusicLayer, valid: () => boolean): Promise<void>;
  prepareResources(
    store: MusicSourceSetup,
    layer: MusicLayer,
    valid: () => boolean,
  ): Promise<unknown>;
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
    before: MonitorOriginals,
    after: MonitorOriginals,
    side: 'before' | 'after',
  ): Promise<void>;
  monitorPlanCompatible(relationship: MonitorRelationship, after: MonitorOriginals): boolean;
}

export interface MusicAudioMode extends MusicAudioRecovery {
  wantsMonitor(): boolean;
  prepareDesktopMix<T>(
    device: MusicDevice,
    relationship: MonitorRelationship,
    apply: (plan: {
      changes: AudioMonitorChange[];
      managedMusicUuids: string[];
      musicBefore: MonitorOriginals;
      musicAfter: MonitorOriginals;
    }) => Promise<T>,
  ): Promise<T>;
}

export interface MusicMixerControl {
  mixerStatus(): { channel: MixerChannelStatus; desktopIncludesMusic: boolean };
  setMixer(volume: number | undefined, muted: boolean | undefined): Promise<boolean>;
}
