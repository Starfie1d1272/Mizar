import { getSideLogo } from '@mizar/cs2-assets';
import type { HudDesign } from '../../hud-design';
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import {
  teamUtilityAsset,
  type PlayerRailSide,
  type TeamSummaryPresentation,
  type TeamUtilityFamily,
} from './presentation';

const SUMMARY_HOLD_MS = 5_000;

function formatMoney(value: number | null): string {
  return value === null ? '—' : `$${Math.round(value).toLocaleString('en-US')}`;
}

function formatUtility(value: number | null): string {
  return value === null ? '—' : String(value);
}

const UTILITY_SLOTS: readonly { readonly family: TeamUtilityFamily; readonly label: string }[] = [
  { family: 'smoke', label: 'SMOKE' },
  { family: 'flash', label: 'FLASH' },
  { family: 'he', label: 'HE' },
  { family: 'fire', label: 'FIRE' },
];

function UtilityAsset({
  side,
  family,
  label,
}: {
  readonly side: PlayerRailSide;
  readonly family: TeamUtilityFamily;
  readonly label: string;
}) {
  const asset = teamUtilityAsset(side, family);
  if (asset === null) return null;
  const style = { '--player-rail-icon': `url("${asset.outputPath}")` } as CSSProperties;
  return (
    <span
      aria-hidden="true"
      className="player-rail__icon"
      data-asset-id={asset.canonicalKey}
      style={style}
    >
      {label}
    </span>
  );
}

export function TeamSummary({
  design = 'current',
  phase,
  side,
  summary,
}: {
  readonly design?: HudDesign;
  readonly phase: 'freezetime' | 'live' | 'unknown';
  readonly side: PlayerRailSide;
  readonly summary: TeamSummaryPresentation;
}) {
  const previousPhase = useRef(phase);
  const [carryoverActive, setCarryoverActive] = useState(false);

  useEffect(() => {
    const wasFreezetime = previousPhase.current === 'freezetime';
    previousPhase.current = phase;
    if (phase !== 'live' || !wasFreezetime) {
      setCarryoverActive(false);
      return;
    }
    setCarryoverActive(true);
    const timer = window.setTimeout(() => setCarryoverActive(false), SUMMARY_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const economyVisible = phase === 'freezetime' || (phase === 'live' && carryoverActive);
  const utilityVisible = phase === 'freezetime' || phase === 'live';
  const visible = economyVisible || utilityVisible;
  const utilityOnly = utilityVisible && !economyVisible;
  const displayed = summary;
  const utility = displayed.utility;

  if (design === 'perfectworld')
    return (
      <div
        className="shanghai-summary"
        data-summary-economy-visible={economyVisible}
        data-side={side}
        aria-hidden={!visible}
      >
        {economyVisible ? (
          <div className="shanghai-summary__economy">
            {side === 'CT' || side === 'T' ? (
              <img className="shanghai-summary__side" src={getSideLogo(side)?.outputPath} alt="" />
            ) : null}
            <div>
              <strong>{formatMoney(displayed.lossBonus).replaceAll(',', '')}</strong>
              <span>Loss Bonus</span>
            </div>
            <div>
              <strong>{formatMoney(displayed.equip).replaceAll(',', '')}</strong>
              <span>Equipment Value</span>
            </div>
          </div>
        ) : null}
        <div className="shanghai-summary__utility">
          {UTILITY_SLOTS.map(({ family, label }) => (
            <span key={family} aria-label={`${label} ${formatUtility(utility?.[family] ?? null)}`}>
              <UtilityAsset family={family} label={label} side={side} />
              <b>x{formatUtility(utility?.[family] ?? null)}</b>
            </span>
          ))}
        </div>
      </div>
    );
  return (
    <div
      aria-hidden={!visible}
      className={`player-rail__summary${visible ? ' is-visible' : ''}${
        utilityOnly ? ' is-utility-only' : ''
      }`}
      data-summary-carryover={carryoverActive}
      data-summary-economy-visible={economyVisible}
      data-summary-mode={visible ? (utilityOnly ? 'utility-only' : 'full') : 'hidden'}
      data-summary-phase={phase}
      data-summary-utility-visible={utilityVisible}
      data-summary-visible={visible}
      data-team-summary={side}
    >
      <div
        aria-hidden={!economyVisible}
        className={`player-rail__economy${economyVisible ? ' is-visible' : ''}`}
        data-summary-row="economy"
      >
        <div>
          <span>MONEY</span>
          <strong>{formatMoney(displayed.money)}</strong>
        </div>
        <div>
          <span>EQUIP</span>
          <strong>{formatMoney(displayed.equip)}</strong>
        </div>
        <div>
          <span>LOSS</span>
          <strong>{formatMoney(displayed.lossBonus).replaceAll(',', '')}</strong>
        </div>
      </div>
      <div
        aria-hidden={!utilityVisible}
        className={`player-rail__utility${utilityVisible ? ' is-visible' : ''}${
          utilityOnly ? ' is-live-only' : ''
        }`}
        data-summary-row="utility"
      >
        {UTILITY_SLOTS.map(({ family, label }) => (
          <span
            aria-label={`${label} ${utility === null ? 'unavailable' : utility[family]}`}
            className="player-rail__summary-utility"
            data-utility={family}
            key={family}
          >
            <UtilityAsset family={family} label={label} side={side} />
            <b>{formatUtility(utility?.[family] ?? null)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

export { SUMMARY_HOLD_MS };
