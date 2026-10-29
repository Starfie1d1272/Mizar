import { gameBackgroundReady } from './game-background.js';
import { ObsActionError } from './action-error.js';
import { assertBpCompactOff, BpOverlayOwner } from './bp-overlay.js';
import { diagnosticValue } from '../support/session-journal.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { OBSWebSocket } from 'obs-websocket-js';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import type { ObsAudioBindCommand, ObsOutputCommand, ObsOutputsStatus } from '@mizar/protocol/obs';
import type { ObsAudioRouting } from './audio-routing.js';
import type { GameAudioController } from './audio-policy-controller.js';
import type { MixerChannelStatus, MixerCommand, MixerCommandResult } from '@mizar/protocol/mixer';
import { createCommentaryProbe, isTeamspeak, RemoteCommentary } from './remote-commentary.js';
import {
  AUTO_TEAMSPEAK_TARGET,
  readCommentarySwitch,
  saveCommentarySwitch,
} from './commentary-switch.js';
import { readOwnedCommentaryTarget } from './commentary-owned-target.js';
import { OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';
import { configureIndependentAudio } from './audio-setup.js';
import { reconcileManagedAudio } from './managed-audio.js';
import { AudioMigration, type AudioMonitorChange } from './audio-migration.js';
import { desktopMonitorRelationship } from './audio-monitor-device.js';
import { discoverWaitingCommentary } from './remote-commentary-wait.js';
import { AudioConfigurationConnection } from './audio-configuration-connection.js';
import { ObsOutputController, ObsOutputError } from './outputs.js';
import { readObsProgramEvidence, type ObsProgramEvidence } from './program-evidence.js';
import {
  ObsConfigStore,
  discoverObsExecutable,
  isObsProcessRunning,
  type ObsConfig,
} from './config.js';
import { checkObsAudio, ensureObsAudio, setupObsAudio } from './audio.js';
import {
  ObsExitSafetyError,
  checkObsConfiguration,
  ensureObsConfiguration,
  repairObsConfiguration,
  refreshObsBrowserSources,
  switchObsScene,
  type ObsFinding,
  type ObsRpc,
  type ObsSceneSwitchOptions,
} from './reconcile.js';

export function obsFailureKind(
  error: unknown,
): 'authentication' | 'refused' | 'timeout' | 'unknown' {
  const value = error as { code?: unknown; message?: unknown } | null;
  const message = typeof value?.message === 'string' ? value.message.toLowerCase() : '';
  if (value?.code === 4009 || /authentication|invalid password|password required/.test(message))
    return 'authentication';
  if (value?.code === 'ECONNREFUSED' || message.includes('econnrefused')) return 'refused';
  if (/timeout|timed out|超时/.test(message)) return 'timeout';
  return 'unknown';
}
export function obsErrorEvidence(error: unknown, password = ''): unknown {
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string')
      return password ? value.replaceAll(password, '[redacted]') : value;
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value === 'object' && value !== null)
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, redact(field)]));
    return value;
  };
  return redact(diagnosticValue(error, '', new Set(), password ? [password] : []));
}

export interface ObsStatus {
  readonly connection: 'connected' | 'unavailable' | 'password_required' | 'invalid_password';
  readonly connectionFailure?: ReturnType<typeof obsFailureKind>;
  readonly currentScene: string | null;
  readonly port: number;
  readonly streaming: boolean;
  readonly recording: boolean;
  readonly passwordConfigured: boolean;
  readonly video: null | { readonly canvas: string; readonly output: string; readonly fps: number };
  readonly findings: readonly ObsFinding[];
  readonly programEvidence?: ObsProgramEvidence | null;
}

const TIMEOUT_MS = 4000;
const PROGRAM_EVIDENCE_MS = 750;

export class ObsAdapter {
  private readonly outputs: ObsOutputController;
  private readonly audioConfiguration: AudioConfigurationConnection;
  private readonly bpOwner = new BpOverlayOwner();
  private bpClient: OBSWebSocket | undefined;
  private bpDisconnect: (() => void) | undefined;
  onBpDisconnect(callback: () => void): void {
    this.bpDisconnect = callback;
  }
  private configurationPending = false;
  private queue: Promise<unknown> = Promise.resolve();
  private findings: ObsFinding[] = [
    { code: 'configuration_unchecked', message: '请检查 OBS 场景配置。' },
  ];
  private commentaryTimer: ReturnType<typeof setTimeout> | undefined;
  private commentaryTask: Promise<void> | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryClosed = false;
  private recoveryComplete = false;
  private recoveryTask: Promise<void> | undefined;
  private readonly refreshedBrowserSources = new Set<string>();
  private commentaryChoices = new Map<
    string,
    { window: string; revision: string; endpoint: string; probe: string; until: number }
  >();
  constructor(
    private readonly configStore: ObsConfigStore,
    private readonly browserBaseUrl: string,
    private readonly diagnostic: (stage: string, error: unknown) => void = () => undefined,
    private readonly audioRouting?: ObsAudioRouting,
    private readonly commentary?: { owner: RemoteCommentary; journal: string },
  ) {
    this.audioConfiguration = new AudioConfigurationConnection(configStore);
    this.outputs = new ObsOutputController(configStore, (error, password) =>
      diagnostic('obs_output', obsErrorEvidence(error, password)),
    );
  }

  async outputStatus(): Promise<ObsOutputsStatus> {
    return this.outputs.read().catch(() => this.outputs.snapshot());
  }

