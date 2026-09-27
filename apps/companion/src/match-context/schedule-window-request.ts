import type { BroadcastScheduleWindowV1 } from '@mizar/rivalhub';

/** The acquisition identity for one requested ScheduleWindow. */
export interface ScheduleWindowRequest {
  readonly competitionId: string;
  readonly from: string;
  readonly to: string;
}

export function scheduleWindowRequest(
  value: Pick<BroadcastScheduleWindowV1, 'competition' | 'from' | 'to'>,
): ScheduleWindowRequest {
  return {
    competitionId: value.competition.competitionId,
    from: value.from,
    to: value.to,
  };
}

/** V1 uses exact competition/window identity for fallback eligibility. */
export function sameScheduleWindowRequest(
  left: ScheduleWindowRequest,
  right: ScheduleWindowRequest,
): boolean {
  return (
    left.competitionId === right.competitionId && left.from === right.from && left.to === right.to
  );
}

export function scheduleMatchesRequest(
  request: ScheduleWindowRequest,
  value: Pick<BroadcastScheduleWindowV1, 'competition' | 'from' | 'to'>,
): boolean {
  return sameScheduleWindowRequest(request, scheduleWindowRequest(value));
}
