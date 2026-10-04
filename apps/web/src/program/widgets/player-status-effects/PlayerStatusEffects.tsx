import type { CSSProperties } from 'react';
import type { HudDesign } from '../../hud-design';
import './broadcast-smoke.css';

import type { PlayerStatusEffectState } from './presentation';

function effectStrength(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value <= 0) return 0;
  const normalized = value <= 1 ? value : value / 255;
  return Math.max(0, Math.min(1, Math.pow(normalized, 0.72)));
}

export function PlayerStatusEffects({
  state,
  anchor = 'left',
  design = 'current',
}: {
  readonly state: PlayerStatusEffectState;
  readonly anchor?: 'left' | 'right';
  readonly design?: HudDesign;
}) {
  const smoke = effectStrength(state.smoked);
  const burning = effectStrength(state.burning);
  const flashed = Math.min(0.72, effectStrength(state.flashed));

  const style = {
    '--rh-player-status-smoke': smoke,
    '--rh-player-status-burning': burning,
    '--rh-player-status-flashed': flashed,
  } as CSSProperties;

  return (
    <>
      {design !== 'current' ? (
        <div
          className="broadcast-smoke"
          data-smoked={smoke > 0}
          data-anchor={anchor}
          style={style}
          aria-hidden="true"
        >
          <span className="player-status-effects__smoke" />
        </div>
      ) : null}
      <div
        aria-hidden="true"
        className="player-status-effects"
        data-anchor={anchor}
        data-burning={burning > 0}
        data-flashed={flashed > 0}
        data-smoked={smoke > 0}
        style={style}
      >
        {design === 'current' ? <span className="player-status-effects__smoke" /> : null}
        <span className="player-status-effects__fire" />
        <span className="player-status-effects__flash" />
      </div>
    </>
  );
}