  async outputCommand(command: ObsOutputCommand): Promise<ObsOutputsStatus> {
    try {
      if (this.configurationPending)
        throw new ObsOutputError('obs_output_busy', 'OBS 配置正在处理，请稍后操作。');
      await this.outputs.command(command);
    } catch (error) {
      const config = await this.configStore.read();
      this.diagnostic('obs_output_command', obsErrorEvidence(error, config.password));
      throw error;
    }
    return this.outputs.snapshot();
  }

  private configurationMutation<T>(run: () => Promise<T>): Promise<T> {
    if (this.configurationPending || this.outputs.busy)
      return Promise.reject(
        new ObsOutputError('obs_output_busy', 'OBS 正在处理操作，请等待状态确认。'),
      );
    this.configurationPending = true;
    return this.serial(run).finally(() => {
      this.configurationPending = false;
    });
  }

  configure(config: ObsConfig): Promise<void> {
    return this.configurationMutation(async () => {
      this.bpOwner.invalidate();
      const bpClient = this.bpClient;
      this.bpClient = undefined;
      await bpClient?.disconnect().catch(() => undefined);
      this.bpDisconnect?.();
      await this.configStore.save(config);
      this.audioRouting?.invalidateSelections();
      this.commentaryChoices.clear();
      this.outputs.reset();
    });
  }

  startBrowserRecovery(): void {
    if (this.recoveryClosed || this.recoveryComplete || this.recoveryTask || this.recoveryTimer)
      return;
    const attempt = () => {
      if (this.recoveryClosed) return;
      this.recoveryTimer = undefined;
      this.recoveryTask = this.serial(() =>
        this.withObs((obs) =>
          refreshObsBrowserSources(obs, this.browserBaseUrl, this.refreshedBrowserSources),
        ),
      )
        .then((complete) => {
          this.recoveryComplete = complete;
        })
        .catch(() => undefined)
        .finally(() => {
          this.recoveryTask = undefined;
          if (!this.recoveryClosed && !this.recoveryComplete) {
            this.recoveryTimer = setTimeout(attempt, 5000);
            this.recoveryTimer.unref();
          }
        });
    };
    attempt();
  }

  startCommentaryRecovery(): void {
    if (!this.commentary || this.recoveryClosed || this.commentaryTimer || this.commentaryTask)
      return;
    const attempt = () => {
      if (this.recoveryClosed) return;
      this.commentaryTimer = undefined;
      this.commentaryTask = this.serial(() =>
        this.withObs((obs, endpoint) =>
          discoverWaitingCommentary(
            obs,
            this.commentary!.owner,
            this.commentary!.journal,
            endpoint,
          ),
        ),
      )
        .then(async (result) => {
          if (result === 'complete' && !this.recoveryClosed) await this.ensure();
        })
        .catch(() => undefined)
        .finally(() => {
          this.commentaryTask = undefined;
          if (!this.recoveryClosed) {
            this.commentaryTimer = setTimeout(attempt, 5000);
            this.commentaryTimer.unref();
          }
        });
    };
    attempt();
  }

