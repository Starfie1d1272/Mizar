import type { FastifyInstance } from 'fastify';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';

export type BroadcastMigrationStatus =
  | { state: 'ready' }
  | {
      state: 'pending';
      reason:
        | 'owner_unavailable'
        | 'camera_identity_unavailable'
        | 'facades_pending'
        | 'dependency_unavailable';
    };
/** This status is private to the local operator; it never includes legacy configuration or paths. */
export function registerBroadcastMigrationStatus(
  app: FastifyInstance,
  policy: LocalWebOriginPolicy,
  get: () => BroadcastMigrationStatus,
): void {
  app.get('/local/v1/broadcast-config/migration', (request, reply) => {
    if (
      policy.mode !== 'loopback' ||
      !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(request.hostname) ||
      request.headers['sec-fetch-site'] === 'cross-site' ||
      (request.headers.origin && !checkLocalWebOrigin(policy, request.headers.origin).allowed)
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    return reply.header('cache-control', 'no-store').send(get());
  });
}
