import { useEffect, useState, type CSSProperties } from 'react';
import type { ProgramPayload } from '@mizar/protocol/program';

type Prediction = ProgramPayload['bombDamage']['players'][number];
interface Echo {
  readonly scope: string;
  readonly health: number;
  readonly start: number;
  readonly lethal: boolean;
}
interface Sample {
  readonly prediction: Prediction | undefined;
  readonly health: number;
  readonly explosionHandoff: boolean;
  readonly scope: string | null;
  readonly sequence: number | null;
}

/** A short visual handoff, never a current estimate or a predicted HP update. */
export function BombPredictionBar({
  prediction,
  health,
  explosionHandoff,
  scope,
  sequence,
}: Sample) {
  const [state, setState] = useState<{ sample: Sample | null; echo: Echo | null }>({
    sample: null,
    echo: null,
  });
  const prior = state.sample;
  let echo = state.echo;
  if (
    prior === null ||
    prior.prediction !== prediction ||
    prior.health !== health ||
    prior.explosionHandoff !== explosionHandoff ||
    prior.scope !== scope ||
    prior.sequence !== sequence
  ) {
    if (!explosionHandoff || scope === null || echo?.scope !== scope || echo.health !== health)
      echo = null;
    if (
      explosionHandoff &&
      scope !== null &&
      prior?.prediction?.status === 'predicted' &&
      prior.prediction.damage > 0 &&
      !prior.explosionHandoff &&
      prior.scope === scope &&
      prior.health === health &&
      prior.sequence !== null &&
      sequence === prior.sequence + 1
    ) {
      echo = {
        scope,
        health,
        start: Math.max(0, Math.min(100, prior.prediction.hpAfter)),
        lethal: prior.prediction.lethal,
      };
    }
    // Adjust this presentation state before children paint; no effect-driven second frame.
    setState({ sample: { prediction, health, explosionHandoff, scope, sequence }, echo });
  }
  useEffect(() => {
    if (echo === null) return;
    const timer = window.setTimeout(
      () => setState((value) => (value.echo === echo ? { ...value, echo: null } : value)),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [echo]);
  const style = (start: number): CSSProperties =>
    ({
      '--prediction-start': `${start}%`,
      '--prediction-end': `${health}%`,
    }) as CSSProperties;
  if (prediction?.status === 'predicted' && prediction.damage > 0) {
    return (
      <i
        className="player-rail__bomb-prediction"
        data-bomb-prediction={prediction.lethal ? 'lethal' : 'surviving'}
        aria-label={`C4 standing estimate: ${prediction.damage} damage, ${prediction.hpAfter} HP remaining`}
        style={style(Math.max(0, Math.min(100, prediction.hpAfter)))}
      />
    );
  }
  if (explosionHandoff && echo !== null && echo.scope === scope && echo.health === health) {
    return (
      <i
        className="player-rail__bomb-prediction"
        data-bomb-estimate-echo={echo.lethal ? 'lethal' : 'surviving'}
        aria-label="Pre-explosion estimate handoff"
        style={style(echo.start)}
      />
    );
  }
  if (prediction?.status === 'unavailable' && prediction.reason === 'prediction-loading') {
    return (
      <i
        className="player-rail__bomb-prediction player-rail__bomb-prediction--pending"
        data-bomb-prediction="updating"
        aria-label="C4 estimate updating"
        style={style(0)}
      />
    );
  }
  return null;
}
