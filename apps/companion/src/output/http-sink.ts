import type { LiveSnapshotV1, ReliableEventV1 } from '@mizar/protocol/output';

import type { ReliableDeliveryResult, ReliableEventSink } from './reliable-outbox.js';
import type { LiveSnapshotConsumer } from './service.js';

export interface HttpOutputConfig {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

function transport(config: HttpOutputConfig) {
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
  return async (
    payload: LiveSnapshotV1 | ReliableEventV1,
    key?: string,
    signal?: AbortSignal,
  ): Promise<ReliableDeliveryResult> => {
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
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
        body: JSON.stringify(payload),
      });
      await response.body?.cancel();
      if (signal?.aborted || controller.signal.aborted) return 'retry';
      if (response.ok) return 'accepted';
      if (response.status === 408 || response.status === 429 || response.status >= 500)
        return 'retry';
      return 'rejected';
    } catch {
      return 'retry';
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createHttpReliableSink(config: HttpOutputConfig): ReliableEventSink {
  const post = transport(config);
  return { send: (event, signal) => post(event, event.idempotencyKey, signal) };
}

/** Failed snapshots are dropped; the OutputService lane offers only the latest next value. */
export function createHttpLiveSink(config: HttpOutputConfig): LiveSnapshotConsumer {
  const post = transport(config);
  return {
    send: async (snapshot) => {
      if ((await post(snapshot)) !== 'accepted') throw new Error('snapshot_http_delivery_failed');
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
