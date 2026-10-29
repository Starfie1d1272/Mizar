import { DIAGNOSTIC_CONSENT_REVISION } from '@mizar/protocol/version';
import type { FastifyInstance } from 'fastify';
import { DiagnosticDelivery, type RetainedDiagnosticBatch } from './delivery.js';
import { diagnosticValue, type SessionJournal } from './session-journal.js';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import { fullLogArchive } from './archive.js';
import { IncidentStore } from './incident-store.js';

export function registerDiagnosticDelivery(
  app: FastifyInstance,
  options: {
    directory?: string;
    journal?: SessionJournal;
    originPolicy: LocalWebOriginPolicy;
    endpoint?: string;
    fetch?: typeof fetch;
    onReport?: (report: { category: string; observedAt: string }) => void;
  },
) {
  let delivery: DiagnosticDelivery | undefined;
  let failure: string | null = null;
  let ready = false;
  let closing = false;
  let initializing = Promise.resolve();
  const incidents = options.directory ? new IncidentStore(options.directory) : undefined;
  const status = () => ({
    available: ready,
    error: failure,
    ...(delivery?.status() ?? {
      configured: false,
      consent: false,
      queuedBatches: 0,
      queuedBytes: 0,
      acknowledged: 0,
      deletionPending: 0,
    }),
  });
  app.addHook('onReady', () => {
    if (!options.directory || !options.journal) {
      failure = 'not_configured';
      return;
    }
    const directory = options.directory;
    const journal = options.journal;
    // Diagnostics initialization never holds service readiness or live controls.
    initializing = (async () => {
      try {
        delivery = new DiagnosticDelivery(directory, journal, {
          ...(options.endpoint ? { endpoint: options.endpoint } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        await delivery.initialize();
        ready = true;
      } catch (error) {
        failure = 'local_queue_unavailable';
        journal.record('diagnostic_delivery_failure', {
          phase: 'initialize',
          error: diagnosticValue(error),
        });
      }
    })();
  });
  app.addHook('onRequest', async (request, reply) => {
    if (
      ![
        '/local/v1/diagnostics/delivery',
        '/operator/diagnostics/consent',
        '/operator/diagnostics/report',
        '/operator/diagnostics/pause',
      ].includes(request.url.split('?')[0]!)
    )
      return;
    if (
      request.method === 'GET' &&
      request.headers.origin === undefined &&
      request.headers['sec-fetch-site'] === 'same-origin' &&
      options.originPolicy.mode === 'loopback'
    )
      return;
    if (
      options.originPolicy.mode !== 'loopback' ||
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
    )
      return reply.code(403).send({ message: '诊断设置仅允许本机 Mizar 页面操作。' });
  });
  app.get('/local/v1/diagnostics/delivery', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(status()),
  );
  app.post('/operator/diagnostics/consent', { bodyLimit: 1024 }, async (request, reply) => {
    const body = request.body as { enabled?: unknown; revision?: unknown } | null;
    if (
      !body ||
      typeof body.enabled !== 'boolean' ||
      (body.revision !== DIAGNOSTIC_CONSENT_REVISION &&
        (body.enabled || body.revision !== 'technical-diagnostics-v1'))
    )
      return reply.code(400).send({ message: '请先阅读技术诊断回传说明。' });
    if (!ready || !delivery)
      return reply.code(503).send({ message: '诊断待传队列尚不可用；当前不会回传。' });
    if (body.enabled && !delivery.status().configured)
      return reply.code(503).send({ message: '自动发送诊断暂不可用，仍可导出本机诊断报告。' });
    try {
      return await delivery.consent(body.enabled);
    } catch (error) {
      options.journal?.record('diagnostic_delivery_failure', {
        phase: 'consent',
        error: diagnosticValue(error),
      });
      return reply.code(503).send({ message: '设置未能持久保存，请检查本机状态目录后重试。' });
    }
  });
  app.post('/operator/diagnostics/pause', { bodyLimit: 1024 }, async (request, reply) => {
    const body = request.body as { paused?: unknown } | null;
    if (!body || typeof body.paused !== 'boolean')
      return reply.code(400).send({ message: '暂停设置无效。' });
    if (!ready || !delivery) return reply.code(503).send({ message: '诊断待传队列尚不可用。' });
    try {
      return await delivery.pause(body.paused);
    } catch (error) {
      options.journal?.record('diagnostic_delivery_failure', {
        phase: 'pause',
        error: diagnosticValue(error),
      });
      return reply.code(503).send({ message: '暂停设置未能持久保存。' });
    }
  });
  app.post('/operator/diagnostics/report', { bodyLimit: 1024 }, async (request, reply) => {
    const body = request.body as { category?: unknown; observedAt?: unknown } | null;
    if (
      !body ||
      typeof body.category !== 'string' ||
      !['hud', 'music', 'workspace', 'recovery', 'other'].includes(body.category) ||
      typeof body.observedAt !== 'string'
    )
      return reply.code(400).send({ message: '请选择问题类型和发生时间。' });
    const time = Date.parse(body.observedAt);
    if (!Number.isFinite(time) || time > Date.now() + 60_000 || time < Date.now() - 24 * 3600_000)
      return reply.code(400).send({ message: '请选择过去一天内的问题发生时间。' });
    const report = { category: body.category, observedAt: new Date(time).toISOString() };
    if (!options.journal)
      return reply.code(503).send({ message: '本机诊断记录不可用，问题时间尚未保存。' });
    if (closing) return reply.code(503).send({ message: '本机诊断正在关闭，问题时间尚未保存。' });
    try {
      const sequence = await options.journal.recordCommitted('problem_report', {
        ...report,
        trigger: 'user',
        upload: delivery?.status().consent ? 'queued_when_capacity_available' : 'local_only',
      });
      options.onReport?.(report);
      await options.journal.flush();
      if (!incidents) throw new Error('incident_directory_unavailable');
      const incident = await incidents.capture(async () => ({
        schema: 'mizar-incident/1',
        capturedAt: new Date().toISOString(),
        report: { ...report, sequence },
        files: (await fullLogArchive(options.directory, {}, [], { includeIncidents: false })).files,
      }));
      return {
        recorded: true,
        evidenceRetained: true,
        incident,
        sequence,
        ...report,
        cloud: delivery?.status() ?? null,
      };
    } catch (error) {
      request.log.error(
        { phase: 'problem_report', error: diagnosticValue(error) },
        'Problem marker was not committed',
      );
      return reply
        .code(503)
        .send({ message: '问题现场未确认完整保存；请立即导出诊断包，并检查本机状态目录和空间。' });
    }
  });
  return {
    status,
    snapshotStatus: () => ({
      available: ready,
      error: ready ? (delivery?.status().error ?? null) : failure,
      delivery: ready ? (delivery?.status() ?? null) : null,
    }),
    async retainedBatches(): Promise<RetainedDiagnosticBatch[]> {
      await initializing;
      if (!options.directory) return [];
      if (!ready || !delivery)
        return [{ id: null, sourceBytes: 0, error: failure ?? 'queue_not_ready' }];
      return delivery.retainedBatches();
    },
    async close() {
      closing = true;
      ready = false;
      await initializing;
      await delivery?.close();
    },
  };
}
