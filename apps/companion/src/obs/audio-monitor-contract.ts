import { z } from 'zod';

export const monitorMode = z.enum([
  'OBS_MONITORING_TYPE_NONE',
  'OBS_MONITORING_TYPE_MONITOR_ONLY',
  'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
]);
export const monitorRef = z
  .object({
    kind: z.literal('monitor'),
    inputUuid: z.string().min(1),
    before: monitorMode,
    applied: monitorMode,
  })
  .strict();
export type AudioMonitorChange = z.infer<typeof monitorRef>;

const musicOriginal = z
  .object({
    uuid: z.string().min(1),
    mode: monitorMode,
    applied: monitorMode.optional(),
  })
  .strict()
  .nullable();
export const musicOriginals = z.object({ bgm: musicOriginal, stinger: musicOriginal }).strict();
export type MonitorOriginals = z.infer<typeof musicOriginals>;
