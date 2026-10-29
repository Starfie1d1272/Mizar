import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ObsRpc } from './reconcile.js';

const binding = z
  .object({
    endpoint: z.string().min(1),
    collection: z.string().min(1),
    inputUuid: z.string().min(1),
  })
  .strict();
const preference = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('autoTeamspeak') }).strict(),
  z.object({ mode: z.literal('application'), window: z.string().min(1) }).strict(),
  z.object({ mode: z.literal('existingInput'), binding }).strict(),
  z.object({ mode: z.literal('disabled') }).strict(),
]);
const schema = z.object({ revision: z.string().uuid(), preference }).strict();
export type CommentaryPreference = z.infer<typeof preference>;
type State = z.infer<typeof schema>;
type Candidate = { window: string; label: string };

// OBS encodes # and : before joining title, class and executable with colons.
function executable(window: unknown): string | null {
  if (typeof window !== 'string') return null;
  const parts = window.split(':');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  return parts[2]!.replaceAll('#3A', ':').replaceAll('#22', '#').toLowerCase();
}
export function isTeamspeak(window: unknown): boolean {
  const exe = executable(window);
  return (
    exe !== null && ['ts3client_win64.exe', 'ts3client_win32.exe', 'teamspeak.exe'].includes(exe)
  );
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    : [];
}

