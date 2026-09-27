import { spawn } from 'node:child_process';
import { OBSWebSocket } from 'obs-websocket-js';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import { ObsConfigStore, discoverObsExecutable } from './config.js';
import {
  checkObsConfiguration,
  repairObsConfiguration,
  switchObsScene,
  type ObsFinding,
  type ObsRpc,
} from './reconcile.js';

export interface ObsStatus {
  readonly connection: 'connected' | 'unavailable' | 'password_required' | 'invalid_password';
  readonly currentScene: string | null;
  readonly streaming: boolean;
  readonly recording: boolean;
  readonly passwordConfigured: boolean;
  readonly video: null | { readonly canvas: string; readonly output: string; readonly fps: number };
  readonly findings: readonly ObsFinding[];
}

const TIMEOUT_MS = 4000;

export class ObsAdapter {
  private queue: Promise<unknown> = Promise.resolve();
  private findings: ObsFinding[] = [];
  constructor(
    private readonly configStore: ObsConfigStore,
    private readonly browserBaseUrl: string,
  ) {}

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
        const [scene, stream, record, video] = await Promise.all([
          obs.call('GetCurrentProgramScene'),
          obs.call('GetStreamStatus'),
          obs.call('GetRecordStatus'),
          obs.call('GetVideoSettings'),
        ]);
        return {
          connection: 'connected',
          currentScene:
            typeof scene.currentProgramSceneName === 'string'
              ? scene.currentProgramSceneName
              : null,
          streaming: stream.outputActive === true,
          recording: record.outputActive === true,
          passwordConfigured: Boolean(config.password),
          video: {
            canvas: `${String(video.baseWidth)}×${String(video.baseHeight)}`,
            output: `${String(video.outputWidth)}×${String(video.outputHeight)}`,
            fps: Number(video.fpsNumerator) / Number(video.fpsDenominator),
          },
          findings: this.findings,
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
        streaming: false,
        recording: false,
        passwordConfigured: Boolean(config.password),
        video: null,
        findings: this.findings,
      };
    }
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
  switchScene(id: ProgramSceneId): Promise<void> {
    return this.serial(() => this.withObs((obs) => switchObsScene(obs, id)));
  }
  async open(): Promise<void> {
    const config = await this.configStore.read();
    const path = await discoverObsExecutable(config.executablePath);
    if (!path) throw new Error('未找到 OBS，请在设置中选择 obs64.exe。');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(path, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
      child.once('error', () => reject(new Error('OBS 程序未能打开。')));
    });
  }
}
