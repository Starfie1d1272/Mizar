import type { PerformanceWindow } from './performance-window.js';
import type { SessionJournal } from './session-journal.js';

type CloseAction = () => unknown;

export async function closeSupportEvidence(
  owners: {
    revokeCapture: () => void;
    closeDelivery: CloseAction;
    closeNativeSource: CloseAction;
    performanceContext: PerformanceWindow | undefined;
    unsubscribeObserver: CloseAction | undefined;
    flushOperationDiagnostics: CloseAction;
    sessionJournal: SessionJournal | undefined;
  },
  closeDiagnostics: (step: CloseAction) => Promise<void>,
): Promise<void> {
  const { performanceContext, sessionJournal } = owners;
  // Release delivery's source holds before producers need space for their final flush.
  // Final records remain in the journal for recovery on the next startup.
  owners.revokeCapture();
  await closeDiagnostics(owners.closeDelivery);
  await closeDiagnostics(owners.closeNativeSource);
  await closeDiagnostics(async () => {
    await performanceContext?.close();
    if (performanceContext) {
      const health = performanceContext.health();
      if (health.pendingRecords > 0 || health.writeError !== null)
        throw new Error('performance_context_close_unconfirmed');
    }
  });
  await closeDiagnostics(() => owners.unsubscribeObserver?.());
  await closeDiagnostics(owners.flushOperationDiagnostics);
  await closeDiagnostics(async () => {
    await sessionJournal?.close();
    if (sessionJournal) {
      const health = sessionJournal.health();
      if (health.pendingRecords > 0 || health.writeError !== null)
        throw new Error('session_journal_close_unconfirmed');
    }
  });
}
