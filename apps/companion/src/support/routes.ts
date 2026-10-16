import {
  collectObsNativeEvidence,
  failedObsNativeEvidence,
  type ObsNativeEvidence,
} from '../obs/native-evidence.js';
import type { FastifyInstance } from 'fastify';
import { arch, platform, release } from 'node:os';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { LocalWebHostDiagnostics } from '../local-web/websocket-transport.js';
import type { ObsStatus } from '../obs/adapter.js';
import { PROGRAM_SCENES, type ProgramSceneState } from '@mizar/protocol/program-scenes';
import { obsSceneName } from '../obs/desired-state.js';
import type { DebugEvidenceStore } from '../runtime/debug-state.js';
import type { LatestWinsConsumerHealth } from '../runtime/latest-wins.js';
import type { RecorderHealth } from '../telemetry/capture-recorder.js';
import type { BusinessJournal } from './business-journal.js';
import { readBusinessHistory } from './business-history.js';
import { choice, count, digest, readSupportLogs, record, recorderCodes } from './logs.js';

export const SUPPORT_BUNDLE_MAX_BYTES = 1024 * 1024;
const findingCodes = [
  'configuration_unchecked',
  'configuration_check_failed',
  'order_drift',
  'source_disabled',
  'source_missing',
  'transform_drift',
  'scene_missing',
  'source_kind_conflict',
  'url_drift',
  'collection_inactive',
  'video_settings',
  'capture_drift',
  'collection_missing',
];

const cs2IssueCodes = [
  'installation-not-found',
  'multiple-installations',
  'selected-path-missing',
  'selected-path-invalid',
  'metadata-invalid',
  'selection-unreadable',
  'restore-before-selection',
  'gsi-file-missing',
  'gsi-file-changed',
  'record-unreadable',
  'endpoint-conflict',
  'status-unreadable',
  'access-denied',
  'operation-failed',
];
const cs2Stages = ['status', 'selection', 'install', 'restore'];
const collectionStates = ['available', 'failed', 'timeout'];

const rectangle = {
  type: ['array', 'null'],
  minItems: 4,
  maxItems: 4,
  items: { type: 'integer', minimum: -100000, maximum: 100000 },
};
const windowFailure = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    stage: {
      type: ['string', 'null'],
      enum: [
        'restore',
        'restore_timeout',
        'raise',
        'measure',
        'empty_client',
        'minimized',
        'dpi',
        'frame',
        'position',
        'correction',
        'client_mismatch',
        null,
      ],
    },
    api: {
      type: ['string', 'null'],
      enum: [
        'ShowWindowAsync',
        'SetWindowPos',
        'GetClientRect',
        'ClientToScreen',
        'GetDpiForWindow',
        'AdjustWindowRectExForDpi',
        null,
      ],
    },
    lastError: { type: ['integer', 'null'], minimum: 0, maximum: 4294967295 },
    target: { type: ['string', 'null'], enum: ['left', 'dock', 'game', 'group', null] },
  },
};
const elevation = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    elevated: { type: ['boolean', 'null'] },
    lastError: { type: ['integer', 'null'], minimum: 0, maximum: 4294967295 },
  },
};
const windowGeometryProperties = {
  ...Object.fromEntries(
    ['client', 'outer', 'monitorBounds', 'workArea', 'layoutArea', 'target'].map((key) => [
      key,
      rectangle,
    ]),
  ),
  dpi: { type: ['integer', 'null'], minimum: 1, maximum: 10000 },
  alignmentRetries: { type: 'integer', minimum: 0, maximum: 30 },
  preserveSettings: { type: 'boolean' },
  fullscreenLayout: { type: 'boolean' },
  alignmentFailure: windowFailure,
  groupFailure: windowFailure,
  hostElevation: elevation,
  gameElevation: elevation,
};
function windowGeometry(value: unknown) {
  if (value === null || value === undefined) return null;
  const input = record(value);
  return Object.fromEntries(
    Object.keys(windowGeometryProperties).map((key) => [key, input[key] ?? null]),
  );
}

