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
}: {
  readonly asset: PlayerRailAsset | null;
  readonly label: string;
  readonly className?: string;
  readonly physicalSide?: 'left' | 'right';
  readonly weaponVisualRole?: WeaponVisualRole | undefined;
  readonly active?: boolean | undefined;
}) {
  if (!asset) return null;
  return (
    <span
      aria-label={label}
      role="img"
      className={`hud-equipment-icon ${className}`.trim()}
      data-asset-id={asset.canonicalKey}
      data-asset-facing={physicalSide === 'right' ? 'left' : 'right'}
      data-weapon-visual-role={weaponVisualRole}
      data-weapon-active={active}
      style={{ '--player-rail-icon': `url("${asset.outputPath}")` } as CSSProperties}
    />
  );
}
