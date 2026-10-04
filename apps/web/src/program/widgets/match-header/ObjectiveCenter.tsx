/* eslint-disable react-hooks/refs -- render-local sample continuity is intentionally kept outside domain state. */
/** Icon/progress composition adapted from Lexogrine BombTimer.tsx / PlantDefuse.tsx,
 * cs2-react-hud@7874750c97fcecd8f72eb3fad382917e035ec651 (MIT).
 * User reference choreography consumes semantic progress; no browser countdown owner. */
import { getCs2Asset, getCs2Item } from '@mizar/cs2-assets';
import type { ProjectionCursor } from '@mizar/protocol/shared';
import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { consecutivePresentationSamples } from '../../presentation-sample';
import type { MatchHeaderPresentation } from './presentation';
import type { ObjectiveCenterPresentation } from './objective-presentation';
import type { HudDesign } from '../../hud-design';
function Icon({
  id,
  defusing = false,
  className,
}: {
  readonly id: string;
  readonly defusing?: boolean;
  readonly className?: string;
}) {
  const item = getCs2Item(id);
  const asset = item === undefined ? undefined : getCs2Asset(item.assetId);
  return asset === undefined ? null : (
    <span
      role="img"
      aria-label={id === 'objective.c4' ? 'C4' : '拆弹器'}
      data-asset-id={id}
      className={`objective-center__icon${defusing ? ' is-defusing' : ''}${className ? ` ${className}` : ''}`}
      style={{ '--objective-icon': `url("${asset.outputPath}")` } as CSSProperties}
    />
  );
}
function useInterpolatedProgress(
  value: number | null,
  mode: ObjectiveCenterPresentation['mode'],
  cursor: ProjectionCursor,
  presentationRevision: number,
  direction: 'increasing' | 'decreasing' = 'increasing',
) {
  const previous = useRef<{
    readonly value: number | null;
    readonly mode: ObjectiveCenterPresentation['mode'];
    readonly cursor: ProjectionCursor;
    readonly presentationRevision: number;
    readonly transition: boolean;
  } | null>(null);
  const prior = previous.current;
  const currentSequence = cursor.programReceiveSequence ?? cursor.runtimeSeq;
  const samePresentationSample =
    prior !== null &&
    prior.value === value &&
    prior.mode === mode &&
    prior.presentationRevision === presentationRevision &&
    prior.cursor.producerInstanceId === cursor.producerInstanceId &&
    prior.cursor.liveSessionId === cursor.liveSessionId &&
    prior.cursor.programSourceGeneration === cursor.programSourceGeneration &&
    prior.cursor.mapEpoch === cursor.mapEpoch &&
    (prior.cursor.programReceiveSequence ?? prior.cursor.runtimeSeq) === currentSequence;
  if (samePresentationSample) {
    return { value, transition: prior.transition };
  }
  const transition =
    value !== null &&
    prior !== null &&
    prior.value !== null &&
    prior.mode === mode &&
    (direction === 'increasing' ? value >= prior.value : value <= prior.value) &&
    consecutivePresentationSamples(
      prior.cursor,
      cursor,
      prior.presentationRevision,
      presentationRevision,
    );
  previous.current = { value, mode, cursor, presentationRevision, transition };
  return { value, transition };
}

