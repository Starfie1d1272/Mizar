import { useBroadcastDisplayConfig } from '../realtime/broadcast-display-client';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  programPresentationSchema,
  type ProgramPresentation,
  type ProgramSceneId,
} from '@mizar/protocol/program-scenes';
import { useHudConfigClient } from '../realtime/hud-config-client';
import { useLocalChannelClient } from '../realtime';
import { useProgramScenes } from '../workspace/client';
import { presentationPreview, programPreviewSnapshot } from './presentation-preview';
import { ProgramView, StatsInsertView } from '@mizar/hud-view';
import { useStatsRotation } from './useStatsRotation';

const motionQuery = '(prefers-reduced-motion: reduce)';
const subscribeMotion = (notify: () => void) => {
  const query = window.matchMedia(motionQuery);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};
const readReducedMotion = () => window.matchMedia(motionQuery).matches;

function usePresentation(preview: boolean) {
  const [value, setValue] = useState<ProgramPresentation | null>(null);
  useEffect(() => {
    if (preview) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch('/local/v1/program-presentation', {
          cache: 'no-store',
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          const next = programPresentationSchema.parse(await response.json());
          if (active) setValue(next);
        }
      } catch {
        /* Static on-air continuity: retain the last safe server projection. */
      } finally {
        if (active) timer = setTimeout(() => void poll(), 250);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [preview]);
  return value;
}

export function ProgramScenePage({ sceneId }: { readonly sceneId: ProgramSceneId }) {
  const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const preview = params.get('preview') === '1';
  const liveData = usePresentation(preview);
  const data = preview ? presentationPreview(sceneId, params.get('variant')) : liveData;
  const scenes = useProgramScenes();
  const reducedMotion = useSyncExternalStore(subscribeMotion, readReducedMotion, () => false);
  const display = useBroadcastDisplayConfig(!preview);
  const hud = useHudConfigClient(
    preview || (display.current === null && display.status !== 'unsupported'),
  );
  const activeHud =
    !preview && display.current?.hud.renderer === 'native' ? display.current.hud : null;
  const client = useLocalChannelClient('program');
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const snapshot = preview
    ? programPreviewSnapshot('gameplay', params.get('variant'))
    : connection.current;
  const clock = snapshot?.payload.clock?.phase;
  const canRotate =
    !preview &&
    (sceneId === 'waiting' || sceneId === 'intermap') &&
    scenes?.active === sceneId &&
    (scenes.director?.mode === 'auto' ||
      (scenes.director?.mode === 'blocked' && scenes.director.blockCause === 'telemetry')) &&
    !scenes.preparing &&
    clock !== 'paused' &&
    clock !== 'timeout_ct' &&
    clock !== 'timeout_t';
  const matchId = data?.match?.matchId ?? null;
  const observedMatch = connection.current?.payload.match?.matchId;
  if (!preview && display.status === 'unsupported' && display.current === null) return null;
  const scene = (
    <ProgramView
      kind="scene"
      sceneId={sceneId}
      data={data}
      snapshot={snapshot ?? null}
      scenes={scenes}
      resolvedPreset={activeHud?.config ?? hud.current}
      overlays={activeHud?.overlays}
      accent={activeHud?.accent}
      reducedMotion={reducedMotion}
      preview={preview}
      shortIntro={params.get('intro') === 'short'}
      previewBackground={params.get('background') !== 'transparent'}
    />
  );
  return canRotate && (!connection.current || observedMatch === matchId) && matchId ? (
    <RotatingScene key={JSON.stringify([sceneId, matchId])} matchId={matchId}>
      {scene}
    </RotatingScene>
  ) : (
    scene
  );
}

function RotatingScene({
  matchId,
  children,
}: {
  readonly matchId: string;
  readonly children: ReactNode;
}) {
  const insert = useStatsRotation(true, matchId);
  return insert ? <StatsInsertView insert={insert} /> : children;
}
