import type { FastifyInstance, FastifyReply } from 'fastify';

import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import {
  HudConfigStore,
  HudConfigCommandError,
  HudConfigEditorConflictError,
  type HudConfigMutationState,
  HudConfigPersistenceError,
  type HudConfigState,
  type HudResourceKind,
} from './store.js';

export interface HudConfigControllerOptions {
  readonly store: HudConfigStore;
  readonly originPolicy: LocalWebOriginPolicy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function originForbidden(reply: FastifyReply): void {
  void reply.code(403).send({ error: 'operator_origin_forbidden' });
}

function mutationUnavailableOnLan(reply: FastifyReply): void {
  void reply.code(403).send({ error: 'operator_mutation_loopback_only' });
}

function resourceKind(value: unknown): HudResourceKind | undefined {
  return value === 'preset' || value === 'layout' || value === 'theme' ? value : undefined;
}

function onAirResponse(state: HudConfigState) {
  return {
    resolved: state.resolved,
    etag: state.etag,
    activeRevision: state.activeRevision,
  };
}

function editorResponse(state: HudConfigState) {
  return {
    document: state.document,
    activationStale: state.activationStale,
    etag: state.editorEtag,
    revision: state.editorRevision,
  };
}

function mutationResponse(state: HudConfigMutationState) {
  return {
    command: state.command,
    onAir: onAirResponse(state),
    editor: editorResponse(state),
  };
}

export function registerHudConfigRoutes(
  app: FastifyInstance,
  options: HudConfigControllerOptions,
): void {
  app.get('/local/v1/hud-config', (request, reply) => {
    const state = options.store.getState();
    reply.header('cache-control', 'no-store');
    reply.header('etag', state.etag);
    const requested = request.headers['if-none-match'];
    if (typeof requested === 'string' && requested === state.etag) return reply.code(304).send();
    return reply.code(200).send(onAirResponse(state));
  });

  app.get('/operator/hud-config', (request, reply) => {
    const state = options.store.getState();
    reply.header('cache-control', 'no-store');
    reply.header('etag', state.editorEtag);
    const requested = request.headers['if-none-match'];
    if (typeof requested === 'string' && requested === state.editorEtag)
      return reply.code(304).send();
    return reply.code(200).send(editorResponse(state));
  });

  app.post('/operator/hud-config', async (request, reply) => {
    if (options.originPolicy.mode !== 'loopback') {
      mutationUnavailableOnLan(reply);
      return;
    }
    if (!checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed) {
      originForbidden(reply);
      return;
    }

    const body: unknown = request.body;
    try {
      if (!isRecord(body) || typeof body.kind !== 'string') {
        return reply.code(400).send({ error: 'invalid_hud_config_command' });
      }
      if (typeof body.expectedEditorRevision !== 'string') {
        return reply.code(400).send({ error: 'invalid_hud_config_command' });
      }
      if (body.kind === 'save-resource' || body.kind === 'save-as') {
        const resource = resourceKind(body.resource);
        if (resource === undefined || !('value' in body)) {
          return reply.code(400).send({ error: 'invalid_hud_config_command' });
        }
        const state =
          body.kind === 'save-resource'
            ? await options.store.saveResource(resource, body.value, body.expectedEditorRevision)
            : await options.store.saveAs(resource, body.value, body.expectedEditorRevision);
        return reply.code(200).send(mutationResponse(state));
      }
      if (body.kind === 'import-preset-pack' && 'value' in body) {
        const state = await options.store.importPresetPack(body.value, body.expectedEditorRevision);
        return reply.code(200).send(mutationResponse(state));
      }
      if (body.kind === 'activate-preset' && typeof body.sourceId === 'string') {
        const state = await options.store.activatePreset(
          body.sourceId,
          body.expectedEditorRevision,
        );
        return reply.code(200).send(mutationResponse(state));
      }
      return reply.code(400).send({ error: 'invalid_hud_config_command' });
    } catch (error: unknown) {
      if (error instanceof HudConfigEditorConflictError) {
        return reply.code(409).send({
          error: 'hud_config_editor_conflict',
          message: 'HUD 配置已在另一页面更新，请先处理冲突。',
        });
      }
      if (error instanceof HudConfigCommandError) {
        return reply.code(400).send({
          error: 'hud_config_command_rejected',
          message: error.message,
        });
      }
      if (error instanceof HudConfigPersistenceError) {
        request.log.error({ err: error.cause }, 'HUD 配置持久化失败');
        return reply.code(500).send({
          error: 'hud_config_persistence_failed',
          message: 'HUD 配置暂时无法保存，请查看本机诊断日志。',
        });
      }
      request.log.error({ err: error }, 'HUD 配置内部错误');
      return reply.code(500).send({
        error: 'hud_config_internal_error',
        message: 'HUD 配置暂时无法保存，请查看本机诊断日志。',
      });
    }
  });
}
