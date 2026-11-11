import { pulseTokenStyle } from './broadcast-display';
import { useBroadcastDisplayConfig } from '../realtime/broadcast-display-client';
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  programPresentationSchema,
  type ProgramPresentation,
  type ProgramSceneId,
} from '@mizar/protocol/program-scenes';
import type { ProgramSnapshot } from '@mizar/protocol/program';
import { useHudConfigClient } from '../realtime/hud-config-client';
import { useLocalChannelClient } from '../realtime';
import { useProgramScenes } from '../workspace/client';
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
  const variant = params.get('variant');
  const [sample, setSample] = useState<{
    sceneId: ProgramSceneId;
    variant: string | null;
    data: ProgramPresentation;
    snapshot: ProgramSnapshot;
  } | null>(null);
  useEffect(() => {
    if (!preview) return;
    let active = true;
    void import('./presentation-preview')
      .then((loaded) => {
        if (active)
          setSample({
            sceneId,
            variant,
            data: loaded.presentationPreview(sceneId, variant),
            snapshot: loaded.programPreviewSnapshot('gameplay', variant),
          });
      })
      .catch((error: unknown) => {
        if (active) console.error('Mizar 节目预览样例加载失败', error);
      });
    return () => {
      active = false;
    };
  }, [preview, sceneId, variant]);
  const selectedSample = sample?.sceneId === sceneId && sample.variant === variant ? sample : null;
  const data = preview ? (selectedSample?.data ?? null) : liveData;
  const scenes = useProgramScenes();
  const reducedMotion = useSyncExternalStore(subscribeMotion, readReducedMotion, () => false);
  const display = useBroadcastDisplayConfig(!preview, sceneId);
  const hud = useHudConfigClient(
    preview || (display.current === null && display.status !== 'unsupported'),
  );
  const activeHud =
    !preview && display.current?.hud.renderer === 'native' ? display.current.hud : null;
  const client = useLocalChannelClient('program');
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const snapshot = preview ? (selectedSample?.snapshot ?? null) : connection.current;
  const clock = snapshot?.payload.clock?.phase;
  const matchId = data?.match?.matchId ?? null;
  const observedMatch = connection.current?.payload.match?.matchId;
  const waiting = sceneId === 'waiting';
  const canRotate =
    !preview &&
    (waiting || sceneId === 'intermap') &&
    scenes?.active === sceneId &&
    !scenes.preparing &&
    (waiting
      ? scenes.productionActive === true
      : (scenes.director?.mode === 'auto' ||
          (scenes.director?.mode === 'blocked' && scenes.director.blockCause === 'telemetry')) &&
        clock !== 'paused' &&
        clock !== 'timeout_ct' &&
        clock !== 'timeout_t');
  // Gameplay deliberately withholds its match before a map is bound. Static
  // pre-match cards use the selected presentation, but never a conflicting match.
  const sameMatch =
    !connection.current || observedMatch === matchId || (waiting && observedMatch == null);
  if (preview ? data === null : display.current === null) return null;
  const sceneStyle = display.current
    ? (pulseTokenStyle(display.current.program) ?? undefined)
    : undefined;
  const scene = (
    <ProgramView
      kind="scene"
      sceneStyle={sceneStyle}
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
  return canRotate && sameMatch && matchId ? (
    <RotatingScene
      key={JSON.stringify([sceneId, matchId])}
      matchId={matchId}
      sceneStyle={sceneStyle}
    >
      {scene}
    </RotatingScene>
  ) : (
    scene
  );
}

function RotatingScene({
  matchId,
  children,
  sceneStyle,
}: {
  readonly matchId: string;
  readonly children: ReactNode;
  readonly sceneStyle?: CSSProperties | undefined;
}) {
  const insert = useStatsRotation(true, matchId);
  return insert ? <StatsInsertView insert={insert} sceneStyle={sceneStyle} /> : children;
}
