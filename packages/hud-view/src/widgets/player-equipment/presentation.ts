import type { ProgramPayload } from '@mizar/protocol/program';

/** Current-frame evidence only: reloads still hold a weapon, ambiguous states do not. */
export function heldWeapon(player: ProgramPayload['players'][number], fresh: boolean) {
  if (!fresh || player.lifeState !== 'alive' || player.lineupEvidence !== 'current') return null;
  return (
    player.weapons.find((weapon) => weapon.sourceWeaponId === player.equipment.heldWeaponId) ?? null
  );
}

export function magazineFill(
  weapon: ProgramPayload['players'][number]['weapons'][number] | null,
): number | null {
  const clip = weapon?.ammoClip;
  const capacity = weapon?.ammoClipMax;
  if (
    clip == null ||
    capacity == null ||
    !Number.isSafeInteger(clip) ||
    clip < 0 ||
    !Number.isSafeInteger(capacity) ||
    capacity <= 0
  )
    return null;
  return Math.min(1, clip / capacity);
}
