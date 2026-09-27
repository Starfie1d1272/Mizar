import type { BpProjection } from '@rivalhub-broadcast/core/projection';
import type { BpDemoCommand, BpDemoFormat, BpSnapshot } from '@rivalhub-broadcast/protocol/bp';

export type { BpDemoFormat };
export type BpDemoState = BpDemoFormat | null;

export class BpDemoStateController {
  private active: BpDemoState = null;

  getState(): BpDemoState {
    return this.active;
  }

  getProjection(
    getRealProjection: () => BpProjection | null,
    getDemoProjection: (format: BpDemoFormat) => BpProjection,
  ): BpProjection | null {
    return this.active === null ? getRealProjection() : getDemoProjection(this.active);
  }

  apply(command: BpDemoCommand, sessionState: BpSnapshot['state']): boolean {
    if (sessionState !== 'hidden') return false;
    this.active = command.kind === 'exit' ? null : command.format;
    return true;
  }
}
