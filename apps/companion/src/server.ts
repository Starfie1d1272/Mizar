import { createHash, randomUUID } from 'node:crypto';
import { SteamAvatars } from './media/steam-avatars.js';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import type { ResourceTrustPolicy } from '@mizar/resource-pack-contract/runtime';
import { defaultResourceRoot } from './resource-store/store.js';
import { version as osVersion } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { buildApp } from './app.js';
import { UpdateManager } from './updates/manager.js';
import { configuredHttpOutputs } from './output/http-sink.js';
import { RivalHubConnection } from './match-context/rivalhub-connection.js';
import { createProgramRuntime } from './runtime/program-runtime.js';
import { JsonSeriesProgressCheckpointStore } from './series-progress/checkpoint-store.js';
import {
  createCaptureRecorder,
  createDisabledRecorder,
  type CaptureRecorder,
  type RecorderDiagnostic,
} from './telemetry/capture-recorder.js';
import {
  createCstvSourceManagers,
  parseCstvSourceUrl,
  type CstvSourceManagers,
} from './telemetry/cstv-source-manager.js';
import { PRODUCTION_GSI_CONFIG } from './telemetry/gsi-ingress.js';
import { parseAllowedOrigins } from './local-web/origin-policy.js';
import { HudConfigStore } from './hud-config/store.js';
import type { QualificationProfile } from './qualification/evidence.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const webRoot = process.env.WEB_ROOT;
const localWebLanMode = /^(?:1|true)$/i.test(process.env.LOCAL_WEB_LAN_MODE ?? '');
const localWebAllowedOrigins = parseAllowedOrigins(process.env.LOCAL_WEB_ALLOWED_ORIGINS);
const gsiToken = process.env.GSI_TOKEN;
const captureDir = process.env.CAPTURE_DIR || join(process.cwd(), 'recordings', 'gsi');
const hudConfigPath = process.env.HUD_CONFIG_PATH ?? join(captureDir, '..', 'hud-config.json');
const seriesProgressCheckpointPath =
  process.env.SERIES_PROGRESS_CHECKPOINT_PATH ?? join(captureDir, '..', 'series-progress.json');
const mizarCommit = process.env.MIZAR_COMMIT ?? 'unknown';
const qualificationMode = /^(?:1|true)$/i.test(process.env.QUALIFICATION_MODE ?? '');
const qualificationProfile: QualificationProfile =
  process.env.QUALIFICATION_PROFILE === 'release'
    ? 'release'
    : process.env.QUALIFICATION_PROFILE === 'objective-timing'
      ? 'objective-timing'
      : 'base';
const qualificationControlToken = process.env.QUALIFICATION_CONTROL_TOKEN;
const qualificationRunId = process.env.QUALIFICATION_RUN_ID ?? randomUUID();
const qualificationEvidenceDir = process.env.QUALIFICATION_EVIDENCE_DIR;
const qualificationScenarioPath =
  process.env.QUALIFICATION_SCENARIO_PATH ?? join(captureDir, '..', 'scenario.jsonl');
const qualificationHostCheckpointsPath =
  process.env.QUALIFICATION_HOST_CHECKPOINTS_PATH ??
  (qualificationEvidenceDir
    ? join(qualificationEvidenceDir, 'host-checkpoints.jsonl')
    : join(captureDir, '..', 'host-checkpoints.jsonl'));
const qualificationFinalRuntimePath =
  qualificationMode && qualificationEvidenceDir !== undefined
    ? join(qualificationEvidenceDir, 'debug', 'final-runtime.json')
    : undefined;
const COMPANION_SHUTDOWN_WATCHDOG_TIMEOUT_MS = 30_000;
const producerInstanceId = randomUUID();

let httpOutputs: ReturnType<typeof configuredHttpOutputs> = {};
let httpOutputConfigError: string | undefined;
try {
  httpOutputs = configuredHttpOutputs(process.env);
} catch {
  httpOutputConfigError = 'HTTP 输出配置不完整或不安全';
}

