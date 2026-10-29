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
      state: z.enum(['connecting', 'ready', 'paused', 'unavailable']),
      timingBasis: z.enum(['estimated', 'program-clock']),
      calibrationState: z.enum(['uncalibrated', 'measured', 'held', 'reacquiring']).optional(),
      effectiveDelaySeconds: z.number().finite().nonnegative().optional(),
      waitingReason: z.string().max(64).nullable(),
      nextWindowSeconds: z.number().finite().nonnegative().nullable(),
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
  })
  .refine((v) => v.leadSeconds < v.expectedDelaySeconds, '提前时间应小于两路延迟差');
export type ObserverSettings = z.infer<typeof observerSettingsSchema>;
export const DEFAULT_OBSERVER_SETTINGS: ObserverSettings = {
  enabled: false,
  expectedDelaySeconds: 120,
  leadSeconds: 5,
};

export const gameAutomationSettingsSchema = z.strictObject({
  autoConnect: z.boolean(),
  hideGameHud: z.boolean(),
});
export type GameAutomationSettings = z.infer<typeof gameAutomationSettingsSchema>;
export const DEFAULT_GAME_AUTOMATION_SETTINGS: GameAutomationSettings = {
  autoConnect: true,
  hideGameHud: true,
};

const endpoint = z
  .string()
  .max(100)
  .regex(/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/)
  .refine((v) => {
    const [ip, port] = v.split(':');
    return (
      ip!.split('.').every((n) => (n === '0' || !n.startsWith('0')) && Number(n) <= 255) &&
      Number(port) > 0 &&
      Number(port) <= 65535
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
  earlyOverride?: string,
): ObserverConnection {
  if (input.length > 512 || /[\r\n\0]/.test(input))
    throw new Error('请粘贴 GOTV 地址或 connect 地址；password 密码');
  // No escaping or arbitrary console grammar: exactly one endpoint and at most one password.
  const commands = input.trim().replace(/;\s*$/, '').split(';');
  let supplied: string | undefined;
  let password: string | undefined;
  for (const command of commands) {
    const connect =
      /^(?:connect\s+)?(?:"(\d{1,3}(?:\.\d{1,3}){3}:\d{1,5})"|(\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}))\s*$/i.exec(
        command.trim(),
      );
    const secret = /^password\s+(?:"([^";\\]*)"|([^;"\\]*))\s*$/i.exec(command.trim());
    if (connect && supplied === undefined) supplied = connect[1] ?? connect[2]!;
    else if (secret && password === undefined) password = secret[1] ?? secret[2]!.trim();
    else throw new Error('请只填写一条连接和可选的 password 密码');
  }
  if (!supplied) throw new Error('请填写 GOTV 数字 IP 和端口');
  endpoint.parse(supplied);
  const colon = supplied.lastIndexOf(':');
  const port = Number(supplied.slice(colon + 1));
  if (!programEndpoint?.trim() && port !== 27025 && port !== 27026)
    throw new Error('此端口请展开高级设置，分别填写早源与节目源。');
  const earlyEndpoint = programEndpoint?.trim() ? supplied : supplied.slice(0, colon + 1) + '27025';
  return observerConnectionSchema.parse({
    earlyEndpoint: earlyOverride?.trim() || earlyEndpoint,
    programEndpoint: programEndpoint?.trim() || supplied.slice(0, colon + 1) + '27026',
    password: password ?? '',
  });
}

/** Safe console output shared by native automation and the connection clipboard. */
export function formatObserverConnection(connection: ObserverConnection): string {
  const parsed = observerConnectionSchema.parse(connection);
  return `password "${parsed.password}"; connect ${parsed.programEndpoint}`;
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
