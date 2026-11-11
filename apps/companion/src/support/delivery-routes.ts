import {
  IncidentPinCoordinator,
  hostIncidentParticipant,
  type IncidentParticipant,
} from './retention.js';
import { DIAGNOSTIC_CONSENT_REVISION } from '@mizar/protocol/version';
import type { FastifyInstance } from 'fastify';
import { DiagnosticDelivery } from './delivery.js';
import { diagnosticValue, type SessionJournal } from './session-journal.js';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';

export function registerDiagnosticDelivery(
  app: FastifyInstance,
  options: {
    directory?: string;
    journal?: SessionJournal;
    originPolicy: LocalWebOriginPolicy;
    endpoint?: string;
    endpointSource?: 'product_default' | 'environment_override';
    fetch?: typeof fetch;
    onConsent?: () => Promise<void>;
    incidentParticipants?: () => IncidentParticipant[];
    deliveryParticipants?: () => IncidentParticipant[];
    onReport?: (report: { category: string; observedAt: string }) => void;
  },
) {
  const incidentPins = options.directory
    ? new IncidentPinCoordinator(options.directory)
    : undefined;
  const participants = (hostPinId?: string) => [
    ...(options.incidentParticipants?.() ?? []),
    ...(hostPinId && options.directory
      ? [hostIncidentParticipant(options.directory, hostPinId)]
      : []),
  ];
  let delivery: DiagnosticDelivery | undefined;
  let failure: string | null = null;
  let ready = false;
  let closing = false;
  let initializing = Promise.resolve();
  const status = () => ({
    available: ready,
    ...(delivery?.status() ?? {
      configured: false,
      consent: false,
      queuedBatches: 0,
      queuedBytes: 0,
      acknowledged: 0,
      deletionPending: 0,
    }),
    error: failure ?? delivery?.status().error ?? null,
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
        await incidentPins?.recover(participants(), (pinId) => [
          hostIncidentParticipant(directory, pinId),
        ]);
      } catch (error) {
        journal.record('problem_report_pin_failure', {
          phase: 'recover',
          error: diagnosticValue(error),
        });
      }
      try {
        delivery = new DiagnosticDelivery(directory, journal, {
          ...(options.endpoint ? { endpoint: options.endpoint } : {}),
          ...(options.endpointSource ? { endpointSource: options.endpointSource } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.onConsent ? { onConsent: options.onConsent } : {}),
          participants: options.deliveryParticipants ?? (() => [journal.deliveryParticipant()]),
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
        '/operator/diagnostics/report/confirm',
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
    const body = request.body as {
      category?: unknown;
      observedAt?: unknown;
      hostPinId?: unknown;
    } | null;
    if (
      !body ||
      typeof body.category !== 'string' ||
      !['hud', 'music', 'workspace', 'recovery', 'other'].includes(body.category) ||
      typeof body.observedAt !== 'string' ||
      (body.hostPinId !== undefined &&
        (typeof body.hostPinId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.hostPinId)))
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
      let after = options.onReport ? 'sampling' : 'unknown';
      try {
        options.onReport?.(report);
      } catch (error) {
        after = 'unavailable';
        options.journal.record('problem_report_sampling_failure', {
          sequence,
          error: diagnosticValue(error),
        });
      }
      let pinned: {
        evidenceRetained: boolean;
        pinId: string | null;
        requiresHostCommit?: boolean;
        reason: string;
      } = { evidenceRetained: false, pinId: null, reason: 'pin_coordinator_unavailable' };
      if (incidentPins) {
        try {
          pinned = await incidentPins.capture(
            { ...report, eventId: `${options.journal.sessionId}:${sequence}` },
            participants(body.hostPinId as string | undefined),
            [
              'companion',
              'performance',
              ...(options.journal.hostStartupSessionId || body.hostPinId ? ['host'] : []),
            ],
            body.hostPinId as string | undefined,
          );
        } catch (error) {
          options.journal.record('problem_report_pin_failure', {
            sequence,
            error: diagnosticValue(error),
          });
        }
      }
      return {
        recorded: true,
        ...pinned,
        evidenceRetained: pinned.evidenceRetained,
        retention: pinned.evidenceRetained ? 'fixed' : 'unfixed',
        message: pinned.evidenceRetained
          ? '标记及已提交现场证据已固定；后续采样仍在进行。'
          : '标记已记录，现场证据未完整固定；请立即导出诊断包。',
        nextAction: 'export',
        coverage: {
          before: pinned.evidenceRetained ? 'fixed' : 'unfixed',
          after,
          producerPins: pinned.evidenceRetained ? 'confirmed' : 'unconfirmed',
        },
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
  app.post('/operator/diagnostics/report/confirm', { bodyLimit: 1024 }, async (request, reply) => {
    const body = request.body as { pinId?: unknown } | null;
    if (!body || typeof body.pinId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.pinId))
      return reply.code(400).send({ message: '现场标记编号无效。' });
    if (!incidentPins || closing)
      return reply.code(503).send({ message: '现场证据固定结果尚未确认，请立即导出诊断包。' });
    try {
      const result = await incidentPins.confirm(body.pinId, participants(body.pinId));
      options.journal?.record('problem_report_pin_result', {
        pinId: body.pinId,
        result: result.evidenceRetained ? 'success' : 'unconfirmed',
      });
      return {
        ...result,
        message: result.evidenceRetained
          ? '已提交的现场证据已固定；后续采样仍在进行。'
          : '标记已记录，现场证据未完整固定；请立即导出诊断包。',
      };
    } catch (error) {
      options.journal?.record('problem_report_pin_failure', {
        pinId: body.pinId,
        error: diagnosticValue(error),
      });
      return reply.code(503).send({ message: '现场证据固定结果尚未确认，请立即导出诊断包。' });
    }
  });
  return {
    status,
    snapshotStatus: () => ({
      available: ready,
      error: ready ? (delivery?.status().error ?? null) : failure,
      delivery: ready ? (delivery?.status() ?? null) : null,
    }),
    async close() {
      closing = true;
      ready = false;
      await initializing;
      await delivery?.close();
    },
  };
}
