/** Broadcast convention requested for MR12: three regulation slots, one in overtime.
 * Filled slots always come from the game; larger reported counts expand the display. */
export function TimeoutSlots({
  remaining,
  roundNumber,
}: {
  readonly remaining: number | null;
  readonly roundNumber: number | null;
}) {
  const known = remaining !== null && Number.isSafeInteger(remaining) && remaining >= 0;
  // Unknown phase or an unexpected large counter stays numeric, rather than guessing capacity.
  if (!known || roundNumber === null || remaining > 8)
    return <strong>{known ? remaining : '—'}</strong>;
  const capacity = Math.max(roundNumber >= 24 ? 1 : 3, remaining);
  return (
    <div
      className="broadcast-pause__timeout-slots"
      aria-label={`${remaining} timeouts remaining`}
      data-timeouts-remaining={remaining}
    >
      {Array.from({ length: capacity }, (_, index) => (
        <i data-timeout-available={index < remaining} key={index} />
      ))}
    </div>
  );
}
