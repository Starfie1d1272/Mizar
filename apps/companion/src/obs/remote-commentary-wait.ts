import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RemoteCommentary } from './remote-commentary.js';
import type { ObsRpc } from './reconcile.js';

const journalSchema = z
  .object({
    endpoint: z.string(),
    collection: z.string(),
    uuid: z.string(),
    revision: z.string(),
    phase: z.enum(['waiting', 'applying']),
  })
  .strict();

/** Complete only an existing empty owned probe; never recreate or repair a changed source. */
export async function discoverWaitingCommentary(
  obs: ObsRpc,
  owner: RemoteCommentary,
  journalPath: string,
  endpoint: string,
): Promise<'waiting' | 'complete' | 'stopped'> {
  const state = await owner.get();
  if (state.preference.mode !== 'autoTeamspeak') return 'stopped';
  let journal: z.infer<typeof journalSchema>;
  try {
    journal = journalSchema.parse(JSON.parse(await readFile(`${journalPath}.waiting`, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'stopped';
    throw error;
  }
  if (
    journal.phase !== 'waiting' ||
    journal.revision !== state.revision ||
    journal.endpoint !== endpoint
  )
    return 'stopped';
  const uuid = journal.uuid;
  const valid = async () => {
    if ((await owner.get()).revision !== state.revision) return false;
    const [stream, record, collection] = await Promise.all([
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
      obs.call('GetSceneCollectionList'),
    ]);
    return (
      stream.outputActive === false &&
      record.outputActive === false &&
      collection.currentSceneCollectionName === journal.collection
    );
  };
  if (!(await valid())) return 'waiting';
  const list = (await obs.call('GetInputList')).inputs;
  if (
    !Array.isArray(list) ||
    !list.some(
      (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        (value as Record<string, unknown>).inputUuid === uuid &&
        (value as Record<string, unknown>).inputKind === 'wasapi_process_output_capture',
    )
  )
    return 'stopped';
  const settings = (await obs.call('GetInputSettings', { inputUuid: uuid })).inputSettings;
  if (!settings || typeof settings !== 'object') throw new Error('commentary_settings_unknown');
  if ((settings as Record<string, unknown>).window) return 'stopped';
  const found = await owner.discover(obs, state.revision, uuid);
  if (found.kind !== 'window') return 'waiting';
  if (!(await valid())) return 'waiting';
  const current = (await obs.call('GetInputSettings', { inputUuid: uuid })).inputSettings;
  if (!current || typeof current !== 'object' || (current as Record<string, unknown>).window)
    return 'stopped';
  if (!(await valid())) return 'waiting';
  const temp = `${journalPath}.waiting.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ ...journal, phase: 'applying' })}\n`, {
      mode: 0o600,
    });
    await rename(temp, `${journalPath}.waiting`);
  } finally {
    await rm(temp, { force: true });
  }
  if (!(await valid())) return 'stopped';
  await obs.call('SetInputSettings', {
    inputUuid: uuid,
    inputSettings: { window: found.candidate.window, priority: 2 },
    overlay: true,
  });
  await rm(`${journalPath}.waiting`, { force: true });
  return 'complete';
}
