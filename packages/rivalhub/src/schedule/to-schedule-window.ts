import type { ScheduleWindow } from '@mizar/core/match-context';

import { validateBroadcastScheduleWindow } from './validate.js';
import type { BroadcastScheduleCompetitionV1, BroadcastScheduleWindowV1 } from './types.js';

export class BroadcastScheduleWindowConversionError extends Error {
  readonly diagnostics: ReturnType<typeof validateBroadcastScheduleWindow>['diagnostics'];

  constructor(diagnostics: ReturnType<typeof validateBroadcastScheduleWindow>['diagnostics']) {
    super('BroadcastScheduleWindow 不能转换为 ScheduleWindow。');
    this.name = 'BroadcastScheduleWindowConversionError';
    this.diagnostics = diagnostics;
  }
}

function competition(value: BroadcastScheduleCompetitionV1) {
  return { ...value } as const;
}

export function toScheduleWindow(input: unknown): ScheduleWindow {
  const result = validateBroadcastScheduleWindow(input);
  if (!result.ok) throw new BroadcastScheduleWindowConversionError(result.diagnostics);
  const window: BroadcastScheduleWindowV1 = result.value;
  return {
    competition: competition(window.competition),
    from: window.from,
    to: window.to,
    matches: window.matches.map((match) => ({
      matchId: match.matchId,
      scheduledAt: match.scheduledAt,
      startedAt: match.startedAt,
      completedAt: match.completedAt,
      status: match.status,
      format: match.format,
      stage: match.stage,
      round: match.round,
      isForfeit: match.isForfeit,
      scoreA: match.scoreA,
      scoreB: match.scoreB,
      entrants: {
        a: { ...match.entrantA },
        b: { ...match.entrantB },
      },
    })),
  };
}
