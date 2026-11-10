import type { ObsRpc } from './reconcile.js';

/** Resolve a safe desktop monitoring route, not only physical device equality.
 * Unknown also covers unsupported monitor-only semantics. Default selectors
 * cannot be resolved to explicit Windows endpoints through obs-websocket. */
export async function desktopMonitorRelationship(
  obs: ObsRpc,
  desktopUuid: string,
): Promise<'same' | 'different' | 'unknown'> {
  const [source, defaults, profile] = await Promise.all([
    obs.call('GetInputSettings', { inputUuid: desktopUuid }),
    obs.call('GetInputDefaultSettings', { inputKind: 'wasapi_output_capture' }),
    obs.call('GetProfileParameter', {
      parameterCategory: 'Audio',
      parameterName: 'MonitoringDeviceId',
    }),
  ]);
  const settings = source.inputSettings as Record<string, unknown> | undefined;
  const defaultSettings = defaults.defaultInputSettings as Record<string, unknown> | undefined;
  const capture = settings?.device_id ?? defaultSettings?.device_id;
  const monitor = profile.parameterValue;
  if (typeof capture !== 'string' || !capture || typeof monitor !== 'string' || !monitor)
    return 'unknown';
  if (capture.toLowerCase() === monitor.toLowerCase()) {
    // OBS 33 removed monitor-only output suppression. The legacy RPC now enables
    // monitoring AND direct output, so desktop recapture would duplicate music.
    const version = (await obs.call('GetVersion')).obsVersion;
    const major = typeof version === 'string' ? /^(\d+)\./.exec(version)?.[1] : undefined;
    return major && Number(major) > 0 && Number(major) < 33 ? 'same' : 'unknown';
  }
  if (capture.toLowerCase() === 'default' || monitor.toLowerCase() === 'default') return 'unknown';
  return 'different';
}
