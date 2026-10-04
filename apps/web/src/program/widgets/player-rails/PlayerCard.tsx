import { EquipmentIcon } from '../player-equipment/EquipmentIcon';
import { StatGlyph } from '../player-status-effects/StatGlyph';
import type { ProgramPayload } from '@mizar/protocol/program';
import { playerRailSettingsSchema, type PlayerRailSettings } from '@mizar/hud-config';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ProjectionCursor } from '@mizar/protocol/shared';

import { observerHotkeyLabel } from '../../observer-hotkey';
import type { HudDesign } from '../../hud-design';
import {
  CombatTransitionEffects,
  DamageGhost,
  PlayerImpactEffects,
  type DamageGhostState,
  useCombatFeedback,
} from '../player-status-effects/combat-feedback';
import { PlayerStatusEffects } from '../player-status-effects/PlayerStatusEffects';
import {
  weaponVisualRole,
  type PlayerCardPresentation,
  type PlayerRailAsset,
  type PlayerRailWeapon,
} from './presentation';

function displayNumber(value: number | null): string {
  return value === null ? '—' : String(Math.round(value));
}

function displayMoney(value: number | null): string {
  return value === null ? '—' : `$${Math.round(value).toLocaleString('en-US')}`;
}

function displaySpent(value: number | null): string {
  return value === null
    ? '—'
    : '-' + String.fromCharCode(36) + Math.round(value).toLocaleString('en-US');
}

type PresencePhase = 'enter' | 'steady' | 'exit';

type PresenceItem<T extends { readonly key: string }> = T & {
  readonly motionPhase: PresencePhase;
};

