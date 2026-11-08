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
      effectiveDelaySeconds: z.number().finite().nonnegative().nullable(),
      waitingReason: z.string().max(64).nullable(),
      nextWindowSeconds: z.number().finite().nonnegative().nullable(),
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

export const observerSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  nicknameSource: z.enum(['game', 'website']).default('game'),
  leadSeconds: z.number().int().min(1).max(30),
});
export type ObserverSettings = z.infer<typeof observerSettingsSchema>;
export const DEFAULT_OBSERVER_SETTINGS: ObserverSettings = {
  enabled: true,
  nicknameSource: 'game',

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
  .max(100, '请填写有效的数字 IP 和端口。')
  .regex(/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/, '请填写有效的数字 IP 和端口。')
  .refine((v) => {
    const [ip, port] = v.split(':');
    return (
      ip!.split('.').every((n) => (n === '0' || !n.startsWith('0')) && Number(n) <= 255) &&
      Number(port) > 0 &&
      Number(port) <= 65535
    );
  }, '请填写有效的数字 IP 和端口。');
export const observerConnectionSchema = z
  .strictObject({
    earlyEndpoint: endpoint,
    programEndpoint: endpoint,
    password: z
      .string()
      .max(95, '观战密码不能超过 95 个字符。')
      .regex(/^[\x20-\x7e]*$/, '观战密码请使用当前连接入口支持的字符。')
      .refine((v) => !/[;"\\]/.test(v), '观战密码请使用当前连接入口支持的字符。'),
  })
  .refine(
    (v) => v.earlyEndpoint !== v.programEndpoint,
    '提示接收与游戏连接不能使用同一地址，请核对赛事说明。',
  );
export type ObserverConnection = z.infer<typeof observerConnectionSchema>;

/** Parse only the connection pair chosen by the operator's adjacent-port profile. */
export function parseObserverConnection(
  input: string,
  programEndpoint?: string,
  earlyOverride?: string,
): ObserverConnection {
  if (input.length > 512 || /[\r\n\0]/.test(input))
    throw new Error('请粘贴 GoTV 地址或 connect 地址；password 密码。');
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
  if (!supplied) throw new Error('请填写 GoTV 数字 IP 和端口。');
  const parsedEndpoint = endpoint.safeParse(supplied);
  if (!parsedEndpoint.success)
    throw new Error(parsedEndpoint.error.issues[0]!.message, { cause: parsedEndpoint.error });
  const colon = supplied.lastIndexOf(':');
  const port = Number(supplied.slice(colon + 1));
  if (!programEndpoint?.trim() && port !== 27025 && port !== 27026)
    throw new Error('请展开“其他端口设置”，填写赛事方提供的两个连接地址。');
  const earlyEndpoint = programEndpoint?.trim() ? supplied : supplied.slice(0, colon + 1) + '27025';
  const parsed = observerConnectionSchema.safeParse({
    earlyEndpoint: earlyOverride?.trim() || earlyEndpoint,
    programEndpoint: programEndpoint?.trim() || supplied.slice(0, colon + 1) + '27026',
    password: password ?? '',
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]!.message, { cause: parsed.error });
  return parsed.data;
}

/** Safe console output shared by native automation and the connection clipboard. */
export function formatObserverConnection(connection: ObserverConnection): string {
  const parsed = observerConnectionSchema.parse(connection);
  const password =
    !parsed.password || /\s/.test(parsed.password) ? `"${parsed.password}"` : parsed.password;
  return `connect ${parsed.programEndpoint};password ${password}`;
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
