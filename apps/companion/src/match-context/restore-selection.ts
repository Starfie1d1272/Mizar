import { toMatchDocumentV1 } from '@mizar/rivalhub';
import type { FastifyBaseLogger } from 'fastify';
import { diagnosticValue } from '../support/session-journal.js';
import type { MatchContextController } from './controller.js';
import type { LocalTournamentStore } from './local-tournament-store.js';
import { isStandaloneLocalMatch } from './lkg-store.js';

export async function restoreMatchSelection(
  log: FastifyBaseLogger,
  {
    matchContextController,
    localTournamentStore,
    requireHostConfirmation,
  }: {
    matchContextController: MatchContextController | null;
    localTournamentStore: LocalTournamentStore | null;
    requireHostConfirmation: () => void;
  },
  trial: boolean,
): Promise<void> {
  if (matchContextController === null) return;
  try {
    await localTournamentStore?.load();
  } catch (error) {
    log.warn(
      { event: 'local-tournament-unavailable', error: diagnosticValue(error) },
      'Local tournament library could not be loaded',
    );
  }
  const restored = trial
    ? await matchContextController.restoreTemporaryBinding()
    : await matchContextController.restoreLatest();
  if (localTournamentStore === null || !localTournamentStore.getAvailability().available) return;
  const selected = localTournamentStore
    .getSnapshot()
    .matches.find((match) => match.matchId === localTournamentStore.getSnapshot().selectedMatchId);
  const localSelectedAt = localTournamentStore.getSnapshot().selectedAt;
  const localWasSelectedLast =
    localSelectedAt !== null &&
    Date.parse(localSelectedAt) >= Date.parse(restored?.storedAt ?? '1970-01-01T00:00:00.000Z');
  if (
    selected !== undefined &&
    (restored === undefined || isStandaloneLocalMatch(restored) || localWasSelectedLast)
  ) {
    if (!trial) requireHostConfirmation();
    if (trial) matchContextController.restoreTemporaryLocalDocument(selected);
    else matchContextController.activateLocalDocument(selected);
  } else if (restored !== undefined && isStandaloneLocalMatch(restored)) {
    const migrated = await localTournamentStore.importLegacyMatch(
      toMatchDocumentV1(restored.manifest),
    );
    if (!trial) requireHostConfirmation();
    if (trial) matchContextController.restoreTemporaryLocalDocument(migrated);
    else matchContextController.activateLocalDocument(migrated);
  }
}
