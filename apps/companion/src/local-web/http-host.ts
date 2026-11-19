import Fastify from 'fastify';
import type { DebugRuntimeClock } from '../runtime/debug-state.js';
import type { ProductRuntime } from '../runtime/product-runtime.js';
import { PerformanceWindow } from '../support/performance-window.js';
import { SessionJournal } from '../support/session-journal.js';
import { GSI_REQUEST_TIMEOUT_MS } from '../telemetry/gsi-ingress.js';

export function createLocalHttpHost(options: {
  logger: boolean | undefined;
  supportJournal: SessionJournal | undefined;
  supportLogsDirectory: string | undefined;
  product: ProductRuntime | undefined;
  debugClock: DebugRuntimeClock;
}) {
  const sessionJournal =
    options.supportJournal ??
    (options.supportLogsDirectory
      ? new SessionJournal(options.supportLogsDirectory, {
          appVersion: options.product?.appVersion ?? null,
          gitSha: options.product?.gitSha ?? null,
          artifactSha256: options.product?.artifactSha256 ?? null,
        })
      : undefined);
  const app = Fastify({
    logger: sessionJournal
      ? {
          stream: {
            write: (line: string) => {
              sessionJournal.write(line);
              if (options.logger) process.stdout.write(line);
            },
          },
        }
      : (options.logger ?? false),
    logController: new Fastify.LogController({ disableRequestLogging: true }),
    requestTimeout: GSI_REQUEST_TIMEOUT_MS,
  });
  const performanceContext = sessionJournal
    ? new PerformanceWindow(
        sessionJournal,
        () => options.debugClock.nowMonotonicMs(),
        options.supportLogsDirectory,
      )
    : undefined;
  return { app, sessionJournal, performanceContext };
}
