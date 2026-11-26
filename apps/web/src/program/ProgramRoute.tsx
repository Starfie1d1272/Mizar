import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useBroadcastDisplayConfig } from '../realtime/broadcast-display-client';
import { useRadarViewSource } from '../realtime/radar-view-source';
import { useHudConfigClient } from '../realtime/hud-config-client';
import { createProgramCueClient, useLocalChannelClient } from '../realtime';
import { useLocalReadWithTime } from '../preparation/client';
import {
  desktopWidgetVisible,
  overlayGroups,
  type OverlayPolicy,
} from '../preparation/desktop-overlay';
import { nativeSnapshot } from '../debug/control-journal';
import { desktopInvoke, useProgramScenes } from '../workspace/client';
import { ProgramCueRendererBridge } from './ProgramCueRendererBridge';
import { ProgramPage } from './ProgramPage';
import { useProgramSurfaceActivity } from './useProgramSurfaceActivity';

export function ProgramRoute() {
  const scenes = useProgramScenes();
  const [desktopWidth, setDesktopWidth] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => setDesktopWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const useCompanionConfig =
    import.meta.env.VITE_VISUAL_FIXTURES !== '1' ||
    new URLSearchParams(window.location.search).get('hud-config') === 'companion';
  const display = useBroadcastDisplayConfig(useCompanionConfig);
  const hudConfig = useHudConfigClient(
    useCompanionConfig && display.current === null && display.status !== 'unsupported',
  );
  const activeHud = display.current?.hud.renderer === 'native' ? display.current.hud : null;
  const selectedHud = activeHud?.config ?? hudConfig.current;

  const desktop =
    window.__TAURI_INTERNALS__ !== undefined &&
    new URLSearchParams(window.location.search).get('host') === 'desktop';
  const surfaceActive = useProgramSurfaceActivity({
    sceneId: 'gameplay',
    scenes,
    desktop,
  });
  const policyRead = useLocalReadWithTime<OverlayPolicy>(
    desktop ? '/local/v1/desktop-overlay' : null,
    desktop ? 1000 : 60000,
  );
  const [stablePolicy, setStablePolicy] = useState<OverlayPolicy | null>(null);
  const nextPolicy = policyRead.value;
  if (
    nextPolicy === null
      ? stablePolicy !== null
      : stablePolicy === null ||
        stablePolicy.revision !== nextPolicy.revision ||
        stablePolicy.enabled !== nextPolicy.enabled
  ) {
    setStablePolicy(nextPolicy);
  }
  const resolved = useMemo(
    () =>
      desktop
        ? {
            ...selectedHud,
            layout: {
              ...selectedHud.layout,
              widgets: Object.fromEntries(
                Object.entries(selectedHud.layout.widgets).map(([id, placement]) => [
                  id,
                  {
                    ...placement,
                    visible: desktopWidgetVisible(stablePolicy, id, placement.visible),
                  },
                ]),
              ) as typeof selectedHud.layout.widgets,
            },
          }
        : selectedHud,
    [desktop, selectedHud, stablePolicy],
  );
  const overlays = useMemo(
    () =>
      activeHud && desktop && (!stablePolicy || !overlayGroups(stablePolicy).hud)
        ? {
            pause: { ...activeHud.overlays.pause, enabled: false },
            chat: { ...activeHud.overlays.chat, enabled: false },
          }
        : activeHud?.overlays,
    [activeHud, desktop, stablePolicy],
  );

  const displayValid = !(display.status === 'unsupported' && display.current === null);
  const needRadar = surfaceActive && displayValid && resolved.layout.widgets.radar.visible === true;
  const hasNonRadarWidget = Object.entries(resolved.layout.widgets).some(
    ([id, placement]) => id !== 'radar' && placement.visible,
  );
  const hasEnabledOverlay = overlays?.pause.enabled === true || overlays?.chat.enabled === true;
  const needGg = scenes?.active === 'gameplay' && (scenes.director?.gg?.remainingMs ?? 0) > 0;
  const needProgram =
    surfaceActive && displayValid && (hasNonRadarWidget || hasEnabledOverlay || needGg);

  const radarClient = useLocalChannelClient('radar', needRadar);
  const radarSource = useRadarViewSource(radarClient, needRadar);
  const programClient = useLocalChannelClient('program', needProgram);
  const programConnection = useSyncExternalStore(
    programClient.subscribe,
    programClient.getSnapshot,
    programClient.getSnapshot,
  );
  const cueClient = useMemo(() => {
    void needProgram;
    return createProgramCueClient({
      getProgramSnapshot: () => programClient.getSnapshot().current,
    });
  }, [programClient, needProgram]);
  const cueDisposal = useRef<{ client: typeof cueClient; timer: number } | null>(null);
  useEffect(() => {
    if (!needProgram) return;
    if (cueDisposal.current?.client === cueClient) {
      window.clearTimeout(cueDisposal.current.timer);
      cueDisposal.current = null;
    }
    const observeProgramSnapshot = () =>
      cueClient.observeProgramSnapshot(programClient.getSnapshot().current);
    observeProgramSnapshot();
    const unsubscribe = programClient.subscribe(observeProgramSnapshot);
    cueClient.start();
    return () => {
      unsubscribe();
      const timer = window.setTimeout(() => {
        cueClient.dispose();
        if (cueDisposal.current?.client === cueClient) cueDisposal.current = null;
      }, 0);
      cueDisposal.current = { client: cueClient, timer };
    };
  }, [cueClient, programClient, needProgram]);

  const [documentId, setDocumentId] = useState(window.__MIZAR_OVERLAY_DOCUMENT__);
  useEffect(() => {
    const update = () => setDocumentId(window.__MIZAR_OVERLAY_DOCUMENT__);
    window.addEventListener('mizar-overlay-document', update);
    update();
    return () => window.removeEventListener('mizar-overlay-document', update);
  }, []);
  useEffect(() => {
    const generation = window.__MIZAR_OVERLAY_GENERATION__;
    if (
      !desktop ||
      !generation ||
      !documentId ||
      policyRead.status !== 'ready' ||
      !(display.status === 'ready' || hudConfig.status === 'ready')
    )
      return;
    void desktopInvoke('program_overlay_ready', { generation, documentId }).catch(() => {});
  }, [desktop, documentId, policyRead.status, display.status, hudConfig.status]);
  useEffect(() => {
    const observe = () =>
      nativeSnapshot('program_display', {
        hostRole: desktop ? 'desktop' : 'browser',
        overlayGeneration: desktop ? (window.__MIZAR_OVERLAY_GENERATION__ ?? null) : null,
        overlayDocument: desktop ? (documentId ?? null) : null,
        policyRead: desktop ? policyRead.status : 'not_applicable',
        policyRevision: stablePolicy?.revision ?? null,
        policyEnabled: stablePolicy?.enabled ?? null,
        displayStatus: display.status,
        displaySource: display.current
          ? 'broadcast_display'
          : display.status === 'unsupported'
            ? 'none'
            : 'legacy',
        legacyStatus: hudConfig.status,
        legacyRevision: hudConfig.activeRevision,
        displayRevision: display.current?.activeRevision ?? null,
        displayReason: display.reason ?? null,
        hudRoot: !!document.querySelector('.gameplay-hud'),
        widgets: [...document.querySelectorAll('[data-hud-widget]')].map((node) =>
          node.getAttribute('data-hud-widget'),
        ),
        radar: !!document.querySelector('[data-hud-widget="radar"]'),
      });
    observe();
    const timer = setInterval(observe, 1000);
    return () => clearInterval(timer);
  }, [
    desktop,
    documentId,
    policyRead.status,
    stablePolicy?.revision,
    stablePolicy?.enabled,
    display,
    hudConfig.status,
    hudConfig.activeRevision,
  ]);
  const activeSnapshot = programConnection.current;

  const program = (
    <ProgramCueRendererBridge client={cueClient}>
      {display.status === 'unsupported' && display.current === null ? null : (
        <ProgramPage
          radarSource={radarSource}
          connectionState={programConnection.state}
          resolvedPreset={resolved}
          overlays={overlays}
          accent={activeHud?.accent}
          snapshot={activeSnapshot}
          gg={
            scenes?.active === 'gameplay' &&
            (scenes.director?.gg?.remainingMs ?? 0) > 0 &&
            scenes.director?.gg?.mapEpoch === activeSnapshot?.cursor.mapEpoch
          }
        />
      )}
    </ProgramCueRendererBridge>
  );
  return window.__TAURI_INTERNALS__ ? (
    <div className="program-desktop-viewport">
      <div
        style={{
          transform: `scale(${desktopWidth / 1920})`,
          transformOrigin: 'top left',
          width: 1920,
          height: 1080,
        }}
      >
        {program}
      </div>
    </div>
  ) : (
    program
  );
}
