import { errorEvidence } from '../updates/diagnostics.js';
import { rosterCandidate, mergeObservedStarters } from './roster-capture.js';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import type { FastifyInstance } from 'fastify';
import { deriveScheduleNeighborhood } from '@mizar/core/match-context';
import { DEFAULT_LOCAL_BP_MAP_POOL } from '@mizar/core/projection';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { MatchContextController } from './controller.js';
import { LocalTournamentStore } from './local-tournament-store.js';
import { localDocumentBindingManifest } from './local-document-adapter.js';
import { localBo3BpRulesSchema } from '@mizar/protocol/bp';

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
    readonly canReleaseLocalSelection: () => boolean;
    readonly withLocalSelectionRelease: (commit: () => Promise<void>) => Promise<boolean>;
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
      trashedMatches: state.trashedMatches,
      inUseMatchId:
        active?.origin === 'local' &&
        active.localAuthoringMode === 'standalone' &&
        options.canReleaseLocalSelection()
          ? null
          : (active?.context.matchId ?? null),
      canReleaseLocalSelection: options.canReleaseLocalSelection(),
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
      store.getSnapshot().teams,
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
      const continuityRevision = () =>
        rosterCandidate(
          options.projections?.getRosterEvidence() ?? null,
          null,
          controller.getActiveRevision(),
        )?.revision;
      const expectedContinuity = continuityRevision();
      const canCommit = () => candidate()?.revision === current.revision;
      // The commit itself updates Team templates; post-commit activation checks observation only.
      const canActivate = () => continuityRevision() === expectedContinuity;
      try {
        if (operation === 'create-from-server') {
          if (controller.getActiveBinding() || !['bo1', 'bo3', 'bo5'].includes(String(body.format)))
            return reply.code(409).send({ message: '请先核对当前比赛与赛制。' });
          const teamId = (value: unknown) => {
            if (value === undefined) return undefined;
            if (
              typeof value !== 'string' ||
              !store.getSnapshot().teams.some((team) => team.teamId === value)
            )
              throw new Error('local_team_not_found');
            return value;
          };
          const teamAId = teamId(body.teamAId);
          const teamBId = teamId(body.teamBId);
          const existingPlayers = (id: string | undefined) =>
            store.getSnapshot().teams.find((team) => team.teamId === id)?.players ?? [];
          const existingName = (id: string | undefined) =>
            store.getSnapshot().teams.find((team) => team.teamId === id)?.name;
          const document = await store.createMatch(
            {
              teamA: current.ctName ?? (typeof body.teamA === 'string' ? body.teamA : ''),
              teamB: current.tName ?? (typeof body.teamB === 'string' ? body.teamB : ''),
              ...(teamAId === undefined ? {} : { teamAId }),
              ...(teamBId === undefined ? {} : { teamBId }),
              format: body.format as 'bo1' | 'bo3' | 'bo5',
              mapPool: DEFAULT_LOCAL_BP_MAP_POOL,
              playersA: mergeObservedStarters(existingPlayers(teamAId), current.ct, [
                current.ctName,
                existingName(teamAId),
              ]),
              playersB: mergeObservedStarters(existingPlayers(teamBId), current.t, [
                current.tName,
                existingName(teamBId),
              ]),
            },
            canCommit,
          );
          if (canActivate()) controller.activateLocalDocument(document);
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
                    [document.entrants.a.name, ct === 'a' ? current.ctName : current.tName],
                  ),
                },
                b: {
                  ...document.entrants.b,
                  players: mergeObservedStarters(
                    document.entrants.b.players,
                    ct === 'b' ? current.ct : current.t,
                    [document.entrants.b.name, ct === 'b' ? current.ctName : current.tName],
                  ),
                },
              },
            },
            canCommit,
          );
          if (canActivate()) controller.activateLocalDocument(updated);
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

  for (const operation of ['trash', 'restore'] as const) {
    app.post(`/operator/local-match/${operation}`, { bodyLimit: 2048 }, async (request, reply) => {
      if (!canMutate(originPolicy, request.headers.origin))
        return reply.code(403).send({ error: 'operator_origin_forbidden' });
      const body = object(request.body);
      if (typeof body?.matchId !== 'string' || body.confirmed !== true)
        return reply.code(400).send({ message: '请确认要处理的本地比赛。' });
      const matchId = body.matchId;
      const canCommit = () => controller.getActiveBinding()?.context.matchId !== matchId;
      try {
        if (operation === 'restore') await store.restoreMatch(matchId);
        else if (canCommit()) await store.trashMatch(matchId, canCommit);
        else {
          const binding = controller.getActiveBinding();
          if (
            body.releaseCurrent !== true ||
            binding?.origin !== 'local' ||
            binding.localAuthoringMode !== 'standalone' ||
            !options.canReleaseLocalSelection()
          )
            throw new Error('local_match_in_use');
          const revision = controller.getActiveRevision();
          const safe = () =>
            controller.getActiveRevision() === revision && options.canReleaseLocalSelection();
          const released = await options.withLocalSelectionRelease(async () => {
            await store.trashMatch(matchId, safe);
            if (controller.getActiveRevision() === revision) controller.clearActive();
          });
          if (!released) throw new Error('local_match_in_use');
        }
        return { ok: true };
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        const known: Record<string, { status: number; message: string }> = {
          local_match_in_use: {
            status: 409,
            message: '比赛正在使用，或尚未满足安全解除选择条件。请结束制作并切换比赛后重试。',
          },
          local_evidence_changed: {
            status: 409,
            message: '当前比赛引用已变化，资料未删除。请刷新后重试。',
          },
          local_match_not_found: { status: 404, message: '本地比赛不存在，请刷新比赛列表。' },
          local_trash_full: {
            status: 409,
            message: '回收站已满（256 场），比赛未删除。请先恢复回收站中的比赛，再清理其他比赛。',
          },
          local_matches_full: {
            status: 409,
            message: '本地比赛列表已满（256 场），比赛未恢复。请先将不使用的比赛移入回收站。',
          },
          local_store_too_large: {
            status: 409,
            message: '本地比赛资料已达到存储大小上限，操作未完成。请备份资料并查看诊断后处理。',
          },
        };
        const failure = known[code];
        if (failure)
          return reply.code(failure.status).send({ error: code, message: failure.message });
        app.log.error(
          { event: 'local_match', operation, matchId, diagnostic: errorEvidence(error) },
          'Local match persistence failed',
        );
        return reply.code(500).send({
          error: 'local_match_storage_failed',
          message: '本地比赛写入失败，原资料仍保留。请检查磁盘空间和资料目录权限，查看诊断后重试。',
        });
      }
    });
  }

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
    const rules =
      body.bo3Rules === undefined ? undefined : localBo3BpRulesSchema.safeParse(body.bo3Rules);
    if (rules !== undefined && !rules.success)
      return reply.code(400).send({ error: 'local_event_invalid' });
    try {
      await store.saveEvent({
        eventId: body.eventId,
        name: body.name,
        logoUrl: body.logoUrl,
        themeColor: body.themeColor,
        mapPool: body.mapPool,
        ...(rules === undefined ? {} : { bo3Rules: rules.data }),
      });
      const selected = store
        .getSnapshot()
        .matches.find((match) => match.matchId === store.getSnapshot().selectedMatchId);
      if (
        selected !== undefined &&
        selected.competition?.competitionId === body.eventId &&
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
