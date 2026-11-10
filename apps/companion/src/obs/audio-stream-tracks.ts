import type { ObsRpc } from './reconcile.js';

/** OBS's configured live mix, not recording/VOD tracks or proof of audible output.
 * Unsupported services remain unknown; never change the user's track assignment.
 */
export async function configuredStreamTracks(obs: ObsRpc): Promise<number[] | null> {
  const parameter = async (category: string, name: string) => {
    const response = await obs.call('GetProfileParameter', {
      parameterCategory: category,
      parameterName: name,
    });
    return response.parameterValue ?? response.defaultParameterValue;
  };
  const profile = (await obs.call('GetProfileList')).currentProfileName;
  if (typeof profile !== 'string' || !profile) return null;
  const mode = await parameter('Output', 'Mode');
  let tracks: number[] | null = null;
  if (mode === 'Simple') tracks = [1];
  else if (mode === 'Advanced') {
    // Do not retain/log service settings: they can contain the streaming key.
    const service = await obs.call('GetStreamServiceSettings');
    const settings = service.streamServiceSettings as Record<string, unknown> | undefined;
    const server = settings?.server;
    const protocol =
      service.streamServiceType === 'rtmp_common'
        ? typeof settings?.protocol === 'string'
          ? settings.protocol.toLowerCase()
          : 'rtmp'
        : service.streamServiceType === 'rtmp_custom' && typeof server === 'string'
          ? /^([a-z]+):/i.exec(server)?.[1]?.toLowerCase()
          : undefined;
    if (protocol === 'rtmp' || protocol === 'rtmps') {
      const value = await parameter('AdvOut', 'TrackIndex');
      if (typeof value === 'string' && /^[1-6]$/.test(value)) tracks = [Number(value)];
    } else if (protocol === 'srt' || protocol === 'rist') {
      const value = await parameter('AdvOut', 'StreamMultiTrackAudioMixes');
      if (typeof value === 'string' && /^\d+$/.test(value) && Number(value) <= 63)
        tracks = [1, 2, 3, 4, 5, 6].filter((track) => (Number(value) & (1 << (track - 1))) !== 0);
    }
  }
  return (await obs.call('GetProfileList')).currentProfileName === profile ? tracks : null;
}
