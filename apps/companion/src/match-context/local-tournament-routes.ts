import { rosterCandidate, mergeObservedStarters } from './roster-capture.js';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import type { FastifyInstance } from 'fastify';
import { deriveScheduleNeighborhood } from '@mizar/core/match-context';
import { DEFAULT_LOCAL_BP_MAP_POOL } from '@mizar/core/projection';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { MatchContextController } from './controller.js';
import { LocalTournamentStore } from './local-tournament-store.js';
import { localDocumentBindingManifest } from './local-document-adapter.js';

function canMutate(policy: LocalWebOriginPolicy, origin: string | undefined): boolean {
  return policy.mode === 'loopback' && checkLocalWebOrigin(policy, origin).allowed;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function registerLocalTournamentRoutes(
  app: FastifyInstance,
  options: {
    readonly store: LocalTournamentStore;
    readonly projections?: ProjectionCoordinator;
    readonly controller: MatchContextController;
    readonly originPolicy: LocalWebOriginPolicy;
  },
): void {
  const { store, controller, originPolicy } = options;
  app.get('/local/v1/tournament', (_request, reply) => {
    const state = store.getSnapshot();
    const selected = state.matches.find((match) => match.matchId === state.selectedMatchId) ?? null;
    const event = state.events.find((item) => item.matchIds.includes(selected?.matchId ?? ''));
    const schedule = event === undefined ? null : store.scheduleWindow(event.eventId);
    const active = controller.getActiveBinding();
    return reply.header('cache-control', 'no-store').send({
      schemaVersion: 'mizar.local-tournament-view.v1',
      events: state.events,
      teams: state.teams,
      matches: state.matches,
      selectedMatchId: state.selectedMatchId,
      activeLocalMatchId:
        active?.origin === 'local' && active.localAuthoringMode === 'standalone'
          ? active.context.matchId
          : null,
      schedule,
      neighborhood: deriveScheduleNeighborhood(schedule, selected?.matchId ?? ''),
      contextRevision: controller.getActiveRevision(),
    });
  });

  const candidate = () => {
    const active = controller.getActiveBinding();
    const document =
      store.getSnapshot().matches.find((match) => match.matchId === active?.context.matchId) ??
      null;
    return rosterCandidate(
      options.projections?.getRosterEvidence() ?? null,
      document,
      controller.getActiveRevision(),
    );
  };
  app.get('/local/v1/roster-candidate', (_request, reply) =>
    reply
      .header('cache-control', 'no-store')
      .send({ candidate: candidate(), local: controller.getActiveBinding()?.origin === 'local' }),
  );
  for (const operation of ['capture', 'create-from-server'] as const) {
    app.post(`/operator/local-match/${operation}`, { bodyLimit: 4096 }, async (request, reply) => {
      if (!canMutate(originPolicy, request.headers.origin))
        return reply.code(403).send({ error: 'operator_origin_forbidden' });
      const body = object(request.body);
      const current = candidate();
      if (
        !current ||
        body?.expectedContextRevision !== current.contextRevision ||
        body.expectedSourceGeneration !== current.sourceGeneration ||
        body.expectedMapEpoch !== current.mapEpoch ||
        body.candidateRevision !== current.revision
      )
        return reply.code(409).send({ message: '服务器名单已变化，请重新识别。' });
      const canCommit = () => candidate()?.revision === current.revision;
      try {
        if (operation === 'create-from-server') {
          if (controller.getActiveBinding() || !['bo1', 'bo3', 'bo5'].includes(String(body.format)))
            return reply.code(409).send({ message: '请先核对当前比赛与赛制。' });
          const document = await store.createMatch(
            {
              teamA: current.ctName ?? (typeof body.teamA === 'string' ? body.teamA : ''),
              teamB: current.tName ?? (typeof body.teamB === 'string' ? body.teamB : ''),
              format: body.format as 'bo1' | 'bo3' | 'bo5',
              mapPool: DEFAULT_LOCAL_BP_MAP_POOL,
              playersA: mergeObservedStarters([], current.ct),
              playersB: mergeObservedStarters([], current.t),
            },
            canCommit,
          );
          if (canCommit()) controller.activateLocalDocument(document);
        } else {
          const active = controller.getActiveBinding();
          if (active?.origin !== 'local' || active.localAuthoringMode !== 'standalone')
            return reply.code(409).send({ message: '赛事名单只读，请通过赛务流程更新。' });
          const document = store
            .getSnapshot()
            .matches.find((match) => match.matchId === active.context.matchId);
          const ct = current.ctEntrant ?? body.ctEntrant;
          if (!document || (ct !== 'a' && ct !== 'b'))
            return reply.code(400).send({ message: '请确认当前 CT 对应哪支队伍。' });
          const updated = await store.saveMatch(
            {
              ...document,
              entrants: {
                a: {
                  ...document.entrants.a,
                  players: mergeObservedStarters(
                    document.entrants.a.players,
                    ct === 'a' ? current.ct : current.t,
                  ),
                },
                b: {
                  ...document.entrants.b,
                  players: mergeObservedStarters(
                    document.entrants.b.players,
                    ct === 'b' ? current.ct : current.t,
                  ),
                },
              },
            },
            canCommit,
          );
          if (canCommit()) controller.activateLocalDocument(updated);
        }
        return { ok: true };
      } catch {
        return reply
          .code(409)
          .send({ message: '名单保存未完成，请刷新当前比赛与服务器名单后重试。' });
      }
    });
  }

  app.post('/operator/local-match/create', { bodyLimit: 4096 }, async (request, reply) => {
    if (!canMutate(originPolicy, request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = object(request.body);
    if (
      body === null ||
      typeof body.teamA !== 'string' ||
      typeof body.teamB !== 'string' ||
      !(body.teamAId === undefined || typeof body.teamAId === 'string') ||
      !(body.teamBId === undefined || typeof body.teamBId === 'string') ||
      !['bo1', 'bo3', 'bo5'].includes(String(body.format)) ||
      !(body.eventId === undefined || typeof body.eventId === 'string')
    )
      return reply.code(400).send({ error: 'local_match_invalid' });
    try {
      const document = await store.createMatch({
        teamA: body.teamA,
        teamB: body.teamB,
        ...(body.teamAId === undefined ? {} : { teamAId: body.teamAId }),
        ...(body.teamBId === undefined ? {} : { teamBId: body.teamBId }),
        format: body.format as 'bo1' | 'bo3' | 'bo5',
        ...(body.eventId === undefined ? {} : { eventId: body.eventId }),
        mapPool: DEFAULT_LOCAL_BP_MAP_POOL,
      });
      controller.activateLocalDocument(document);
      return { ok: true, matchId: document.matchId };
    } catch {
      return reply.code(400).send({ error: 'local_match_create_failed' });
    }
  });

  app.post('/operator/local-match/select', { bodyLimit: 1024 }, async (request, reply) => {
    if (!canMutate(originPolicy, request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = object(request.body);
    if (typeof body?.matchId !== 'string')
      return reply.code(400).send({ error: 'local_match_id_invalid' });
    try {
      const document = await store.selectMatch(body.matchId);
      controller.activateLocalDocument(document);
      return { ok: true };
    } catch {
      return reply.code(404).send({ error: 'local_match_not_found' });
    }
  });

  app.post('/operator/local-match/save', { bodyLimit: 131_072 }, async (request, reply) => {
    if (!canMutate(originPolicy, request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = object(request.body);
    if (body === null || body.expectedContextRevision !== controller.getActiveRevision())
      return reply.code(409).send({ error: 'local_context_conflict' });
    const current = controller.getActiveBinding();
    if (current?.origin !== 'local' || current.localAuthoringMode !== 'standalone')
      return reply.code(409).send({ error: 'local_match_not_selected' });
    try {
      const proposed = object(body.document);
      if (proposed?.matchId !== current.context.matchId)
        return reply.code(409).send({ error: 'local_match_mismatch' });
      localDocumentBindingManifest(body.document);
      const document = await store.saveMatch(body.document);
      controller.activateLocalDocument(document);
      return { ok: true };
    } catch {
      return reply.code(400).send({ error: 'local_match_save_failed' });
    }
  });

  app.post('/operator/local-event/save', { bodyLimit: 8192 }, async (request, reply) => {
    if (!canMutate(originPolicy, request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = object(request.body);
    if (
      body === null ||
      typeof body.eventId !== 'string' ||
      typeof body.name !== 'string' ||
      !(body.logoUrl === null || typeof body.logoUrl === 'string') ||
      !(body.themeColor === null || typeof body.themeColor === 'string') ||
      !Array.isArray(body.mapPool) ||
      !body.mapPool.every((name) => typeof name === 'string')
    )
      return reply.code(400).send({ error: 'local_event_invalid' });
    try {
      await store.saveEvent({
        eventId: body.eventId,
        name: body.name,
        logoUrl: body.logoUrl,
        themeColor: body.themeColor,
        mapPool: body.mapPool,
      });
      const selected = store
        .getSnapshot()
        .matches.find((match) => match.matchId === store.getSnapshot().selectedMatchId);
      if (
        selected !== undefined &&
        selected.competition.competitionId === body.eventId &&
        controller.getActiveBinding()?.origin === 'local'
      )
        controller.activateLocalDocument(selected);
      return { ok: true };
    } catch {
      return reply.code(400).send({ error: 'local_event_save_failed' });
    }
  });

  app.post('/operator/local-schedule/reorder', { bodyLimit: 8192 }, async (request, reply) => {
    if (!canMutate(originPolicy, request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = object(request.body);
    if (
      typeof body?.eventId !== 'string' ||
      !Array.isArray(body.matchIds) ||
      !body.matchIds.every((id) => typeof id === 'string')
    )
      return reply.code(400).send({ error: 'local_schedule_invalid' });
    try {
      await store.reorder(body.eventId, body.matchIds);
      return { ok: true };
    } catch {
      return reply.code(400).send({ error: 'local_schedule_invalid' });
    }
  });
}
