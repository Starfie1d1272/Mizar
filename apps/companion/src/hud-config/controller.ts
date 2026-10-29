import { resolveHudPreset } from '@mizar/hud-config';
import type { BroadcastConfigDocument } from '@mizar/broadcast-config';
import { exportLhmHud } from '../hud-export/lhm.js';
import { diagnosticValue } from '../support/session-journal.js';
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
  readonly webRoot?: string;
  readonly getBroadcastDocument?: () => BroadcastConfigDocument | undefined;
  readonly waitForBroadcast?: () => Promise<void>;
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

  app.post('/operator/hud-config/export-lhm', async (request, reply) => {
    if (options.originPolicy.mode !== 'loopback')
      return reply.code(403).send({ error: 'operator_mutation_loopback_only' });
    if (!checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed)
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body: unknown = request.body;
    if (
      !isRecord(body) ||
      (typeof body.expectedActiveRevision !== 'string' &&
        (typeof body.moduleId !== 'string' || typeof body.moduleRevision !== 'string'))
    )
      return reply.code(400).send({ error: 'invalid_hud_config_command' });
    try {
      await options.waitForBroadcast?.();
    } catch {
      return reply.code(503).send({ error: 'broadcast_config_unavailable' });
    }
    if (!options.store.canMigrate) return reply.code(503).send({ error: 'hud_config_unavailable' });
    const state = options.store.getState();
    if (state.persistenceError) return reply.code(503).send({ error: 'hud_config_unavailable' });
    if (
      typeof body.expectedActiveRevision === 'string' &&
      state.activeRevision !== body.expectedActiveRevision
    )
      return reply.code(409).send({ error: 'hud_config_active_conflict' });
    if (!options.webRoot) return reply.code(503).send({ error: 'lhm_export_runtime_unavailable' });
    try {
      const document = options.getBroadcastDocument?.();
      let value: unknown = document?.active.resolved.hud ?? state.resolved;
      if (typeof body.moduleId === 'string') {
        const item = document?.modules.find(
          (item) => item.id === body.moduleId && item.kind === 'hud',
        );
        if (!item || item.revision !== body.moduleRevision)
          return reply.code(409).send({ error: 'hud_config_editor_conflict' });
        if (item.kind !== 'hud' || !('preset' in item.value))
          return reply.code(400).send({ error: 'lhm_export_unsupported_hud' });
        value = {
          renderer: 'native',
          config: resolveHudPreset(item.value.preset, item.value.layout, item.value.theme),
          overlays: item.value.overlays,
          accent: item.value.accent,
        };
      }
      const archive = await exportLhmHud(options.webRoot, value);
      await options.waitForBroadcast?.();
      if (
        typeof body.expectedActiveRevision === 'string' &&
        options.store.getState().activeRevision !== body.expectedActiveRevision
      )
        return reply.code(409).send({ error: 'hud_config_active_conflict' });
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', 'attachment; filename="mizar-hud.zip"')
        .header('cache-control', 'no-store')
        .send(archive);
    } catch {
      return reply.code(503).send({ error: 'lhm_export_runtime_unavailable' });
    }
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
    } catch (error) {
      request.log.warn(
        { stage: 'control_failure', error: diagnosticValue(error) },
        'Product control failed',
      );
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