export function registerSupportRoutes(
  app: FastifyInstance,
  options: {
    readonly originPolicy: LocalWebOriginPolicy;
    readonly logsDirectory?: string;
    readonly artifact?: { readonly gitSha: string; readonly artifactSha256: string };
    readonly runtimeSummary: () => ReturnType<DebugEvidenceStore['getSupportSummary']>;
    readonly flushBusinessLog?: () => Promise<void>;
    readonly businessLogHealth?: () => ReturnType<BusinessJournal['getHealth']>;
    readonly businessLogStatus?: () => 'available' | 'write_failed' | 'not_configured';
    readonly recorder: () => RecorderHealth;
    readonly delivery: () => readonly LatestWinsConsumerHealth[];
    readonly hosts: () => LocalWebHostDiagnostics;
    readonly obs: () => Promise<ObsStatus | undefined>;
    readonly program?: () => ProgramSceneState;
    readonly programContext?: () => {
      contextFreshness: string;
      identity: string;
      binding: string | null;
    };
    readonly gsiConfigured: boolean;
    readonly nativeObs?: () => Promise<ObsNativeEvidence>;
  },
) {
  let exporting = false;
  app.post(
    '/debug/support-bundle',
    {
      bodyLimit: 4096,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            desktop: {
              type: ['object', 'null'],
              additionalProperties: false,
              properties: {
                gsi: {
                  type: ['object', 'null'],
                  additionalProperties: false,
                  properties: {
                    ...Object.fromEntries(
                      [
                        'detected',
                        'installed',
                        'conflict',
                        'fileConflict',
                        'endpointConflict',
                        'readFailed',
                      ].map((key) => [key, { type: 'boolean' }]),
                    ),
                    collectionStatus: { type: 'string', enum: collectionStates },
                    candidateCount: { type: 'integer', minimum: 0, maximum: 10000 },
                    conflictCount: { type: 'integer', minimum: 0, maximum: 10000 },
                    issueCodes: {
                      type: 'array',
                      maxItems: 16,
                      items: { type: 'string', enum: cs2IssueCodes },
                    },
                    lastOperation: {
                      type: ['object', 'null'],
                      additionalProperties: false,
                      required: ['code', 'stage'],
                      properties: {
                        code: { type: 'string', enum: cs2IssueCodes },
                        stage: { type: 'string', enum: cs2Stages },
                      },
                    },
                  },
                },
                cs2: {
                  type: ['object', 'null'],
                  additionalProperties: false,
                  properties: {
                    collectionStatus: { type: 'string', enum: collectionStates },
                    found: { type: 'boolean' },
                    managed: { type: 'boolean' },
                    geometry: {
                      type: ['object', 'null'],
                      additionalProperties: false,
                      properties: windowGeometryProperties,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
      if (
        options.originPolicy.mode !== 'loopback' ||
        !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
      )
        return reply.code(403).send({ error: 'support_origin_forbidden' });
      if (exporting) return reply.code(429).send({ error: 'support_export_busy' });
      exporting = true;
      try {
        await options.flushBusinessLog?.();
        const [logs, obs, nativeObs] = await Promise.all([
          readSupportLogs(options.logsDirectory, 160 * 1024),
          options.obs().catch(() => undefined),
          Promise.resolve()
            .then(() =>
              (
                options.nativeObs ?? (() => collectObsNativeEvidence({ includeRelatedLogs: true }))
              )(),
            )
            .catch(failedObsNativeEvidence),
        ]);
        const { logAttachments: obsLogAttachments = [], ...nativeSummary } = nativeObs;
        const program = options.program?.();
        const context = options.programContext?.();
        const desktop = record(record(request.body).desktop);
        const gsi = record(desktop.gsi);
        const cs2 = record(desktop.cs2);
        const bool = (value: unknown) => (typeof value === 'boolean' ? value : null);
        const recorder = options.recorder();
        const hosts = options.hosts();
        const exportedAt = new Date().toISOString();
        const gitSha = digest(options.artifact?.gitSha, 40);
        const businessHistory = readBusinessHistory(options.logsDirectory);
        const businessHealth = options.businessLogHealth?.();
        const bundle = {
          schema: 'mizar-support-bundle/1',
          businessHistory: {
            ...businessHistory,
            manifest: {
              ...businessHistory.manifest,
              ...businessHealth,
              writeFailures: Math.max(
                businessHistory.manifest.writeFailures,
                businessHealth?.writeFailures ?? 0,
              ),
              committedWriteFailures: businessHistory.manifest.writeFailures,
              committedDroppedPendingEvents: businessHistory.manifest.droppedPendingEvents,
              committedCoalescedEvents: businessHistory.manifest.coalescedEvents,
              uncommittedWriteFailures: Math.max(
                0,
                (businessHealth?.writeFailures ?? 0) - businessHistory.manifest.writeFailures,
              ),
              currentWriteStatus: options.businessLogStatus?.() ?? 'not_configured',
            },
          },
          manifest: {
            exportedAt,
            gitSha,
            artifactSha256: digest(options.artifact?.artifactSha256, 64),
            desktopVersion:
              logs
                .find((log) => log.name === 'desktop.ndjson')
                ?.events.find((event) => event.gitSha === gitSha && event.appVersion !== null)
                ?.appVersion ?? null,
            nodeVersion: process.version,
            os: {
              platform: platform(),
              arch: arch(),
              release: /^\d+(?:\.\d+){0,3}$/.test(release()) ? release() : null,
            },
            limits: {
              bundleBytes: SUPPORT_BUNDLE_MAX_BYTES,
              files: 20,
              eventsPerFile: 32,
              tailBytesPerFile: 65536,
              headerBytesPerFile: 4096,
            },
            logPolicy: 'allowlisted-events; bounded-redacted-error-causes-and-technical-paths',
            sessionPolicy: 'ordinary-log-session-salted; business-identifiers-stable',
          },
          summary: [
            '本文件包含比赛业务 ID、阵容核对所需的 Steam64、队伍与槽位；不含凭据、完整配置或原始遥测。异常可能包含必要技术路径，用户目录名已脱敏。',
            '日志保留阶段、结果、错误码及有界脱敏的异常消息、原因链和堆栈。session 只在本文件内关联。',
            'missing 表示未找到文件，unreadable 表示读取失败；truncated 表示仅包含部分历史，omittedLines 包含未知或超限记录。',
            'desktop 状态来自导出时浏览器调用本机 Host；collectionStatus 区分成功、失败与超时。null 表示未知，不能据此推断 CS2 或 GSI 安装失败。',
            'nativeObs 只读取本机 OBS 配置、近期日志和进程元数据；配置来自已保存文件，不等同于当前节目画面。日志成功不证明当前画面正常，进程时间关联不证明实际 hook PID；缺失或未知均不能判为黑屏根因。',
            'OBS 摘要保留分类故障与最新状态，附件包含扫描范围内全部允许的技术事件与固定操作原因，不是完整 OBS 原日志，不含原始私人正文；scan 标明读取字节和缺失范围，附件 omittedEvents 与时间范围标明附件限额遗漏。',
            '本文件不是 Windows + CS2 + OBS 的真实验收通过证明。',
          ],
          snapshot: {
            nativeObs: nativeSummary,
            program: program
              ? {
                  active: program.active,
                  preparing: program.preparing?.target ?? null,
                  mode: program.director?.mode ?? null,
                  gameplayAvailable: program.available.includes('gameplay'),
                  contextFreshness: choice(context?.contextFreshness, [
                    'unbound',
                    'fresh',
                    'stale',
                  ]),
                  identity: choice(context?.identity, [
                    'unbound',
                    'resolving',
                    'matched',
                    'degraded',
                    'mismatch',
                  ]),
                  binding: choice(context?.binding, ['unbound', 'bound', 'needs_operator']),
                }
              : null,
            runtime: options.runtimeSummary(),
            businessLog: options.businessLogStatus?.() ?? 'not_configured',
            gsi: {
              ingressConfigured: options.gsiConfigured,
              source: 'desktop-host-via-browser',
              detected: bool(gsi.detected),
              installed: bool(gsi.installed),
              conflict: bool(gsi.conflict),
              fileConflict: bool(gsi.fileConflict),
              endpointConflict: bool(gsi.endpointConflict),
              readFailed: bool(gsi.readFailed),
              collectionStatus: choice(gsi.collectionStatus, collectionStates),
              candidateCount:
                typeof gsi.candidateCount === 'number' ? count(gsi.candidateCount) : null,
              conflictCount:
                typeof gsi.conflictCount === 'number' ? count(gsi.conflictCount) : null,
              issueCodes: Array.isArray(gsi.issueCodes)
                ? gsi.issueCodes
                    .map((code) => choice(code, cs2IssueCodes))
                    .filter((code) => code !== null)
                : [],
              lastOperation:
                gsi.lastOperation === null || gsi.lastOperation === undefined
                  ? null
                  : {
                      code: choice(record(gsi.lastOperation).code, cs2IssueCodes),
                      stage: choice(record(gsi.lastOperation).stage, cs2Stages),
                    },
            },
            cs2: {
              source: 'desktop-host-via-browser',
              collectionStatus: choice(cs2.collectionStatus, collectionStates),
              found: bool(cs2.found),
              managed: bool(cs2.managed),
              geometry: windowGeometry(cs2.geometry),
            },
            obs:
              obs === undefined
                ? null
                : {
                    connection: choice(obs.connection, [
                      'connected',
                      'unavailable',
                      'password_required',
                      'invalid_password',
                    ]),
                    streaming: bool(obs.streaming),
                    recording: bool(obs.recording),
                    connectionFailure: obs.connectionFailure ?? null,
                    currentScene:
                      PROGRAM_SCENES.find((scene) => obsSceneName(scene.id) === obs.currentScene)
                        ?.id ?? null,
                    sceneAligned:
                      program && obs.connection === 'connected'
                        ? obs.currentScene === obsSceneName(program.active)
                        : null,
                    programEvidence: obs.programEvidence ?? null,
                    findings: obs.findings
                      .slice(0, 32)
                      .map(({ code }) => choice(code, findingCodes) ?? 'unknown_finding'),
                  },
            browserHosts: {
              active: {
                obs: count(hosts.active.obs),
                browser: count(hosts.active.browser),
                unknown: count(hosts.active.unknown),
              },
              totals: {
                connected: count(hosts.totals.connected),
                disconnected: count(hosts.totals.disconnected),
                connectionLimitRejected: count(hosts.totals.connectionLimitRejected),
                slowConsumerTerminated: count(hosts.totals.slowConsumerTerminated),
              },
            },
            recorder: {
              state: choice(recorder.state, [
                'recording',
                'degraded',
                'failed',
                'finalizing',
                'closed',
              ]),
              pendingFrames: count(recorder.pendingFrames),
              pendingBytes: count(recorder.pendingBytes),
              frameCount: count(recorder.frameCount),
              droppedFrames: count(recorder.droppedFrames),
              incomplete: bool(recorder.incomplete),
              lastErrorCode: choice(recorder.lastErrorCode, recorderCodes),
            },
            delivery: options
              .delivery()
              .slice(0, 32)
              .map((item) => ({
                state: choice(item.state, ['idle', 'sending', 'closing', 'closed']),
                inFlight: bool(item.inFlight),
                hasPendingLatest: bool(item.hasPendingLatest),
                offered: count(item.offered),
                sent: count(item.sent),
                coalesced: count(item.coalesced),
                failed: count(item.failed),
              })),
          },
          logs,
          attachments: { obsLogs: obsLogAttachments },
        };
        const json = JSON.stringify(bundle, null, 2);
        if (Buffer.byteLength(json) > SUPPORT_BUNDLE_MAX_BYTES)
          throw new Error('support_bundle_limit');
        return reply
          .type('application/json; charset=utf-8')
          .header(
            'content-disposition',
            `attachment; filename="mizar-support-${exportedAt.replaceAll(':', '-')}.json"`,
          )
          .send(json);
      } catch {
        return reply.code(503).send({
          error: 'support_export_unavailable',
          message: '诊断包暂时无法生成，请稍后重试。',
        });
      } finally {
        exporting = false;
      }
    },
  );
}
