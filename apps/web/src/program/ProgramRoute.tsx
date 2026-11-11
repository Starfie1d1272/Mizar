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

export function ProgramRoute() {
  const scenes = useProgramScenes();
  const [desktopWidth, setDesktopWidth] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => setDesktopWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const radarClient = useLocalChannelClient('radar');
  const radarSource = useRadarViewSource(radarClient);
  const programClient = useLocalChannelClient('program');
  const programConnection = useSyncExternalStore(
    programClient.subscribe,
    programClient.getSnapshot,
    programClient.getSnapshot,
  );
  const useCompanionConfig =
    import.meta.env.VITE_VISUAL_FIXTURES !== '1' ||
    new URLSearchParams(window.location.search).get('hud-config') === 'companion';
  const display = useBroadcastDisplayConfig(useCompanionConfig);
  const hudConfig = useHudConfigClient(
    useCompanionConfig && display.current === null && display.status !== 'unsupported',
  );
  const activeHud = display.current?.hud.renderer === 'native' ? display.current.hud : null;
  const selectedHud = activeHud?.config ?? hudConfig.current;
  const cueClient = useMemo(
    () =>
      createProgramCueClient({
        getProgramSnapshot: () => programClient.getSnapshot().current,
      }),
    [programClient],
  );
  const cueDisposal = useRef<{ client: typeof cueClient; timer: number } | null>(null);
  useEffect(() => {
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
  }, [cueClient, programClient]);

  const desktop =
    window.__TAURI_INTERNALS__ !== undefined &&
    new URLSearchParams(window.location.search).get('host') === 'desktop';
  const policyRead = useLocalReadWithTime<OverlayPolicy>(
    desktop ? '/local/v1/desktop-overlay' : null,
    desktop ? 1000 : 60000,
  );
  const policy = policyRead.value;
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
        policyRevision: policy?.revision ?? null,
        policyEnabled: policy?.enabled ?? null,
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
    policy?.revision,
    policy?.enabled,
    display,
    hudConfig.status,
    hudConfig.activeRevision,
  ]);
  const resolved = desktop
    ? {
        ...selectedHud,
        layout: {
          ...selectedHud.layout,
          widgets: Object.fromEntries(
            Object.entries(selectedHud.layout.widgets).map(([id, placement]) => [
              id,
              {
                ...placement,
                visible: desktopWidgetVisible(policy, id, placement.visible),
              },
            ]),
          ) as typeof selectedHud.layout.widgets,
        },
      }
    : selectedHud;
  const overlays =
    activeHud && desktop && (!policy || !overlayGroups(policy).hud)
      ? {
          pause: { ...activeHud.overlays.pause, enabled: false },
          chat: { ...activeHud.overlays.chat, enabled: false },
        }
      : activeHud?.overlays;
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
