import type { LiveSnapshotV1, ReliableEventV2 } from '@mizar/protocol/output';

import type { ReliableDeliveryResult, ReliableEventSink } from './reliable-delivery.js';
import type { LiveSnapshotConsumer } from './service.js';

export interface HttpOutputConfig {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

function validateConfig(config: HttpOutputConfig): { url: URL; timeoutMs: number } {
  const url = new URL(config.url);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    !config.token.trim() ||
    /[\r\n]/.test(config.token)
  )
    throw new Error('http_output_config_invalid');
  const timeoutMs = config.timeoutMs ?? 4_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 4_000)
    throw new Error('http_output_timeout_invalid');
  return { url, timeoutMs };
}

export function createHttpReliableSink(config: HttpOutputConfig): ReliableEventSink {
  const { url, timeoutMs } = validateConfig(config);
  return {
    send: async (event: ReliableEventV2, signal?: AbortSignal): Promise<ReliableDeliveryResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref();
      try {
        const response = await (config.fetch ?? fetch)(url, {
          method: 'POST',
          redirect: 'manual',
          signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          headers: {
            authorization: `Bearer ${config.token}`,
            'content-type': 'application/json',
            'x-rivalhub-authority': String(event.session.authorityRevision),
          },
          body: JSON.stringify(event),
        });
        if (signal?.aborted || controller.signal.aborted)
          return { status: 'retry', error: 'timeout' };
        if (response.ok) {
          let body: Record<string, unknown> | undefined;
          try {
            const parsed = (await response.json()) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
              body = parsed as Record<string, unknown>;
          } catch {
            // Empty or non-JSON 200 body is still accepted.
          }
          return {
            status: 'accepted',
            ...(body?.outcome === 'needs_attention' ? { outcome: 'needs_attention' as const } : {}),
            ...(typeof body?.warning === 'string' && body.warning ? { warning: body.warning } : {}),
          };
        }
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 408 || response.status === 429 || response.status >= 500)
          return { status: 'retry', error: `http_${response.status}` };
        return { status: 'rejected', error: `http_${response.status}` };
      } catch (error) {
        return { status: 'retry', error: error instanceof Error ? error.message : 'network_error' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Failed snapshots are dropped; the OutputService lane offers only the latest next value. */
export function createHttpLiveSink(config: HttpOutputConfig): LiveSnapshotConsumer {
  const { url, timeoutMs } = validateConfig(config);
  return {
    send: async (snapshot: LiveSnapshotV1) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref();
      try {
        const response = await (config.fetch ?? fetch)(url, {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${config.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(snapshot),
        });
        await response.body?.cancel().catch(() => undefined);
        if (!response.ok) throw new Error('snapshot_http_delivery_failed');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function configuredHttpOutputs(env: NodeJS.ProcessEnv): {
  readonly reliableSink?: ReliableEventSink;
  readonly liveSink?: LiveSnapshotConsumer;
} {
  const liveUrl = env.MIZAR_LIVE_OUTPUT_URL;
  const reliableUrl = env.MIZAR_RELIABLE_OUTPUT_URL;
  const token = env.MIZAR_OUTPUT_TOKEN;
  if (liveUrl === undefined && reliableUrl === undefined && token === undefined) return {};
  if (token === undefined || (liveUrl === undefined && reliableUrl === undefined))
    throw new Error('http_output_config_incomplete');
  return {
    ...(liveUrl === undefined ? {} : { liveSink: createHttpLiveSink({ url: liveUrl, token }) }),
    ...(reliableUrl === undefined
      ? {}
      : { reliableSink: createHttpReliableSink({ url: reliableUrl, token }) }),
  };
}
