import type { HostPinCoverage } from '@mizar/protocol';
import { desktopInvoke } from '../workspace/client';
import { browserErrorEvidence, sendControlEvidence } from './control-journal';

const PIN_BUDGET_MS = 8000;
// A timed-out native call may still own its writer work. Do not enqueue more
// pins from this document until this owner has positively released its hold.
let activePin: string | null = null;

type ExportHostPin = {
  coverage: HostPinCoverage;
  pinId?: string;
  release?: () => void;
};

export function pinHostEvidence(signal: AbortSignal): Promise<ExportHostPin> {
  if (signal.aborted) return Promise.reject(new Error('export_cancelled'));
  const report = (
    status: HostPinCoverage['status'],
    phase: HostPinCoverage['phase'],
  ): HostPinCoverage => ({
    status,
    phase,
    observedAt: new Date().toISOString(),
    budgetMs: PIN_BUDGET_MS,
  });
  if (activePin) return Promise.resolve({ coverage: report('failed', 'admission') });
  const pinId = crypto.randomUUID();
  activePin = pinId;
  let releaseStarted = false;
  const release = () => {
    if (releaseStarted) return;
    releaseStarted = true;
    void desktopInvoke<{ pinId: string; state: string }>('diagnostic_pin', {
      action: 'release',
      pinId,
      kind: 'export',
    })
      .then((receipt) => {
        if (receipt?.pinId !== pinId || receipt.state !== 'released')
          throw new Error('host_pin_release_unconfirmed');
        if (activePin === pinId) activePin = null;
      })
      .catch((error: unknown) => {
        // Retain the local admission hold on uncertain cleanup. A durable
        // receipt's expiry does not prove in-flight native work was cancelled.
        void sendControlEvidence('support_export_host_pin', 'release_failure', {
          exportId: pinId,
          error: browserErrorEvidence(error),
        });
      });
  };
  return new Promise<ExportHostPin>((resolve, reject) => {
    let phase: 'prepare' | 'commit' = 'prepare';
    let abandoned = false;
    let settled = false;
    let transferred = false;
    const finish = (result?: ExportHostPin) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (result) resolve(result);
      else reject(new Error('export_cancelled'));
    };
    const cancel = () => {
      abandoned = true;
      finish();
    };
    const timer = setTimeout(() => {
      // Mark ownership synchronously, before resolving the timeout side.
      abandoned = true;
      finish({ coverage: report('timeout', phase) });
    }, PIN_BUDGET_MS);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    void (async () => {
      try {
        if (abandoned) return;
        await desktopInvoke('diagnostic_pin', { action: 'prepare', pinId, kind: 'export' });
        if (abandoned) return;
        phase = 'commit';
        const receipt = await desktopInvoke<{ pinId: string; state: string; kind: string }>(
          'diagnostic_pin',
          { action: 'commit', pinId, kind: 'export' },
        );
        if (abandoned) return;
        if (receipt?.pinId !== pinId || receipt.state !== 'committed' || receipt.kind !== 'export')
          throw new Error('host_pin_commit_unconfirmed');
        // Transfer and remove the abandonment callbacks in the same turn.
        transferred = true;
        finish({ pinId, release, coverage: report('committed', phase) });
      } catch (error) {
        void sendControlEvidence('support_export_host_pin', 'failure', {
          exportId: pinId,
          phase,
          error: browserErrorEvidence(error),
        });
        if (!abandoned) finish({ coverage: report('failed', phase) });
      } finally {
        // Release only after the actual prepare/commit promise settles. A late
        // prepare must never trigger commit or race its own cleanup.
        if (!transferred) release();
      }
    })();
  });
}