let cstvSourceConfig: CstvSourceManagers | undefined;
let programCstvUrl: string | undefined;
let cstvSourceConfigError: string | undefined;
let receiverSequence = 0;
try {
  const programUrl = parseCstvSourceUrl(process.env.PROGRAM_CSTV_URL, 'PROGRAM_CSTV_URL');
  programCstvUrl = programUrl;
  const lookaheadUrl = parseCstvSourceUrl(process.env.LOOKAHEAD_CSTV_URL, 'LOOKAHEAD_CSTV_URL');
  cstvSourceConfig = createCstvSourceManagers({
    ...(programUrl === undefined ? {} : { programUrl }),
    ...(lookaheadUrl === undefined ? {} : { lookaheadUrl }),
  });
} catch (error: unknown) {
  cstvSourceConfigError =
    error instanceof Error ? error.message : 'CSTV source configuration invalid';
}

function logRecorderDiagnostic(diagnostic: RecorderDiagnostic): void {
  const fields = {
    code: diagnostic.code,
    ...(diagnostic.operation === undefined ? {} : { operation: diagnostic.operation }),
    ...(diagnostic.causeCode === undefined ? {} : { causeCode: diagnostic.causeCode }),
  };
  console.warn(`Companion 采集记录诊断：${JSON.stringify(fields)}`);
}

