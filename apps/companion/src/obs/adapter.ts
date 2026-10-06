import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { OBSWebSocket } from 'obs-websocket-js';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import { ObsConfigStore, discoverObsExecutable } from './config.js';
import {
  checkObsConfiguration,
  repairObsConfiguration,
  refreshObsBrowserSources,
  switchObsScene,
  type ObsFinding,
  type ObsRpc,
  type ObsSceneSwitchOptions,
} from './reconcile.js';

export interface ObsStatus {
  readonly connection: 'connected' | 'unavailable' | 'password_required' | 'invalid_password';
  readonly currentScene: string | null;
  readonly port: number;
  readonly streaming: boolean;
  readonly recording: boolean;
  readonly passwordConfigured: boolean;
  readonly video: null | { readonly canvas: string; readonly output: string; readonly fps: number };
  readonly findings: readonly ObsFinding[];
}

const TIMEOUT_MS = 4000;

export class ObsAdapter {
  private queue: Promise<unknown> = Promise.resolve();
  private findings: ObsFinding[] = [
    { code: 'configuration_unchecked', message: '请检查 OBS 场景配置。' },
  ];
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryClosed = false;
  private recoveryComplete = false;
  private recoveryTask: Promise<void> | undefined;
  private readonly refreshedBrowserSources = new Set<string>();
  constructor(
    private readonly configStore: ObsConfigStore,
    private readonly browserBaseUrl: string,
  ) {}

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

  async close(): Promise<void> {
    this.recoveryClosed = true;
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
    operation: (obs: ObsRpc) => Promise<T>,
    timeoutMs = TIMEOUT_MS,
  ): Promise<T> {
    const config = await this.configStore.read();
    const client = new OBSWebSocket();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const task = (async () => {
        await client.connect(`ws://${config.host}:${config.port}`, config.password);
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
        return operation(rpc);
      })();
      return await Promise.race([
        task,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('OBS 操作超时，请检查连接。')), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      await client.disconnect().catch(() => undefined);
    }
  }

  async status(): Promise<ObsStatus> {
    const config = await this.configStore.read();
    try {
      return await this.withObs(async (obs) => {
        const [scene, stream, record, video, findings] = await Promise.all([
          obs.call('GetCurrentProgramScene'),
          obs.call('GetStreamStatus'),
          obs.call('GetRecordStatus'),
          obs.call('GetVideoSettings'),
          checkObsConfiguration(obs, this.browserBaseUrl).catch(() => [
            { code: 'configuration_check_failed', message: 'OBS 配置检查未完成，请重新检查。' },
          ]),
        ]);
        this.findings = findings;
        return {
          connection: 'connected',
          currentScene:
            typeof scene.currentProgramSceneName === 'string'
              ? scene.currentProgramSceneName
              : null,
          port: config.port,
          streaming: stream.outputActive === true,
          recording: record.outputActive === true,
          passwordConfigured: Boolean(config.password),
          video: {
            canvas: `${String(video.baseWidth)}×${String(video.baseHeight)}`,
            output: `${String(video.outputWidth)}×${String(video.outputHeight)}`,
            fps: Number(video.fpsNumerator) / Number(video.fpsDenominator),
          },
          findings,
        } satisfies ObsStatus;
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      return {
        connection:
          message.includes('authentication') || message.includes('password')
            ? config.password
              ? 'invalid_password'
              : 'password_required'
            : 'unavailable',
        currentScene: null,
        port: config.port,
        streaming: false,
        recording: false,
        passwordConfigured: Boolean(config.password),
        video: null,
        findings: this.findings,
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
      this.findings = await this.withObs((obs) => checkObsConfiguration(obs, this.browserBaseUrl));
      return this.findings;
    });
  }
  repair(activeScene: () => ProgramSceneId): Promise<readonly ObsFinding[]> {
    return this.serial(async () => {
      this.findings = await this.withObs(async (obs) => {
        const findings = await repairObsConfiguration(obs, this.browserBaseUrl);
        await switchObsScene(obs, activeScene());
        return findings;
      }, 12_000);
      return this.findings;
    });
  }
  switchScene(id: ProgramSceneId, options?: ObsSceneSwitchOptions): Promise<void> {
    return this.serial(() => this.withObs((obs) => switchObsScene(obs, id, options)));
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
      child.once('error', () => reject(new Error('OBS 程序未能打开。')));
    });
  }
}
