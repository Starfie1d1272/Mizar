import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_LOCAL_BP_MAP_POOL,
  LOCAL_BP_MAP_CATALOG,
} from '@rivalhub-broadcast/core/projection';
import { bpWorkspaceSchema, localBpDraftSchema } from '@rivalhub-broadcast/protocol/bp';
import type { MatchContextController } from '../match-context/index.js';
import {
  bpAuthoringDraftFromBinding,
  createLocalBpManifest,
  localBpDraftFromBinding,
} from './local-draft.js';
import { localAuthoringMode } from '../match-context/lkg-store.js';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';

function canMutate(policy: LocalWebOriginPolicy, origin: string | undefined): boolean {
  return policy.mode === 'loopback' && checkLocalWebOrigin(policy, origin).allowed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registerBpWorkspaceRoutes(
  app: FastifyInstance,
  options: {
    readonly originPolicy: LocalWebOriginPolicy;
    readonly controller: MatchContextController | null;
    readonly projections: ProjectionCoordinator;
  },
) {
  app.get('/local/v1/bp-workspace', (_request, reply) => {
    const binding = options.controller?.getActiveBinding();
    const pending = options.controller?.getPendingOnlineCandidate();
    const publicSource =
      binding?.origin === 'online'
        ? 'online'
        : binding?.origin === 'local'
          ? 'local'
          : binding?.origin === 'cache'
            ? 'cache'
            : 'none';
    const assessment = options.projections.getBpAssessment();
    const match =
      binding === undefined
        ? null
        : {
            competition: binding.context.competition.name,
            stage: binding.context.stage,
            format: binding.context.format,
            entrants: {
              a: {
                name: binding.context.entrants.a.name,
                logoUrl: binding.context.entrants.a.logoUrl,
              },
              b: {
                name: binding.context.entrants.b.name,
                logoUrl: binding.context.entrants.b.logoUrl,
              },
            },
          };
    const response = bpWorkspaceSchema.parse({
      schemaVersion: 'rivalhub.bp-workspace.v3',
      source: publicSource,
      authoringMode: localAuthoringMode(binding) ?? 'standalone',
      contextRevision: options.controller?.getActiveRevision() ?? 'unavailable',
      freshness: binding?.freshness ?? 'none',
      readiness:
        binding === undefined
          ? 'unbound'
          : binding.context.veto.length === 0
            ? 'missing'
            : assessment.readiness,
      match,
      authoringDraft: binding === undefined ? null : bpAuthoringDraftFromBinding(binding),
      localDraft: binding === undefined ? null : localBpDraftFromBinding(binding),
      pendingRivalhub:
        pending === undefined
          ? null
          : {
              revision: pending.revision,
              competition: pending.binding.context.competition.name,
              stage: pending.binding.context.stage,
              format: pending.binding.context.format,
              entrants: {
                a: { name: pending.binding.context.entrants.a.name },
                b: { name: pending.binding.context.entrants.b.name },
              },
            },
      mapPoolOptions: LOCAL_BP_MAP_CATALOG,
      defaultMapPool: DEFAULT_LOCAL_BP_MAP_POOL,
    });
    return reply.header('cache-control', 'no-store').send(response);
  });

  app.post('/operator/bp-local-save', { bodyLimit: 65_536 }, async (request, reply) => {
    if (!canMutate(options.originPolicy, request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    if (options.controller === null)
      return reply
        .code(503)
        .send({ error: 'bp_authoring_unavailable', message: '本地 BP 保存服务尚未启动。' });
    const body = request.body;
    if (!isRecord(body) || typeof body.expectedContextRevision !== 'string' || !('draft' in body))
      return reply
        .code(400)
        .send({ error: 'invalid_bp_draft_command', message: '本地 BP 信息格式有误。' });
    const parsed = localBpDraftSchema.safeParse(body.draft);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: 'bp_draft_invalid', message: '本地 BP 信息格式有误，请检查填写内容。' });
    if (body.expectedContextRevision !== options.controller.getActiveRevision())
      return reply.code(409).send({
        error: 'bp_context_conflict',
        message: '比赛上下文已更新，请核对后再保存。',
      });
    const compiled = createLocalBpManifest(parsed.data, options.controller.getActiveBinding());
    if (!compiled.ok)
      return reply.code(400).send({ error: compiled.code, message: compiled.message });
    const result = await options.controller.selectLocalMatch(
      compiled.manifest,
      body.expectedContextRevision,
    );
    if (!result.ok) {
      const stale = result.diagnostics.some((diagnostic) => diagnostic.code === 'selection_stale');
      const identityConflict = result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'local_identity_mismatch',
      );
      const persistenceFailed = result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'lkg_persistence_failed',
      );
      return reply.code(stale || identityConflict ? 409 : persistenceFailed ? 500 : 400).send({
        error: stale
          ? 'bp_context_conflict'
          : identityConflict
            ? 'bp_identity_conflict'
            : persistenceFailed
              ? 'bp_save_failed'
              : 'bp_draft_invalid',
        message: stale
          ? '比赛上下文已更新，请核对后再保存。'
          : identityConflict
            ? '当前比赛身份已改变，请重新载入 BP 工作台。'
            : persistenceFailed
              ? '保存失败，当前 BP 保持不变。'
              : '本地 BP 无法转换为有效比赛上下文。',
      });
    }
    return { ok: true, message: '本地 BP 已保存。' };
  });

  app.post('/operator/bp-rivalhub', { bodyLimit: 4096 }, async (request, reply) => {
    if (!canMutate(options.originPolicy, request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    if (options.controller === null)
      return reply
        .code(503)
        .send({ error: 'rivalhub_unavailable', message: 'RivalHub 来源尚未接入。' });
    const body = request.body;
    if (
      !isRecord(body) ||
      typeof body.expectedContextRevision !== 'string' ||
      typeof body.expectedPendingRevision !== 'string'
    )
      return reply.code(400).send({ error: 'invalid_bp_source_command' });
    const result = await options.controller.activatePendingOnlineMatch(
      body.expectedContextRevision,
      body.expectedPendingRevision,
    );
    if (!result.ok) {
      const persistenceFailed = result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'lkg_persistence_failed',
      );
      return reply.code(persistenceFailed ? 500 : 409).send({
        error: persistenceFailed ? 'bp_source_save_failed' : 'bp_source_unavailable',
        message: persistenceFailed
          ? '无法安全切回 RivalHub BP，本地比赛保持不变。'
          : 'RivalHub BP 尚未就绪，当前比赛保持不变。',
      });
    }
    return { ok: true, message: '已切回 RivalHub BP。' };
  });
}
