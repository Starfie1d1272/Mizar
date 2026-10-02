import type { FastifyInstance } from 'fastify';
import { arch, platform, release } from 'node:os';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { LocalWebHostDiagnostics } from '../local-web/websocket-transport.js';
import type { ObsStatus } from '../obs/adapter.js';
import type { DebugEvidenceStore } from '../runtime/debug-state.js';
import type { LatestWinsConsumerHealth } from '../runtime/latest-wins.js';
import type { RecorderHealth } from '../telemetry/capture-recorder.js';
import { choice, count, digest, readSupportLogs, record } from './logs.js';

export const SUPPORT_BUNDLE_MAX_BYTES = 256 * 1024;
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

export function registerSupportRoutes(
  app: FastifyInstance,
  options: {
    readonly originPolicy: LocalWebOriginPolicy;
    readonly logsDirectory?: string;
    readonly artifact?: { readonly gitSha: string; readonly artifactSha256: string };
    readonly runtimeSummary: () => ReturnType<DebugEvidenceStore['getSupportSummary']>;
    readonly recorder: () => RecorderHealth;
    readonly delivery: () => readonly LatestWinsConsumerHealth[];
    readonly hosts: () => LocalWebHostDiagnostics;
    readonly obs: () => Promise<ObsStatus | undefined>;
    readonly gsiConfigured: boolean;
  },
) {
  let exporting = false;
  app.post(
    '/debug/support-bundle',
    {
      bodyLimit: 2048,
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
                  properties: Object.fromEntries(
                    ['detected', 'installed', 'conflict', 'fileConflict', 'endpointConflict'].map(
                      (key) => [key, { type: 'boolean' }],
                    ),
                  ),
                },
                cs2: {
                  type: ['object', 'null'],
                  additionalProperties: false,
                  properties: {
                    found: { type: 'boolean' },
                    managed: { type: 'boolean' },
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
        const logs = await readSupportLogs(options.logsDirectory);
        const obs = await options.obs().catch(() => undefined);
        const desktop = record(record(request.body).desktop);
        const gsi = record(desktop.gsi);
        const cs2 = record(desktop.cs2);
        const bool = (value: unknown) => (typeof value === 'boolean' ? value : null);
        const recorder = options.recorder();
        const hosts = options.hosts();
        const exportedAt = new Date().toISOString();
        const gitSha = digest(options.artifact?.gitSha, 40);
        const bundle = {
          schema: 'mizar-support-bundle/1',
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
              files: 16,
              eventsPerFile: 32,
              tailBytesPerFile: 65536,
              headerBytesPerFile: 4096,
            },
            logPolicy: 'allowlisted-events-only; free-text-errors-stay-local',
            sessionPolicy: 'salted-per-export-sha256',
          },
          summary: [
            '本文件是有界诊断摘要，可用于提交 Mizar 问题；不包含原始遥测、选手资料、凭据、主机名或本地路径。',
            '日志保留启动阶段、结果与数值错误码；原始错误文本仅留在本机。session 只在本文件内关联。',
            'missing 表示未找到文件，unreadable 表示读取失败；truncated 表示仅包含部分历史，omittedLines 包含未知或超限记录。',
            'desktop 状态来自导出时浏览器调用本机 Host；null 表示不可用，不能据此推断 CS2 或 GSI 安装失败。',
            '本文件不是 Windows + CS2 + OBS 的真实验收通过证明。',
          ],
          snapshot: {
            runtime: options.runtimeSummary(),
            gsi: {
              ingressConfigured: options.gsiConfigured,
              source: 'desktop-host-via-browser',
              detected: bool(gsi.detected),
              installed: bool(gsi.installed),
              conflict: bool(gsi.conflict),
              fileConflict: bool(gsi.fileConflict),
              endpointConflict: bool(gsi.endpointConflict),
            },
            cs2: {
              source: 'desktop-host-via-browser',
              found: bool(cs2.found),
              managed: bool(cs2.managed),
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
