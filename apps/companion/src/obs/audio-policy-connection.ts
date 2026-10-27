import { EventSubscription, OBSWebSocket } from 'obs-websocket-js';
import type { ObsAudioBinding } from '@mizar/protocol/obs';
import type { ObsConfigStore } from './config.js';
import type { ObsRpc } from './reconcile.js';
import { GameAudioPolicy, type AudioPolicy } from './audio-policy.js';

const required = [
  'GetInputList',
  'GetSceneCollectionList',
  'GetInputVolume',
  'SetInputVolume',
  'GetInputMute',
  'SetInputMute',
];

/** A single continuously observed OBS connection. Disconnects never replay old work. */
export class GameAudioConnection {
  private client: OBSWebSocket | null = null;
  private epoch = 0;
  private signature = '';
  private closed = false;
  private busy = false;
  constructor(
    private readonly config: ObsConfigStore,
    readonly owner: GameAudioPolicy,
    private readonly create = () => new OBSWebSocket(),
  ) {}
  invalidate() {
    this.epoch++;
    this.owner.disconnect();
    const old = this.client;
    this.client = null;
    this.signature = '';
    if (old) void old.disconnect().catch(() => undefined);
  }
  close() {
    this.closed = true;
    this.invalidate();
  }
  async run(
    binding: ObsAudioBinding,
    revision: string,
    desired: 'halftime' | 'gameplay',
    policy: AudioPolicy,
    valid: () => boolean,
  ) {
    if (this.closed || this.busy) return;
    this.busy = true;
    try {
      const config = await this.config.read();
      const endpoint = `ws://${config.host}:${config.port}`;
      const signature = JSON.stringify([endpoint, config.password, binding, revision]);
      if (endpoint !== binding.endpoint || !valid()) {
        this.invalidate();
        return;
      }
      if (this.client && this.signature !== signature) this.invalidate();
      if (!this.client) {
        const client = this.create();
        this.client = client;
        const epoch = ++this.epoch;
        const current = () => !this.closed && this.client === client && this.epoch === epoch;
        client.on('ConnectionClosed', () => {
          if (current()) this.invalidate();
        });
        client.on('ConnectionError', () => undefined);
        client.on('CurrentSceneCollectionChanging', () => {
          if (current()) this.invalidate();
        });
        client.on('InputRemoved', (event) => {
          if (current() && event.inputUuid === binding.inputUuid) this.invalidate();
        });
        client.on('InputSettingsChanged', (event) => {
          if (current() && event.inputUuid === binding.inputUuid) this.invalidate();
        });
        client.on('InputVolumeChanged', (event) => {
          if (current()) this.owner.observe(event.inputUuid, 'volume', event.inputVolumeMul);
        });
        client.on('InputMuteStateChanged', (event) => {
          if (current()) this.owner.observe(event.inputUuid, 'mute', event.inputMuted);
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            client.connect(endpoint, config.password, {
              eventSubscriptions:
                EventSubscription.Inputs | EventSubscription.Scenes | EventSubscription.General,
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('audio_connection_timeout')), 4000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (!current() || !valid()) {
          this.invalidate();
          return;
        }
        this.signature = signature;
      }
      const client = this.client;
      const epoch = this.epoch;
      const current = () =>
        !this.closed && this.client === client && this.epoch === epoch && valid();
      const rpc: ObsRpc = {
        call: async (name, data) => {
          if (!current()) throw new Error('audio_cancelled');
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              (
                client.call as (
                  name: string,
                  data?: Record<string, unknown>,
                ) => Promise<Record<string, unknown>>
              )(name, data),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  this.invalidate();
                  reject(new Error('audio_timeout'));
                }, 4000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        },
      };
      const version = await rpc.call('GetVersion');
      if (
        !Array.isArray(version.availableRequests) ||
        !required.every((name) => (version.availableRequests as unknown[]).includes(name))
      )
        throw new Error('audio_capability_missing');
      const collection = await rpc.call('GetSceneCollectionList');
      const list = await rpc.call('GetInputList');
      if (
        collection.currentSceneCollectionName !== binding.collection ||
        !Array.isArray(list.inputs) ||
        list.inputs.filter(
          (input: unknown) =>
            typeof input === 'object' &&
            input !== null &&
            'inputUuid' in input &&
            'inputKind' in input &&
            input.inputUuid === binding.inputUuid &&
            input.inputKind === binding.inputKind,
        ).length !== 1 ||
        !current()
      )
        throw new Error('audio_binding_changed');
      if (desired === 'halftime')
        await this.owner.apply(rpc, epoch, binding, revision, policy, current);
      else await this.owner.restore(rpc, epoch, binding, revision, current);
    } catch (error) {
      this.invalidate();
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
