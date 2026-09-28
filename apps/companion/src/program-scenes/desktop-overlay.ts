import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { HUD_WIDGET_IDS } from '@mizar/hud-config';
import { replaceDurableJson } from '../match-context/durable-json.js';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';

export async function registerDesktopOverlayRoutes(
  app: FastifyInstance,
  path: string | undefined,
  origin: LocalWebOriginPolicy,
) {
  let enabled = true;
  let visibility: Record<string, boolean> = { radar: false };
  let revision = randomUUID();
  let busy = false;
  const valid = (value: unknown): value is Record<string, boolean> =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([id, flag]) => HUD_WIDGET_IDS.some((key) => key === id) && typeof flag === 'boolean',
    );
  if (path) {
    try {
      const saved = JSON.parse(await readFile(path, 'utf8')) as {
        enabled: unknown;
        visibility: unknown;
      };
      if (typeof saved.enabled === 'boolean' && valid(saved.visibility)) {
        enabled = saved.enabled;
        visibility = saved.visibility;
      }
    } catch {
      /* Invalid local presentation policy uses the safe built-in policy. */
    }
  }
  const view = () => ({ enabled, visibility, revision });
  app.get('/local/v1/desktop-overlay', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(view()),
  );
  app.post('/operator/desktop-overlay', { bodyLimit: 2048 }, async (request, reply) => {
    if (origin.mode !== 'loopback' || !checkLocalWebOrigin(origin, request.headers.origin).allowed)
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const value = request.body as {
      enabled?: unknown;
      visibility?: unknown;
      revision?: unknown;
    } | null;
    if (busy || value?.revision !== revision)
      return reply.code(409).send({ message: '本机覆盖设置已变化，请刷新后重试。' });
    if (typeof value?.enabled !== 'boolean' || !valid(value.visibility))
      return reply.code(400).send({ message: '本机覆盖设置无效。' });
    busy = true;
    try {
      if (path)
        await replaceDurableJson(path, { enabled: value.enabled, visibility: value.visibility });
      enabled = value.enabled;
      visibility = value.visibility;
      revision = randomUUID();
      return view();
    } finally {
      busy = false;
    }
  });
}
