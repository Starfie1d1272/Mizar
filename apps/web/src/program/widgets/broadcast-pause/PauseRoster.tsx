import type { PlayerRailSettings } from '@mizar/hud-config';
import { EquipmentIcon } from '../player-equipment/EquipmentIcon';
import type { PlayerCardPresentation, PlayerRailPresentation } from '../player-rails/presentation';

function Equipment({
  player,
  options,
  physicalSide,
}: {
  readonly player: PlayerCardPresentation;
  readonly options: PlayerRailSettings;
  readonly physicalSide: 'left' | 'right';
}) {
  const utility = player.utility
    .flatMap((item) =>
      Array.from({ length: Math.min(4, item.count) }, (_, index) => ({
        ...item,
        key: `${item.sourceWeaponId}:${index}`,
      })),
    )
    .slice(0, 4);
  return (
    <div className="broadcast-pause__equipment">
      <div className="broadcast-pause__armor">
        {options.showLoadout ? (
          <>
            <EquipmentIcon
              className="broadcast-pause__icon"
              asset={player.armorAsset}
              label="Armor"
            />
            <EquipmentIcon
              className="broadcast-pause__icon"
              asset={player.defuserAsset ?? player.c4Asset ?? null}
              label={player.defuserAsset ? 'Defuse kit' : 'C4'}
            />
            <EquipmentIcon
              className="broadcast-pause__icon"
              asset={player.zeus?.asset ?? null}
              label="Zeus"
              physicalSide={physicalSide}
            />
          </>
        ) : null}
      </div>
      <div className="broadcast-pause__utility">
        {options.showUtility
          ? utility.map((item) => (
              <EquipmentIcon
                className="broadcast-pause__icon"
                asset={item.asset}
                label={item.family}
                key={item.key}
              />
            ))
          : null}
      </div>
      <div className="broadcast-pause__secondary">
        {options.showLoadout ? (
          <EquipmentIcon
            className="broadcast-pause__icon broadcast-pause__pistol"
            asset={player.secondaryWeapon?.asset ?? null}
            label={player.secondaryWeapon?.name ?? 'Pistol'}
            physicalSide={physicalSide}
          />
        ) : null}
      </div>
      <div className="broadcast-pause__primary">
        {options.showLoadout ? (
          <EquipmentIcon
            className="broadcast-pause__icon broadcast-pause__weapon"
            asset={player.primaryWeapon?.asset ?? null}
            label={player.primaryWeapon?.name ?? 'Weapon'}
            physicalSide={physicalSide}
          />
        ) : null}
      </div>
    </div>
  );
}

export function PauseRoster({
  rail,
  options,
  physicalSide,
  visible,
}: {
  readonly rail: PlayerRailPresentation;
  readonly options: PlayerRailSettings;
  readonly physicalSide: 'left' | 'right';
  readonly visible: boolean;
}) {
  return (
    <section
      className="broadcast-pause__roster"
      data-physical-side={physicalSide}
      data-side={rail.side}
      aria-label={`${physicalSide} roster`}
    >
      {visible
        ? rail.players.map((player) => (
            <div
              className="broadcast-pause__player"
              data-pause-player={player.sourcePlayerId}
              key={player.sourcePlayerId}
            >
              <div className="broadcast-pause__avatar">
                {options.showAvatar && player.avatarUrl ? (
                  <img
                    src={player.avatarUrl}
                    alt=""
                    onError={(event) => {
                      event.currentTarget.style.visibility = 'hidden';
                    }}
                  />
                ) : null}
              </div>
              <strong
                className="broadcast-pause__player-name"
                title={player.displayName ?? 'PLAYER'}
              >
                {player.displayName ?? 'PLAYER'}
              </strong>
              <Equipment player={player} options={options} physicalSide={physicalSide} />
              <span className="broadcast-pause__money">
                {options.showMoney
                  ? player.money === null
                    ? '—'
                    : `$${Math.round(player.money).toLocaleString('en-US')}`
                  : ''}
              </span>
            </div>
          ))
        : null}
    </section>
  );
}
