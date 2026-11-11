/** Only known Windows endpoint selectors enter diagnostics; arbitrary settings are not exported. */
export function audioDeviceSelector(value: unknown) {
  if (typeof value !== 'string' || !value) return { kind: 'unknown', value: null } as const;
  if (value.toLowerCase() === 'default') return { kind: 'default', value: 'default' } as const;
  if (/^\{0\.0\.[01]\.00000000\}\.\{[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}$/i.test(value))
    return { kind: 'endpoint', value: value.toLowerCase() } as const;
  return { kind: 'other', value: null } as const;
}

export function audioSourceUuid(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

export function effectiveAudioSetting(
  settings: Record<string, unknown>,
  defaults: Record<string, unknown>,
  key: 'device_id' | 'use_device_timing',
) {
  // An explicitly present malformed value must not be replaced with a reassuring default.
  if (Object.hasOwn(settings, key)) return { value: settings[key], source: 'explicit' } as const;
  if (Object.hasOwn(defaults, key)) return { value: defaults[key], source: 'obs_default' } as const;
  return { value: undefined, source: 'unknown' } as const;
}

export function audioSourceRole(value: unknown) {
  const roles = {
    麦克风: 'microphone',
    桌面声音: 'desktop',
    游戏声音: 'game',
    其他解说: 'commentary',
    音乐: 'music',
    音效: 'effect',
  } as const;
  return typeof value === 'string' && Object.hasOwn(roles, value)
    ? roles[value as keyof typeof roles]
    : 'other';
}

/** Error bodies may contain settings or credentials; export only known reasons and RPC codes. */
export function audioDiagnosticReadFailure(error: unknown) {
  const value = error as { code?: unknown; message?: unknown; name?: unknown } | null;
  const reasons = [
    'audio_devices_owner_missing',
    'audio_devices_owner_changed',
    'audio_devices_changed',
    'obs_observation_changed',
    'obs_operation_cancelled',
    'collection_ownership_unknown',
    'ECONNREFUSED',
    'ECONNRESET',
  ];
  const reason = reasons.find((reason) => value?.code === reason || value?.message === reason);
  return {
    status: 'unavailable' as const,
    reason:
      reason ??
      (value?.name === 'ZodError'
        ? 'invalid_response'
        : typeof value?.message === 'string' && /timeout|timed out|超时/i.test(value.message)
          ? 'timeout'
          : 'obs_audio_read_failed'),
    rpcCode:
      typeof value?.code === 'number' &&
      Number.isSafeInteger(value.code) &&
      value.code >= 0 &&
      value.code <= 65535
        ? value.code
        : null,
  };
}
