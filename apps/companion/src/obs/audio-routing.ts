import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  obsAudioBindingSchema,
  type ObsAudioBindCommand,
  type ObsAudioRole,
  type ObsAudioRoutingStatus,
} from '@mizar/protocol/obs';
import type { ObsRpc } from './reconcile.js';
import { OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';
import { BP_COMPACT_INPUT, BP_COMPACT_PATH } from './bp-overlay.js';
import { inspectAudioSceneGraph } from './audio-scene-graph.js';

const roles = ['game', 'remoteCommentary', 'microphone'] as const;
const musicOriginal = z
  .object({ uuid: z.string().min(1), mode: z.literal('OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT') })
  .strict()
  .nullable();
const musicOriginals = z.object({ bgm: musicOriginal, stinger: musicOriginal }).strict();
export type MonitorOriginals = z.infer<typeof musicOriginals>;
const modeTransition = z
  .object({
    id: z.string().uuid(),
    endpoint: z.string().min(1),
    collection: z.string().min(1),
    targetDesktop: obsAudioBindingSchema.nullable(),
    targetMicrophone: obsAudioBindingSchema.nullable(),
    musicBefore: musicOriginals,
    musicAfter: musicOriginals,
  })
  .strict();
export type ModeTransition = z.infer<typeof modeTransition>;
const stateSchema = z
  .object({
    revision: z.string().uuid(),
    desktop: obsAudioBindingSchema.nullable().default(null),
    lastDesktop: obsAudioBindingSchema.nullable().default(null),
    desktopMicrophone: obsAudioBindingSchema.nullable().default(null),
    transition: z
      .union([modeTransition, z.boolean(), z.null()])
      .default(null)
      .transform((value) => (value === false ? null : value)),
    bindings: z
      .object({
        game: obsAudioBindingSchema.nullable(),
        remoteCommentary: obsAudioBindingSchema.nullable(),
        microphone: obsAudioBindingSchema.nullable(),
      })
      .strict(),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
type Input = { inputUuid: string; inputName: string; inputKind: string };
const audioKinds = new Set([
  'wasapi_output_capture',
  'wasapi_input_capture',
  'wasapi_process_output_capture',
]);
const videoKinds = new Set(['game_capture', 'window_capture']);
const visualKinds = new Set([
  'image_source',
  'color_source',
  'color_source_v3',
  'text_gdiplus',
  'text_gdiplus_v2',
]);
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
      )
    : [];
}

/** Explicit identities are revalidated against OBS; selection tokens expire and contain no PID. */
export class ObsAudioRouting {
  private listeners = new Set<() => void>();
  onChanged(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private state: State | undefined;
  private automaticEligible = false;
  private selections = new Map<
    string,
    { input: Input; collection: string; endpoint: string; until: number }
  >();
  constructor(
    private readonly path: string,
    private readonly now = Date.now,
  ) {}
  invalidateSelections() {
    this.selections.clear();
  }
  private async load(): Promise<State> {
    if (this.state) return this.state;
    try {
      this.state = stateSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('audio_routing_storage_invalid', { cause: error });
      this.state = {
        revision: randomUUID(),
        desktop: null,
        lastDesktop: null,
        desktopMicrophone: null,
        transition: null,
        bindings: { game: null, remoteCommentary: null, microphone: null },
      };
      this.automaticEligible = true;
    }
    return this.state;
  }
  async enabled() {
    const state = await this.load();
    return roles.some((role) => state.bindings[role] !== null);
  }
  async gameBinding() {
    const state = await this.load();
    return {
      revision: state.revision,
      binding: state.desktop || state.transition ? null : state.bindings.game,
    };
  }
  async commentaryBinding() {
    const state = await this.load();
    return {
      revision: state.revision,
      binding: state.bindings.remoteCommentary,
      game: state.bindings.game,
      microphone: state.bindings.microphone,
    };
  }
  /** Seed a never-configured routing store once; explicit user choices always win. */
  async seedAutomatic(obs: ObsRpc, endpoint: string, ids: Record<ObsAudioRole, string>) {
    const state = await this.load();
    if (!this.automaticEligible || roles.some((role) => state.bindings[role])) return;
    const current = await this.inputs(obs);
    if (new Set(Object.values(ids)).size !== roles.length)
      throw new Error('audio_binding_duplicate');
    const bindings = {} as State['bindings'];
    for (const role of roles) {
      const input = current.candidates.find((item) => item.inputUuid === ids[role]);
      if (!input) throw new Error('audio_selection_changed');
      bindings[role] = {
        inputUuid: input.inputUuid,
        inputKind: input.inputKind,
        collection: current.collection,
        endpoint,
      };
    }
    if (
      (await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== current.collection
    )
      throw new Error('audio_selection_changed');
    const next: State = {
      revision: randomUUID(),
      desktop: null,
      lastDesktop: state.lastDesktop,
      desktopMicrophone: state.desktopMicrophone,
      transition: null,
      bindings,
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
    this.state = next;
    this.automaticEligible = false;
    for (const listener of this.listeners) listener();
  }
  private async inputs(obs: ObsRpc) {
    const version = await obs.call('GetVersion');
    const requests = version.availableRequests;
    if (
      !Array.isArray(requests) ||
      ![
        'GetInputList',
        'GetInputSettings',
        'GetSceneCollectionList',
        'GetSpecialInputs',
        'GetSceneList',
        'GetSceneItemList',
        'GetGroupSceneItemList',
      ].every((name) => requests.includes(name))
    )
      throw new Error('audio_obs_capability_missing');
    const collection = (await obs.call('GetSceneCollectionList')).currentSceneCollectionName;
    if (typeof collection !== 'string' || !collection) throw new Error('audio_collection_unknown');
    const raw = (await obs.call('GetInputList')).inputs;
    if (!Array.isArray(raw)) throw new Error('audio_inputs_unknown');
    const inputs = records(raw).filter(
      (i): i is Input =>
        typeof i?.inputUuid === 'string' &&
        typeof i?.inputName === 'string' &&
        typeof i?.inputKind === 'string',
    );
    if (new Set(inputs.map((input) => input.inputUuid)).size !== inputs.length)
      throw new Error('audio_input_identity_ambiguous');
    const candidates: Input[] = [];
    for (const input of inputs) {
      if (audioKinds.has(input.inputKind)) candidates.push(input);
      else if (videoKinds.has(input.inputKind)) {
        const settings = (await obs.call('GetInputSettings', { inputUuid: input.inputUuid }))
          .inputSettings as Record<string, unknown>;
        if (settings?.capture_audio === true) candidates.push(input);
      }
    }
    return { collection, inputs, candidates };
  }
  async invalidBindings(obs: ObsRpc, endpoint: string): Promise<ObsAudioRole[]> {
    const state = await this.load();
    const { collection, candidates } = await this.inputs(obs);
    return roles.filter((role) => {
      const binding = state.bindings[role];
      return (
        binding !== null &&
        (binding.endpoint !== endpoint ||
          binding.collection !== collection ||
          !candidates.some(
            (input) =>
              input.inputUuid === binding.inputUuid && input.inputKind === binding.inputKind,
          ))
      );
    });
  }
  async managedBindings(obs: ObsRpc, endpoint: string) {
    const state = await this.load();
    if (!(await this.enabled())) return null;
    if (roles.some((role) => !state.bindings[role])) return null;
    if ((await this.invalidBindings(obs, endpoint)).length)
      throw new Error('audio_bindings_incomplete');
    return {
      revision: state.revision,
      ids: Object.fromEntries(
        roles.map((role) => [role, state.bindings[role]!.inputUuid]),
      ) as Record<ObsAudioRole, string>,
    };
  }
  /** Check the active mode and every managed scene before enabling music monitoring. */
  async musicMonitorSafe(
    obs: ObsRpc,
    endpoint: string,
    music?: {
      owner: string;
      sources: { bgm: string | null; stinger: string | null };
      baseUrl: string;
    },
  ): Promise<boolean> {
    const state = await this.load();
    const managed = state.desktop ? null : await this.managedBindings(obs, endpoint);
    if (
      state.transition ||
      (!state.desktop && !managed) ||
      (await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION ||
      (state.desktop &&
        (state.desktop.endpoint !== endpoint || state.desktop.collection !== OBS_COLLECTION))
    )
      return false;
    const selectedIds = state.desktop
      ? [
          state.desktop.inputUuid,
          ...(state.desktopMicrophone ? [state.desktopMicrophone.inputUuid] : []),
        ]
      : Object.values(managed!.ids);
    const specials = await obs.call('GetSpecialInputs');
    if (
      Object.entries(specials).some(
        ([key, value]) => key.startsWith('desktop') && typeof value === 'string' && value,
      )
    )
      return false;
    const inputs = records((await obs.call('GetInputList')).inputs);
    if (state.desktop) {
      if (
        !inputs.some(
          (i) =>
            i.inputUuid === state.desktop!.inputUuid && i.inputKind === 'wasapi_output_capture',
        )
      )
        return false;
    } else if (
      selectedIds.some(
        (id) => inputs.find((i) => i.inputUuid === id)?.inputKind === 'wasapi_output_capture',
      )
    )
      return false;
    for (const scene of obsDesiredScenes('http://127.0.0.1:3000')) {
      const items = records(
        (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
      );
      if (
        selectedIds.some(
          (id) =>
            items.filter((i) => i.sourceUuid === id && i.sceneItemEnabled === true).length !== 1,
        )
      )
        return false;
      for (const item of items) {
        if (typeof item.sceneItemEnabled !== 'boolean') return false;
        if (item.sceneItemEnabled !== true) continue;
        if (item.isGroup === true || item.sourceType === 'OBS_SOURCE_TYPE_SCENE') return false;
        const input = inputs.find((i) => i.inputUuid === item.sourceUuid);
        if (!input) return false;
        const selected = selectedIds.includes(String(input.inputUuid));
        if (input.inputKind === 'wasapi_output_capture' && !selected) return false;
        if (audioKinds.has(String(input.inputKind)) && !selected) return false;
        if (['game_capture', 'window_capture'].includes(String(input.inputKind)) && !selected) {
          const settings = (await obs.call('GetInputSettings', { inputUuid: input.inputUuid }))
            .inputSettings;
          if (!settings || typeof settings !== 'object') return false;
          if ((settings as Record<string, unknown>).capture_audio !== false) return false;
        }
        if (
          selected ||
          videoKinds.has(String(input.inputKind)) ||
          visualKinds.has(String(input.inputKind))
        )
          continue;
        if (
          music &&
          input.inputKind === 'ffmpeg_source' &&
          (['bgm', 'stinger'] as const).some(
            (layer) =>
              input.inputUuid === music.sources[layer] &&
              (input.inputName ===
                `Mizar · ${layer === 'bgm' ? 'BGM' : 'Stinger'} · ${music.owner}` ||
                (typeof input.inputName === 'string' &&
                  (layer === 'bgm' ? /^音乐(?: \d+)?$/ : /^音效(?: \d+)?$/).test(input.inputName))),
          )
        )
          continue;
        if (music && input.inputKind === 'browser_source') {
          const desired = obsDesiredScenes(music.baseUrl).find(
            (s) => s.browserInput === input.inputName,
          );
          const expected =
            desired?.browserUrl ??
            (input.inputName === BP_COMPACT_INPUT
              ? new URL(BP_COMPACT_PATH, music.baseUrl).toString()
              : null);
          if (expected) {
            const settings = (await obs.call('GetInputSettings', { inputUuid: input.inputUuid }))
              .inputSettings;
            if (
              settings &&
              typeof settings === 'object' &&
              (settings as Record<string, unknown>).url === expected
            )
              continue;
          }
        }
        return false;
      }
    }
    const after = await this.load();
    return (
      !after.transition &&
      after.revision === state.revision &&
      after.desktop?.inputUuid === state.desktop?.inputUuid
    );
  }
  async read(obs: ObsRpc, endpoint: string): Promise<ObsAudioRoutingStatus> {
    const state = await this.load();
    const { collection, inputs, candidates } = await this.inputs(obs);
    for (const [id, selection] of this.selections)
      if (selection.until <= this.now()) this.selections.delete(id);
    const choices = candidates.map((input) => {
      const selectionId = randomUUID();
      this.selections.set(selectionId, { input, collection, endpoint, until: this.now() + 30_000 });
      return { selectionId, name: input.inputName, kind: input.inputKind, uuid: input.inputUuid };
    });
    while (this.selections.size > 2048)
      this.selections.delete(this.selections.keys().next().value!);
    const bindings = Object.fromEntries(
      roles.map((role) => {
        const binding = state.bindings[role];
        if (!binding) return [role, null];
        const found = candidates.find(
          (i) =>
            i.inputUuid === binding.inputUuid &&
            i.inputKind === binding.inputKind &&
            collection === binding.collection &&
            endpoint === binding.endpoint,
        );
        return [role, { ...binding, valid: Boolean(found), name: found?.inputName ?? null }];
      }),
    ) as ObsAudioRoutingStatus['bindings'];
    const findings: string[] = [];
    const specials = await obs.call('GetSpecialInputs');
    if (
      Object.entries(specials).some(
        ([key, value]) => key.startsWith('desktop') && typeof value === 'string' && value,
      )
    )
      findings.push(
        'OBS 全局桌面音频可能重复采集应用和监听声音。请在 OBS 设置 → 音频中核对并自行迁移。',
      );
    for (const input of candidates.filter((i) => videoKinds.has(i.inputKind)))
      findings.push(`${input.inputName} 已启用捕获音频；请核对是否与应用音频或桌面音频重复。`);
    if (inputs.some((i) => i.inputKind === 'wasapi_output_capture'))
      findings.push('桌面音频可能包含应用音频和音乐监听；请在 OBS 中核对并自行迁移。');
    const scenes = (await obs.call('GetSceneList')).scenes;
    if (!Array.isArray(scenes)) throw new Error('audio_scenes_unknown');
    for (const scene of records(scenes)) {
      if (typeof scene?.sceneName !== 'string') continue;
      const counts = new Map<string, number>();
      const walk = async (name: string, group: boolean, ancestors: Set<string>): Promise<void> => {
        if (ancestors.has(name) || ancestors.size >= 16) return;
        const next = new Set(ancestors).add(name);
        const result = await obs.call(group ? 'GetGroupSceneItemList' : 'GetSceneItemList', {
          sceneName: name,
        });
        if (!Array.isArray(result.sceneItems)) throw new Error('audio_scene_items_unknown');
        for (const item of records(result.sceneItems)) {
          if (item.sceneItemEnabled !== true) continue;
          if (
            typeof item.sourceUuid === 'string' &&
            candidates.some((i) => i.inputUuid === item.sourceUuid)
          )
            counts.set(item.sourceUuid, (counts.get(item.sourceUuid) ?? 0) + 1);
          if (
            typeof item.sourceName === 'string' &&
            (item.isGroup === true || item.sourceType === 'OBS_SOURCE_TYPE_SCENE')
          )
            await walk(item.sourceName, item.isGroup === true, next);
        }
      };
      await walk(scene.sceneName, false, new Set());
      for (const [uuid, count] of counts)
        if (count > 1) {
          const input = candidates.find((i) => i.inputUuid === uuid)!;
          findings.push(
            `${scene.sceneName} 中 ${input.inputName} 出现 ${count} 次（含嵌套场景）；请在 OBS 核对重复路径。`,
          );
        }
    }
    findings.push('请在 OBS 核对监听回灌及输出音轨，并录制试听。');
    return {
      revision: state.revision,
      endpoint,
      collection,
      desktop: state.desktop,
      desktopMicrophone: state.desktopMicrophone
        ? {
            ...state.desktopMicrophone,
            valid:
              state.desktopMicrophone.endpoint === endpoint &&
              state.desktopMicrophone.collection === collection &&
              candidates.some(
                (input) =>
                  input.inputUuid === state.desktopMicrophone!.inputUuid &&
                  input.inputKind === state.desktopMicrophone!.inputKind,
              ),
            name:
              candidates.find(
                (input) =>
                  input.inputUuid === state.desktopMicrophone!.inputUuid &&
                  input.inputKind === state.desktopMicrophone!.inputKind,
              )?.inputName ?? null,
          }
        : null,
      transition: Boolean(state.transition),
      bindings,
      candidates: choices,
      findings,
    };
  }
  async desktopBinding() {
    return (await this.load()).desktop;
  }
  async modePending() {
    return Boolean((await this.load()).transition);
  }
  async modeRecoveryState() {
    const state = await this.load();
    return {
      revision: state.revision,
      desktop: state.desktop,
      transition: state.transition,
      bindings: state.bindings,
    };
  }
  private async saveState(next: State) {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  async commitModeTransition(id: string, side: 'before' | 'after') {
    const state = await this.load();
    const transition = state.transition;
    if (!transition || transition === true || transition.id !== id)
      throw new Error('audio_mode_transition_changed');
    const desktop = side === 'after' ? transition.targetDesktop : state.desktop;
    await this.saveState({
      ...state,
      revision: id,
      desktop,
      lastDesktop: desktop ?? state.desktop ?? state.lastDesktop,
      desktopMicrophone: side === 'after' ? transition.targetMicrophone : state.desktopMicrophone,
      transition: null,
    });
  }
  async switchMode(
    obs: ObsRpc,
    endpoint: string,
    revision: string,
    mode: 'desktop' | 'independent',
    selectionId: string | undefined,
    apply: (
      ids: Partial<Record<ObsAudioRole, string>>,
      desktopUuid: string | undefined,
      verify: () => Promise<boolean>,
      begin: (before: MonitorOriginals, after: MonitorOriginals) => Promise<string>,
      commit: (id: string) => Promise<void>,
    ) => Promise<void>,
  ) {
    const state = await this.load();
    if (state.revision !== revision) throw new Error('audio_revision_changed');
    if (state.transition) throw new Error('audio_mode_pending');
    if (mode === 'desktop' && state.desktop) throw new Error('audio_mode_already_desktop');
    let ids: Partial<Record<ObsAudioRole, string>> = {};
    let desktop: State['desktop'] = null;
    let desktopMicrophone: State['desktopMicrophone'] = null;
    if (mode === 'independent') {
      const managed = await this.managedBindings(obs, endpoint);
      if (!managed) throw new Error('audio_bindings_incomplete');
      ids = managed.ids;
    } else {
      const [stream, record, current, specials] = await Promise.all([
        obs.call('GetStreamStatus'),
        obs.call('GetRecordStatus'),
        this.inputs(obs),
        obs.call('GetSpecialInputs'),
      ]);
      if (
        stream.outputActive !== false ||
        record.outputActive !== false ||
        current.collection !== OBS_COLLECTION
      )
        throw new Error('audio_setup_context_changed');
      if (Object.values(specials).some((value) => typeof value === 'string' && value))
        throw new Error('audio_global_path_unresolved');
      const managedNames = obsDesiredScenes('http://127.0.0.1').map((scene) => scene.sceneName);
      const graph = await inspectAudioSceneGraph(obs, managedNames);
      const managedIds = new Set(
        graph
          .filter((container) => container.managedRoots.size)
          .flatMap((container) => container.items.map((item) => item.sourceUuid)),
      );
      for (const role of roles) {
        const binding = state.bindings[role];
        if (
          binding &&
          binding.endpoint === endpoint &&
          binding.collection === current.collection &&
          current.candidates.some(
            (input) =>
              input.inputUuid === binding.inputUuid && input.inputKind === binding.inputKind,
          )
        )
          ids[role] = binding.inputUuid;
      }
      if (!ids.microphone) {
        const microphones = current.candidates.filter(
          (input) => input.inputKind === 'wasapi_input_capture' && managedIds.has(input.inputUuid),
        );
        if (microphones.length === 1) ids.microphone = microphones[0]!.inputUuid;
      }
      let input: Input | undefined;
      if (selectionId) {
        const selected = this.selections.get(selectionId);
        input = current.candidates.find(
          (value) =>
            value.inputUuid === selected?.input.inputUuid &&
            value.inputKind === 'wasapi_output_capture',
        );
        if (
          !selected ||
          selected.until <= this.now() ||
          !input ||
          selected.endpoint !== endpoint ||
          selected.collection !== current.collection
        )
          throw new Error('audio_selection_changed');
      } else {
        const prior = state.desktop ?? state.lastDesktop;
        if (prior?.endpoint === endpoint && prior.collection === current.collection)
          input = current.candidates.find(
            (value) =>
              value.inputUuid === prior.inputUuid && value.inputKind === 'wasapi_output_capture',
          );
        if (!input) {
          const candidates = current.candidates.filter(
            (value) =>
              value.inputKind === 'wasapi_output_capture' && managedIds.has(value.inputUuid),
          );
          if (candidates.length > 1) {
            const deviceIds = await Promise.all(
              candidates.map(async (candidate) => {
                const result = await obs.call('GetInputSettings', {
                  inputUuid: candidate.inputUuid,
                });
                const settings = result.inputSettings as Record<string, unknown> | undefined;
                return typeof settings?.device_id === 'string' && settings.device_id
                  ? settings.device_id.toLowerCase()
                  : null;
              }),
            );
            if (deviceIds.some((id) => !id) || new Set(deviceIds).size !== 1)
              throw new Error('audio_desktop_choice_required');
          }
          input = candidates[0];
        }
        if (!input) {
          const [streamNow, recordNow, collectionNow] = await Promise.all([
            obs.call('GetStreamStatus'),
            obs.call('GetRecordStatus'),
            obs.call('GetSceneCollectionList'),
          ]);
          if (
            streamNow.outputActive !== false ||
            recordNow.outputActive !== false ||
            collectionNow.currentSceneCollectionName !== current.collection ||
            (await this.load()).revision !== revision
          )
            throw new Error('audio_setup_context_changed');
          const names = new Set(current.inputs.map((value) => value.inputName));
          let name = '桌面声音';
          for (let suffix = 2; names.has(name); suffix++) name = `桌面声音 ${suffix}`;
          const created = await obs.call('CreateInput', {
            sceneName: managedNames[0],
            inputName: name,
            inputKind: 'wasapi_output_capture',
            inputSettings: { device_id: 'default' },
            sceneItemEnabled: false,
          });
          const updated = await this.inputs(obs);
          input = updated.candidates.find(
            (value) =>
              value.inputUuid === created.inputUuid &&
              value.inputName === name &&
              value.inputKind === 'wasapi_output_capture',
          );
          if (!input || updated.collection !== current.collection)
            throw new Error('audio_selection_changed');
        }
      }
      if (ids.microphone) {
        const microphone = current.candidates.find(
          (candidate) => candidate.inputUuid === ids.microphone,
        )!;
        desktopMicrophone = {
          inputUuid: microphone.inputUuid,
          inputKind: microphone.inputKind,
          endpoint,
          collection: current.collection,
        };
      }
      desktop = {
        inputUuid: input.inputUuid,
        inputKind: input.inputKind,
        endpoint,
        collection: current.collection,
      };
    }
    let modeId: string | undefined;
    const begin = async (musicBefore: MonitorOriginals, musicAfter: MonitorOriginals) => {
      if (modeId || (await this.load()).revision !== revision || (await this.load()).transition)
        throw new Error('audio_mode_transition_changed');
      modeId = randomUUID();
      await this.saveState({
        ...state,
        transition: {
          id: modeId,
          endpoint,
          collection: desktop?.collection ?? OBS_COLLECTION,
          targetDesktop: desktop,
          targetMicrophone: desktopMicrophone,
          musicBefore,
          musicAfter,
        },
      });
      return modeId;
    };
    await apply(
      ids,
      desktop?.inputUuid,
      async () => (await this.load()).revision === revision,
      begin,
      async (id) => {
        if (id !== modeId) throw new Error('audio_mode_transition_changed');
        await this.commitModeTransition(id, 'after');
      },
    );
    if (!modeId || (await this.load()).revision !== modeId || (await this.load()).transition)
      throw new Error('audio_mode_unconfirmed');
  }
  async bind(
    obs: ObsRpc,
    command: ObsAudioBindCommand,
    endpoint: string,
    beforeCommit?: (binding: State['bindings'][ObsAudioRole]) => Promise<void>,
  ) {
    const state = await this.load();
    if (state.transition || state.desktop) throw new Error('audio_mode_pending');
    if (state.revision !== command.revision) throw new Error('audio_revision_changed');
    let binding: State['bindings'][ObsAudioRole] = null;
    if (command.selectionId) {
      const selected = this.selections.get(command.selectionId);
      if (!selected || selected.until <= this.now()) throw new Error('audio_selection_expired');
      const current = await this.inputs(obs);
      const input = current.candidates.find(
        (i) => i.inputUuid === selected.input.inputUuid && i.inputKind === selected.input.inputKind,
      );
      if (!input || current.collection !== selected.collection || endpoint !== selected.endpoint)
        throw new Error('audio_selection_changed');
      if (
        roles.some(
          (role) =>
            role !== command.role &&
            state.bindings[role]?.inputUuid === input.inputUuid &&
            state.bindings[role]?.collection === current.collection,
        )
      )
        throw new Error('audio_binding_duplicate');
      binding = {
        inputUuid: input.inputUuid,
        inputKind: input.inputKind,
        collection: current.collection,
        endpoint,
      };
    }
    if (
      binding &&
      (await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== binding.collection
    )
      throw new Error('audio_selection_changed');
    await beforeCommit?.(binding);
    const next: State = {
      revision: randomUUID(),
      desktop: state.desktop,
      lastDesktop: state.lastDesktop,
      desktopMicrophone: state.desktopMicrophone,
      transition: state.transition,
      bindings: { ...state.bindings, [command.role]: binding },
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
    this.state = next;
    this.automaticEligible = false;
    for (const listener of this.listeners) listener();
  }
}
