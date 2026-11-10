import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { obsAudioBindingSchema } from '@mizar/protocol/obs';
import type { ObsAudioRouting } from './audio-routing.js';
import { AudioMigration } from './audio-migration.js';
import { OBS_COLLECTION } from './desired-state.js';
import { ObsVideoError } from './video-transaction.js';
import type { ObsRpc } from './reconcile.js';

const slots = [
  'desktop',
  'lastDesktop',
  'desktopMicrophone',
  'game',
  'remoteCommentary',
  'microphone',
] as const;
type Slot = (typeof slots)[number];
const names: Record<Slot, string> = {
  desktop: '桌面声音',
  lastDesktop: '桌面声音',
  desktopMicrophone: '麦克风',
  game: '游戏声音',
  remoteCommentary: '其他解说',
  microphone: '麦克风',
};
const object = z.record(z.string(), z.unknown());
const sourceSchema = z
  .object({
    name: z.string().min(1),
    binding: obsAudioBindingSchema,
    slots: z.array(z.enum(slots)).min(1),
    settings: object,
    muted: z.boolean(),
    enabled: z.boolean().optional(),
    volume: z.number().finite().nonnegative(),
    tracks: z.record(z.string(), z.boolean()),
    monitor: z.enum([
      'OBS_MONITORING_TYPE_NONE',
      'OBS_MONITORING_TYPE_MONITOR_ONLY',
      'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
    ]),
    filters: z.array(
      z
        .object({
          filterName: z.string(),
          filterKind: z.string(),
          filterSettings: object,
          filterEnabled: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
const monitorMode = z.enum([
  'OBS_MONITORING_TYPE_NONE',
  'OBS_MONITORING_TYPE_MONITOR_ONLY',
  'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
]);
const completedMonitor = z
  .object({
    kind: z.literal('monitor'),
    inputUuid: z.string().min(1),
    before: monitorMode,
    applied: monitorMode,
    phase: z.literal('confirmed'),
    externalChanged: z.literal(false),
  })
  .strict();
const completedModeSchema = z
  .object({
    targetPath: z.string().min(1),
    snapshot: z
      .object({
        endpoint: z.string().min(1),
        collection: z.literal('Mizar'),
        modeId: z.string().uuid().optional(),
        fields: z.array(
          z
            .object({ phase: z.literal('confirmed'), externalChanged: z.literal(false) })
            .passthrough(),
        ),
      })
      .strict(),
  })
  .strict();
export const audioCollectionTransferSchema = z
  .object({
    revision: z.string().uuid(),
    endpoint: z.string().min(1),
    sources: z.array(sourceSchema).min(1),
    journals: z.array(z.object({ path: z.string().min(1), before: object }).strict()),
    completedMode: completedModeSchema.nullable().default(null),
  })
  .strict();
export type AudioCollectionTransfer = z.infer<typeof audioCollectionTransferSchema>;
export type AudioCollectionBindings = Partial<Record<Slot, z.infer<typeof obsAudioBindingSchema>>>;

async function collection(obs: ObsRpc, expected: string) {
  const [stream, record] = await Promise.all([
    obs.call('GetStreamStatus'),
    obs.call('GetRecordStatus'),
  ]);
  if (stream.outputActive !== false || record.outputActive !== false)
    throw new Error('audio_collection_transfer_output_active');
  if ((await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== expected)
    throw new Error('audio_collection_transfer_collection_changed');
}

/** Capture effective enable intent before leaving the legacy graph, including groups. */
async function sourceEnabled(obs: ObsRpc, uuid: string): Promise<boolean> {
  const scenes = (await obs.call('GetSceneList')).scenes as { sceneName: string }[];
  const visit = async (
    name: string,
    group = false,
    ancestors = new Set<string>(),
  ): Promise<boolean> => {
    if (ancestors.has(name)) throw new Error('audio_collection_transfer_scene_cycle');
    const next = new Set(ancestors).add(name);
    const items = (
      await obs.call(group ? 'GetGroupSceneItemList' : 'GetSceneItemList', {
        sceneName: name,
      })
    ).sceneItems as {
      sourceUuid: string;
      sourceName: string;
      sceneItemEnabled: boolean;
      isGroup?: boolean;
    }[];
    for (const item of items) {
      if (typeof item.sceneItemEnabled !== 'boolean')
        throw new Error('audio_collection_transfer_enable_unknown');
      if (!item.sceneItemEnabled) continue;
      if (item.sourceUuid === uuid) return true;
      if (item.isGroup && (await visit(item.sourceName, true, next))) return true;
    }
    return false;
  };
  for (const scene of scenes) if (await visit(scene.sceneName)) return true;
  return false;
}

/** Snapshot only explicit old bindings, before the old collection is left. No OBS writes. */
export async function captureAudioCollectionTransfer(
  obs: ObsRpc,
  routing: ObsAudioRouting,
  endpoint: string,
  journal: string,
): Promise<void> {
  const state = await routing.collectionTransferState();
  if (state.collectionTransfer) {
    if (state.collectionTransfer.endpoint !== endpoint)
      throw new Error('audio_collection_transfer_endpoint_changed');
    return;
  }
  const bindings: AudioCollectionBindings = {};
  for (const slot of slots) {
    const binding =
      slot === 'game' || slot === 'remoteCommentary' || slot === 'microphone'
        ? state.bindings[slot]
        : state[slot];
    if (binding) bindings[slot] = binding;
  }
  const entries = Object.entries(bindings) as [Slot, z.infer<typeof obsAudioBindingSchema>][];
  if (
    entries.length > 0 &&
    entries.every(
      ([, binding]) => binding.collection === OBS_COLLECTION && binding.endpoint === endpoint,
    )
  )
    return;
  if (
    entries.some(([, binding]) => binding.collection !== 'Mizar' || binding.endpoint !== endpoint)
  )
    throw new Error('audio_collection_transfer_binding_context_mismatch');
  if (state.transition || state.waitingIndependent)
    throw new Error('audio_collection_transfer_mode_pending');
  // A completed backup is evidence, not an unfinished mode transaction.
  // Retain its original file; only copied source monitoring can cross collections.
  let completedMode: AudioCollectionTransfer['completedMode'] = null;
  try {
    const snapshot = await new AudioMigration(`${journal}.migration-mode`).pending();
    if (snapshot) {
      if (
        !state.desktop ||
        snapshot.endpoint !== endpoint ||
        snapshot.collection !== 'Mizar' ||
        snapshot.fields.some((field) => field.phase !== 'confirmed' || field.externalChanged)
      )
        throw new Error('audio_collection_transfer_completed_mode_unconfirmed');
      completedMode = completedModeSchema.parse({
        targetPath: `${journal}.dedicated-mode`,
        snapshot,
      });
    }
  } catch (cause) {
    throw new Error('audio_collection_transfer_completed_mode_unconfirmed', { cause });
  }
  // Legacy mode/source transactions must be resolved in their original collection, never discarded.
  for (const suffix of ['.migration', '.waiting', '.switch', '.game.switch']) {
    try {
      await access(`${journal}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error('audio_collection_transfer_journal_pending');
  }
  const journals: AudioCollectionTransfer['journals'] = [];
  for (const suffix of ['', '.game', '.microphone', '.owned-target']) {
    try {
      const probe = object.parse(JSON.parse(await readFile(`${journal}${suffix}`, 'utf8')));
      if (
        typeof probe.uuid !== 'string' ||
        !probe.uuid ||
        probe.endpoint !== endpoint ||
        probe.collection !== 'Mizar'
      )
        throw new Error('audio_collection_transfer_probe_pending');
      journals.push({ path: `${journal}${suffix}`, before: probe });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!entries.length) {
    if (journals.length) throw new Error('audio_collection_transfer_binding_missing');
    return;
  }
  await collection(obs, 'Mizar');
  const inputs = (await obs.call('GetInputList')).inputs as {
    inputUuid: string;
    inputKind: string;
  }[];
  const sources: AudioCollectionTransfer['sources'] = [];
  for (const [slot, binding] of entries) {
    const existing = sources.find((source) => source.name === names[slot]);
    if (existing) {
      if (existing.binding.inputUuid !== binding.inputUuid)
        throw new Error('audio_collection_transfer_conflicting_choices');
      existing.slots.push(slot);
      continue;
    }
    if (
      !['wasapi_output_capture', 'wasapi_input_capture', 'wasapi_process_output_capture'].includes(
        binding.inputKind,
      )
    )
      throw new Error('audio_collection_transfer_unsupported_source');
    if (
      !inputs.some(
        (input) => input.inputUuid === binding.inputUuid && input.inputKind === binding.inputKind,
      )
    )
      throw new Error('audio_collection_transfer_source_missing');
    const data = { inputUuid: binding.inputUuid };
    const [settings, mute, volume, tracks, monitor, filters] = await Promise.all([
      obs.call('GetInputSettings', data),
      obs.call('GetInputMute', data),
      obs.call('GetInputVolume', data),
      obs.call('GetInputAudioTracks', data),
      obs.call('GetInputAudioMonitorType', data),
      obs.call('GetSourceFilterList', { sourceUuid: binding.inputUuid }),
    ]);
    sources.push(
      sourceSchema.parse({
        name: names[slot],
        binding,
        slots: [slot],
        settings: settings.inputSettings,
        muted: mute.inputMuted,
        enabled: await sourceEnabled(obs, binding.inputUuid),
        volume: volume.inputVolumeMul,
        tracks: tracks.inputAudioTracks,
        monitor: monitor.monitorType,
        filters: (filters.filters as Record<string, unknown>[]).map((filter) => ({
          filterName: filter.filterName,
          filterKind: filter.filterKind,
          filterSettings: filter.filterSettings,
          filterEnabled: filter.filterEnabled,
        })),
      }),
    );
  }
  await collection(obs, 'Mizar');
  for (const journal of journals) {
    const source = sources.find((source) => source.binding.inputUuid === journal.before.uuid);
    if (!source || ('window' in journal.before && journal.before.window !== source.settings.window))
      throw new Error('audio_collection_transfer_journal_binding_mismatch');
  }
  await routing.saveCollectionTransfer({
    revision: state.revision,
    endpoint,
    sources,
    journals,
    completedMode,
  });
}

/** Caller must verify dedicated collection ownership first. Retry only inside that collection. */
export async function applyAudioCollectionTransfer(
  obs: ObsRpc,
  routing: ObsAudioRouting,
  endpoint: string,
  sceneName: string,
  beforeCommit?: (bindings: AudioCollectionBindings) => Promise<void>,
): Promise<void> {
  const state = await routing.collectionTransferState();
  const transfer = state.collectionTransfer;
  if (!transfer) return;
  if (transfer.endpoint !== endpoint || transfer.revision !== state.revision)
    throw new Error('audio_collection_transfer_context_changed');
  await collection(obs, OBS_COLLECTION);
  const bindings: AudioCollectionBindings = {};
  for (const source of transfer.sources) {
    if (source.name === '麦克风' && typeof source.enabled !== 'boolean')
      throw new Error('audio_collection_transfer_enable_unknown');
    await collection(obs, OBS_COLLECTION);
    const inputs = (await obs.call('GetInputList')).inputs as {
      inputUuid: string;
      inputName: string;
      inputKind: string;
    }[];
    const existing = inputs.find((input) => input.inputName === source.name);
    if (existing && existing.inputKind !== source.binding.inputKind)
      throw new Error('audio_collection_transfer_name_conflict');
    const inputUuid =
      existing?.inputUuid ??
      (
        await obs.call('CreateInput', {
          sceneName,
          inputName: source.name,
          inputKind: source.binding.inputKind,
          inputSettings: source.settings,
          sceneItemEnabled: false,
        })
      ).inputUuid;
    if (typeof inputUuid !== 'string' || !inputUuid)
      throw new Error('audio_collection_transfer_create_unconfirmed');
    // The persisted source snapshot owns migration intent, including interrupted retries.
    if (source.name === '麦克风') {
      const items = (await obs.call('GetSceneItemList', { sceneName })).sceneItems as {
        sourceUuid: string;
        sceneItemId: number;
        sceneItemEnabled: boolean;
      }[];
      const refs = items.filter((item) => item.sourceUuid === inputUuid);
      if (refs.length !== 1) throw new Error('audio_collection_transfer_enable_unknown');
      await obs.call('SetSceneItemEnabled', {
        sceneName,
        sceneItemId: refs[0]!.sceneItemId,
        sceneItemEnabled: source.enabled,
      });
      const confirmed = (await obs.call('GetSceneItemList', { sceneName }))
        .sceneItems as typeof items;
      if (
        !confirmed.some(
          (item) => item.sourceUuid === inputUuid && item.sceneItemEnabled === source.enabled,
        )
      )
        throw new Error('audio_collection_transfer_enable_unknown');
    }
    const data = { inputUuid };
    await obs.call('SetInputSettings', { ...data, inputSettings: source.settings, overlay: false });
    await obs.call('SetInputMute', { ...data, inputMuted: source.muted });
    await obs.call('SetInputVolume', { ...data, inputVolumeMul: source.volume });
    await obs.call('SetInputAudioTracks', { ...data, inputAudioTracks: source.tracks });
    await obs.call('SetInputAudioMonitorType', { ...data, monitorType: source.monitor });
    const filterData = { sourceUuid: inputUuid };
    const current = (await obs.call('GetSourceFilterList', filterData)).filters as {
      filterName: string;
      filterKind: string;
    }[];
    for (const [index, filter] of source.filters.entries()) {
      const prior = current.find((item) => item.filterName === filter.filterName);
      if (prior && prior.filterKind !== filter.filterKind)
        throw new Error('audio_collection_transfer_filter_conflict');
      if (!prior)
        await obs.call('CreateSourceFilter', {
          ...filterData,
          filterName: filter.filterName,
          filterKind: filter.filterKind,
          filterSettings: filter.filterSettings,
        });
      else
        await obs.call('SetSourceFilterSettings', {
          ...filterData,
          filterName: filter.filterName,
          filterSettings: filter.filterSettings,
          overlay: false,
        });
      await obs.call('SetSourceFilterEnabled', {
        ...filterData,
        filterName: filter.filterName,
        filterEnabled: filter.filterEnabled,
      });
      await obs.call('SetSourceFilterIndex', {
        ...filterData,
        filterName: filter.filterName,
        filterIndex: index,
      });
    }
    const [settings, mute, volume, tracks, monitor, filters] = await Promise.all([
      obs.call('GetInputSettings', data),
      obs.call('GetInputMute', data),
      obs.call('GetInputVolume', data),
      obs.call('GetInputAudioTracks', data),
      obs.call('GetInputAudioMonitorType', data),
      obs.call('GetSourceFilterList', filterData),
    ]);
    const confirmedFilters = (filters.filters as Record<string, unknown>[]).map((filter) => ({
      filterName: filter.filterName,
      filterKind: filter.filterKind,
      filterSettings: filter.filterSettings,
      filterEnabled: filter.filterEnabled,
    }));
    if (
      !isDeepStrictEqual(settings.inputSettings, source.settings) ||
      mute.inputMuted !== source.muted ||
      typeof volume.inputVolumeMul !== 'number' ||
      Math.abs(volume.inputVolumeMul - source.volume) > 0.000001 ||
      !isDeepStrictEqual(tracks.inputAudioTracks, source.tracks) ||
      monitor.monitorType !== source.monitor ||
      !isDeepStrictEqual(confirmedFilters, source.filters)
    )
      throw new Error('audio_collection_transfer_readback_mismatch');
    for (const slot of source.slots)
      bindings[slot] = { ...source.binding, inputUuid, collection: OBS_COLLECTION };
  }
  await collection(obs, OBS_COLLECTION);
  for (const journal of transfer.journals) {
    const source = transfer.sources.find(
      (source) => source.binding.inputUuid === journal.before.uuid,
    )!;
    const binding = bindings[source.slots[0]!]!;
    const after = {
      ...journal.before,
      collection: OBS_COLLECTION,
      uuid: binding.inputUuid,
      ...('name' in journal.before ? { name: source.name } : {}),
    };
    const current = JSON.parse(await readFile(journal.path, 'utf8')) as unknown;
    if (isDeepStrictEqual(current, after)) continue;
    if (!isDeepStrictEqual(current, journal.before))
      throw new Error('audio_collection_transfer_journal_changed');
    const temporary = `${journal.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(after)}\n`, { mode: 0o600 });
      await rename(temporary, journal.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  if (transfer.completedMode) {
    const { snapshot, targetPath } = transfer.completedMode;
    const fields = snapshot.fields.flatMap((field) => {
      if (field.kind !== 'monitor') return [];
      const monitor = completedMonitor.parse(field);
      const source = transfer.sources.find(
        (source) => source.binding.inputUuid === monitor.inputUuid,
      );
      if (!source) return [];
      return [{ ...monitor, inputUuid: bindings[source.slots[0]!]!.inputUuid }];
    });
    if (fields.length) {
      const backup = { ...snapshot, collection: OBS_COLLECTION, endpoint, fields };
      try {
        await writeFile(targetPath, `${JSON.stringify(backup)}\n`, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (!isDeepStrictEqual(JSON.parse(await readFile(targetPath, 'utf8')), backup))
        throw new Error('audio_collection_transfer_completed_mode_conflict');
    }
  }
  await beforeCommit?.(bindings);
  await routing.commitCollectionTransfer(transfer.revision, bindings);
}

/** Keep the original technical reason in diagnostics and give preparation an actionable blocker. */
export function audioCollectionTransferError(cause: unknown): ObsVideoError {
  const reason = cause instanceof Error ? cause.message : '';
  const messages: Record<string, string> = {
    audio_collection_transfer_completed_mode_unconfirmed:
      '旧音频模式恢复记录尚未确认，无法安全迁移。请保留原集合和记录，核对旧操作后重试。',
    audio_collection_transfer_completed_mode_conflict:
      '专用集合已有不同的模式恢复记录，未覆盖现有记录。请保留诊断并核对后重试。',
    audio_collection_transfer_collection_changed:
      '请先在 OBS 选择原 Mizar 集合，再准备专用集合，以便保留已选择的声音设备。',
    audio_collection_transfer_output_active: '请先停止 OBS 输出，再迁移已选择的声音设备。',
    audio_collection_transfer_mode_pending:
      '旧音频模式切换尚未完成。请先在原集合处理，再准备专用集合。',
    audio_collection_transfer_journal_pending:
      '旧音频操作仍待确认。请先保留原集合和诊断，完成旧操作后再准备专用集合。',
    audio_collection_transfer_unsupported_source:
      '旧音频绑定使用画面附带音频，暂不能自动迁移。请先在原版本选择独立音频来源。',
    audio_collection_transfer_conflicting_choices:
      '同一声音角色保存了不同来源，暂不能自动迁移。请先在原版本统一设备选择。',
  };
  return new ObsVideoError(
    'audio_collection_transfer_blocked',
    messages[reason] ?? '已选择的声音设备尚未迁移完成。原配置已保留，请检查诊断后重试准备。',
    { cause },
  );
}
