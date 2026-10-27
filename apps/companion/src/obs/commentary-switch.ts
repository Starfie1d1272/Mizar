import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { MigrationObserver } from './audio-migration.js';
import type { ObsRpc } from './reconcile.js';

export const AUTO_TEAMSPEAK_TARGET = '@autoTeamspeak';
const schema = z
  .object({
    endpoint: z.string(),
    collection: z.string(),
    uuid: z.string(),
    from: z.string().min(1),
    to: z.string().min(1),
    revision: z.string().uuid(),
    routingRevision: z.string().uuid(),
    phase: z.enum(['prepared', 'sent']),
  })
  .strict();
export type CommentarySwitch = z.infer<typeof schema>;
export async function readCommentarySwitch(path: string): Promise<CommentarySwitch | null> {
  try {
    return schema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function saveCommentarySwitch(path: string, value: CommentarySwitch) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(schema.parse(value))}\n`, { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
/** A sent but unconfirmed write is retained and never replayed. */
export async function applyCommentarySwitch(
  obs: ObsRpc,
  path: string,
  plan: CommentarySwitch,
  observer: MigrationObserver,
  check: () => Promise<void>,
): Promise<void> {
  if (plan.phase !== 'prepared') throw new Error('commentary_switch_recovery_required');
  let changed = false;
  let expected = false;
  let seen = false;
  let original: Record<string, unknown> | undefined;
  const sameOtherSettings = (settings: Record<string, unknown>) => {
    if (!original) return false;
    const keys = new Set([...Object.keys(original), ...Object.keys(settings)]);
    return [...keys].every(
      (key) => key === 'window' || JSON.stringify(original![key]) === JSON.stringify(settings[key]),
    );
  };
  const stop = observer.subscribe((event) => {
    if (
      event.type === 'inputSettings' &&
      expected &&
      !seen &&
      event.inputUuid === plan.uuid &&
      event.settings.window === plan.to &&
      sameOtherSettings(event.settings)
    )
      seen = true;
    else changed = true;
  });
  try {
    await check();
    const before = (await obs.call('GetInputSettings', { inputUuid: plan.uuid })).inputSettings;
    if (
      !before ||
      typeof before !== 'object' ||
      (before as Record<string, unknown>).window !== plan.from ||
      changed
    )
      throw new Error('commentary_switch_changed');
    original = before as Record<string, unknown>;
    await check();
    if (changed) throw new Error('commentary_switch_changed');
    await saveCommentarySwitch(path, { ...plan, phase: 'sent' });
    await check();
    if (changed) throw new Error('commentary_switch_changed');
    expected = true;
    await obs.call('SetInputSettings', {
      inputUuid: plan.uuid,
      inputSettings: { window: plan.to },
      overlay: true,
    });
    const after = (await obs.call('GetInputSettings', { inputUuid: plan.uuid })).inputSettings;
    await check();
    if (
      changed ||
      !after ||
      typeof after !== 'object' ||
      (after as Record<string, unknown>).window !== plan.to ||
      !sameOtherSettings(after as Record<string, unknown>)
    )
      throw new Error('commentary_switch_uncertain');
    await rm(path);
  } finally {
    stop();
  }
}
