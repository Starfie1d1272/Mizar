import type { ObsRpc } from '../src/obs/reconcile.js';
import { readFileSync } from 'node:fs';
import { programSnapshotSchema } from '@mizar/protocol/program';
import { crc32, deflateRawSync } from 'node:zlib';
/** Generated PCM silence only; no third-party or private audio. */
export function musicWav(value = 0) {
  const b = Buffer.alloc(2044);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(2000, 40);
  b.fill(value, 44);
  return b;
}
/** Independent ordinary ZIP32 producer, with Unix permissions, for import boundary tests. */
export function musicZip(files: Record<string, Buffer>, attributes: Record<string, number> = {}) {
  const locals: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const [path, bytes] of Object.entries(files)) {
    const name = Buffer.from(path),
      compressed = deflateRawSync(bytes),
      local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(attributes[path] ?? 0x81a40000, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    directory.push(central, name);
    offset += 30 + name.length + compressed.length;
  }
  const cd = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
export function musicManifest() {
  return {
    format: 'mizar.local-music',
    version: 1,
    groups: {
      waiting: { tracks: [{ path: 'audio/等待.wav' }] },
      tactical: { tracks: [] },
      technical: { tracks: [] },
      halftime: { tracks: [] },
      mapVictory: { tracks: [] },
      matchVictory: { tracks: [] },
      opening: { tracks: [] },
    },
  };
}

export function musicProgram() {
  const artifact = JSON.parse(
    readFileSync(
      new URL(
        '../../web/src/program/fixtures/generated/real-program-fixtures.generated.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { fixtures: Record<string, { snapshot: unknown }> };
  const snapshot = programSnapshotSchema.parse(artifact.fixtures['real-live-rich']!.snapshot);
  return { ...snapshot.payload, cursor: snapshot.cursor };
}

/** Protocol simulator only; it does not decode or produce audible sound. */
export class MediaObs implements ObsRpc {
  calls: { type: string; data: Record<string, unknown> }[] = [];
  inputs = new Map<
    string,
    {
      uuid: string;
      state: string;
      file: string;
      volume: number;
      muted: boolean;
      cursor: number;
      monitor: string;
    }
  >();
  disconnected = false;
  streamActive: boolean | undefined = false;
  recordActive: boolean | undefined = false;
  duration: number | null = 10000;
  restartOpeningReads = 0;
  restartState = 'OBS_MEDIA_STATE_OPENING';
  private openingReads = -1;
  private inputGeneration = 0;
  intercept: ((type: string) => Promise<void>) | undefined;
  async call(type: string, data: Record<string, unknown> = {}) {
    await this.intercept?.(type);
    if (this.disconnected) throw new Error('offline');
    this.calls.push({ type, data });
    const input = data.inputUuid
      ? [...this.inputs.values()].find((i) => i.uuid === data.inputUuid)
      : this.inputs.get(String(data.inputName));
    if (type === 'GetStreamStatus') return { outputActive: this.streamActive };
    if (type === 'GetRecordStatus') return { outputActive: this.recordActive };
    if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Mizar' };
    if (type === 'GetInputList')
      return {
        inputs: [...this.inputs].map(([inputName, i]) => ({
          inputName,
          inputUuid: i.uuid,
          inputKind: 'ffmpeg_source',
        })),
      };
    if (type === 'GetSceneList') return { scenes: [{ sceneName: '赛前等待' }] };
    if (type === 'GetSceneItemList')
      return {
        sceneItems: [...this.inputs].map(([sourceName, input], sceneItemId) => ({
          sourceName,
          sourceUuid: input.uuid,
          sceneItemId,
        })),
      };
    if (type === 'SetSceneItemTransform') return {};
    if (type === 'CreateInput') {
      const uuid = `uuid-${this.inputGeneration++}`;
      this.inputs.set(String(data.inputName), {
        uuid,
        state: 'OBS_MEDIA_STATE_STOPPED',
        file: '',
        volume: 1,
        muted: false,
        cursor: 0,
        monitor: 'OBS_MONITORING_TYPE_NONE',
      });
      return { inputUuid: uuid };
    }
    if (!input) throw new Error(`Unexpected input for ${type}`);
    if (type === 'GetMediaInputStatus') {
      if (this.openingReads >= 0 && this.openingReads-- === 0)
        input.state = 'OBS_MEDIA_STATE_PLAYING';
      return { mediaState: input.state, mediaCursor: input.cursor, mediaDuration: this.duration };
    }
    if (type === 'GetInputAudioMonitorType') return { monitorType: input.monitor };
    if (type === 'SetInputAudioMonitorType') {
      input.monitor = String(data.monitorType);
      return {};
    }
    if (type === 'GetInputMute') return { inputMuted: input.muted };
    if (type === 'GetInputVolume') return { inputVolumeMul: input.volume };
    if (type === 'GetInputSettings') return { inputSettings: { local_file: input.file } };
    if (type === 'SetInputSettings')
      input.file = String((data.inputSettings as { local_file: string }).local_file);
    else if (type === 'SetInputVolume') input.volume = Number(data.inputVolumeMul);
    else if (type === 'SetInputMute') input.muted = Boolean(data.inputMuted);
    else if (type === 'SetMediaInputCursor') {
      if (!['OBS_MEDIA_STATE_PLAYING', 'OBS_MEDIA_STATE_PAUSED'].includes(input.state))
        throw new Error('OBS 604: media input must be playing or paused');
      input.cursor = Number(data.mediaCursor);
    } else if (type === 'TriggerMediaInputAction') {
      if (data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE') {
        input.state = 'OBS_MEDIA_STATE_PAUSED';
        return {};
      }
      if (data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY') {
        input.state = 'OBS_MEDIA_STATE_PLAYING';
        return {};
      }
      input.state =
        data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
          ? 'OBS_MEDIA_STATE_PLAYING'
          : 'OBS_MEDIA_STATE_STOPPED';
      input.cursor = 0;
      this.openingReads = -1;
      if (input.state === 'OBS_MEDIA_STATE_PLAYING' && this.restartOpeningReads) {
        input.state = this.restartState;
        this.openingReads = this.restartOpeningReads;
      }
    } else throw new Error(`Unexpected RPC ${type}`);
    return {};
  }
  restarts() {
    return this.calls.filter(
      (c) => c.data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
    ).length;
  }
  bgm() {
    return [...this.inputs].find(([name]) => name === '音乐')![1];
  }
}
