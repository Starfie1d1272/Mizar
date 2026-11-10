import { createHash } from 'node:crypto';
import { z } from 'zod';
import { guardedPreparationWrites, type ObsRpc } from './reconcile.js';

const roles = {
  desktop: { name: '桌面声音', kind: 'wasapi_output_capture' },
  microphone: { name: '麦克风', kind: 'wasapi_input_capture' },
} as const;
const row = z.record(z.string(), z.unknown());
export const audioDeviceCommandSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    role: z.enum(['desktop', 'microphone']),
    deviceId: z.string().min(1).max(2048),
  })
  .strict();
export type AudioDeviceCommand = z.infer<typeof audioDeviceCommandSchema>;

/** Device choices belong to the managed role, never to arbitrary OBS input bindings. */
export async function readAudioDevices(obs: ObsRpc) {
  if (!obs.ownershipScope || !obs.managedInputIdentity)
    throw new Error('audio_devices_owner_missing');
  const scope = await obs.ownershipScope();
  const inputs = z
    .array(z.object({ inputName: z.string(), inputUuid: z.string(), inputKind: z.string() }))
    .parse((await obs.call('GetInputList')).inputs);
  const devices = await Promise.all(
    Object.entries(roles).map(async ([role, spec]) => {
      const matches = inputs.filter((input) => input.inputName === spec.name);
      const input = matches[0];
      const identity = await obs.managedInputIdentity!(spec.name);
      if (!identity || input?.inputUuid !== identity.uuid || input.inputKind !== identity.kind)
        throw new Error('audio_devices_prepare_required');
      if (matches.length !== 1 || !input) throw new Error('audio_devices_prepare_required');
      if (role === 'desktop' && input.inputKind !== spec.kind)
        throw new Error('audio_devices_prepare_required');
      if (!['wasapi_input_capture', 'wasapi_output_capture'].includes(input.inputKind))
        return {
          role: role as keyof typeof roles,
          name: spec.name,
          uuid: input.inputUuid,
          deviceId: null,
          candidates: [],
          configurable: false,
        };
      const data = { inputUuid: input.inputUuid };
      const settings = row.parse((await obs.call('GetInputSettings', data)).inputSettings);
      const candidates = z
        .array(z.object({ itemName: z.string(), itemValue: z.string(), itemEnabled: z.boolean() }))
        .parse(
          (
            await obs.call('GetInputPropertiesListPropertyItems', {
              ...data,
              propertyName: 'device_id',
            })
          ).propertyItems,
        )
        .filter((item) => item.itemEnabled && item.itemValue)
        .map((item) => ({ id: item.itemValue, label: item.itemName }));
      return {
        role: role as keyof typeof roles,
        name: spec.name,
        uuid: input.inputUuid,
        deviceId: typeof settings.device_id === 'string' ? settings.device_id : null,
        candidates,
        configurable: true,
      };
    }),
  );
  if ((await obs.ownershipScope()) !== scope) throw new Error('audio_devices_owner_changed');
  return {
    revision: createHash('sha256').update(JSON.stringify({ scope, devices })).digest('hex'),
    devices,
  };
}

export async function setAudioDevice(
  obs: ObsRpc,
  command: AudioDeviceCommand,
  verifyRoute?: (uuid: string) => Promise<void>,
) {
  const before = await readAudioDevices(obs);
  const device = before.devices.find((item) => item.role === command.role)!;
  if (
    before.revision !== command.revision ||
    !device.candidates.some((item) => item.id === command.deviceId)
  )
    throw new Error('audio_devices_changed');
  if (device.deviceId === command.deviceId) return before;
  await verifyRoute?.(device.uuid);
  await guardedPreparationWrites(obs).call('SetInputSettings', {
    inputUuid: device.uuid,
    inputSettings: { device_id: command.deviceId },
    overlay: true,
  });
  const after = await readAudioDevices(obs);
  if (after.devices.find((item) => item.role === command.role)?.deviceId !== command.deviceId)
    throw new Error('audio_device_unconfirmed');
  return after;
}