/** Persists user intent only. Discovery returns observations and never changes a target. */
export class RemoteCommentary {
  private state?: State;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async load(): Promise<State> {
    if (this.state) return this.state;
    try {
      this.state = schema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const initial: State = { revision: randomUUID(), preference: { mode: 'autoTeamspeak' } };
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(initial)}\n`, { flag: 'wx', mode: 0o600 });
        await link(temp, this.path);
        this.state = initial;
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        this.state = schema.parse(JSON.parse(await readFile(this.path, 'utf8')));
      } finally {
        await rm(temp, { force: true });
      }
    }
    return this.state;
  }
  async get(): Promise<State> {
    return structuredClone(await this.load());
  }
  async set(value: CommentaryPreference, revision: string): Promise<State> {
    const operation = this.queue.then(async () => {
      const current = await this.load();
      if (current.revision !== revision) throw new Error('commentary_revision_changed');
      const next = schema.parse({ revision: randomUUID(), preference: value });
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
        await rename(temp, this.path);
      } finally {
        await rm(temp, { force: true });
      }
      this.state = next;
      return structuredClone(next);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  private async assertRevision(revision: string) {
    await this.queue;
    if ((await this.load()).revision !== revision) throw new Error('commentary_revision_changed');
  }
  async windows(obs: ObsRpc, revision: string, probeUuid: string): Promise<Candidate[]> {
    await this.assertRevision(revision);
    const result = await obs.call('GetInputPropertiesListPropertyItems', {
      inputUuid: probeUuid,
      propertyName: 'window',
    });
    if (!Array.isArray(result.propertyItems)) throw new Error('commentary_windows_unknown');
    const candidates = records(result.propertyItems)
      .filter(
        (item) =>
          item.itemEnabled !== false &&
          typeof item.itemValue === 'string' &&
          executable(item.itemValue) !== null,
      )
      .map((item) => ({
        window: item.itemValue as string,
        label: typeof item.itemName === 'string' ? item.itemName : (item.itemValue as string),
      }));
    await this.assertRevision(revision);
    return candidates;
  }
  /** Probe must be an existing process-capture input, including a disabled owned input. */
  async discover(obs: ObsRpc, revision: string, probeUuid: string) {
    await this.assertRevision(revision);
    const current = await this.load();
    if (current.preference.mode !== 'autoTeamspeak') return { kind: 'manual' as const };
    const version = await obs.call('GetVersion');
    if (
      !Array.isArray(version.availableRequests) ||
      !['GetInputList', 'GetInputSettings', 'GetInputPropertiesListPropertyItems'].every((x) =>
        (version.availableRequests as unknown[]).includes(x),
      )
    )
      throw new Error('commentary_capability_missing');
    const inputs = records((await obs.call('GetInputList')).inputs).filter(
      (i) => i.inputKind === 'wasapi_process_output_capture' && typeof i.inputUuid === 'string',
    );
    if (!inputs.some((i) => i.inputUuid === probeUuid)) throw new Error('commentary_probe_missing');
    const existing: { inputUuid: string; window: string }[] = [];
    for (const input of inputs) {
      const settings = (await obs.call('GetInputSettings', { inputUuid: input.inputUuid }))
        .inputSettings;
      if (
        settings &&
        typeof settings === 'object' &&
        isTeamspeak((settings as Record<string, unknown>).window)
      )
        existing.push({
          inputUuid: input.inputUuid as string,
          window: (settings as { window: string }).window,
        });
    }
    await this.assertRevision(revision);
    if (existing.length === 1) return { kind: 'existing' as const, candidate: existing[0]! };
    if (existing.length > 1) return { kind: 'existingChoices' as const, candidates: existing };
    const result = await obs.call('GetInputPropertiesListPropertyItems', {
      inputUuid: probeUuid,
      propertyName: 'window',
    });
    if (!Array.isArray(result.propertyItems)) throw new Error('commentary_windows_unknown');
    const candidates: Candidate[] = records(result.propertyItems)
      .filter((item) => item.itemEnabled !== false && isTeamspeak(item.itemValue))
      .map((item) => ({
        window: item.itemValue as string,
        label: typeof item.itemName === 'string' ? item.itemName : (item.itemValue as string),
      }));
    await this.assertRevision(revision);
    return candidates.length === 0
      ? { kind: 'waiting' as const }
      : candidates.length === 1
        ? { kind: 'window' as const, candidate: candidates[0]! }
        : { kind: 'windowChoices' as const, candidates };
  }
}

/** Rename only journal-owned legacy probes; custom names and active output are left intact. */
export async function renameLegacyProbe(
  obs: ObsRpc,
  journalPath: string,
  endpoint: string,
  collection: string,
  role: 'game' | 'commentary',
): Promise<void> {
  let saved: { endpoint?: string; collection?: string; uuid?: string; name?: string };
  try {
    saved = JSON.parse(await readFile(journalPath, 'utf8')) as typeof saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (saved.endpoint !== endpoint || saved.collection !== collection || !saved.uuid) return;
  const pattern =
    role === 'game'
      ? /^Mizar · Game Audio [0-9a-f-]{36}$/
      : /^Mizar · Remote Commentary [0-9a-f-]{36}$/;
  const [stream, record, current, list] = await Promise.all([
    obs.call('GetStreamStatus'),
    obs.call('GetRecordStatus'),
    obs.call('GetSceneCollectionList'),
    obs.call('GetInputList'),
  ]);
  if (
    stream.outputActive !== false ||
    record.outputActive !== false ||
    current.currentSceneCollectionName !== collection
  )
    return;
  const inputs = records(list.inputs);
  const owned = inputs.find((input) => input.inputUuid === saved.uuid);
  if (
    owned?.inputKind !== 'wasapi_process_output_capture' ||
    typeof owned.inputName !== 'string' ||
    !pattern.test(owned.inputName) ||
    owned.inputName !== saved.name
  )
    return;
  const base = role === 'game' ? '游戏声音' : '其他解说';
  let name = base;
  for (let index = 2; inputs.some((input) => input.inputName === name); index++)
    name = `${base} ${index}`;
  await obs.call('SetInputName', { inputUuid: saved.uuid, newInputName: name });
}

/** Create an inert probe only with an idle OBS; the journal prevents blind recreation after an uncertain call. */
export async function createCommentaryProbe(
  obs: ObsRpc,
  journalPath: string,
  context: { endpoint: string; collection: string; sceneName: string; label?: string },
  stillCurrent: () => Promise<void>,
): Promise<string> {
  const journalSchema = z
    .object({
      endpoint: z.string(),
      collection: z.string(),
      name: z.string(),
      uuid: z.string().optional(),
    })
    .strict();
  let journal: z.infer<typeof journalSchema> | undefined;
  try {
    journal = journalSchema.parse(JSON.parse(await readFile(journalPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (journal) {
    if (journal.endpoint !== context.endpoint || journal.collection !== context.collection)
      throw new Error('commentary_probe_context_changed');
    if (!journal.uuid) throw new Error('commentary_probe_creation_uncertain');
    const inputs = records((await obs.call('GetInputList')).inputs);
    if (
      !inputs.some(
        (i) => i.inputUuid === journal.uuid && i.inputKind === 'wasapi_process_output_capture',
      )
    )
      throw new Error('commentary_probe_deleted');
    return journal.uuid;
  }
  const [stream, record, collection, version] = await Promise.all([
    obs.call('GetStreamStatus'),
    obs.call('GetRecordStatus'),
    obs.call('GetSceneCollectionList'),
    obs.call('GetVersion'),
  ]);
  if (stream.outputActive !== false || record.outputActive !== false)
    throw new Error('commentary_output_active');
  if (collection.currentSceneCollectionName !== context.collection)
    throw new Error('commentary_collection_changed');
  if (
    !Array.isArray(version.availableRequests) ||
    !['CreateInput', 'GetInputKindList', 'GetInputPropertiesListPropertyItems'].every((x) =>
      (version.availableRequests as unknown[]).includes(x),
    )
  )
    throw new Error('commentary_capability_missing');
  const kinds = (await obs.call('GetInputKindList')).inputKinds;
  if (!Array.isArray(kinds) || !kinds.includes('wasapi_process_output_capture'))
    throw new Error('commentary_capture_unavailable');
  await stillCurrent();
  const baseName = context.label === 'Game Audio' ? '游戏声音' : '其他解说';
  const inputs = records((await obs.call('GetInputList')).inputs);
  let name = baseName;
  for (let index = 2; inputs.some((input) => input.inputName === name); index++)
    name = `${baseName} ${index}`;
  const planned = { endpoint: context.endpoint, collection: context.collection, name };
  await mkdir(dirname(journalPath), { recursive: true });
  // Exclusive creation prevents competing callers from claiming the same operation.
  await writeFile(journalPath, `${JSON.stringify(planned)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    await stillCurrent();
    const check = await Promise.all([
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
      obs.call('GetSceneCollectionList'),
    ]);
    if (
      check[0].outputActive !== false ||
      check[1].outputActive !== false ||
      check[2].currentSceneCollectionName !== context.collection
    )
      throw new Error('commentary_context_changed');
    await stillCurrent();
  } catch (error) {
    // No creation was attempted, so this journal is safe to discard.
    await rm(journalPath, { force: true });
    throw error;
  }
  const created = await obs.call('CreateInput', {
    sceneName: context.sceneName,
    inputName: name,
    inputKind: 'wasapi_process_output_capture',
    inputSettings: {},
    sceneItemEnabled: false,
  });
  if (typeof created.inputUuid !== 'string' || !created.inputUuid)
    throw new Error('commentary_probe_creation_uncertain');
  const temp = `${journalPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ ...planned, uuid: created.inputUuid })}\n`, {
      mode: 0o600,
    });
    await rename(temp, journalPath);
  } finally {
    await rm(temp, { force: true });
  }
  await stillCurrent();
  return created.inputUuid;
}