export function ObjectiveFuse({
  center,
  cursor,
  presentationRevision,
}: {
  readonly center: ObjectiveCenterPresentation;
  readonly cursor: ProjectionCursor;
  readonly presentationRevision: number;
}) {
  const fuse = useInterpolatedProgress(
    center.fuse,
    center.mode,
    cursor,
    presentationRevision,
    'decreasing',
  );
  return (
    <div
      className="objective-center__fuse"
      data-objective-track="fuse"
      data-progress={fuse.value === null ? 'unavailable' : 'determinate'}
      data-danger={center.danger}
    >
      {fuse.value === null ? null : (
        <span
          data-fuse-value={fuse.value}
          style={{
            left: '50%',
            transform: 'translateX(-50%)',
            transition: fuse.transition ? 'width 220ms linear' : 'none',
            width: `${fuse.value * 100}%`,
          }}
        />
      )}
    </div>
  );
}
export function ObjectiveCenter({
  presentation,
  cursor,
  presentationRevision,
}: {
  readonly design?: HudDesign;
  readonly presentation: MatchHeaderPresentation;
  readonly cursor: ProjectionCursor;
  readonly presentationRevision: number;
}) {
  const c = presentation.objective;
  const action = useInterpolatedProgress(c.action, c.mode, cursor, presentationRevision);
  const previous = useRef<{
    readonly mode: typeof c.mode;
    readonly cursor: ProjectionCursor;
    readonly presentationRevision: number;
  }>({ mode: c.mode, cursor, presentationRevision });
  const plantedTimer = useRef<number | null>(null);
  const [plantedTransition, setPlantedTransition] = useState(false);
  useEffect(() => {
    const prior = previous.current;
    const continuous = consecutivePresentationSamples(
      prior.cursor,
      cursor,
      prior.presentationRevision,
      presentationRevision,
    );
    const shouldCommit = prior.mode === 'planting' && c.mode === 'planted' && continuous;
    previous.current = { mode: c.mode, cursor, presentationRevision };
    if (shouldCommit) {
      if (plantedTimer.current !== null) window.clearTimeout(plantedTimer.current);
      setPlantedTransition(true);
      plantedTimer.current = window.setTimeout(() => {
        plantedTimer.current = null;
        setPlantedTransition(false);
      }, 280);
    } else if (!continuous || c.mode !== 'planted') {
      if (plantedTimer.current !== null) window.clearTimeout(plantedTimer.current);
      plantedTimer.current = null;
      setPlantedTransition(false);
    }
  }, [
    c.mode,
    cursor,
    cursor.producerInstanceId,
    cursor.liveSessionId,
    cursor.programSourceGeneration,
    cursor.programReceiveSequence,
    cursor.mapEpoch,
    cursor.runtimeSeq,
    presentationRevision,
  ]);
  useEffect(
    () => () => {
      if (plantedTimer.current !== null) window.clearTimeout(plantedTimer.current);
    },
    [],
  );
  return (
    <div
      className="objective-center"
      data-objective-mode={c.mode}
      data-danger={c.danger}
      data-planted-transition={plantedTransition}
      data-timing-available={c.fuse !== null}
      aria-label={
        c.mode === 'planting' ? 'PLANTING' : c.mode === 'defusing' ? 'DEFUSING' : 'PLANTED'
      }
    >
      {c.mode === 'defusing' ? (
        <>
          <div
            className="objective-center__ring"
            data-objective-track="action"
            data-progress={c.action === null || c.stateOnly ? 'unavailable' : 'determinate'}
          >
            <Icon id={c.hasKit ? 'equipment.defuse-kit' : 'objective.c4'} defusing />
            <svg viewBox="0 0 64 64" aria-hidden="true">
              <circle className="objective-center__ring-track" cx="32" cy="32" r="29" />
              {action.value === null || c.stateOnly ? null : (
                <circle
                  className="objective-center__ring-fill"
                  cx="0"
                  cy="0"
                  r="29"
                  pathLength="1"
                  strokeDasharray="1"
                  strokeDashoffset={1 - action.value}
                  transform="translate(32 32) scale(-1 1) rotate(-90)"
                  style={{
                    transition: action.transition ? 'stroke-dashoffset 220ms linear' : 'none',
                  }}
                />
              )}
            </svg>
          </div>
          <span className="objective-center__caption" title={c.playerName ?? undefined}>
            {c.playerName ?? 'DEFUSING'}
          </span>
        </>
      ) : (
        <>
          <div className="objective-center__bomb">
            <span className="objective-center__device">
              <Icon className={plantedTransition ? 'is-planted-commit' : ''} id="objective.c4" />
              {(c.mode === 'planted' && !c.stateOnly) ||
              (c.mode === 'planting' && action.value !== null) ? (
                <span
                  className="objective-center__code"
                  aria-hidden="true"
                  data-code-steps={
                    c.mode === 'planted' ? 4 : Math.min(4, Math.floor(action.value! * 4) + 1)
                  }
                >
                  {[0, 1, 2, 3].map((step) => (
                    <i
                      key={step}
                      data-filled={
                        c.mode === 'planted' ||
                        step < Math.min(4, Math.floor(action.value! * 4) + 1)
                      }
                    />
                  ))}
                </span>
              ) : null}
            </span>
            <span aria-hidden="true" className="objective-center__led" />
            {c.mode === 'planting' ? (
              <div
                className="objective-center__plant-progress"
                aria-label="安装进度"
                data-objective-track="action"
                data-progress={c.action === null ? 'unavailable' : 'determinate'}
              >
                {action.value === null ? null : (
                  <span
                    data-action-value={action.value}
                    data-action-transition={action.transition}
                    style={{
                      transition: action.transition ? 'width 220ms linear' : 'none',
                      width: `${action.value * 100}%`,
                    }}
                  />
                )}
              </div>
            ) : null}
          </div>
          {c.stateOnly || (c.mode === 'planting' && c.action === null) ? (
            <span className="objective-center__caption">
              {c.mode === 'planting' ? 'PLANTING' : 'PLANTED'}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}
