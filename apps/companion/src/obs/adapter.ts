import { diagnosticValue } from '../support/session-journal.js';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { OBSWebSocket } from 'obs-websocket-js';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import type { ObsAudioBindCommand, ObsOutputCommand, ObsOutputsStatus } from '@mizar/protocol/obs';
import type { ObsAudioRouting } from './audio-routing.js';
import { RemoteCommentary } from './remote-commentary.js';
import { prepareRemoteCommentary } from './remote-commentary-setup.js';
import { discoverWaitingCommentary } from './remote-commentary-wait.js';
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
  constructor(
    private readonly configStore: ObsConfigStore,
    private readonly browserBaseUrl: string,
    private readonly diagnostic: (stage: string, error: unknown) => void = () => undefined,
    private readonly audioRouting?: ObsAudioRouting,
    private readonly commentary?: { owner: RemoteCommentary; journal: string },
  ) {
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
      await this.configStore.save(config);
      this.audioRouting?.invalidateSelections();
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
        .then(() => undefined)
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
  ): Promise<T> {
    const config = await this.configStore.read();
    const client = new OBSWebSocket();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stage = 'obs_connect';
    try {
      const task = (async () => {
        await client.connect(`ws://${config.host}:${config.port}`, config.password);
        stage = 'obs_request';
        const rpc: ObsRpc = {
          onTransitionVideoEnded: (listener) => {
            const onEnded = (event: { transitionName: string }) => listener(event.transitionName);
            client.on('SceneTransitionVideoEnded', onEnded);
            return () => client.off('SceneTransitionVideoEnded', onEnded);
          },
          call: (type, data) =>
            (
              client.call as (
                name: string,
                args?: Record<string, unknown>,
              ) => Promise<Record<string, unknown>>
            )(type, data),
        };
        return operation(rpc, `ws://${config.host}:${config.port}`);
      })();
      return await Promise.race([
        task,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('OBS 操作超时，请检查连接。')), timeoutMs);
        }),
      ]);
    } catch (error) {
      this.diagnostic(diagnosticStage ?? stage, obsErrorEvidence(error, config.password));
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
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
  bindAudio(command: ObsAudioBindCommand) {
    if (!this.audioRouting) throw new Error('audio_routing_unavailable');
    return this.serial(() =>
      this.withObs((obs, endpoint) => this.audioRouting!.bind(obs, command, endpoint), 12000),
    );
  }
  ensure(activeScene: () => ProgramSceneId = () => 'waiting'): Promise<readonly ObsFinding[]> {
    return this.configurationMutation(async () => {
      this.findings = await this.withObs(async (obs, endpoint) => {
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
          return visual;
        let audio: ObsFinding[];
        if (await this.audioRouting?.enabled()) {
          audio = await checkObsAudio(obs);
          audio.push(...(await this.bindingFindings(obs, endpoint)));
        } else audio = await ensureObsAudio(obs, this.browserBaseUrl);
        let commentary: ObsFinding[] = [];
        if (this.commentary) {
          try {
            commentary = await prepareRemoteCommentary(
              obs,
              this.commentary.owner,
              this.commentary.journal,
              endpoint,
              this.browserBaseUrl,
            );
          } catch (error) {
            this.diagnostic('obs_commentary_prepare', obsErrorEvidence(error));
            commentary = [
              {
                code: 'commentary_pending',
                message: '场景已准备，音频分路待完成。请检查远端解说来源后重试。',
              },
            ];
          }
        }
        return [...visual, ...audio, ...commentary];
      }, 30_000);
      return this.findings;
    });
  }
  repair(activeScene: () => ProgramSceneId): Promise<readonly ObsFinding[]> {
    return this.configurationMutation(async () => {
      this.findings = await this.withObs(async (obs, endpoint) => {
        const findings = await repairObsConfiguration(obs, this.browserBaseUrl);
        await switchObsScene(obs, activeScene());
        return this.configurationFindings(obs, endpoint, findings);
      }, 12_000);
      return this.findings;
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
      if (await this.audioRouting?.enabled())
        throw new Error('已启用音频分路，请在 OBS 中维护音频来源。');
      await this.withObs((obs) => setupObsAudio(obs, this.browserBaseUrl), 12_000);
    });
  }
  async launchTarget(): Promise<string> {
    const config = await this.configStore.read();
    const path = await discoverObsExecutable(config.executablePath);
    if (!path) throw new Error('未找到 OBS，请在设置中选择 obs64.exe。');
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
      child.once('error', (cause) => reject(new Error('OBS 程序未能打开。', { cause })));
    });
  }
}
