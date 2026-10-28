import type { CSSProperties } from 'react';
import type { PlayerRailAsset, WeaponVisualRole } from '../player-rails/presentation';
import './equipment-icon.css';

/** Canonical artwork points right. Only this asset leaf changes its facing;
 * parents place slots, and never transform text, avatars or whole inventory groups. */
export function EquipmentIcon({
  asset,
  label,
  className = '',
  physicalSide = 'left',
  weaponVisualRole,
  active,
  clipFill,
}: {
  readonly asset: PlayerRailAsset | null;
  readonly label: string;
  readonly className?: string;
  readonly physicalSide?: 'left' | 'right';
  readonly weaponVisualRole?: WeaponVisualRole | undefined;
  readonly active?: boolean | undefined;
  readonly clipFill?: number | null | undefined;
}) {
  if (!asset) return null;
  const filled = clipFill != null;
  return (
    <span
      aria-label={label}
      role="img"
      className={`hud-equipment-icon ${className}`.trim()}
      data-asset-id={asset.canonicalKey}
      data-asset-facing={physicalSide === 'right' ? 'left' : 'right'}
      data-weapon-visual-role={weaponVisualRole}
      data-weapon-active={active}
      data-clip-fill={filled ? clipFill : undefined}
      style={
        {
          '--player-rail-icon': `url("${asset.outputPath}")`,
          ...(filled
            ? {
                '--magazine-empty': `${(1 - clipFill) * 100}%`,
                background: 'none',
                mask: 'none',
                transform: 'none',
              }
            : {}),
        } as CSSProperties
      }
    >
      {filled ? (
        <span className="hud-equipment-icon__artwork" aria-hidden="true">
          <img src={asset.outputPath} alt="" />
          <span className="hud-equipment-icon__fill" />
        </span>
      ) : null}
    </span>
  );
}
