import { randomUUID } from 'node:crypto';
import type { SessionJournal } from './session-journal.js';

/** Coalesce only a caller's unchanged diagnostic state, never operations or delivery. */
export class RepeatedDiagnostic {
  private active:
    | {
        key: string;
        stage: string;
        evidence: Record<string, unknown>;
        repetitionId: string;
        firstObservedAt: string;
        lastObservedAt: string;
        totalOccurrences: number;
        pending: number;
      }
    | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly emit: (stage: string, evidence: Record<string, unknown>) => void) {}

  record(stage: string, key: string, evidence: Record<string, unknown>): void {
    const now = new Date().toISOString();
    if (!this.active || this.active.key !== key || this.active.stage !== stage) {
      this.clear();
      this.active = {
        key,
        stage,
        evidence,
        repetitionId: randomUUID(),
        firstObservedAt: now,
        lastObservedAt: now,
        totalOccurrences: 1,
        pending: 1,
      };
      this.flush();
      return;
    }
    this.active.evidence = evidence;
    this.active.lastObservedAt = now;
    this.active.totalOccurrences++;
    this.active.pending++;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, 5000);
      this.timer.unref();
    }
  }

  clear(recoveryStage?: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.flush();
    const previous = this.active;
    this.active = undefined;
    if (previous && recoveryStage)
      this.emit(recoveryStage, {
        repetitionId: previous.repetitionId,
        firstObservedAt: previous.firstObservedAt,
        lastObservedAt: previous.lastObservedAt,
        totalOccurrences: previous.totalOccurrences,
        result: 'success',
      });
  }

  private flush(): void {
    const active = this.active;
    if (!active?.pending) return;
    const occurrences = active.pending;
    active.pending = 0;
    this.emit(active.stage, {
      ...active.evidence,
      repetitionId: active.repetitionId,
      firstObservedAt: active.firstObservedAt,
      lastObservedAt: active.lastObservedAt,
      occurrences,
      totalOccurrences: active.totalOccurrences,
    });
  }
}

export function renewalDiagnostics(
  routes: readonly string[],
  journal: Pick<SessionJournal, 'record' | 'withSystem'> | undefined,
) {
  const observations = new Map(
    routes.map((route) => [
      route,
      {
        identity: '',
        key: '',
        repeated: new RepeatedDiagnostic((stage, evidence) => {
          const scope = { operation: route, identity: evidence.repetitionId };
          if (evidence.totalOccurrences === 1)
            journal?.record('operation_result', { ...evidence, scope });
          else {
            // Later observations retain the first result's identity and omit its full context.
            const summary: Record<string, unknown> = { ...evidence, scope };
            delete summary.before;
            delete summary.after;
            journal?.withSystem(() => journal.record(stage, summary));
          }
        }),
        clear() {
          this.repeated.clear();
          this.identity = '';
          this.key = '';
        },
      },
    ]),
  );
  return {
    get: (route: string) => observations.get(route),
    clear: () => {
      for (const observation of observations.values()) observation.clear();
    },
  };
}
