import type { ObsRpc } from './reconcile.js';

/** Compare OBS device selectors. A default selector cannot be resolved to an
 * explicit Windows endpoint by obs-websocket, so that case remains unknown. */
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
  if (capture.toLowerCase() === monitor.toLowerCase()) return 'same';
  if (capture.toLowerCase() === 'default' || monitor.toLowerCase() === 'default') return 'unknown';
  return 'different';
}
