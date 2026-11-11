import type { ObsRpc } from './reconcile.js';

/** Resolve a safe desktop monitoring route, not only physical device equality.
 * Unknown also covers unsupported monitor-only semantics. Default selectors
 * cannot be resolved to explicit Windows endpoints through obs-websocket. */
export async function desktopMonitorRelationship(
  obs: ObsRpc,
  desktopUuid: string,
  nextDeviceId?: string,
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
  const capture = nextDeviceId ?? settings?.device_id ?? defaultSettings?.device_id;
  const monitor = profile.parameterValue;
  if (typeof capture !== 'string' || !capture || typeof monitor !== 'string' || !monitor)
    return 'unknown';
  if (capture.toLowerCase() === 'default' || monitor.toLowerCase() === 'default') return 'unknown';
  if (capture.toLowerCase() === monitor.toLowerCase()) {
    // OBS 33 removed monitor-only output suppression. The legacy RPC now enables
    // monitoring AND direct output, so desktop recapture would duplicate music.
    const version = (await obs.call('GetVersion')).obsVersion;
    const major = typeof version === 'string' ? /^(\d+)\./.exec(version)?.[1] : undefined;
    return major && Number(major) > 0 && Number(major) < 33 ? 'same' : 'unknown';
  }
  return 'different';
}

/** A device-only edit must preserve each audible monitoring path, without restoring music state. */
export async function assertDesktopDeviceRoute(
  obs: ObsRpc,
  desktopUuid: string,
  nextDeviceId: string,
) {
  const relationship = await desktopMonitorRelationship(obs, desktopUuid, nextDeviceId);
  const inputs = (await obs.call('GetInputList')).inputs;
  if (!Array.isArray(inputs)) throw new Error('audio_device_monitor_unknown');
  for (const input of inputs as Record<string, unknown>[]) {
    if (typeof input.inputUuid !== 'string' || typeof input.inputKind !== 'string')
      throw new Error('audio_device_monitor_unknown');
    if (['game_capture', 'window_capture'].includes(input.inputKind)) {
      const settings = (await obs.call('GetInputSettings', { inputUuid: input.inputUuid }))
        .inputSettings as Record<string, unknown> | undefined;
      if (settings?.capture_audio === false) continue;
    }
    let monitor: unknown;
    try {
      monitor = (await obs.call('GetInputAudioMonitorType', { inputUuid: input.inputUuid }))
        .monitorType;
    } catch (error) {
      // OBS reports non-audio inputs with this exact response. Other 604 errors
      // and unknown plugin/transport failures do not establish a safe route.
      if (
        error instanceof Error &&
        (error as Error & { code?: number }).code === 604 &&
        error.message === 'The specified input does not support audio.'
      )
        continue;
      throw Object.assign(new Error('audio_device_monitor_unknown', { cause: error }), {
        stage: 'GetInputAudioMonitorType',
        inputKind: input.inputKind,
      });
    }
    if (monitor === 'OBS_MONITORING_TYPE_NONE') continue;
    if (monitor === 'OBS_MONITORING_TYPE_MONITOR_ONLY' && relationship === 'same') continue;
    if (monitor === 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' && relationship === 'different')
      continue;
    throw Object.assign(new Error('audio_device_monitor_conflict'), {
      stage: 'GetInputAudioMonitorType',
      inputKind: input.inputKind,
      monitor,
    });
  }
}