  async close(): Promise<void> {
    this.recoveryClosed = true;
    if (this.commentaryTimer) clearTimeout(this.commentaryTimer);
    await this.commentaryTask;
    await this.outputs.close();
    const bpClient = this.bpClient;
    this.bpClient = undefined;
    await bpClient?.disconnect().catch(() => undefined);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    await this.recoveryTask;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async withObs<T>(
    operation: (obs: ObsRpc, endpoint: string) => Promise<T>,
    timeoutMs = TIMEOUT_MS,
    diagnosticStage?: string,
    observeAudioIdentity = false,
  ): Promise<T> {
    const config = await this.configStore.read();
    const client = new OBSWebSocket();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stage = 'obs_connect';
    let active = true;
    const invalidateAudio = () => {
      active = false;
    };
    try {
      const task = (async () => {
        await client.connect(`ws://${config.host}:${config.port}`, config.password);
        if (!active) throw new Error('obs_operation_cancelled');
        if (observeAudioIdentity) {
          client.on('CurrentSceneCollectionChanging', invalidateAudio);
          client.on('InputRemoved', invalidateAudio);
          client.on('InputSettingsChanged', invalidateAudio);
          client.on('ConnectionClosed', invalidateAudio);
        }
        stage = 'obs_request';
        const rpc: ObsRpc = {
          onTransitionVideoEnded: (listener) => {
            const onEnded = (event: { transitionName: string }) => listener(event.transitionName);
            client.on('SceneTransitionVideoEnded', onEnded);
            return () => client.off('SceneTransitionVideoEnded', onEnded);
          },
          call: async (type, data) => {
            if (!active) throw new Error('obs_operation_cancelled');
            const result = await (
              client.call as (
                name: string,
                args?: Record<string, unknown>,
              ) => Promise<Record<string, unknown>>
            )(type, data);
            if (!active) throw new Error('obs_operation_cancelled');
            return result;
          },
        };
        return operation(rpc, `ws://${config.host}:${config.port}`);
      })();
      return await Promise.race([
        task,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            active = false;
            reject(new Error('OBS 操作超时，请检查连接。'));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      this.diagnostic(diagnosticStage ?? stage, obsErrorEvidence(error, config.password));
      throw error;
    } finally {
      active = false;
      if (timeout) clearTimeout(timeout);
      if (observeAudioIdentity) {
        client.off('CurrentSceneCollectionChanging', invalidateAudio);
        client.off('InputRemoved', invalidateAudio);
        client.off('InputSettingsChanged', invalidateAudio);
        client.off('ConnectionClosed', invalidateAudio);
      }
      await client.disconnect().catch(() => undefined);
    }
  }

  private statusPending: Promise<ObsStatus> | undefined;
  status(): Promise<ObsStatus> {
    this.statusPending ??= this.serial(() => this.readStatus()).finally(() => {
      this.statusPending = undefined;
    });
    return this.statusPending;
  }

  private async bindingFindings(obs: ObsRpc, endpoint: string): Promise<ObsFinding[]> {
    if (!(await this.audioRouting?.enabled())) return [];
    return (await this.audioRouting!.invalidBindings(obs, endpoint)).map((role) => ({
      code: `audio_binding:${role}`,
      message: `${role} 音频来源已失效，请在音频分路中核对。`,
    }));
  }
  private async configurationFindings(
    obs: ObsRpc,
    endpoint: string,
    visual?: ObsFinding[],
  ): Promise<ObsFinding[]> {
    const findings = visual ?? (await checkObsConfiguration(obs, this.browserBaseUrl));
    return findings.some((item) =>
      ['collection_missing', 'collection_inactive', 'scene_missing'].includes(item.code),
    )
      ? findings
      : [
          ...findings,
          ...(await checkObsAudio(obs)),
          ...(await this.bindingFindings(obs, endpoint)),
        ];
  }

  private async readStatus(): Promise<ObsStatus> {
    const config = await this.configStore.read();
    try {
      const status = await this.withObs(async (obs, endpoint) => {
        const [scene, outputs, video, findings] = await Promise.all([
          obs.call('GetCurrentProgramScene'),
          this.outputs.read(),
          obs.call('GetVideoSettings'),
          this.configurationFindings(obs, endpoint).catch((error: unknown) => {
            this.diagnostic('obs_configuration_check', obsErrorEvidence(error, config.password));
            return [
              {
                code: 'configuration_check_failed',
                message: 'OBS 已连接，但场景或音频检查失败。请查看诊断后重新检查。',
              },
            ];
          }),
        ]);
        if (outputs.stream.active === null || outputs.record.active === null)
          throw new Error('OBS 输出状态无法确认。');
        const currentScene =
          typeof scene.currentProgramSceneName === 'string' ? scene.currentProgramSceneName : null;
        return {
          connection: 'connected',
          currentScene,
          port: config.port,
          streaming: outputs.stream.active === true,
          recording: outputs.record.active === true,
          passwordConfigured: Boolean(config.password),
          video: {
            canvas: `${String(video.baseWidth)}×${String(video.baseHeight)}`,
            output: `${String(video.outputWidth)}×${String(video.outputHeight)}`,
            fps: Number(video.fpsNumerator) / Number(video.fpsDenominator),
          },
          findings,
        } satisfies ObsStatus;
      });
      this.findings = [...status.findings];
      // Evidence gets a separate session and deadline after base facts are confirmed.
      // Its failure cannot consume the base session's deadline or change connection facts.
      let evidenceTimeout: ReturnType<typeof setTimeout> | undefined;
      const programEvidence = await Promise.race([
        this.withObs(
          (obs) => readObsProgramEvidence(obs, this.browserBaseUrl, status.currentScene),
          PROGRAM_EVIDENCE_MS,
          'obs_program_check',
        ).catch(() => null),
        new Promise<null>((resolve) => {
          // Also bound config/cleanup work; withObs may still be disconnecting after its RPC timeout.
          evidenceTimeout = setTimeout(() => {
            this.diagnostic('obs_program_check', {
              message: 'OBS 节目取证超时，未能在期限内完成。',
            });
            resolve(null);
          }, PROGRAM_EVIDENCE_MS + 50);
        }),
      ]).finally(() => {
        if (evidenceTimeout) clearTimeout(evidenceTimeout);
      });
      return { ...status, programEvidence };
    } catch (error: unknown) {
      const kind = obsFailureKind(error);
      return {
        connection:
          kind === 'authentication'
            ? config.password
              ? 'invalid_password'
              : 'password_required'
            : 'unavailable',
        connectionFailure: kind,
        currentScene: null,
        port: config.port,
        streaming: false,
        recording: false,
        passwordConfigured: Boolean(config.password),
        video: null,
        findings: [],
        programEvidence: null,
      };
    }
  }

  private previewPending: Promise<{ scene: string; image: string } | null> | null = null;
  confidencePreview(): Promise<{ scene: string; image: string } | null> {
    if (this.previewPending) return this.previewPending;
    this.previewPending = this.withObs(async (obs) => {
      const current = await obs.call('GetCurrentProgramScene');
      const scene = current.currentProgramSceneName;
      if (typeof scene !== 'string') return null;
      const screenshot = await obs.call('GetSourceScreenshot', {
        sourceName: scene,
        imageFormat: 'jpeg',
        imageWidth: 640,
        imageHeight: 360,
        imageCompressionQuality: 70,
      });
      const after = await obs.call('GetCurrentProgramScene');
      const image = screenshot.imageData;
      return after.currentProgramSceneName === scene &&
        typeof image === 'string' &&
        image.startsWith('data:image/jpeg;base64,') &&
        image.length < 1_000_000
        ? { scene, image }
        : null;
    })
      .catch(() => null)
      .finally(() => {
        this.previewPending = null;
      });
    return this.previewPending;
  }

  check(): Promise<readonly ObsFinding[]> {
    return this.serial(async () => {
      this.findings = await this.withObs(
        (obs, endpoint) => this.configurationFindings(obs, endpoint),
        12_000,
      );
      return this.findings;
    });
  }
  readAudioRouting() {
    if (!this.audioRouting) throw new Error('audio_routing_unavailable');
    return this.serial(() =>
      this.withObs((obs, endpoint) => this.audioRouting!.read(obs, endpoint), 12000),
    );
  }
  switchAudioMode(
    revision: string,
    mode: 'desktop' | 'independent',
    selectionId: string | undefined,
    prepareMusic: (
      obs: ObsRpc,
      same: boolean,
      apply: (changes: AudioMonitorChange[]) => Promise<void>,
    ) => Promise<void>,
  ) {
    if (!this.audioRouting || !this.commentary) throw new Error('audio_routing_unavailable');
    return this.configurationMutation(() =>
      this.audioConfiguration.run(async (obs, endpoint, observer) => {
        const completedPath = `${this.commentary!.journal}.migration-mode`;
        await this.audioRouting!.switchMode(
          obs,
          endpoint,
          revision,
          mode,
          selectionId,
          async (ids, desktop, verify) => {
            const [stream, record, collection, inputs] = await Promise.all([
              obs.call('GetStreamStatus'),
              obs.call('GetRecordStatus'),
              obs.call('GetSceneCollectionList'),
              obs.call('GetInputList'),
            ]);
            if (
              stream.outputActive !== false ||
              record.outputActive !== false ||
              collection.currentSceneCollectionName !== OBS_COLLECTION ||
              !Array.isArray(inputs.inputs)
            )
              throw new Error('audio_setup_context_changed');
            const allInputs = inputs.inputs as Record<string, unknown>[];
            if (
              desktop &&
              [ids.game, ids.remoteCommentary].some((uuid) =>
                ['game_capture', 'window_capture'].includes(
                  String(allInputs.find((input) => input.inputUuid === uuid)?.inputKind),
                ),
              )
            )
              throw new Error('audio_video_binding');
            const relationship = desktop
              ? await desktopMonitorRelationship(obs, desktop)
              : 'different';
            if (relationship === 'unknown') throw new Error('audio_monitor_device_unknown');
            if (desktop && relationship === 'same' && ids.microphone) {
              const mic = await obs.call('GetInputAudioMonitorType', { inputUuid: ids.microphone });
              if (mic.monitorType !== 'OBS_MONITORING_TYPE_NONE')
                throw new Error('audio_microphone_monitor');
            }
            await new AudioMigration(`${this.commentary!.journal}.migration`).recover(
              obs,
              endpoint,
              observer,
            );
            await prepareMusic(obs, relationship === 'same', async (monitor) => {
              if (
                !desktop &&
                (await new AudioMigration(`${this.commentary!.journal}.migration`).restoreCompleted(
                  obs,
                  endpoint,
                  observer,
                  completedPath,
                  monitor,
                ))
              )
                return;
              await reconcileManagedAudio(
                obs,
                endpoint,
                observer,
                this.commentary!.journal,
                this.browserBaseUrl,
                ids,
                verify,
                desktop,
                desktop ? completedPath : undefined,
                monitor,
              );
            });
          },
        );
        if (mode === 'independent') await rm(completedPath, { force: true });
      }),
    );
  }
  private mixerRevision(routing: { revision: string; endpoint: string; collection: string }) {
    return createHash('sha256')
      .update(JSON.stringify([routing.revision, routing.endpoint, routing.collection]))
      .digest('hex');
  }
  private async mixerReadObs(obs: ObsRpc, endpoint: string) {
    if (!this.audioRouting) throw new Error('audio_routing_unavailable');
    const routing = await this.audioRouting.read(obs, endpoint);
    const channels = {} as Record<'game' | 'remoteCommentary' | 'microphone', MixerChannelStatus>;
    for (const role of ['game', 'remoteCommentary', 'microphone'] as const) {
      if (routing.transition) {
        channels[role] = {
          name: role,
          volume: null,
          muted: null,
          control: 'unknown',
          message: '音频模式切换待完成，请回到声音设置重新切换。',
        };
        continue;
      }
      const binding =
        routing.desktop && role === 'game'
          ? {
              ...routing.desktop,
              valid:
                routing.desktop.endpoint === endpoint &&
                routing.desktop.collection === routing.collection &&
                routing.candidates.some(
                  (input) =>
                    input.uuid === routing.desktop!.inputUuid &&
                    input.kind === routing.desktop!.inputKind,
                ),
              name: '桌面混音',
            }
          : routing.bindings[role];
      if (routing.desktop && role === 'remoteCommentary') {
        channels[role] = {
          name: '远端解说',
          volume: null,
          muted: null,
          control: 'unbound',
          message: '桌面混音中无法单独调整。',
        };
        continue;
      }
      const name =
        binding?.name ??
        ({ game: '游戏', remoteCommentary: '远端解说', microphone: '麦克风' } as const)[role];
      if (!binding || !binding.valid) {
        channels[role] = {
          name,
          volume: null,
          muted: null,
          control: binding ? 'unknown' : 'unbound',
        };
        continue;
      }
      const args = { inputUuid: binding.inputUuid };
      const [volume, mute] = await Promise.all([
        obs.call('GetInputVolume', args),
        obs.call('GetInputMute', args),
      ]);
      const known =
        typeof volume.inputVolumeMul === 'number' &&
        Number.isFinite(volume.inputVolumeMul) &&
        typeof mute.inputMuted === 'boolean';
      channels[role] = {
        name,
        volume: known ? (volume.inputVolumeMul as number) : null,
        muted: known ? (mute.inputMuted as boolean) : null,
        control: known ? 'available' : 'unknown',
      };
    }
    return { revision: this.mixerRevision(routing), channels, routing };
  }
  mixerRead() {
    return this.serial(() =>
      this.withObs((obs, endpoint) => this.mixerReadObs(obs, endpoint), 12000, undefined, true),
    );
  }
  mixerWrite(command: MixerCommand, gameAudio?: GameAudioController): Promise<MixerCommandResult> {
    return this.serial(() =>
      this.withObs<MixerCommandResult>(
        async (obs, endpoint) => {
          try {
            const initial = await this.mixerReadObs(obs, endpoint);
            if (
              command.channel === 'music' ||
              initial.revision !== command.revision ||
              initial.channels[command.channel].control !== 'available'
            )
              return { status: 'rejected', message: '音频绑定已变化或不可用，请刷新。' };
            const role = command.channel;
            const binding =
              role === 'game' && initial.routing.desktop
                ? initial.routing.desktop
                : initial.routing.bindings[role]!;
            const perform = async (): Promise<MixerCommandResult> => {
              const current = await this.mixerReadObs(obs, endpoint);
              if (
                current.revision !== command.revision ||
                current.channels[role].control !== 'available'
              )
                return { status: 'rejected', message: '音频绑定已变化，请刷新。' };
              const args = { inputUuid: binding.inputUuid };
              if (command.volume !== undefined) {
                await obs.call('SetInputVolume', { ...args, inputVolumeMul: command.volume });
              }
              if (command.muted !== undefined) {
                await obs.call('SetInputMute', { ...args, inputMuted: command.muted });
              }
              const after = await this.mixerReadObs(obs, endpoint);
              const observed = after.channels[role];
              if (
                after.revision !== command.revision ||
                observed.control !== 'available' ||
                (command.volume !== undefined &&
                  (observed.volume === null ||
                    Math.fround(observed.volume) !== Math.fround(command.volume))) ||
                (command.muted !== undefined && observed.muted !== command.muted)
              )
                return { status: 'unknown', message: '写入结果未确认，请刷新。' };
              return { status: 'confirmed' };
            };
            if (role === 'game' && !initial.routing.desktop) {
              if (!gameAudio) return { status: 'rejected', message: '游戏音频控制不可用。' };
              return await gameAudio.manual(perform);
            }
            return await perform();
          } catch {
            return {
              status: 'unknown',
              message: '音频操作未确认，请刷新。',
            };
          }
        },
        12000,
        undefined,
        true,
      ).catch(() => ({ status: 'unknown', message: 'OBS 连接未确认。' })),
    );
  }
  bindAudio(command: ObsAudioBindCommand) {
    if (!this.audioRouting) throw new Error('audio_routing_unavailable');
    return this.serial(() =>
      this.withObs(async (obs, endpoint) => {
        await this.audioRouting!.bind(obs, command, endpoint, async (binding) => {
          if (command.role !== 'remoteCommentary' || !this.commentary) return;
          const current = await this.commentary.owner.get();
          await this.commentary.owner.set(
            binding
              ? {
                  mode: 'existingInput',
                  binding: {
                    endpoint: binding.endpoint,
                    collection: binding.collection,
                    inputUuid: binding.inputUuid,
                  },
                }
              : { mode: 'disabled' },
            current.revision,
          );
        });
      }, 12000),
    );
  }
  async readCommentary() {
    if (!this.commentary) throw new Error('commentary_unavailable');
    return this.commentary.owner.get();
  }
  listCommentaryApplications() {
    if (!this.commentary) throw new Error('commentary_unavailable');
    return this.configurationMutation(() =>
      this.audioConfiguration.run(async (obs, endpoint) => {
        const { owner, journal } = this.commentary!;
        const state = await owner.get();
        const check = async (idle = false) => {
          const [current, stream, record, collection] = await Promise.all([
            owner.get(),
            obs.call('GetStreamStatus'),
            obs.call('GetRecordStatus'),
            obs.call('GetSceneCollectionList'),
          ]);
          if (
            current.revision !== state.revision ||
            (idle && (stream.outputActive !== false || record.outputActive !== false)) ||
            collection.currentSceneCollectionName !== OBS_COLLECTION
          )
            throw new Error('commentary_context_changed');
        };
        await check();
        const inputs = (await obs.call('GetInputList')).inputs;
        if (!Array.isArray(inputs)) throw new Error('commentary_inputs_unknown');
        const existing = (inputs as Record<string, unknown>[]).find(
          (input) =>
            input.inputKind === 'wasapi_process_output_capture' &&
            typeof input.inputUuid === 'string',
        );
        const probe =
          typeof existing?.inputUuid === 'string'
            ? existing.inputUuid
            : await createCommentaryProbe(
                obs,
                journal,
                {
                  endpoint,
                  collection: OBS_COLLECTION,
                  sceneName: obsDesiredScenes(this.browserBaseUrl)[0]!.sceneName,
                },
                () => check(true),
              );
        const windows = await owner.windows(obs, state.revision, probe);
        await check();
        this.commentaryChoices.clear();
        const candidates = windows.map((candidate) => {
          const id = randomUUID();
          this.commentaryChoices.set(id, {
            window: candidate.window,
            revision: state.revision,
            endpoint,
            probe,
            until: Date.now() + 30_000,
          });
          return { id, label: candidate.label };
        });
        return { revision: state.revision, candidates };
      }),
    );
  }
  selectCommentaryApplication(id: string, revision: string) {
    if (!this.commentary) throw new Error('commentary_unavailable');
    return this.configurationMutation(() =>
      this.audioConfiguration.run(async (obs, endpoint) => {
        const selected = this.commentaryChoices.get(id);
        this.commentaryChoices.clear();
        if (
          !selected ||
          selected.until <= Date.now() ||
          selected.revision !== revision ||
          selected.endpoint !== endpoint ||
          (await this.commentary!.owner.get()).revision !== revision
        )
          throw new Error('commentary_selection_changed');
        const [collection, inputs] = await Promise.all([
          obs.call('GetSceneCollectionList'),
          obs.call('GetInputList'),
        ]);
        if (
          collection.currentSceneCollectionName !== OBS_COLLECTION ||
          !Array.isArray(inputs.inputs) ||
          !(inputs.inputs as Record<string, unknown>[]).some(
            (input) =>
              input.inputUuid === selected.probe &&
              input.inputKind === 'wasapi_process_output_capture',
          )
        )
          throw new Error('commentary_selection_changed');
        const candidates = await this.commentary!.owner.windows(obs, revision, selected.probe);
        if (!candidates.some((candidate) => candidate.window === selected.window))
          throw new Error('commentary_selection_changed');
        const previous = await this.commentary!.owner.get();
        const switchPath = `${this.commentary!.journal}.switch`;
        const pendingSwitch = await readCommentarySwitch(switchPath);
        if (pendingSwitch?.phase === 'sent') throw new Error('commentary_switch_recovery_required');
        let owned: { endpoint?: string; collection?: string; uuid?: string } | undefined;
        try {
          owned = JSON.parse(await readFile(this.commentary!.journal, 'utf8')) as typeof owned;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        let from: string | undefined;
        const routing = await this.audioRouting?.commentaryBinding();
        const confirmed = await readOwnedCommentaryTarget(
          `${this.commentary!.journal}.owned-target`,
        );
        if (
          owned?.endpoint === endpoint &&
          owned.collection === OBS_COLLECTION &&
          typeof owned.uuid === 'string' &&
          confirmed?.endpoint === endpoint &&
          confirmed.collection === OBS_COLLECTION &&
          confirmed.uuid === owned.uuid &&
          routing?.binding?.inputUuid === owned.uuid &&
          routing.binding.endpoint === endpoint &&
          routing.binding.collection === OBS_COLLECTION &&
          routing.game?.inputUuid !== owned.uuid &&
          routing.microphone?.inputUuid !== owned.uuid &&
          (inputs.inputs as Record<string, unknown>[]).some(
            (input) =>
              input.inputUuid === owned.uuid && input.inputKind === 'wasapi_process_output_capture',
          )
        ) {
          const settings = (await obs.call('GetInputSettings', { inputUuid: owned.uuid }))
            .inputSettings;
          if (settings && typeof settings === 'object') {
            const value = (settings as Record<string, unknown>).window;
            if (
              typeof value === 'string' &&
              value !== selected.window &&
              value === confirmed.window &&
              ((previous.preference.mode === 'autoTeamspeak' && isTeamspeak(value)) ||
                (previous.preference.mode === 'application' &&
                  previous.preference.window === value) ||
                previous.preference.mode === 'disabled' ||
                (previous.preference.mode === 'existingInput' &&
                  previous.preference.binding.endpoint === endpoint &&
                  previous.preference.binding.collection === OBS_COLLECTION &&
                  previous.preference.binding.inputUuid === owned.uuid) ||
                (pendingSwitch?.phase === 'prepared' &&
                  pendingSwitch.endpoint === endpoint &&
                  pendingSwitch.collection === OBS_COLLECTION &&
                  pendingSwitch.uuid === owned.uuid &&
                  pendingSwitch.revision === revision &&
                  pendingSwitch.from === value &&
                  ((previous.preference.mode === 'application' &&
                    pendingSwitch.to === previous.preference.window) ||
                    (previous.preference.mode === 'autoTeamspeak' &&
                      pendingSwitch.to === AUTO_TEAMSPEAK_TARGET))))
            )
              from = value;
          }
        }
        const next = await this.commentary!.owner.set(
          { mode: 'application', window: selected.window },
          revision,
        );
        if (from && owned?.uuid && routing)
          await saveCommentarySwitch(switchPath, {
            endpoint,
            collection: OBS_COLLECTION,
            uuid: owned.uuid,
            from,
            to: selected.window,
            revision: next.revision,
            routingRevision: routing.revision,
            phase: 'prepared',
          });
        return next;
      }),
    );
  }
  setCommentaryMode(mode: 'autoTeamspeak' | 'disabled', revision: string) {
    if (!this.commentary) throw new Error('commentary_unavailable');
    if (mode === 'disabled')
      return this.serial(() => this.commentary!.owner.set({ mode }, revision));
    return this.configurationMutation(() =>
      this.audioConfiguration.run(async (obs, endpoint) => {
        const { owner, journal } = this.commentary!;
        const previous = await owner.get();
        if (previous.revision !== revision) throw new Error('commentary_revision_changed');
        const path = `${journal}.switch`;
        const pending = await readCommentarySwitch(path);
        if (pending?.phase === 'sent') throw new Error('commentary_switch_recovery_required');
        let owned: { endpoint?: string; collection?: string; uuid?: string } | undefined;
        try {
          owned = JSON.parse(await readFile(journal, 'utf8')) as typeof owned;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const routing = await this.audioRouting?.commentaryBinding();
        const confirmed = await readOwnedCommentaryTarget(`${journal}.owned-target`);
        let target: { uuid: string; from: string; to: string; routingRevision: string } | undefined;
        if (
          owned?.endpoint === endpoint &&
          owned.collection === OBS_COLLECTION &&
          typeof owned.uuid === 'string' &&
          confirmed?.endpoint === endpoint &&
          confirmed.collection === OBS_COLLECTION &&
          confirmed.uuid === owned.uuid &&
          routing?.binding?.inputUuid === owned.uuid &&
          routing.binding.endpoint === endpoint &&
          routing.binding.collection === OBS_COLLECTION &&
          routing.game?.inputUuid !== owned.uuid &&
          routing.microphone?.inputUuid !== owned.uuid &&
          (previous.preference.mode === 'application' ||
            previous.preference.mode === 'disabled' ||
            (previous.preference.mode === 'existingInput' &&
              previous.preference.binding.endpoint === endpoint &&
              previous.preference.binding.collection === OBS_COLLECTION &&
              previous.preference.binding.inputUuid === owned.uuid))
        ) {
          const [collection, inputs, settings] = await Promise.all([
            obs.call('GetSceneCollectionList'),
            obs.call('GetInputList'),
            obs.call('GetInputSettings', { inputUuid: owned.uuid }),
          ]);
          const found =
            Array.isArray(inputs.inputs) &&
            (inputs.inputs as Record<string, unknown>[]).some(
              (input) =>
                input.inputUuid === owned.uuid &&
                input.inputKind === 'wasapi_process_output_capture',
            );
          const from =
            settings.inputSettings && typeof settings.inputSettings === 'object'
              ? (settings.inputSettings as Record<string, unknown>).window
              : undefined;
          if (
            collection.currentSceneCollectionName === OBS_COLLECTION &&
            found &&
            from === confirmed.window &&
            (previous.preference.mode === 'disabled' ||
              previous.preference.mode === 'existingInput' ||
              from === previous.preference.window)
          ) {
            const windows = (await owner.windows(obs, revision, owned.uuid)).filter((candidate) =>
              isTeamspeak(candidate.window),
            );
            if (windows.length === 1 && windows[0]!.window !== from)
              target = {
                uuid: owned.uuid,
                from,
                to: windows[0]!.window,
                routingRevision: routing.revision,
              };
            else if (windows.length === 0)
              target = {
                uuid: owned.uuid,
                from,
                to: AUTO_TEAMSPEAK_TARGET,
                routingRevision: routing.revision,
              };
          }
        }
        const next = await owner.set({ mode }, revision);
        if (target)
          await saveCommentarySwitch(path, {
            endpoint,
            collection: OBS_COLLECTION,
            ...target,
            revision: next.revision,
            phase: 'prepared',
          });
        return next;
      }),
    );
  }
  ensure(activeScene: () => ProgramSceneId = () => 'waiting'): Promise<readonly ObsFinding[]> {
    return this.configurationMutation(async () => {
      const prepared = await this.withObs(async (obs, endpoint) => {
        await assertBpCompactOff(obs);
        const visual = await ensureObsConfiguration(obs, this.browserBaseUrl, activeScene);
        if (
          visual.some((item) =>
            [
              'collection_missing',
              'collection_inactive',
              'scene_missing',
              'source_kind_conflict',
            ].includes(item.code),
          )
        )
          return { findings: visual, ready: false };
        let audio: ObsFinding[];
        if (await this.audioRouting?.enabled()) {
          audio = await checkObsAudio(obs);
          audio.push(...(await this.bindingFindings(obs, endpoint)));
        } else audio = await ensureObsAudio(obs, this.browserBaseUrl);
        return { findings: [...visual, ...audio], ready: true };
      }, 30_000);
      this.findings = prepared.findings;
      if (await this.audioRouting?.modePending())
        this.findings = [
          ...this.findings,
          {
            code: 'commentary_pending',
            message: '音频模式切换待完成，请在声音设置重新核对并切换。',
          },
        ];
      if (
        prepared.ready &&
        this.commentary &&
        !(await this.audioRouting?.desktopBinding()) &&
        !(await this.audioRouting?.modePending())
      ) {
        try {
          const commentary = await this.audioConfiguration.run((obs, endpoint, observer) =>
            configureIndependentAudio(
              obs,
              endpoint,
              observer,
              this.commentary!.owner,
              this.commentary!.journal,
              this.browserBaseUrl,
              async (ids) => this.audioRouting?.seedAutomatic(obs, endpoint, ids),
              async () => !(await this.audioRouting?.enabled()),
              async (plan) => {
                const routing = await this.audioRouting?.commentaryBinding();
                return Boolean(
                  routing &&
                  routing.revision === plan.routingRevision &&
                  routing.binding?.inputUuid === plan.uuid &&
                  routing.binding.endpoint === plan.endpoint &&
                  routing.binding.collection === plan.collection &&
                  routing.game?.inputUuid !== plan.uuid &&
                  routing.microphone?.inputUuid !== plan.uuid,
                );
              },
              async () => (await this.audioRouting?.managedBindings(obs, endpoint)) ?? null,
            ),
          );
          this.findings = [...this.findings, ...commentary];
        } catch (error) {
          this.diagnostic('obs_commentary_prepare', obsErrorEvidence(error));
          const audioReason = error instanceof Error ? error.message : '';
          const audioHelp: Record<string, string> = {
            audio_global_path_unresolved:
              'OBS 仍启用了全局音频，请先关闭重复的全局采集，再重试自动配置。',
            audio_nested_path_unresolved:
              'Mizar 场景包含嵌套音频路径，请先将音频改为直接来源，再重试自动配置。',
            audio_video_path_unresolved:
              '画面来源仍附带采集声音，请将它选为对应音频分路，或关闭附带音频后重试。',
            audio_bindings_incomplete: '已选择的音频来源已失效，请在声音设置中重新选择。',
          };
          const uncertain = await readCommentarySwitch(`${this.commentary.journal}.switch`)
            .then((value) => value?.phase === 'sent')
            .catch(() => true);
          this.findings = [
            ...this.findings,
            {
              code: 'commentary_pending',
              message: uncertain
                ? '解说来源切换结果待核对，请在 OBS 中检查后处理。'
                : (audioHelp[audioReason] ??
                  '场景已准备，音频分路待完成。请检查远端解说来源后重试。'),
            },
          ];
        }
      }
      return this.findings;
    });
  }
  repair(activeScene: () => ProgramSceneId): Promise<readonly ObsFinding[]> {
    return this.configurationMutation(async () => {
      this.findings = await this.withObs(async (obs, endpoint) => {
        await assertBpCompactOff(obs);
        const findings = await repairObsConfiguration(obs, this.browserBaseUrl);
        await switchObsScene(obs, activeScene());
        return this.configurationFindings(obs, endpoint, findings);
      }, 12_000);
      return this.findings;
    });
  }
  gameBackgroundReady(): Promise<boolean> {
    return this.serial(() => this.withObs((obs) => gameBackgroundReady(obs)).catch(() => false));
  }
  setBpCompactVisible(visible: boolean): Promise<void> {
    return this.serial(async () => {
      let client = this.bpClient;
      if (!client) {
        const config = await this.configStore.read();
        client = new OBSWebSocket();
        const current = client;
        const invalidate = () => {
          if (this.bpClient !== current) return;
          this.bpOwner.invalidate();
          this.bpClient = undefined;
          this.bpDisconnect?.();
        };
        client.on('ConnectionClosed', invalidate);
        client.on('CurrentSceneCollectionChanging', () => {
          this.bpOwner.invalidate();
          this.bpDisconnect?.();
        });
        client.on('SceneItemEnableStateChanged', (event) => {
          if (this.bpOwner.observeItem(event.sceneName, event.sceneItemId, event.sceneItemEnabled))
            this.bpDisconnect?.();
        });
        client.on('SceneItemRemoved', (event) => {
          if (this.bpOwner.observeRemoval(event.sceneName, event.sceneItemId))
            this.bpDisconnect?.();
        });
        client.on('SceneRemoved', (event) => {
          if (this.bpOwner.observeSceneRemoval(event.sceneName)) this.bpDisconnect?.();
        });
        let connectTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            client.connect(`ws://${config.host}:${config.port}`, config.password),
            new Promise<never>((_, reject) => {
              connectTimer = setTimeout(() => reject(new Error('OBS 连接超时。')), TIMEOUT_MS);
            }),
          ]);
          this.bpClient = client;
        } catch (error) {
          await client.disconnect().catch(() => undefined);
          throw error;
        } finally {
          if (connectTimer) clearTimeout(connectTimer);
        }
      }
      const rpc: ObsRpc = {
        call: (type, data) =>
          (
            client.call as (
              name: string,
              args?: Record<string, unknown>,
            ) => Promise<Record<string, unknown>>
          )(type, data),
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.bpOwner.set(rpc, this.browserBaseUrl, visible),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('OBS 操作超时，请检查连接。')), TIMEOUT_MS);
          }),
        ]);
        if (!visible && this.bpClient === client) {
          this.bpClient = undefined;
          await client.disconnect().catch(() => undefined);
        }
      } catch (error) {
        this.bpOwner.invalidate();
        if (this.bpClient === client) this.bpClient = undefined;
        await client.disconnect().catch(() => undefined);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
  }
  switchScene(id: ProgramSceneId, options?: ObsSceneSwitchOptions): Promise<void> {
    return this.serial(() => this.withObs((obs) => switchObsScene(obs, id, options)));
  }
  switchToWaitingForExit(options: ObsSceneSwitchOptions): Promise<void> {
    return this.serial(async () => {
      try {
        await this.withObs((obs) => switchObsScene(obs, 'waiting', options));
      } catch (error) {
        // A fresh native absence proof also covers a previously used OBS that
        // the operator has closed. Disconnection alone never proves output stopped.
        let running: boolean;
        try {
          running = await isObsProcessRunning();
        } catch (probeError) {
          this.diagnostic('obs_exit_process_probe', obsErrorEvidence(probeError));
          throw new ObsExitSafetyError(
            'OBS 运行状态未确认，制作尚未结束。请连接 OBS 后重试退出；若 OBS 已关闭，请查看诊断并重试。',
            { cause: error },
          );
        }
        if (running)
          throw new ObsExitSafetyError(
            'OBS 等待画面未确认，制作尚未结束。请连接 OBS 后重试退出；若无法连接，请在 OBS 中确认停止推流与录制并关闭 OBS 后重试。',
            { cause: error },
          );
        if (options.valid && !options.valid())
          throw new Error('退出请求已失效，请重试。', { cause: error });
      }
    });
  }
  setupAudio(): Promise<void> {
    return this.configurationMutation(async () => {
      if (await this.audioRouting?.enabled()) throw new ObsActionError('audio_routing_enabled');
      await this.withObs((obs) => setupObsAudio(obs, this.browserBaseUrl), 12_000);
    });
  }
  async launchTarget(): Promise<string> {
    const config = await this.configStore.read();
    const path = await discoverObsExecutable(config.executablePath);
    if (!path) throw new ObsActionError('executable_missing');
    return path;
  }

  async open(): Promise<void> {
    const path = await this.launchTarget();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(path, [], {
        cwd: dirname(path),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
      child.once('error', (cause) => reject(new ObsActionError('executable_failed', { cause })));
    });
  }
}
