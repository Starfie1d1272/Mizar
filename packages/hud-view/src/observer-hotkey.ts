export function observerHotkeyLabel(slot: number | null): string {
  if (slot === null || !Number.isInteger(slot) || slot < 0 || slot > 9) return '—';
  return slot === 9 ? '0' : String(slot + 1);
}
