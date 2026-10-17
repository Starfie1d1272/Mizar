import { browserErrorEvidence, controlEvidence } from './control-journal';

/** Explicit per-action context: concurrent browser actions never share ambient state. */
export class ControlTask {
  readonly taskId: string;
  readonly operationId = crypto.randomUUID();
  readonly parentOperationId: string | null;
  result: 'confirmed' | 'failed' | 'blocked' | 'cancelled' | 'unconfirmed' | null = null;
  private terminal = false;
  constructor(
    readonly kind: string,
    readonly trigger: 'user' | 'system',
    before: unknown,
    parent?: ControlTask,
  ) {
    this.taskId = parent?.taskId ?? crypto.randomUUID();
    this.parentOperationId = parent?.operationId ?? null;
    this.event(parent ? 'step_begin' : 'begin', { before });
  }
  headers(): Record<string, string> {
    return {
      'x-mizar-task-id': this.taskId,
      'x-mizar-trigger': this.trigger,
      'x-mizar-parent-operation-id': this.operationId,
    };
  }
  event(phase: string, evidence: unknown): void {
    controlEvidence('task', phase, {
      taskId: this.taskId,
      operationId: this.operationId,
      parentOperationId: this.parentOperationId,
      kind: this.kind,
      trigger: this.trigger,
      evidence,
    });
  }
  finish(
    result: 'confirmed' | 'failed' | 'blocked' | 'cancelled' | 'unconfirmed',
    evidence: unknown,
  ): void {
    if (this.terminal) return;
    this.terminal = true;
    this.result = result;
    this.event(this.parentOperationId ? 'step_terminal' : 'terminal', {
      result,
      ...(typeof evidence === 'object' && evidence !== null ? evidence : { detail: evidence }),
    });
  }
  fail(error: unknown): void {
    this.finish('failed', { error: browserErrorEvidence(error) });
  }
}
