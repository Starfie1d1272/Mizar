import { z } from 'zod';

import {
  localSnapshotEnvelopeSchema,
  projectionCursorSchema,
  type LocalSnapshot,
} from './shared.js';
import { ASSIST_SCHEMA_VERSION } from './version.js';

export const assistPayloadSchema = z.object({
  availability: z.enum(['unavailable', 'available']),
  observer: z
    .object({
      state: z.enum(['connecting', 'aligning', 'ready', 'paused', 'unavailable']),
      expectedDelaySeconds: z.number().finite(),
      leadSeconds: z.number().finite(),
      measuredDelaySeconds: z.number().finite().nullable(),
      hints: z
        .array(
          z.object({
            id: z.string().max(200),
            remainingSeconds: z.number().finite(),
            attacker: z.object({
              name: z.string().max(256),
              observerSlot: z.number().int().min(0).max(9).nullable(),
            }),
            victim: z.object({
              name: z.string().max(256),
              observerSlot: z.number().int().min(0).max(9).nullable(),
            }),
          }),
        )
        .max(6),
    })
    .optional(),
});

export const observerSettingsSchema = z
  .strictObject({
    enabled: z.boolean(),
    expectedDelaySeconds: z.number().int().min(10).max(600),
    leadSeconds: z.number().int().min(1).max(30),
    hideGameHud: z.boolean(),
  })
  .refine((v) => v.leadSeconds < v.expectedDelaySeconds, '提前时间应小于两路延迟差');
export type ObserverSettings = z.infer<typeof observerSettingsSchema>;
export const DEFAULT_OBSERVER_SETTINGS: ObserverSettings = {
  enabled: false,
  expectedDelaySeconds: 120,
  leadSeconds: 7,
  hideGameHud: true,
};

const endpoint = z
  .string()
  .max(100)
  .regex(/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/)
  .refine((v) => {
    const [ip, port] = v.split(':');
    return (
      ip!.split('.').every((n) => Number(n) <= 255) && Number(port) > 0 && Number(port) <= 65535
    );
  }, '请填写有效的数字 IP 和端口');
export const observerConnectionSchema = z
  .strictObject({
    earlyEndpoint: endpoint,
    programEndpoint: endpoint,
    password: z
      .string()
      .max(95)
      .regex(/^[\x20-\x7e]*$/)
      .refine((v) => !/[;"\\]/.test(v), '观战密码请使用当前连接入口支持的字符'),
  })
  .refine((v) => v.earlyEndpoint !== v.programEndpoint, '早源与游戏节目源应使用不同端点');
export type ObserverConnection = z.infer<typeof observerConnectionSchema>;

/** Parse only the connection pair chosen by the operator's adjacent-port profile. */
export function parseObserverConnection(
  input: string,
  programEndpoint?: string,
): ObserverConnection {
  const match =
    /^(?:connect\s+)?(\d{1,3}(?:\.\d{1,3}){3}:\d{1,5})(?:\s*;\s*password\s+(?:"([^";\\]*)"|([^;"\\]*)))?\s*;?\s*$/i.exec(
      input.trim(),
    );
  if (!match || input.length > 512)
    throw new Error('请粘贴 GOTV 地址或 connect 地址；password 密码');
  const earlyEndpoint = match[1]!;
  const colon = earlyEndpoint.lastIndexOf(':');
  return observerConnectionSchema.parse({
    earlyEndpoint,
    programEndpoint:
      programEndpoint?.trim() ||
      earlyEndpoint.slice(0, colon + 1) + String(Number(earlyEndpoint.slice(colon + 1)) + 1),
    password: match[2] ?? (match[3] ?? '').trim(),
  });
}

export const assistSnapshotSchema = localSnapshotEnvelopeSchema.extend({
  channel: z.literal('assist'),
  schemaVersion: z.literal(ASSIST_SCHEMA_VERSION),
  cursor: projectionCursorSchema,
  payload: assistPayloadSchema,
});

export type AssistPayload = z.infer<typeof assistPayloadSchema>;
export type AssistSnapshot = z.infer<typeof assistSnapshotSchema>;
export type AssistSnapshotInput = Omit<
  LocalSnapshot<AssistPayload, typeof ASSIST_SCHEMA_VERSION>,
  'channelSeq'
> & {
  readonly channel: 'assist';
  readonly schemaVersion: typeof ASSIST_SCHEMA_VERSION;
};

export const AssistPayloadSchema = assistPayloadSchema;
export const AssistSnapshotSchema = assistSnapshotSchema;