async function writeFinalRuntime(path: string, response: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(response, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

if (gsiToken === undefined || gsiToken.trim().length === 0) {
  console.error('Companion 启动失败：GSI_TOKEN 必须设置为非空值');
  process.exitCode = 1;
} else if (qualificationMode && (qualificationControlToken?.trim().length ?? 0) === 0) {
  console.error('Companion 启动失败：现场验收模式下必须设置 QUALIFICATION_CONTROL_TOKEN');
  process.exitCode = 1;
} else if (qualificationMode && host !== '127.0.0.1') {
  console.error('Companion 启动失败：现场验收模式必须监听本机回环地址 127.0.0.1');
  process.exitCode = 1;
} else if (httpOutputConfigError !== undefined) {
  console.error(`Companion 启动失败：${httpOutputConfigError}`);
  process.exitCode = 1;
} else if (cstvSourceConfigError !== undefined) {
  console.error(`Companion 启动失败：${cstvSourceConfigError}`);
  process.exitCode = 1;
} else {
  let recorder: CaptureRecorder;
  const createRecorder = () =>
    createCaptureRecorder({
      captureDir,
      broadcastCommit: mizarCommit,
      gsiConfig: PRODUCTION_GSI_CONFIG,
      ...(qualificationMode
        ? {
            windowsVersion: process.env.QUALIFICATION_WINDOWS_VERSION ?? osVersion(),
            cs2Build: process.env.QUALIFICATION_CS2_VERSION ?? 'unknown',
            ...(process.env.QUALIFICATION_ARTIFACT_SHA256 === undefined
              ? {}
              : { artifactSha256: process.env.QUALIFICATION_ARTIFACT_SHA256 }),
            qualificationRunId,
          }
        : {}),
      onDiagnostic: logRecorderDiagnostic,
    });

  try {
    recorder = await createRecorder();
  } catch (error: unknown) {
    recorder = createDisabledRecorder('recorder_start_failed');
    console.error(`Companion 采集记录不可用：${String(error)}`);
  }

  const seriesProgressCheckpointStore = new JsonSeriesProgressCheckpointStore({
    filePath: seriesProgressCheckpointPath,
    onDiagnostic: (code) => console.warn(`系列进度检查点诊断：${code}`),
  });
  const rivalhubConnection = new RivalHubConnection(
    join(captureDir, '..', 'rivalhub-connection.json'),
  );
  await rivalhubConnection.load();
  const steamAvatars = new SteamAvatars(join(captureDir, '..', 'steam-avatars'));
  await steamAvatars.load();
  const hudConfigStore = new HudConfigStore({
    filePath: hudConfigPath,
    onDiagnostic: (code) => console.warn(`HUD 配置诊断：${code}`),
  });
  await hudConfigStore.load();
  const programRuntime = createProgramRuntime(producerInstanceId, {
    liveSession: { kind: 'bound', liveSessionId: randomUUID() },
    seriesProgressCheckpointStore,
    onSeriesProgressDiagnostic: ({ code }) => console.warn(`系列进度检查点诊断：${code}`),
  });
  const productInstance = process.env.MIZAR_PRODUCT_INSTANCE;
  const rehearsalCandidates = [
    resolve(process.cwd(), 'fixtures/epl-s24/rehearsal.generated.json'),
    resolve(process.cwd(), '../../fixtures/epl-s24/rehearsal.generated.json'),
  ];
  const detectedRehearsalPath = rehearsalCandidates.find((candidate) => existsSync(candidate));
  const rehearsalFixturePath =
    productInstance === undefined &&
    (process.argv.includes('--rehearsal') ||
      (qualificationMode && process.env.MIZAR_REHEARSAL === '1') ||
      detectedRehearsalPath !== undefined)
      ? detectedRehearsalPath
      : undefined;
  const productArtifact = process.env.MIZAR_ARTIFACT_SHA256;
  const productToken = process.env.MIZAR_RUNTIME_TOKEN;
  if (productInstance !== undefined && (qualificationMode || !productArtifact || !productToken)) {
    throw new Error('便携产品运行身份不完整或模式冲突');
  }
  let updates: UpdateManager | undefined;
  if (
    productInstance &&
    process.env.MIZAR_BUNDLE_ROOT &&
    process.env.MIZAR_STATE_ROOT &&
    process.env.MIZAR_APP_VERSION
  ) {
    updates = new UpdateManager({
      stateRoot: process.env.MIZAR_STATE_ROOT,
      bundleRoot: process.env.MIZAR_BUNDLE_ROOT,
      version: process.env.MIZAR_APP_VERSION,
      currentContentDigest: productArtifact!,
      installed: process.env.MIZAR_DISTRIBUTION === 'installed',
      log: (stage, code, version) =>
        console.info(JSON.stringify({ event: 'update', stage, code, version })),
    });
    await updates.load();
  }
  const app = buildApp({
    resources: {
      root: defaultResourceRoot(),
      // This optional pin is inside the authenticated Core bundle, not mirror metadata.
      ...(process.env.MIZAR_BUNDLE_ROOT
        ? await (async () => {
            try {
              const policy = JSON.parse(
                await readFile(
                  join(process.env.MIZAR_BUNDLE_ROOT!, 'resource-policy.json'),
                  'utf8',
                ),
              ) as ResourceTrustPolicy & { cacheHistory?: ResourceTrustPolicy[] };
              if (policy.coreVersion !== process.env.MIZAR_APP_VERSION) return {};
              return {
                policy,
                ...(Array.isArray(policy.cacheHistory)
                  ? { cacheHistory: policy.cacheHistory }
                  : {}),
              };
            } catch {
              return {};
            }
          })()
        : {}),
    },
    ...(updates ? { updates } : {}),
    steamAvatars,
    ...(productInstance === undefined
      ? {}
      : { supportLogsDirectory: resolve(captureDir, '../../logs') }),
    ...httpOutputs,
    rivalhubConnection,
    ...(rehearsalFixturePath === undefined ? {} : { rehearsalFixturePath }),
    ...(productInstance === undefined
      ? {}
      : {
          productRuntime: {
            ...(process.env.MIZAR_APP_VERSION ? { appVersion: process.env.MIZAR_APP_VERSION } : {}),
            instanceId: productInstance,
            artifactSha256: productArtifact!,
            gitSha: mizarCommit,
            controlToken: productToken!,
            stop: () => shutdown('product-stop'),
          },
        }),
    logger: true,
    gsiToken,
    recorder,
    ...(qualificationMode
      ? {
          gsiSequenceSource: () => receiverSequence++,
        }
      : {}),
    programRuntime,
    ...(webRoot === undefined ? {} : { webRoot }),
    host,
    port,
    localWebLanMode,
    localWebAllowedOrigins,
    ...(cstvSourceConfig === undefined ? {} : { cstvSources: cstvSourceConfig }),
    qualificationMode,
    ...(qualificationControlToken === undefined ? {} : { qualificationControlToken }),
    matchManifestPath: join(captureDir, '..', 'match-context.json'),
    localTournamentPath: join(captureDir, '..', 'local-tournament.json'),
    reliableOutboxPath: join(captureDir, '..', 'reliable-outbox.json'),
    ...(process.env.RIVALHUB_MANIFEST_URL_TEMPLATE && process.env.RIVALHUB_BROADCAST_READ_TOKEN
      ? {
          onlineManifestConfig: {
            urlTemplate: process.env.RIVALHUB_MANIFEST_URL_TEMPLATE,
            readToken: process.env.RIVALHUB_BROADCAST_READ_TOKEN,
          },
        }
      : {}),
    hudConfigPath,
    hudConfigStore,
    obsConfigPath: join(captureDir, '..', 'obs.json'),
    ...(qualificationMode
      ? {
          qualificationRunId,
          qualificationScenarioPath,
          qualificationHostCheckpointsPath,
          qualificationProfile,
          onQualificationRestart: () => shutdown('qualification-restart', 75),
          onQualificationRecorderRotate: async (currentRecorder) => {
            if (currentRecorder !== recorder) {
              throw new Error('采集记录在切换过程中发生了意外变化。');
            }
            const nextRecorder = await createRecorder();
            const previousCaptureId = currentRecorder.captureId;
            recorder = nextRecorder;
            return {
              previousCaptureId,
              captureId: nextRecorder.captureId,
              nextRecorder,
            };
          },
          onQualificationFinish: async ({ debug }: { readonly debug: unknown }) => {
            try {
              if (qualificationFinalRuntimePath !== undefined) {
                await writeFinalRuntime(qualificationFinalRuntimePath, debug);
              }
            } catch (error: unknown) {
              console.error(`现场验收最终运行状态快照获取失败：${String(error)}`);
            } finally {
              shutdown('qualification-finish');
            }
          },
        }
      : {}),
    ...(programCstvUrl === undefined
      ? {}
      : {
          objectiveReferenceSource: {
            artifactId: 'program-cstv-endpoint',
            artifactSha256: createHash('sha256').update(programCstvUrl, 'utf8').digest('hex'),
          },
        }),
  });
  let shutdownPromise: Promise<void> | undefined;

  function shutdown(signal: string, exitCode = 0): void {
    shutdownPromise ??= (async () => {
      let appClosed = false;
      const watchdog = setTimeout(() => {
        if (appClosed && recorder.getHealth().state === 'closed') return;
        console.error(
          `Companion 关闭监视器在 ${COMPANION_SHUTDOWN_WATCHDOG_TIMEOUT_MS} 毫秒后超时`,
        );
        process.exit(1);
      }, COMPANION_SHUTDOWN_WATCHDOG_TIMEOUT_MS);
      watchdog.unref();

      try {
        await app.close();
        appClosed = true;
        app.log.info({ signal, exitCode }, 'Companion 已停止');
        process.exitCode = exitCode;
      } catch (error: unknown) {
        app.log.error(error, 'Companion 关闭失败');
        process.exitCode = 1;
      } finally {
        if (recorder.getHealth().state === 'closed') clearTimeout(watchdog);
      }
    })();
  }

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await app.listen({ host, port });
    cstvSourceConfig?.program.start();
    cstvSourceConfig?.lookahead.start();
    app.log.info({ host, port }, 'Companion 正在监听');
  } catch (error: unknown) {
    app.log.error(error, 'Companion 启动失败');
    await app.close();
    process.exitCode = 1;
  }
}
