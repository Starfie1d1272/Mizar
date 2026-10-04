import { Button, Select } from '../ui';
import { HUD_DESIGN_CHOICES, parseHudDesign, type HudDesign } from '../program/hud-design';
import { ToolShell } from '../patterns';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { PointerEvent } from 'react';

import {
  BUILTIN_LAYOUT_ID,
  BUILTIN_THEME_ID,
  HUD_CANVAS_HEIGHT,
  HUD_CANVAS_WIDTH,
  changePlacementAnchor,
  createDefaultHudConfigDocument,
  getBuiltinLayout,
  getBuiltinPreset,
  getBuiltinTheme,
  moveWidgetPlacement,
  normalizeHudPlacement,
  placementToBox,
  resetLayoutDraft,
  resetPresetDraft,
  resetThemeDraft,
  resizeRadarPlacement,
  type HudConfigDocument,
  type HudLayout,
  type HudPreset,
  type HudTheme,
  type HudWidgetId,
} from '@mizar/hud-config';
import type { ProgramSnapshot } from '@mizar/protocol/program';
import { defaultMapGeometryProvider } from '@mizar/radar';

import {
  getHudEditorFixture,
  HUD_EDITOR_DEFAULT_FIXTURE_ID,
  HUD_EDITOR_FIXTURE_GROUPS,
  PROGRAM_FIXTURE_LABELS,
  type ProgramFixtureId,
} from '../program/fixtures';
import { radarSnapshotForProgramFixture } from '../program/fixtures/radar-fixtures';
import { hasAcceptedProgramSnapshot } from '../program/presentation-boundary';

import { HudCanvasPreview } from './HudCanvasPreview';
import { HudConsoleWorkspaces } from './HudConsoleWorkspaces';
import { clientPointToHudLogicalPoint } from './hud-canvas-geometry';
import {
  activePresetId,
  cloneHudValue as clone,
  isHudResourceSame as isSame,
  mergeHudEditorDocument,
  resourceFor,
} from './hud-console-drafts';
import { resolveHudPreview } from './hud-console-preview';
import {
  hudResourceNameError,
  hudResourceNavigationBlockReason,
  type HudDraftDirtyState,
  type HudResource,
  type HudWorkspace,
} from './hud-console-state';
import { type LocalChannelConnectionState, useLocalChannelClient } from '../realtime';
import { loadReplayFixture, type LoadedReplayFixture, type ReplaySourceId } from './replay-fixture';
import type { ReplaySessionSnapshot } from '@mizar/replay';
import type { AcceptanceReplayFrame } from './replay-fixture';
import {
  HudConfigMutationError,
  mutateHudConfig,
  useHudConfigEditorClient,
  type HudConfigMutation,
  type HudConfigMutationResponse,
} from '../realtime/hud-config-client';

import './hud-console.css';

const WORKSPACES: readonly { readonly id: HudWorkspace; readonly label: string }[] = [
  { id: 'preset', label: '预设' },
  { id: 'layout', label: '布局' },
];

const EMPTY_REPLAY_SNAPSHOT: ReplaySessionSnapshot<AcceptanceReplayFrame> = {
  current: null,
  currentIndex: 0,
  currentEventId: null,
  presentationRevision: 0,
  isPlaying: false,
  isSeeking: false,
  error: null,
};

function replayTimeLabel(elapsedUs: number): string {
  const totalMs = Math.floor(elapsedUs / 1_000);
  const minutes = Math.floor(totalMs / 60_000)
    .toString()
    .padStart(2, '0');
  const seconds = Math.floor((totalMs % 60_000) / 1_000)
    .toString()
    .padStart(2, '0');
  const milliseconds = (totalMs % 1_000).toString().padStart(3, '0');
  return `${minutes}:${seconds}.${milliseconds}`;
}

function fixtureLabel(id: ProgramFixtureId): string {
  return id === 'awaiting-neutral' ? '等待数据' : PROGRAM_FIXTURE_LABELS[id];
}

function connectionLabel(state: LocalChannelConnectionState): string {
  switch (state) {
    case 'live':
      return '实时数据可用';
    case 'awaiting-baseline':
      return '等待实时数据';
    case 'connecting':
      return '正在连接实时数据';
    case 'reconnecting':
      return '正在重连';
    case 'protocol-error':
      return '数据协议不兼容';
    case 'closed':
      return '连接已关闭';
    default:
      return '实时数据未启动';
  }
}

function useProgramConnection(): {
  readonly current: ProgramSnapshot | null;
  readonly state: LocalChannelConnectionState;
} {
  const client = useLocalChannelClient('program');
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  return { current: snapshot.current, state: snapshot.state };
}

