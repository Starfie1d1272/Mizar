import { randomUUID } from 'node:crypto';
import {
  audioCollectionTransferSchema,
  type AudioCollectionTransfer,
  type AudioCollectionBindings,
} from './audio-collection-transfer.js';
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
import { assertManagedGlobalAudioSilent } from './audio.js';

const roles = ['game', 'remoteCommentary', 'microphone'] as const;
const musicOriginal = z
  .object({
    uuid: z.string().min(1),
    mode: z.enum([
      'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
      'OBS_MONITORING_TYPE_MONITOR_ONLY',
      'OBS_MONITORING_TYPE_NONE',
    ]),
    applied: z
      .enum([
        'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',
        'OBS_MONITORING_TYPE_MONITOR_ONLY',
        'OBS_MONITORING_TYPE_NONE',
      ])
      .optional(),
  })
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
    omitCommentary: z.boolean().default(false),
    musicBefore: musicOriginals,
    musicAfter: musicOriginals,
  })
  .strict();
const stateSchema = z
  .object({
    revision: z.string().uuid(),
    collectionTransfer: audioCollectionTransferSchema.nullable().default(null),
    desktop: obsAudioBindingSchema.nullable().default(null),
    lastDesktop: obsAudioBindingSchema.nullable().default(null),
    desktopMicrophone: obsAudioBindingSchema.nullable().default(null),
    independentCommentaryDisabled: z.boolean().default(false),
    cancelledCommentaryRevision: z.string().uuid().nullable().default(null),
    waitingIndependent: z
      .object({
        id: z.string().uuid(),
        endpoint: z.string().min(1),
        collection: z.string().min(1),
        commentaryRevision: z.string().uuid(),
        createdMicrophone: z.boolean().default(false),
        omitCommentary: z.boolean().default(false),
      })
      .strict()
      .nullable()
      .default(null),
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
        collectionTransfer: null,
        desktop: null,
        lastDesktop: null,
        desktopMicrophone: null,
        independentCommentaryDisabled: false,
        cancelledCommentaryRevision: null,
        waitingIndependent: null,
        transition: null,
        bindings: { game: null, remoteCommentary: null, microphone: null },
      };
      this.automaticEligible = true;
    }
    return this.state;
  }
  /** Do not infer a prior mode from an empty store, including a legacy saved one. */
  async hasNoEstablishedMode() {
    const state = await this.load();
    return Boolean(
      !state.desktop &&
      !state.lastDesktop &&
      !state.desktopMicrophone &&
      !state.independentCommentaryDisabled &&
      !state.cancelledCommentaryRevision &&
      !state.transition &&
      !state.waitingIndependent &&
      !roles.some((role) => state.bindings[role]),
    );
  }
  async requiresManualBindings() {
    return (await this.hasNoEstablishedMode()) && !this.automaticEligible;
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
    await this.saveState(
      { ...state, revision: randomUUID(), desktop: null, transition: null, bindings },
      true,
    );
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
    const { collection, candidates, inputs } = await this.inputs(obs);
    return roles.filter((role) => {
      const binding = state.bindings[role];
      return (
        binding !== null &&
        (binding.endpoint !== endpoint ||
          binding.collection !== collection ||
          ![...candidates, ...inputs.filter((input) => videoKinds.has(input.inputKind))].some(
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
    const managed =
      state.desktop || state.independentCommentaryDisabled
        ? null
        : await this.managedBindings(obs, endpoint);
    if (
      state.transition ||
      state.collectionTransfer ||
      (!state.desktop && !state.independentCommentaryDisabled && !managed) ||
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
      : state.independentCommentaryDisabled
        ? [state.bindings.game?.inputUuid, state.bindings.microphone?.inputUuid].filter(
            (uuid): uuid is string => Boolean(uuid),
          )
        : Object.values(managed!.ids);
    const inputs = records((await obs.call('GetInputList')).inputs);
    if (
      !state.desktop &&
      state.independentCommentaryDisabled &&
      (selectedIds.length !== 2 ||
        ['game', 'microphone'].some((role) => {
          const binding = state.bindings[role as 'game' | 'microphone'];
          return (
            !binding ||
            binding.endpoint !== endpoint ||
            binding.collection !== OBS_COLLECTION ||
            !inputs.some(
              (input) =>
                input.inputUuid === binding.inputUuid && input.inputKind === binding.inputKind,
            )
          );
        }))
    )
      return false;
    try {
      await assertManagedGlobalAudioSilent(obs);
    } catch {
      return false;
    }
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
    const scenes = obsDesiredScenes('http://127.0.0.1:3000');
    for (const scene of scenes) {
      const items = records(
        (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
      );
      if (
        selectedIds.some(
          (id) =>
            !(state.desktop && id === state.desktopMicrophone?.inputUuid) &&
            items.filter((item) => item.sourceUuid === id && item.sceneItemEnabled === true)
              .length !== 1,
        )
      )
        return false;
      for (const item of items) {
        if (typeof item.sceneItemEnabled !== 'boolean') return false;
        if (item.sceneItemEnabled !== true) continue;
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
        if (selected || videoKinds.has(String(input.inputKind))) continue;
        if (
          music &&
          input.inputKind === 'ffmpeg_source' &&
          (['bgm', 'stinger'] as const).some(
            (layer) =>
              input.inputUuid === music.sources[layer] &&
              input.inputName === (layer === 'bgm' ? '音乐' : '音效'),
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
    const { collection, candidates } = await this.inputs(obs);
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
      waitingIndependent: Boolean(state.waitingIndependent),
      independentCommentaryDisabled: state.independentCommentaryDisabled,
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
      desktopMicrophone: state.desktopMicrophone,
      independentCommentaryDisabled: state.independentCommentaryDisabled,
      cancelledCommentaryRevision: state.cancelledCommentaryRevision,
      waitingIndependent: state.waitingIndependent,
    };
  }
  /** Persist a newly prepared default once; existing mode choices always win. */
  async establishDefaultDesktop(obs: ObsRpc, endpoint: string): Promise<void> {
    const state = await this.load();
    if (state.transition || state.collectionTransfer || !(await this.hasNoEstablishedMode()))
      return;
    const current = await this.inputs(obs);
    if (current.collection !== OBS_COLLECTION) throw new Error('audio_collection_changed');
    await assertManagedGlobalAudioSilent(obs);
    const binding = (name: string, kind: string) => {
      const input = current.inputs.find(
        (candidate) => candidate.inputName === name && candidate.inputKind === kind,
      );
      if (!input) throw new Error('audio_bindings_incomplete');
      return {
        inputUuid: input.inputUuid,
        inputKind: input.inputKind,
        endpoint,
        collection: OBS_COLLECTION,
      };
    };
    const desktop = binding('桌面声音', 'wasapi_output_capture');
    const desktopMicrophone = binding('麦克风', 'wasapi_input_capture');
    if (
      (await this.load()).revision !== state.revision ||
      (await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION
    )
      throw new Error('audio_revision_changed');
    await this.saveState(
      { ...state, revision: randomUUID(), desktop, lastDesktop: desktop, desktopMicrophone },
      true,
    );
  }
  /** Only a verified owned collection may recreate these fixed-name identities. */
  async refreshManagedBindings(
    obs: ObsRpc,
    endpoint: string,
    beforeCommit?: (
      replacements: { before: string; after: string; kind: string }[],
    ) => Promise<void>,
  ) {
    const state = await this.load();
    if (state.transition || state.waitingIndependent || state.collectionTransfer)
      throw new Error('audio_mode_pending');
    if ((await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION)
      throw new Error('audio_collection_changed');
    const inputs = records((await obs.call('GetInputList')).inputs);
    let changed = false;
    const replacements: { before: string; after: string; kind: string }[] = [];
    const refresh = (binding: State['desktop'], name: string) => {
      if (!binding || binding.collection !== OBS_COLLECTION || binding.endpoint !== endpoint)
        return binding;
      const input = inputs.find(
        (input) => input.inputName === name && input.inputKind === binding.inputKind,
      );
      if (
        !input ||
        typeof input.inputUuid !== 'string' ||
        !input.inputUuid ||
        input.inputUuid === binding.inputUuid
      )
        return binding;
      changed = true;
      replacements.push({
        before: binding.inputUuid,
        after: input.inputUuid,
        kind: binding.inputKind,
      });
      return { ...binding, inputUuid: input.inputUuid };
    };
    const next: State = {
      ...state,
      desktop: refresh(state.desktop, '桌面声音'),
      lastDesktop: refresh(state.lastDesktop, '桌面声音'),
      desktopMicrophone: refresh(state.desktopMicrophone, '麦克风'),
      bindings: {
        game: refresh(state.bindings.game, '游戏声音'),
        remoteCommentary: refresh(state.bindings.remoteCommentary, '其他解说'),
        microphone: refresh(state.bindings.microphone, '麦克风'),
      },
    };
    if ((await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION)
      throw new Error('audio_collection_changed');
    if (changed) {
      await beforeCommit?.(replacements);
      if ((await this.load()).revision !== state.revision)
        throw new Error('audio_revision_changed');
      await this.saveState({ ...next, revision: randomUUID() }, true);
      this.invalidateSelections();
    }
  }
  async collectionTransferState() {
    return structuredClone(await this.load());
  }
  async saveCollectionTransfer(transfer: AudioCollectionTransfer) {
    const state = await this.load();
    if (state.revision !== transfer.revision || state.transition || state.waitingIndependent)
      throw new Error('audio_collection_transfer_context_changed');
    await this.saveState({
      ...state,
      collectionTransfer: audioCollectionTransferSchema.parse(transfer),
    });
  }
  async commitCollectionTransfer(revision: string, bindings: AudioCollectionBindings) {
    const state = await this.load();
    if (
      state.revision !== revision ||
      !state.collectionTransfer ||
      state.transition ||
      state.waitingIndependent
    )
      throw new Error('audio_collection_transfer_context_changed');
    await this.saveState(
      {
        ...state,
        revision: randomUUID(),
        collectionTransfer: null,
        desktop: bindings.desktop ?? state.desktop,
        lastDesktop: bindings.lastDesktop ?? state.lastDesktop,
        desktopMicrophone: bindings.desktopMicrophone ?? state.desktopMicrophone,
        bindings: {
          game: bindings.game ?? state.bindings.game,
          remoteCommentary: bindings.remoteCommentary ?? state.bindings.remoteCommentary,
          microphone: bindings.microphone ?? state.bindings.microphone,
        },
      },
      true,
    );
    this.invalidateSelections();
  }
  private async saveState(next: State, clearAutomatic = false) {
    if (
      this.state?.collectionTransfer &&
      next.collectionTransfer &&
      next.revision !== this.state.revision
    )
      throw new Error('audio_collection_transfer_pending');
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
    this.state = next;
    if (clearAutomatic) this.automaticEligible = false;
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
      independentCommentaryDisabled:
        side === 'after' && !desktop
          ? transition.omitCommentary
          : state.independentCommentaryDisabled,
      waitingIndependent: side === 'after' && !desktop ? null : state.waitingIndependent,
      transition: null,
    });
  }
  async waitForIndependent(
    revision: string,
    endpoint: string,
    collection: string,
    commentaryRevision: string,
    omitCommentary: boolean,
  ) {
    const state = await this.load();
    if (state.revision !== revision) throw new Error('audio_revision_changed');
    if (
      state.transition ||
      state.collectionTransfer ||
      (!state.desktop && !state.independentCommentaryDisabled) ||
      (state.desktop &&
        (state.desktop.endpoint !== endpoint || state.desktop.collection !== collection))
    )
      throw new Error('audio_mode_pending');
    const existing = state.waitingIndependent;
    if (
      existing &&
      existing.endpoint === endpoint &&
      existing.collection === collection &&
      existing.commentaryRevision === commentaryRevision
    )
      return existing;
    const waitingIndependent = {
      id: randomUUID(),
      endpoint,
      collection,
      commentaryRevision,
      createdMicrophone: false,
      omitCommentary,
    };
    await this.saveState({ ...state, revision: randomUUID(), waitingIndependent });
    return waitingIndependent;
  }
  async cancelIndependentWait(id?: string, userCancelled = false, revision?: string) {
    const state = await this.load();
    if (revision && state.revision !== revision) throw new Error('audio_revision_changed');
    if (state.transition) throw new Error('audio_mode_pending');
    if (!state.waitingIndependent || (id && state.waitingIndependent.id !== id)) return false;
    await this.saveState({
      ...state,
      revision: randomUUID(),
      cancelledCommentaryRevision:
        userCancelled && !state.desktop
          ? state.waitingIndependent.commentaryRevision
          : state.cancelledCommentaryRevision,
      waitingIndependent: null,
    });
    return true;
  }
  async adoptPreparedBindings(
    obs: ObsRpc,
    endpoint: string,
    waitId: string,
    revision: string,
    ids: Partial<Record<ObsAudioRole, string>>,
    createdMicrophone: boolean,
  ) {
    const state = await this.load();
    if (
      state.revision !== revision ||
      state.waitingIndependent?.id !== waitId ||
      state.transition ||
      state.collectionTransfer ||
      (!state.desktop && !state.independentCommentaryDisabled)
    )
      throw new Error('audio_revision_changed');
    const current = await this.inputs(obs);
    if (
      current.collection !== state.waitingIndependent.collection ||
      endpoint !== state.waitingIndependent.endpoint ||
      !ids.game ||
      !ids.microphone ||
      (!ids.remoteCommentary && !state.waitingIndependent.omitCommentary) ||
      new Set(Object.values(ids)).size !== Object.values(ids).length
    )
      throw new Error('audio_selection_changed');
    const bindings = { ...state.bindings };
    for (const role of roles) {
      if (!ids[role]) continue;
      const input = current.inputs.find((candidate) => candidate.inputUuid === ids[role]);
      if (!input) throw new Error('audio_selection_changed');
      const existing = bindings[role];
      if (
        existing &&
        !(role === 'remoteCommentary' && !state.desktop && state.independentCommentaryDisabled) &&
        (existing.inputUuid !== input.inputUuid ||
          existing.inputKind !== input.inputKind ||
          existing.endpoint !== endpoint ||
          existing.collection !== current.collection)
      )
        throw new Error('audio_binding_changed');
      if (
        !existing ||
        (role === 'remoteCommentary' && !state.desktop && state.independentCommentaryDisabled)
      )
        bindings[role] = {
          inputUuid: input.inputUuid,
          inputKind: input.inputKind,
          endpoint,
          collection: current.collection,
        };
    }
    await this.saveState({
      ...state,
      revision: randomUUID(),
      bindings,
      waitingIndependent: {
        ...state.waitingIndependent,
        createdMicrophone: state.waitingIndependent.createdMicrophone || createdMicrophone,
      },
    });
    return (await this.load()).revision;
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
    if (state.transition || state.collectionTransfer) throw new Error('audio_mode_pending');
    if (mode === 'desktop' && state.waitingIndependent) {
      await this.cancelIndependentWait(state.waitingIndependent.id, true);
      return;
    }
    if (mode === 'desktop' && state.desktop) throw new Error('audio_mode_already_desktop');
    let ids: Partial<Record<ObsAudioRole, string>> = {};
    let desktop: State['desktop'] = null;
    let desktopMicrophone: State['desktopMicrophone'] = null;
    if (mode === 'independent') {
      if (state.waitingIndependent?.omitCommentary) {
        const invalid = await this.invalidBindings(obs, endpoint);
        if (
          !state.bindings.game ||
          !state.bindings.microphone ||
          invalid.includes('game') ||
          invalid.includes('microphone')
        )
          throw new Error('audio_bindings_incomplete');
        ids = {
          game: state.bindings.game.inputUuid,
          microphone: state.bindings.microphone.inputUuid,
        };
      } else {
        if (
          !state.bindings.remoteCommentary ||
          (await this.invalidBindings(obs, endpoint)).includes('remoteCommentary')
        )
          throw new Error('audio_commentary_unavailable');
        const managed = await this.managedBindings(obs, endpoint);
        if (!managed) throw new Error('audio_bindings_incomplete');
        ids = managed.ids;
      }
    } else {
      const current = await this.inputs(obs);
      if (current.collection !== OBS_COLLECTION) throw new Error('audio_setup_context_changed');
      await assertManagedGlobalAudioSilent(obs);
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
      const microphone = current.candidates.find(
        (input) => input.inputName === '麦克风' && input.inputKind === 'wasapi_input_capture',
      );
      if (!ids.microphone && microphone) ids.microphone = microphone.inputUuid;
      let input = current.candidates.find(
        (input) => input.inputName === '桌面声音' && input.inputKind === 'wasapi_output_capture',
      );
      if (selectionId) {
        const selected = this.selections.get(selectionId);
        if (
          !selected ||
          selected.until <= this.now() ||
          selected.endpoint !== endpoint ||
          selected.collection !== current.collection ||
          selected.input.inputUuid !== input?.inputUuid
        )
          throw new Error('audio_selection_changed');
      }
      if (!input) {
        if (current.inputs.some((input) => input.inputName === '桌面声音'))
          throw new Error('audio_desktop_missing');
        const created = await obs.call('CreateInput', {
          sceneName: obsDesiredScenes('http://127.0.0.1')[0]!.sceneName,
          inputName: '桌面声音',
          inputKind: 'wasapi_output_capture',
          inputSettings: { device_id: 'default' },
          sceneItemEnabled: false,
        });
        const updated = await this.inputs(obs);
        input = updated.candidates.find(
          (input) =>
            input.inputUuid === created.inputUuid &&
            input.inputName === '桌面声音' &&
            input.inputKind === 'wasapi_output_capture',
        );
        if (
          !input ||
          updated.collection !== current.collection ||
          (await this.load()).revision !== revision
        )
          throw new Error('audio_selection_changed');
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
          omitCommentary: !desktop && Boolean(state.waitingIndependent?.omitCommentary),
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
    if ((await obs.call('GetSceneCollectionList')).currentSceneCollectionName === OBS_COLLECTION)
      throw new Error('audio_managed_roles_required');
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
    await this.saveState(
      {
        ...state,
        revision: randomUUID(),
        bindings: { ...state.bindings, [command.role]: binding },
      },
      true,
    );
  }
}
