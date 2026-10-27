import { z } from 'zod';

/** Private operator control; OBS identity is resolved by the Companion. */
export const mixerChannelSchema = z.enum(['game', 'remoteCommentary', 'microphone', 'music']);
export const mixerCommandSchema = z
  .object({
    revision: z.string().min(1),
    channel: mixerChannelSchema,
    volume: z.number().finite().min(0).max(1).optional(),
    muted: z.boolean().optional(),
  })
  .strict()
  .refine((command) => command.volume !== undefined || command.muted !== undefined);
export type MixerCommand = z.infer<typeof mixerCommandSchema>;
export type MixerChannel = z.infer<typeof mixerChannelSchema>;
export interface MixerChannelStatus {
  name: string;
  volume: number | null;
  muted: boolean | null;
  control: 'available' | 'unbound' | 'unknown' | 'held';
  message?: string;
}
export interface MixerStatus {
  revision: string;
  channels: Record<MixerChannel, MixerChannelStatus>;
}
export interface MixerCommandResult {
  status: 'confirmed' | 'rejected' | 'unknown';
  message?: string;
}