export function HudConsolePage() {
  // The development fixture host can exercise the actual Companion authoring lifecycle.
  const visualFixtureMode =
    import.meta.env.VITE_VISUAL_FIXTURES === '1' &&
    new URLSearchParams(window.location.search).get('hud-config') !== 'companion';
  const hudEditor = useHudConfigEditorClient(!visualFixtureMode);
  const program = useProgramConnection();
  const radarClient = useLocalChannelClient('radar');
  const radar = useSyncExternalStore(
    radarClient.subscribe,
    radarClient.getSnapshot,
    radarClient.getSnapshot,
  );

  const fixtureDocument = useMemo(() => createDefaultHudConfigDocument(), []);
  const authoritativeDocument = hudEditor.document ?? (visualFixtureMode ? fixtureDocument : null);
  const configDocument = authoritativeDocument ?? fixtureDocument;
  const editorReady = authoritativeDocument !== null;
  const editorStatus = visualFixtureMode ? 'ready' : hudEditor.status;
  const initialDocument = fixtureDocument;
  const [workspace, setWorkspace] = useState<HudWorkspace>('preset');
  const [design, setDesign] = useState<HudDesign>(() =>
    parseHudDesign(new URLSearchParams(window.location.search).get('design')),
  );
  const reviewingDesign = design !== 'current';
  const [mapBackground, setMapBackground] = useState(true);
  const reviewFrameRef = useRef<HTMLDivElement>(null);
  const [selectedPresetId, setSelectedPresetId] = useState(() => activePresetId(initialDocument));
  const [selectedLayoutId, setSelectedLayoutId] = useState(() => {
    const preset = resourceFor(initialDocument, 'preset', activePresetId(initialDocument));
    return preset !== undefined && 'layoutId' in preset ? preset.layoutId : BUILTIN_LAYOUT_ID;
  });
  const [selectedThemeId, setSelectedThemeId] = useState(() => {
    const preset = resourceFor(initialDocument, 'preset', activePresetId(initialDocument));
    return preset !== undefined && 'themeId' in preset ? preset.themeId : BUILTIN_THEME_ID;
  });
  const [presetDraft, setPresetDraft] = useState<HudPreset>(() =>
    clone(resourceFor(initialDocument, 'preset', activePresetId(initialDocument)) as HudPreset),
  );
  const [layoutDraft, setLayoutDraft] = useState<HudLayout>(() =>
    clone(resourceFor(initialDocument, 'layout', selectedLayoutId) as HudLayout),
  );
  const [themeDraft, setThemeDraft] = useState<HudTheme>(() =>
    clone(resourceFor(initialDocument, 'theme', selectedThemeId) as HudTheme),
  );
  const [lastValidTheme, setLastValidTheme] = useState<HudTheme>(themeDraft);
  const [selectedWidgetId, setSelectedWidgetId] = useState<HudWidgetId | null>(null);
  const [previewSource, setPreviewSource] = useState<'fixture' | 'replay' | 'current-live'>(() =>
    new URLSearchParams(window.location.search).get('mode') === 'replay' ? 'replay' : 'fixture',
  );
  const [fixtureId, setFixtureId] = useState<ProgramFixtureId>(HUD_EDITOR_DEFAULT_FIXTURE_ID);
  const [replaySourceId, setReplaySourceId] = useState<ReplaySourceId>('ancient-round-03');
  const [replayLoadState, setReplayLoadState] = useState<
    | {
        readonly sourceId: ReplaySourceId;
        readonly generation: number;
        readonly status: 'ready';
        readonly fixture: LoadedReplayFixture;
      }
    | {
        readonly sourceId: ReplaySourceId;
        readonly generation: number;
        readonly status: 'error';
        readonly error: string;
      }
    | null
  >(null);
  const replayLoadGeneration = useRef(0);
  const [pendingReplayIndex, setPendingReplayIndex] = useState<number | null>(null);
  const [showGrid, setShowGrid] = useState(true);
  const [showCenter, setShowCenter] = useState(true);
  const [showSafeArea, setShowSafeArea] = useState(false);
  const [snapToGridEnabled, setSnapToGridEnabled] = useState(true);
  const [commandState, setCommandState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canvasFrameRef = useRef<HTMLDivElement>(null);
  const authoritativeDocumentRef = useRef<HudConfigDocument | null>(null);
  const observedRevisionRef = useRef<string | null>(null);
  const pendingMutationRef = useRef<{
    readonly kind: HudWorkspace;
    readonly resourceId: string;
  } | null>(null);
  const draftBaseRevisionRef = useRef<Record<HudWorkspace, string | null>>({
    preset: null,
    layout: null,
    theme: null,
  });
  const [draftConflicts, setDraftConflicts] = useState<Record<HudWorkspace, boolean>>({
    preset: false,
    layout: false,
    theme: false,
  });
  const [drag, setDrag] = useState<{
    readonly kind: 'move' | 'resize';
    readonly widgetId: HudWidgetId;
    readonly startX: number;
    readonly startY: number;
    readonly placement: HudLayout['widgets'][HudWidgetId];
  } | null>(null);
  const fixture = useMemo(() => getHudEditorFixture(fixtureId), [fixtureId]);
  const fixtureRadarSnapshot = useMemo(
    () => radarSnapshotForProgramFixture(fixtureId),
    [fixtureId],
  );
  useEffect(() => {
    const generation = replayLoadGeneration.current + 1;
    replayLoadGeneration.current = generation;
    if (previewSource !== 'replay') return;
    let active = true;
    let loaded: LoadedReplayFixture | null = null;
    void loadReplayFixture(replaySourceId)
      .then((fixture) => {
        loaded = fixture;
        if (!active || replayLoadGeneration.current !== generation) {
          fixture.dispose();
          return;
        }
        setReplayLoadState({ sourceId: replaySourceId, generation, status: 'ready', fixture });
      })
      .catch(() => {
        if (!active || replayLoadGeneration.current !== generation) return;
        setReplayLoadState({
          sourceId: replaySourceId,
          generation,
          status: 'error',
          error: '无法载入本地重放素材，请检查素材完整性后重试',
        });
      });
    return () => {
      active = false;
      loaded?.dispose();
    };
  }, [previewSource, replaySourceId]);
  const currentReplayLoadState =
    replayLoadState?.sourceId === replaySourceId &&
    replayLoadState.generation === replayLoadGeneration.current
      ? replayLoadState
      : null;
  const replayFixture =
    previewSource === 'replay' && currentReplayLoadState?.status === 'ready'
      ? currentReplayLoadState.fixture
      : null;
  const replayLoadError =
    previewSource === 'replay' && currentReplayLoadState?.status === 'error'
      ? currentReplayLoadState.error
      : null;
  const replayLoading = previewSource === 'replay' && currentReplayLoadState === null;
  const replaySession = replayFixture?.session ?? null;
  const subscribeReplay = useCallback(
    (listener: () => void) => replaySession?.subscribe(listener) ?? (() => undefined),
    [replaySession],
  );
  const getReplaySnapshot = useCallback(
    () => replaySession?.getSnapshot() ?? EMPTY_REPLAY_SNAPSHOT,
    [replaySession],
  );
  const replayState = useSyncExternalStore(subscribeReplay, getReplaySnapshot, getReplaySnapshot);
  const previewSourceLive = hasAcceptedProgramSnapshot(program.current, program.state);
  const activePreviewSource = previewSource;
  const replayFrame = activePreviewSource === 'replay' ? replayState.current : null;
  const activeSnapshot =
    activePreviewSource === 'current-live'
      ? program.current
      : activePreviewSource === 'replay'
        ? (replayFrame?.program ?? null)
        : fixture;
  const activeRadarSnapshot =
    activePreviewSource === 'replay'
      ? (replayFrame?.radar ?? null)
      : activePreviewSource === 'fixture'
        ? fixtureRadarSnapshot
        : null;
  let unsupportedRadarMap: string | null = null;
  const previewRadarMapName =
    activePreviewSource === 'current-live'
      ? radar.current?.payload.mapName
      : activeRadarSnapshot?.payload.mapName;
  if (previewRadarMapName && defaultMapGeometryProvider.resolve(previewRadarMapName) === null) {
    unsupportedRadarMap = previewRadarMapName;
  }
  const radarDiagnosticAttributes =
    unsupportedRadarMap === null
      ? {}
      : {
          'data-radar-diagnostic': 'unsupported-map',
          'data-radar-unsupported-map': unsupportedRadarMap,
        };

  const savedPreset = resourceFor(configDocument, 'preset', selectedPresetId) as
    HudPreset | undefined;
  const savedLayout = resourceFor(configDocument, 'layout', selectedLayoutId) as
    HudLayout | undefined;
  const savedTheme = resourceFor(configDocument, 'theme', selectedThemeId) as HudTheme | undefined;
  const presetDirty = savedPreset === undefined || !isSame(savedPreset, presetDraft);
  const layoutDirty = savedLayout === undefined || !isSame(savedLayout, layoutDraft);
  const themeDirty = savedTheme === undefined || !isSame(savedTheme, themeDraft);
  const presetNameError = hudResourceNameError(presetDraft.name);
  const layoutNameError = hudResourceNameError(layoutDraft.name);
  const themeNameError = hudResourceNameError(themeDraft.name);
  const themeDraftInvalid = !/^#[0-9a-fA-F]{6}$/.test(themeDraft.brandColor);
  const dirtyDrafts: HudDraftDirtyState = {
    preset: presetDirty,
    layout: layoutDirty,
    theme: themeDirty,
  };
  const hasDirtyDraft = presetDirty || layoutDirty || themeDirty;
  const activationStale = hudEditor.activationStale;
  const currentReplayEvent = replayFixture?.events.find(
    (event) => event.id === replayState.currentEventId,
  );

  function commitReplaySeek(targetIndex?: number): void {
    if (replaySession === null || replayState.isSeeking) return;
    const selectedIndex = targetIndex ?? pendingReplayIndex ?? replayState.currentIndex;
    setPendingReplayIndex(null);
    void replaySession.seekCaptureIndex(selectedIndex);
  }

  function stepReplayEvent(direction: -1 | 1): void {
    if (replaySession === null || replayState.isSeeking) return;
    setPendingReplayIndex(null);
    void replaySession.stepEvent(direction);
  }

  useEffect(() => {
    const nextDocument = authoritativeDocument;
    const nextRevision = visualFixtureMode ? 'fixture' : hudEditor.revision;
    if (nextDocument === null || nextRevision === null) return;
    if (observedRevisionRef.current === nextRevision) return;

    const merged = mergeHudEditorDocument({
      previousDocument: authoritativeDocumentRef.current,
      nextDocument,
      currentIds: {
        preset: selectedPresetId,
        layout: selectedLayoutId,
        theme: selectedThemeId,
      },
      currentDrafts: { preset: presetDraft, layout: layoutDraft, theme: themeDraft },
      currentConflicts: draftConflicts,
      baseRevisions: draftBaseRevisionRef.current,
      nextRevision,
      committed: pendingMutationRef.current,
    });

    authoritativeDocumentRef.current = nextDocument;
    observedRevisionRef.current = nextRevision;
    pendingMutationRef.current = null;
    draftBaseRevisionRef.current = merged.baseRevisions;
    setSelectedPresetId(merged.ids.preset);
    setSelectedLayoutId(merged.ids.layout);
    setSelectedThemeId(merged.ids.theme);
    setPresetDraft(merged.drafts.preset);
    setLayoutDraft(merged.drafts.layout);
    setThemeDraft(merged.drafts.theme);
    setDraftConflicts(merged.conflicts);
    if (Object.values(merged.conflicts).some(Boolean)) {
      setCommandState('已在另一页面更新，请先处理冲突。');
    }
  }, [
    authoritativeDocument,
    draftConflicts,
    hudEditor.revision,
    layoutDraft,
    layoutDirty,
    presetDraft,
    presetDirty,
    selectedLayoutId,
    selectedPresetId,
    selectedThemeId,
    themeDirty,
    themeDraft,
    visualFixtureMode,
  ]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasDirtyDraft) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [hasDirtyDraft]);

  useEffect(() => {
    if (drag === null) return;

    const logicalPoint = (clientX: number, clientY: number) =>
      clientPointToHudLogicalPoint(
        clientX,
        clientY,
        canvasFrameRef.current?.getBoundingClientRect() ?? {
          left: 0,
          top: 0,
          width: HUD_CANVAS_WIDTH,
          height: HUD_CANVAS_HEIGHT,
        },
      );
    const move = (event: globalThis.PointerEvent) => {
      const point = logicalPoint(event.clientX, event.clientY);
      if (drag.kind === 'move') {
        setLayoutDraft((current) => ({
          ...current,
          widgets: {
            ...current.widgets,
            [drag.widgetId]: moveWidgetPlacement(
              drag.widgetId,
              drag.placement,
              point.x - drag.startX,
              point.y - drag.startY,
              snapToGridEnabled,
            ),
          },
        }));
      } else {
        setLayoutDraft((current) => ({
          ...current,
          widgets: {
            ...current.widgets,
            radar: resizeRadarPlacement(drag.placement, point.x - drag.startX, snapToGridEnabled),
          },
        }));
      }
    };
    const end = () => setDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [drag, snapToGridEnabled]);

  function selectedDraft(kind: HudWorkspace): HudResource {
    if (kind === 'preset') return presetDraft;
    if (kind === 'layout') return layoutDraft;
    return themeDraft;
  }

  function setSelectedDraft(kind: HudWorkspace, value: HudResource): void {
    if (kind === 'preset') setPresetDraft(value as HudPreset);
    else if (kind === 'layout') setLayoutDraft(value as HudLayout);
    else setThemeDraftValue(value as HudTheme);
  }

  function setThemeDraftValue(next: HudTheme): void {
    const currentIsValid = !themeDraftInvalid && themeNameError === null;
    const nextIsValid =
      /^#[0-9a-fA-F]{6}$/.test(next.brandColor) && hudResourceNameError(next.name) === null;
    setThemeDraft(next);
    if (nextIsValid) setLastValidTheme(clone(next));
    else if (currentIsValid) setLastValidTheme(clone(themeDraft));
  }

  function selectResource(kind: HudWorkspace, id: string): void {
    if (!editorReady) return;
    const resource = resourceFor(configDocument, kind, id);
    if (resource === undefined) return;
    const blockReason = hudResourceNavigationBlockReason(
      kind,
      resource,
      { preset: selectedPresetId, layout: selectedLayoutId, theme: selectedThemeId },
      dirtyDrafts,
    );
    if (blockReason !== null) {
      setCommandState(blockReason);
      return;
    }
    if (kind === 'preset') {
      const preset = resource as HudPreset;
      setSelectedPresetId(id);
      setPresetDraft(clone(preset));
      if (preset.layoutId !== selectedLayoutId) {
        setSelectedLayoutId(preset.layoutId);
        setLayoutDraft(clone(resourceFor(configDocument, 'layout', preset.layoutId) as HudLayout));
      }
      if (preset.themeId !== selectedThemeId) {
        setSelectedThemeId(preset.themeId);
        setThemeDraftValue(clone(resourceFor(configDocument, 'theme', preset.themeId) as HudTheme));
      }
    } else if (kind === 'layout') {
      setSelectedLayoutId(id);
      setLayoutDraft(clone(resource as HudLayout));
    } else {
      setSelectedThemeId(id);
      setThemeDraftValue(clone(resource as HudTheme));
    }
    setCommandState(null);
  }

  function changeWorkspace(next: HudWorkspace): void {
    if (next === workspace) return;
    setWorkspace(next);
    setCommandState(null);
  }

  function updatePresetReference(kind: 'layout' | 'theme', id: string): void {
    if (!editorReady) return;
    const resource = resourceFor(configDocument, kind, id);
    if (resource === undefined) return;
    const selectedId = kind === 'layout' ? selectedLayoutId : selectedThemeId;
    const dirty = kind === 'layout' ? layoutDirty : themeDirty;
    if (dirty && id !== selectedId) {
      setCommandState(
        `当前${kind === 'layout' ? '布局' : '外观'}有未保存更改；切换预设中的${kind === 'layout' ? '布局' : '外观'}会覆盖它，请先保存或放弃。`,
      );
      return;
    }
    setPresetDraft((current) => ({ ...current, [`${kind}Id`]: id }));
    if (id === selectedId) return;
    if (kind === 'layout') {
      setSelectedLayoutId(id);
      setLayoutDraft(clone(resource as HudLayout));
    } else {
      setSelectedThemeId(id);
      setThemeDraftValue(clone(resource as HudTheme));
    }
  }

  function applyResponse(response: HudConfigMutationResponse): void {
    if (response.command.resource !== undefined && response.command.resourceId !== undefined) {
      pendingMutationRef.current = {
        kind: response.command.resource,
        resourceId: response.command.resourceId,
      };
      if (response.command.resource === 'preset') setSelectedPresetId(response.command.resourceId);
      if (response.command.resource === 'layout') setSelectedLayoutId(response.command.resourceId);
      if (response.command.resource === 'theme') setSelectedThemeId(response.command.resourceId);
    } else {
      pendingMutationRef.current = null;
    }
    hudEditor.applyResponse(response.editor);
  }

  async function submitMutation(kind: HudWorkspace, saveAs: boolean): Promise<void> {
    if (busy || !editorReady) return;
    const nameError = hudResourceNameError(selectedDraft(kind).name);
    if (nameError !== null) {
      setCommandState(nameError);
      return;
    }
    if (kind === 'theme' && themeDraftInvalid) {
      setCommandState('请先修正品牌色格式，再保存 HUD 外观。');
      return;
    }
    const draft = selectedDraft(kind);
    const expectedEditorRevision = draftBaseRevisionRef.current[kind] ?? hudEditor.revision;
    if (expectedEditorRevision === null) {
      setCommandState('正在读取 HUD 配置，请稍后再试。');
      return;
    }
    const command: HudConfigMutation = {
      kind: saveAs ? 'save-as' : 'save-resource',
      resource: kind,
      value: { ...draft, name: draft.name.trim() },
      expectedEditorRevision,
    };
    setBusy(true);
    setCommandState(null);
    try {
      const response = await mutateHudConfig(command);
      applyResponse(response);
      if (response.command.resource !== kind || response.command.resourceId === undefined) {
        throw new Error('服务器未返回本次操作对应的 HUD 资源身份');
      }
      const nextId = response.command.resourceId;
      const saved = resourceFor(response.editor.document, kind, nextId);
      if (saved === undefined) throw new Error('服务器未返回已保存的 HUD 资源');
      setSelectedDraft(kind, clone(saved));
      if (kind === 'preset') setSelectedPresetId(nextId);
      if (kind === 'layout') setSelectedLayoutId(nextId);
      if (kind === 'theme') setSelectedThemeId(nextId);
      setCommandState(saveAs ? `已另存为「${saved.name}」。` : '已保存。');
    } catch (error: unknown) {
      if (error instanceof HudConfigMutationError && error.status === 409) {
        setDraftConflicts((current) => ({ ...current, [kind]: true }));
        setCommandState('已在另一页面更新，请先处理冲突。');
      } else {
        setCommandState('HUD 操作未完成，请检查配置连接后重试。');
      }
    } finally {
      setBusy(false);
    }
  }

  async function activateSelectedPreset(): Promise<void> {
    if (busy || !editorReady || hudEditor.revision === null) return;
    setBusy(true);
    setCommandState(null);
    try {
      const response = await mutateHudConfig({
        kind: 'activate-preset',
        sourceId: selectedPresetId,
        expectedEditorRevision: hudEditor.revision,
      });
      applyResponse(response);
      setCommandState('当前预设已启用。');
    } catch (error: unknown) {
      setCommandState(
        error instanceof HudConfigMutationError && error.status === 409
          ? '已在另一页面更新，请先处理冲突。'
          : 'HUD 预设未启用，请检查配置连接后重试。',
      );
    } finally {
      setBusy(false);
    }
  }

  function discard(kind: HudWorkspace): void {
    if (!editorReady) return;
    const saved = resourceFor(
      configDocument,
      kind,
      kind === 'preset' ? selectedPresetId : kind === 'layout' ? selectedLayoutId : selectedThemeId,
    );
    if (saved === undefined) return;
    setSelectedDraft(kind, clone(saved));
    setDraftConflicts((current) => ({ ...current, [kind]: false }));
    if (hudEditor.revision !== null) draftBaseRevisionRef.current[kind] = hudEditor.revision;
    setCommandState('已放弃当前更改。');
  }

  function reset(kind: HudWorkspace): void {
    if (!editorReady) return;
    if (kind === 'preset') setPresetDraft(resetPresetDraft(presetDraft));
    else if (kind === 'layout') setLayoutDraft(resetLayoutDraft(layoutDraft));
    else setThemeDraftValue(resetThemeDraft(themeDraft));
    setCommandState('已恢复默认值，请保存。');
  }

  function startMove(widgetId: HudWidgetId, event: PointerEvent<HTMLButtonElement>): void {
    if (workspace !== 'layout') return;
    event.preventDefault();
    const rect = canvasFrameRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const point = clientPointToHudLogicalPoint(event.clientX, event.clientY, rect);
    setSelectedWidgetId(widgetId);
    setDrag({
      kind: 'move',
      widgetId,
      startX: point.x,
      startY: point.y,
      placement: clone(layoutDraft.widgets[widgetId]),
    });
  }

  function startRadarResize(event: PointerEvent<HTMLButtonElement>): void {
    if (workspace !== 'layout') return;
    event.preventDefault();
    event.stopPropagation();
    const rect = canvasFrameRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const point = clientPointToHudLogicalPoint(event.clientX, event.clientY, rect);
    setSelectedWidgetId('radar');
    setDrag({
      kind: 'resize',
      widgetId: 'radar',
      startX: point.x,
      startY: point.y,
      placement: clone(layoutDraft.widgets.radar),
    });
  }

  const previewPreset = useMemo(
    () => ({ ...presetDraft, layoutId: selectedLayoutId, themeId: selectedThemeId }),
    [presetDraft, selectedLayoutId, selectedThemeId],
  );
  const previewLayout = useMemo(() => {
    if (selectedLayoutId === layoutDraft.id) return layoutDraft;
    return resourceFor(configDocument, 'layout', selectedLayoutId) as HudLayout | undefined;
  }, [configDocument, layoutDraft, selectedLayoutId]);
  const previewTheme = useMemo(() => {
    if (selectedThemeId === themeDraft.id) return themeDraft;
    return resourceFor(configDocument, 'theme', selectedThemeId) as HudTheme | undefined;
  }, [configDocument, selectedThemeId, themeDraft]);
  const previewResolved = useMemo(
    () =>
      resolveHudPreview({
        fallbackLayout: savedLayout ?? getBuiltinLayout(),
        fallbackPreset: savedPreset ?? getBuiltinPreset(),
        fallbackTheme: lastValidTheme,
        layout: previewLayout ?? savedLayout ?? getBuiltinLayout(),
        preset: previewPreset,
        theme: previewTheme ?? savedTheme ?? getBuiltinTheme(),
      }),
    [
      lastValidTheme,
      previewLayout,
      previewPreset,
      previewTheme,
      savedLayout,
      savedPreset,
      savedTheme,
    ],
  );

  const selectedPlacement =
    selectedWidgetId === null ? null : layoutDraft.widgets[selectedWidgetId];
  const selectedBox =
    selectedWidgetId === null
      ? null
      : placementToBox(selectedWidgetId, layoutDraft.widgets[selectedWidgetId]);

  function updateSelectedPlacement(
    update: (placement: HudLayout['widgets'][HudWidgetId]) => HudLayout['widgets'][HudWidgetId],
    preserveVisualBox = false,
  ): void {
    if (selectedWidgetId === null) return;
    setLayoutDraft((current) => ({
      ...current,
      widgets: {
        ...current.widgets,
        [selectedWidgetId]: (() => {
          const currentPlacement = current.widgets[selectedWidgetId];
          const updatedPlacement = update(currentPlacement);
          return preserveVisualBox
            ? changePlacementAnchor(selectedWidgetId, currentPlacement, updatedPlacement.anchor)
            : normalizeHudPlacement(selectedWidgetId, updatedPlacement);
        })(),
      },
    }));
  }

  const workspaceProps = {
    activationStale,
    busy,
    configDocument,
    editorReady,
    hasDirtyDraft,
    layoutDirty,
    layoutDraft,
    layoutNameError,
    onActivate: () => void activateSelectedPreset(),
    onDiscard: discard,
    onLayoutDraftChange: (draft: HudLayout) => setLayoutDraft(draft),
    onPresetDraftChange: (draft: HudPreset) => setPresetDraft(draft),
    onReset: reset,
    onSelectResource: selectResource,
    onSelectWidget: (id: HudWidgetId) => setSelectedWidgetId(id),
    onShowCenterChange: (value: boolean) => setShowCenter(value),
    onShowGridChange: (value: boolean) => setShowGrid(value),
    onShowSafeAreaChange: (value: boolean) => setShowSafeArea(value),
    onSnapToGridChange: (value: boolean) => setSnapToGridEnabled(value),
    onSubmitMutation: (kind: HudWorkspace, saveAs: boolean) => void submitMutation(kind, saveAs),
    onThemeDraftChange: setThemeDraftValue,
    onUpdatePresetReference: updatePresetReference,
    onUpdateSelectedPlacement: updateSelectedPlacement,
    presetDirty,
    presetDraft,
    presetNameError,
    selectedBox,
    selectedLayoutId,
    selectedPlacement,
    selectedPresetId,
    selectedThemeId,
    selectedWidgetId,
    showCenter,
    showGrid,
    showSafeArea,
    snapToGridEnabled,
    themeDirty,
    themeDraft,
    themeDraftInvalid,
    themeNameError,
    workspace,
  };

  return (
    <ToolShell title="HUD 编辑器">
      <main className="hud-console" data-surface="hud-console" data-design-review={reviewingDesign}>
        <header className="hud-console__header">
          <div>
            <p className="hud-console__eyebrow">Mizar</p>
            <h1>{reviewingDesign ? 'HUD 设计预览' : 'HUD 编辑器'}</h1>
            <p className="hud-console__intro">
              {reviewingDesign
                ? '同一回合，两种设计。播放完整回合，或保持当前时刻切换比较。'
                : '调整预设与布局，预览确认后启用。'}
            </p>
          </div>
          <div className="hud-console__header-meta">
            <span>连接状态</span>
            <strong>
              {!editorReady
                ? '正在读取配置'
                : editorStatus === 'error'
                  ? '连接异常，使用最近保存的配置'
                  : '已连接'}
            </strong>
          </div>
        </header>

        <div className="hud-console__layout">
          <div className="hud-console__preview-column" ref={reviewFrameRef}>
            <section className="hud-console__preview-toolbar" aria-label="预览设置">
              <Select
                label="HUD 设计"
                value={design}
                onChange={(event) => setDesign(parseHudDesign(event.target.value))}
              >
                {HUD_DESIGN_CHOICES.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </Select>
              {reviewingDesign ? (
                <Select
                  label="预览背景"
                  value={mapBackground ? 'map' : 'plain'}
                  onChange={(event) => setMapBackground(event.target.value === 'map')}
                >
                  <option value="map">地图画面</option>
                  <option value="plain">纯色底板</option>
                </Select>
              ) : null}
              {reviewingDesign && document.fullscreenEnabled ? (
                <Button
                  onClick={() =>
                    void reviewFrameRef.current?.requestFullscreen().catch(() => undefined)
                  }
                >
                  全屏预览
                </Button>
              ) : null}
              <div>
                <span className="hud-console__kicker">预览</span>
                <strong>
                  {activePreviewSource === 'fixture'
                    ? fixtureLabel(fixtureId)
                    : activePreviewSource === 'replay'
                      ? (replayFixture?.title ?? (replayLoading ? '正在载入回放' : '回放不可用'))
                      : previewSourceLive
                        ? '实时比赛'
                        : '实时数据不可用'}
                </strong>
              </div>
              <label>
                来源
                <select
                  aria-label="预览来源"
                  value={activePreviewSource}
                  onChange={(event) =>
                    setPreviewSource(event.target.value as 'fixture' | 'replay' | 'current-live')
                  }
                >
                  <option value="fixture">示例比赛</option>
                  <option value="replay">比赛回放</option>
                  <option disabled={!previewSourceLive} value="current-live">
                    实时比赛
                  </option>
                </select>
              </label>
              {activePreviewSource === 'fixture' ? (
                <label>
                  场景
                  <select
                    aria-label="示例比赛"
                    value={fixtureId}
                    onChange={(event) => setFixtureId(event.target.value as ProgramFixtureId)}
                  >
                    {HUD_EDITOR_FIXTURE_GROUPS.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.ids.map((id) => (
                          <option key={id} value={id}>
                            {fixtureLabel(id)}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              ) : null}
              {activePreviewSource === 'replay' ? (
                <label>
                  回放来源
                  <select
                    aria-label="回放来源"
                    value={replaySourceId}
                    onChange={(event) => {
                      setPendingReplayIndex(null);
                      setReplaySourceId(event.target.value as ReplaySourceId);
                    }}
                  >
                    <option value="ancient-round-03">Ancient · 第 3 回合</option>
                    <option value="ancient-round-11-defuse">Ancient · 第 11 回合拆弹</option>
                  </select>
                </label>
              ) : null}
              <span
                className="hud-console__source-status"
                data-connection-state={activePreviewSource === 'replay' ? 'replay' : program.state}
                {...radarDiagnosticAttributes}
              >
                {activePreviewSource === 'replay'
                  ? replayLoadError === null
                    ? '比赛回放'
                    : '重放素材不可用'
                  : activePreviewSource === 'fixture'
                    ? '示例画面'
                    : connectionLabel(program.state)}
                {activePreviewSource === 'current-live' && unsupportedRadarMap !== null
                  ? ` · 雷达不可用：不支持地图 ${unsupportedRadarMap}`
                  : null}
              </span>
            </section>

            {activePreviewSource === 'replay' ? (
              <section
                aria-label="重放控制"
                className="hud-console__replay"
                data-replay-cursor={replayFrame?.cursor.sequence ?? ''}
                data-replay-event-kind={currentReplayEvent?.kind ?? ''}
              >
                <div className="hud-console__replay-actions">
                  <Button
                    disabled={replaySession === null || replayState.isSeeking || replayLoading}
                    onClick={() =>
                      replayState.isPlaying ? replaySession?.pause() : replaySession?.play()
                    }
                    type="button"
                  >
                    {replayState.isPlaying ? '暂停' : '播放'}
                  </Button>
                  <Button
                    disabled={replaySession === null || replayState.isSeeking || replayLoading}
                    onClick={() => {
                      setPendingReplayIndex(null);
                      void replaySession?.restart();
                    }}
                    type="button"
                  >
                    重播
                  </Button>
                  <Button
                    aria-label="上一个语义事件"
                    disabled={replaySession === null || replayState.isSeeking}
                    onClick={() => stepReplayEvent(-1)}
                    type="button"
                  >
                    上一事件
                  </Button>
                  <Button
                    aria-label="下一个语义事件"
                    disabled={replaySession === null || replayState.isSeeking}
                    onClick={() => stepReplayEvent(1)}
                    type="button"
                  >
                    下一事件
                  </Button>
                </div>
                <label className="hud-console__replay-scrubber">
                  回放进度
                  <input
                    aria-label="回放进度"
                    disabled={replaySession === null || replayState.isSeeking || replayLoading}
                    max={Math.max(0, (replayFixture?.manifest.frameCount ?? 1) - 1)}
                    min={0}
                    onChange={(event) => setPendingReplayIndex(Number(event.target.value))}
                    onKeyUp={() => commitReplaySeek()}
                    onPointerUp={(event) => commitReplaySeek(Number(event.currentTarget.value))}
                    type="range"
                    value={Math.max(
                      0,
                      Math.min(
                        pendingReplayIndex ?? replayState.currentIndex,
                        (replayFixture?.manifest.frameCount ?? 1) - 1,
                      ),
                    )}
                  />
                </label>
                <label className="hud-console__replay-event-select">
                  语义事件
                  <select
                    aria-label="语义事件"
                    disabled={replaySession === null || replayState.isSeeking || replayLoading}
                    onChange={(event) => {
                      if (event.target.value) {
                        setPendingReplayIndex(null);
                        void replaySession?.seekEvent(event.target.value);
                      }
                    }}
                    value={currentReplayEvent?.id ?? ''}
                  >
                    <option value="">当前窗口无事件</option>
                    {replayFixture?.events.map((event) => (
                      <option key={event.id} value={event.id}>
                        {event.sequence} · {event.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="hud-console__replay-readout" aria-live="polite">
                  <span>
                    {replayFrame === null
                      ? '00:00.000'
                      : replayTimeLabel(replayFrame.cursor.scheduledElapsedUs)}
                  </span>
                  <span>序列 {replayFrame?.cursor.sequence ?? '—'}</span>
                  <span>{currentReplayEvent?.label ?? '当前窗口无语义事件'}</span>
                  {replayState.isSeeking ? <span>正在重建回放前缀…</span> : null}
                  {replayLoadError !== null ? <span role="alert">{replayLoadError}</span> : null}
                  {replayState.error !== null ? (
                    <span role="alert">重放未完成，请重新载入素材后重试。</span>
                  ) : null}
                </div>
                {replayFixture !== null ? (
                  <details className="hud-console__replay-provenance">
                    <summary>来源、覆盖与完整性</summary>
                    <dl>
                      <dt>原始 capture</dt>
                      <dd>{replayFixture.manifest.source.sourceCaptureId}</dd>
                      <dt>来源 SHA-256</dt>
                      <dd>{replayFixture.manifest.source.sourceFramesSha256}</dd>
                      <dt>帧 / 语义事件</dt>
                      <dd>
                        {replayFixture.manifest.frameCount} / {replayFixture.manifest.eventCount}
                      </dd>
                      <dt>Sanitizer</dt>
                      <dd>v{replayFixture.manifest.source.sanitizerVersion}</dd>
                      {replayFixture.manifest.coverage
                        .filter((item) => item.status !== 'observed')
                        .map((item) => (
                          <Fragment key={item.kind}>
                            <dt>{item.kind}</dt>
                            <dd>{item.status}</dd>
                          </Fragment>
                        ))}
                    </dl>
                  </details>
                ) : null}
              </section>
            ) : null}

            <HudCanvasPreview
              design={design}
              mapBackground={reviewingDesign && mapBackground}
              radarSnapshot={activeRadarSnapshot}
              radarClient={activePreviewSource === 'current-live' ? radarClient : undefined}
              presentationRevision={
                activePreviewSource === 'replay' ? replayState.presentationRevision : 0
              }
              canvasFrameRef={canvasFrameRef}
              connectionState={program.state}
              editorMode={!reviewingDesign && workspace === 'layout' ? 'layout' : 'preview'}
              editorInteractive={!reviewingDesign && editorReady && workspace === 'layout'}
              liveSource={activePreviewSource === 'current-live'}
              onRadarResizePointerDown={workspace === 'layout' ? startRadarResize : undefined}
              onWidgetPointerDown={workspace === 'layout' ? startMove : undefined}
              resolvedPreset={previewResolved}
              selectedWidgetId={workspace === 'layout' ? selectedWidgetId : null}
              showCenter={!reviewingDesign && showCenter}
              showGrid={!reviewingDesign && showGrid}
              showSafeArea={!reviewingDesign && showSafeArea}
              snapshot={activeSnapshot}
            />
            <p className="hud-console__preview-caption">
              {reviewingDesign
                ? `${HUD_DESIGN_CHOICES.find((choice) => choice.id === design)!.description} · 设计预览，不改变已启用 HUD${mapBackground ? ' · 地图背景为静态素材，HUD 为真实数据回放' : ''}`
                : '1920 × 1080 · 10px 网格'}
            </p>
          </div>

          <div className="hud-console__editor-column" hidden={reviewingDesign}>
            <div className="hud-console__tabs" aria-label="HUD 编辑区域">
              {WORKSPACES.map((item) => (
                <Button
                  aria-current={workspace === item.id ? 'page' : undefined}
                  className={workspace === item.id ? 'is-active' : undefined}
                  key={item.id}
                  onClick={() => changeWorkspace(item.id)}
                  type="button"
                >
                  {item.label}
                </Button>
              ))}
            </div>
            <fieldset className="hud-console__editor-fieldset" disabled={!editorReady}>
              <HudConsoleWorkspaces {...workspaceProps} />
            </fieldset>
          </div>
        </div>

        {commandState !== null || !editorReady ? (
          <div
            aria-live="polite"
            className="hud-console__status"
            role={
              commandState?.includes('冲突') || commandState?.includes('未完成')
                ? 'alert'
                : 'status'
            }
          >
            {commandState ?? '正在读取配置。'}
          </div>
        ) : null}
      </main>
    </ToolShell>
  );
}
