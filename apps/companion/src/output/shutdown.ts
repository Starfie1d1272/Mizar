import type { RivalHubConnection } from '../match-context/rivalhub-connection.js';
import type { OutputService } from './service.js';

export async function closeWebsiteOutput(
  connection: Pick<RivalHubConnection, 'shutdownSource' | 'closeSourceState'> | undefined,
  output: Pick<OutputService, 'close'>,
  onRemoteFailure: (error: unknown) => void,
): Promise<void> {
  if (connection?.shutdownSource) {
    const remote = new AbortController();
    const timeout = new Error('数据源远端收尾超时');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connection.shutdownSource(remote.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            remote.abort(timeout);
            reject(timeout);
          }, 9000);
        }),
      ]);
    } catch (error) {
      onRemoteFailure(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Both local writers must close even if one reports a failure.
  const local = await Promise.allSettled([
    Promise.resolve().then(() => connection?.closeSourceState?.()),
    Promise.resolve().then(() => output.close()),
  ]);
  const failures = local.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length) throw new AggregateError(failures, 'website_local_shutdown_failed');
}
