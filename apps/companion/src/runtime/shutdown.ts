import type { FastifyInstance } from 'fastify';
import type { HudConfigStore } from '../hud-config/store.js';
import type { BusinessJournal } from '../support/business-journal.js';
import type { CaptureRecorder } from '../telemetry/capture-recorder.js';
import { writeRuntimeFlushReceipt, type ProductRuntime } from './product-runtime.js';

type CloseAction = () => unknown;

export function registerCompanionShutdown(
  app: FastifyInstance,
  owners: {
    stopDirector: () => void;
    stopObservation: CloseAction;
    unsubscribePresentation: CloseAction;
    unsubscribeObjectiveReference: CloseAction | undefined;
    closeCamera: CloseAction;
    closeMusic: CloseAction;
    closeGameAudio: CloseAction;
    closeObs: CloseAction;
    waitForObsExit: () => Promise<unknown>;
    stopCstv: readonly CloseAction[];
    closeDeliveryConsumers: readonly CloseAction[];
    closeProjection: CloseAction;
    closeCues: CloseAction;
    stopWebsiteDelivery: CloseAction;
    flushWebsiteDiagnostics: CloseAction;
    closeRuntime: CloseAction;
    closeTransport: CloseAction;
    hudConfigStore: Pick<HudConfigStore, 'flush' | 'getState'>;
    flushBroadcastReceipts: CloseAction;
    currentRecorder: () => CaptureRecorder;
    readBusinessJournal: () => BusinessJournal | undefined;
    closeSupport: (closeDiagnostic: (action: CloseAction) => Promise<void>) => Promise<void>;
    closeWebsiteOutput: CloseAction;
    unsubscribeMatchBinding: (() => void) | undefined;
    product: ProductRuntime | undefined;
  },
): void {
  app.addHook('onClose', async () => {
    const failures: unknown[] = [];
    const closeStep = async (action: CloseAction) => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    const closeDiagnostics = async (action: CloseAction) => {
      try {
        await action();
      } catch (error) {
        app.log.warn({ err: error }, '诊断收尾未完成，已记录的日志仍可读取');
      }
    };
    owners.stopDirector();
    await closeStep(owners.stopObservation);
    await closeStep(owners.unsubscribePresentation);
    await closeStep(() => owners.unsubscribeObjectiveReference?.());
    await closeStep(owners.closeCamera);
    await closeStep(owners.closeMusic);
    await closeStep(owners.closeGameAudio);
    // Both waits share one deadline; adapter closure may itself enqueue a new
    // unconfirmed status after the first wait has already finished.
    const obsExitDeadline = performance.now() + 4000;
    const waitForObsExit = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          owners.waitForObsExit(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('OBS 收尾尚未确认')),
              Math.max(0, obsExitDeadline - performance.now()),
            );
          }),
        ]);
      } catch (error) {
        app.log.warn({ err: error }, 'OBS 收尾未确认');
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    await waitForObsExit();
    await closeStep(owners.closeObs);
    await waitForObsExit();
    for (const result of await Promise.allSettled([
      ...owners.stopCstv.map((stop) => Promise.resolve().then(stop)),
      ...owners.closeDeliveryConsumers.map((close) => Promise.resolve().then(close)),
    ])) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    // Stop producers before flushing each local owner. One failed close must
    // not prevent the remaining owners from attempting their own flush.
    await closeStep(owners.closeProjection);
    await closeStep(owners.closeCues);
    await closeStep(owners.stopWebsiteDelivery);
    await closeDiagnostics(owners.flushWebsiteDiagnostics);
    await closeStep(owners.closeRuntime);
    await closeStep(owners.closeTransport);
    await closeStep(async () => {
      await owners.hudConfigStore.flush();
      if (owners.hudConfigStore.getState().persistenceError)
        throw new Error('hud_config_close_unconfirmed');
    });
    await closeStep(owners.flushBroadcastReceipts);
    await closeStep(async () => {
      const recorder = owners.currentRecorder();
      await recorder.finalize();
      recorder.assertDurableFinalized?.();
    });
    await closeDiagnostics(async () => {
      const businessJournal = owners.readBusinessJournal();
      await businessJournal?.close();
      if (
        businessJournal &&
        (businessJournal.getStatus() === 'write_failed' ||
          businessJournal.getHealth().uncommittedChanges)
      )
        throw new Error('business_journal_close_unconfirmed');
    });
    await owners.closeSupport(closeDiagnostics);
    await closeStep(owners.closeWebsiteOutput);
    owners.unsubscribeMatchBinding?.();
    if (failures.length > 0) throw new AggregateError(failures, 'Companion 本地收尾未全部完成');
    await writeRuntimeFlushReceipt(owners.product);
  });
}