function usePresenceItems<T extends { readonly key: string }>(
  items: readonly T[],
  signature: string,
  presentationRevision: number,
  exitMs = 110,
): readonly PresenceItem<T>[] {
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const revisionRef = useRef(presentationRevision);
  const [rendered, setRendered] = useState<readonly PresenceItem<T>[]>(() =>
    items.map((item) => ({ ...item, motionPhase: 'steady' as const })),
  );

  useEffect(() => {
    const current = itemsRef.current;
    if (revisionRef.current !== presentationRevision) {
      revisionRef.current = presentationRevision;
      setRendered(current.map((item) => ({ ...item, motionPhase: 'steady' as const })));
      return;
    }

    setRendered((previous) => {
      const previousByKey = new Map(previous.map((item) => [item.key, item]));
      const currentKeys = new Set(current.map((item) => item.key));
      return [
        ...current.map((item) => ({
          ...item,
          motionPhase: previousByKey.has(item.key) ? ('steady' as const) : ('enter' as const),
        })),
        ...previous
          .filter((item) => !currentKeys.has(item.key) && item.motionPhase !== 'exit')
          .map((item) => ({ ...item, motionPhase: 'exit' as const })),
      ];
    });

    const timer = window.setTimeout(() => {
      setRendered((previous) =>
        previous
          .filter((item) => item.motionPhase !== 'exit')
          .map((item) =>
            item.motionPhase === 'enter' ? { ...item, motionPhase: 'steady' as const } : item,
          ),
      );
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [exitMs, presentationRevision, signature]);

  return rendered;
}

function WeaponIcon({
  weapon,
  pairedWithFirearm,
  physicalSide,
}: {
  readonly weapon: PlayerRailWeapon | null;
  readonly pairedWithFirearm: boolean;
  readonly physicalSide: 'left' | 'right';
}) {
  const visualRole = weapon === null ? undefined : weaponVisualRole(weapon, pairedWithFirearm);
  return (
    <EquipmentIcon
      asset={weapon?.asset ?? null}
      active={weapon?.active}
      className={`player-rail__icon ${visualRole === undefined ? '' : `is-${visualRole}`}`}
      physicalSide={physicalSide}
      label={weapon?.name ?? 'Weapon'}
      {...(visualRole === undefined ? {} : { weaponVisualRole: visualRole })}
    />
  );
}

function Avatar({
  player,
  dead,
  onUnavailable,
}: {
  readonly player: PlayerCardPresentation;
  readonly dead: boolean;
  readonly onUnavailable?: () => void;
}) {
  return (
    <div
      aria-hidden="true"
      className="player-rail__avatar"
      data-avatar-present={player.avatarUrl !== null}
      data-card-part="avatar"
    >
      {player.avatarUrl === null ? null : (
        <img
          alt=""
          onError={(event) => {
            event.currentTarget.style.display = 'none';
            onUnavailable?.();
          }}
          src={player.avatarUrl}
          data-dead={dead}
        />
      )}
    </div>
  );
}

function Equipment({
  player,
  presentationRevision,
}: {
  readonly player: PlayerCardPresentation;
  readonly presentationRevision: number;
}) {
  const slots = [
    { key: 'armor', label: 'Armor', asset: player.armorAsset },
    { key: 'kit', label: 'Defuse kit', asset: player.defuserAsset },
    { key: 'c4', label: 'C4', asset: player.c4Asset },
    { key: 'zeus', label: 'Zeus', asset: player.zeus?.asset ?? null },
  ].filter(
    (slot): slot is { key: string; label: string; asset: PlayerRailAsset } => slot.asset !== null,
  );
  const signature = slots.map((slot) => `${slot.key}:${slot.asset.canonicalKey}`).join('|');
  const visibleSlots = usePresenceItems(slots, signature, presentationRevision);

  return (
    <div className="player-rail__equipment" data-player-equipment="true">
      {visibleSlots.map((slot) => (
        <span
          className="player-rail__equipment-slot"
          data-equipment={slot.key}
          data-motion-phase={slot.motionPhase}
          key={slot.key}
        >
          <EquipmentIcon className="player-rail__icon" asset={slot.asset} label={slot.label} />
        </span>
      ))}
    </div>
  );
}

const UTILITY_FAMILIES = ['smoke', 'flash', 'he', 'fire'] as const;

function UtilityIcons({
  player,
  presentationRevision,
}: {
  readonly player: PlayerCardPresentation;
  readonly presentationRevision: number;
}) {
  const counts = new Map<
    PlayerCardPresentation['utility'][number]['family'],
    { count: number; asset: PlayerRailAsset | null; active: boolean }
  >();
  for (const utility of player.utility) {
    const current = counts.get(utility.family);
    counts.set(utility.family, {
      count: (current?.count ?? 0) + utility.count,
      asset: current?.asset ?? utility.asset,
      active: Boolean(current?.active || utility.active),
    });
  }

  const icons = UTILITY_FAMILIES.flatMap((family) => {
    const utility = counts.get(family);
    if (utility === undefined || utility.asset === null) return [];
    const asset = utility.asset;
    return Array.from({ length: utility.count }, (_, index) => ({
      asset,
      family,
      key: `${family}-${index}`,
      active: utility.active && index === 0,
    }));
  }).slice(0, 4);
  const signature = icons
    .map((utility) => `${utility.key}:${utility.asset.canonicalKey}`)
    .join('|');
  const visibleIcons = usePresenceItems(icons, signature, presentationRevision);

  return (
    <div className="player-rail__utility-icons" data-utility-count={icons.length}>
      {visibleIcons.map((utility) => (
        <span
          aria-label={utility.family}
          className="player-rail__utility-item"
          data-utility-family={utility.family}
          data-motion-phase={utility.motionPhase}
          key={utility.key}
        >
          <EquipmentIcon
            className="player-rail__icon"
            asset={utility.asset}
            label={utility.family}
            active={utility.active}
          />
        </span>
      ))}
    </div>
  );
}

function Kd({ player }: { readonly player: PlayerCardPresentation }) {
  return (
    <span className="player-rail__kd" aria-label="Kills and deaths" data-player-rail-row-part="kd">
      <StatGlyph kind="kills" />
      <span>{displayNumber(player.stats.kills)}</span>
      <StatGlyph kind="deaths" />
      <span>{displayNumber(player.stats.deaths)}</span>
    </span>
  );
}

function RoundKillBadge({ kills }: { readonly kills: number }) {
  return (
    <span
      aria-label={`Round kills ${kills}`}
      className="player-rail__round-kill-badge"
      data-round-kills={kills}
      role="img"
    >
      <svg aria-hidden="true" viewBox="0 0 26 26">
        <path d="M13 1.5V5M13 21V24.5M1.5 13H5M21 13h3.5" />
        <circle cx="13" cy="13" r="6" />
        <text dominantBaseline="central" textAnchor="middle" x="13" y="13">
          {kills}
        </text>
      </svg>
    </span>
  );
}

type BombPrediction = Extract<
  ProgramPayload['bombDamage']['players'][number],
  { status: 'predicted' }
>;

function PlayerBody({
  prediction,
  design,
  physicalSide,
  player,
  dead,
  presentationRevision,
  damageGhost,
  options,
}: {
  readonly design: HudDesign;
  readonly physicalSide: 'left' | 'right';
  readonly player: PlayerCardPresentation;
  readonly dead: boolean;
  readonly presentationRevision: number;
  readonly damageGhost: DamageGhostState | null;
  readonly options: PlayerRailSettings;
  readonly prediction?: BombPrediction | undefined;
}) {
  const healthStyle = { '--player-rail-health': `${player.healthPercent ?? 0}%` } as CSSProperties;
  const secondaryVisible = player.secondaryWeapon !== null;
  const pairedWithFirearm = [
    player.primaryWeapon,
    secondaryVisible ? player.secondaryWeapon : null,
  ].some((weapon) => weapon?.item?.kind === 'firearm' && weapon.item.family !== 'pistol');
  return (
    <div className="player-rail__body" data-card-part="body" data-dead={dead}>
      {dead && (design === 'ewc' || design === 'iem') ? (
        <svg className="player-rail__death-watermark" aria-hidden="true" viewBox="3 2 10 12">
          <path
            fillRule="evenodd"
            d="M4 7.25a4 4 0 1 1 8 0v2.1c0 .8-.42 1.55-1.1 1.97V14H5.1v-2.68A2.3 2.3 0 0 1 4 9.35z M5.2 7.6a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0 M8.4 7.6a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0 M8 9.2l-1 1.6h2z M6 12v2h.7v-2z M7.65 12v2h.7v-2z M9.3 12v2h.7v-2z"
          />
        </svg>
      ) : null}
      <div className="player-rail__identity">
        <span className="player-rail__name" title={player.displayName ?? undefined}>
          {player.displayName ?? 'PLAYER'}
        </span>
        {dead ? (
          <span className="player-rail__life-state" data-life-state-label="dead">
            DEAD
          </span>
        ) : (
          <strong className="player-rail__health-value" data-health-value="true">
            {displayNumber(player.health)}
          </strong>
        )}
      </div>

      {dead ? (
        <div aria-hidden="true" className="player-rail__health-spacer" data-health-spacer="true">
          <DamageGhost state={damageGhost} />
        </div>
      ) : (
        <div className="player-rail__health-bar" data-health-bar="true">
          <span style={healthStyle} data-health-empty={!player.healthPercent} />
          {options.showBombPrediction && prediction && prediction.damage > 0 ? (
            <i
              className="player-rail__bomb-prediction"
              data-bomb-prediction={prediction.lethal ? 'lethal' : 'surviving'}
              aria-label={`C4 standing estimate: ${prediction.damage} damage, ${prediction.hpAfter} HP remaining`}
              style={
                {
                  '--prediction-start': `${Math.max(0, Math.min(100, prediction.hpAfter))}%`,
                  '--prediction-end': `${player.healthPercent ?? 0}%`,
                } as CSSProperties
              }
            />
          ) : null}
          <DamageGhost state={damageGhost} />
        </div>
      )}

      <div
        className="player-rail__combat"
        data-combat-row="true"
        data-dead={dead}
        data-phase={player.mode}
        data-secondary={secondaryVisible}
      >
        {!dead || options.deadInformation === 'stats' ? <Kd player={player} /> : null}
        <div className="player-rail__context" data-player-rail-row-part="context">
          {dead ? (
            <div className="player-rail__dead-stats" data-dead-stats="true">
              {options.deadInformation === 'stats' ? (
                <>
                  {player.liveAdr === null ? null : (
                    <span className="player-rail__adr">
                      <small>ADR</small>
                      <b>{displayNumber(player.liveAdr)}</b>
                    </span>
                  )}
                  {player.currentRoundDamage === null ? null : (
                    <span className="player-rail__damage">
                      <small>DMG</small>
                      <b>{displayNumber(player.currentRoundDamage)}</b>
                    </span>
                  )}
                </>
              ) : null}
            </div>
          ) : (
            <div className="player-rail__loadout">
              {options.showLoadout ? (
                <>
                  <div className="player-rail__weapons">
                    <div className="player-rail__weapon-icons">
                      <WeaponIcon
                        physicalSide={design === 'current' ? 'left' : physicalSide}
                        pairedWithFirearm={pairedWithFirearm}
                        weapon={player.primaryWeapon}
                      />
                      {secondaryVisible ? (
                        <WeaponIcon
                          physicalSide={design === 'current' ? 'left' : physicalSide}
                          pairedWithFirearm={pairedWithFirearm}
                          weapon={player.secondaryWeapon}
                        />
                      ) : null}
                    </div>
                  </div>
                  <Equipment player={player} presentationRevision={presentationRevision} />
                </>
              ) : null}
              {options.showUtility ? (
                <UtilityIcons player={player} presentationRevision={presentationRevision} />
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div className="player-rail__bottom">
        {options.showMoney && (!dead || options.deadInformation === 'stats') ? (
          <span className="player-rail__money">
            {design === 'perfectworld'
              ? displayMoney(player.money).replaceAll(',', '')
              : displayMoney(player.money)}
          </span>
        ) : null}
        {options.showMoney && player.mode === 'freezetime' && !dead ? (
          <span className="player-rail__spent">{displaySpent(player.roundMoneySpent)}</span>
        ) : null}
        <span
          aria-hidden={
            (dead && options.deadInformation === 'minimal') ||
            player.roundKills === null ||
            player.roundKills <= 0
          }
          className="player-rail__round-kill-slot"
          data-round-kill-slot="true"
        >
          {(!dead || options.deadInformation === 'stats') &&
          player.roundKills !== null &&
          player.roundKills > 0 ? (
            <RoundKillBadge key={player.roundKills} kills={player.roundKills} />
          ) : null}
        </span>
      </div>
    </div>
  );
}

export function PlayerCard({
  design = 'current',
  prediction,
  player,
  cursor = null,
  physicalSide = 'left',
  presentationRevision = 0,
  options = playerRailSettingsSchema.parse({}),
}: {
  readonly design?: HudDesign;
  readonly prediction?: BombPrediction | undefined;
  readonly player: PlayerCardPresentation;
  readonly cursor?: ProjectionCursor | null;
  readonly physicalSide?: 'left' | 'right';
  readonly options?: PlayerRailSettings;
  readonly presentationRevision?: number;
}) {
  const dead = player.mode === 'dead';
  const combatFeedback = useCombatFeedback({
    sourcePlayerId: player.sourcePlayerId,
    health: player.health,
    dead,
    cursor,
    presentationRevision,
  });
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
  const hasAvatar =
    options.showAvatar && player.avatarUrl !== null && failedAvatarUrl !== player.avatarUrl;
  const avatar = options.showAvatar ? (
    <Avatar
      dead={dead}
      player={player}
      onUnavailable={() => setFailedAvatarUrl(player.avatarUrl)}
    />
  ) : (
    <div className="player-rail__avatar" data-card-part="avatar" />
  );
  const body = (
    <PlayerBody
      physicalSide={physicalSide}
      design={design}
      prediction={prediction}
      options={options}
      damageGhost={combatFeedback.damageGhost}
      dead={dead}
      player={player}
      presentationRevision={presentationRevision}
    />
  );
  const hotkeyLabel = observerHotkeyLabel(player.observerSlot);
  const endcap = (
    <div
      aria-label={`Observer hotkey ${hotkeyLabel}`}
      className={`player-rail__endcap player-rail__endcap--${physicalSide}`}
      data-card-part="observer-endcap"
      data-observed={player.observed}
      data-side={player.side}
      role="img"
    >
      <strong>{hotkeyLabel}</strong>
    </div>
  );

  return (
    <article
      aria-label={`${player.displayName ?? 'Player'} ${dead ? 'DEAD' : 'player card'}`}
      className={`player-rail__card player-rail__card--${player.mode}${
        player.observed ? ' is-observed' : ''
      }${player.healthPercent !== null && player.healthPercent <= 25 ? ' is-low-health' : ''}`}
      data-avatar={hasAvatar}
      data-life-state={player.lifeState}
      data-observed={player.observed}
      data-player-card={player.sourcePlayerId}
      data-side={player.side}
      data-physical-side={physicalSide}
    >
      {avatar}
      {body}
      <PlayerStatusEffects
        design={design}
        key={`status:${presentationRevision}`}
        anchor={physicalSide}
        state={player.statusEffects}
      />
      <PlayerImpactEffects
        anchor={physicalSide}
        sourcePlayerId={player.sourcePlayerId}
        surface="rail"
      />
      <CombatTransitionEffects feedback={combatFeedback} surface="rail" />
      {endcap}
    </article>
  );
}
