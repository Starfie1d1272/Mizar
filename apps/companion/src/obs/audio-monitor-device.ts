import type { ObsRpc } from './reconcile.js';

/** The desktop host refreshes this value through its private runtime capability. */
export class DefaultRenderDevice {
  private value: string | null = null;
  private until = 0;
  constructor(private readonly now = Date.now) {}
  update(value: string | null) {
    this.value = value;
    this.until = this.now() + 6000;
  }
  current() {
    return this.now() < this.until ? this.value : null;
  }
}

/** Compare OBS selectors; unresolved defaults remain unknown. */
export async function desktopMonitorRelationship(
  obs: ObsRpc,
  desktopUuid: string,
  defaultRender?: string | null,
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
  const captureId = capture.toLowerCase();
  const monitorId = monitor.toLowerCase();
  if (captureId === monitorId) return 'same';
  if (captureId === 'default' || monitorId === 'default') {
    if (!defaultRender) return 'unknown';
    const resolved = defaultRender.toLowerCase();
    return (captureId === 'default' ? resolved : captureId) ===
      (monitorId === 'default' ? resolved : monitorId)
      ? 'same'
      : 'different';
  }
  return 'different';
}
