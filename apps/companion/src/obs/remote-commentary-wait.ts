import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isTeamspeak, RemoteCommentary } from './remote-commentary.js';
import { AUTO_TEAMSPEAK_TARGET, readCommentarySwitch } from './commentary-switch.js';
import type { ObsRpc } from './reconcile.js';

const journalSchema = z
  .object({
    endpoint: z.string(),
    collection: z.string(),
    uuid: z.string(),
    revision: z.string(),
    phase: z.enum(['waiting', 'applying', 'ready']),
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
  if (state.preference.mode !== 'autoTeamspeak' && state.preference.mode !== 'application')
    return 'stopped';
  let journal: z.infer<typeof journalSchema>;
  try {
    journal = journalSchema.parse(JSON.parse(await readFile(`${journalPath}.waiting`, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'stopped';
    throw error;
  }
  if (
    journal.phase === 'applying' ||
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
  if (journal.phase === 'ready')
    return (settings as Record<string, unknown>).window ? 'complete' : 'stopped';
  const currentWindow = (settings as Record<string, unknown>).window;
  if (currentWindow) {
    if (state.preference.mode === 'autoTeamspeak') {
      const plan = await readCommentarySwitch(`${journalPath}.switch`);
      if (
        !plan ||
        plan.phase !== 'prepared' ||
        plan.endpoint !== endpoint ||
        plan.collection !== journal.collection ||
        plan.uuid !== uuid ||
        plan.revision !== state.revision ||
        plan.from !== currentWindow ||
        plan.to !== AUTO_TEAMSPEAK_TARGET
      )
        return 'stopped';
      const windows = (await owner.windows(obs, state.revision, uuid)).filter((candidate) =>
        isTeamspeak(candidate.window),
      );
      return windows.length === 1 ? 'complete' : 'waiting';
    }
    if (state.preference.mode !== 'application') return 'stopped';
    if (currentWindow !== state.preference.window) {
      const plan = await readCommentarySwitch(`${journalPath}.switch`);
      if (
        !plan ||
        plan.phase !== 'prepared' ||
        plan.endpoint !== endpoint ||
        plan.collection !== journal.collection ||
        plan.uuid !== uuid ||
        plan.revision !== state.revision ||
        plan.from !== currentWindow ||
        plan.to !== state.preference.window
      )
        return 'stopped';
    }
    const chosen = state.preference.window;
    return (await owner.windows(obs, state.revision, uuid)).some(
      (candidate) => candidate.window === chosen,
    )
      ? 'complete'
      : 'waiting';
  }
  const selectedWindow = state.preference.mode === 'application' ? state.preference.window : null;
  const found =
    selectedWindow !== null
      ? (await owner.windows(obs, state.revision, uuid)).some(
          (candidate) => candidate.window === selectedWindow,
        )
        ? { kind: 'window' as const, candidate: { window: selectedWindow } }
        : { kind: 'waiting' as const }
      : await owner.discover(obs, state.revision, uuid);
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
  const ready = `${journalPath}.waiting.${randomUUID()}.tmp`;
  try {
    await writeFile(ready, `${JSON.stringify({ ...journal, phase: 'ready' })}\n`, { mode: 0o600 });
    await rename(ready, `${journalPath}.waiting`);
  } finally {
    await rm(ready, { force: true });
  }
  return 'complete';
}
