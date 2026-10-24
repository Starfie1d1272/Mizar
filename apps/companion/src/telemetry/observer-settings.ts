import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  observerSettingsSchema,
  DEFAULT_OBSERVER_SETTINGS,
  observerConnectionSchema,
  type ObserverSettings,
  type ObserverConnection,
} from '@mizar/protocol/assist';
import { atomicJson } from '../resource-store/files.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';

/** Persist operator preferences; the current match's credentials stay in memory. */
export class ObserverSettingsStore {
  settings: ObserverSettings = { ...DEFAULT_OBSERVER_SETTINGS };
  private connection: ObserverConnection | undefined;
  revision = randomUUID();
  private listeners = new Set<(kind: 'settings' | 'connection') => void>();
  private writing = Promise.resolve();
  constructor(private readonly path?: string) {}
  async load() {
    if (!this.path) return;
    try {
      this.settings = observerSettingsSchema.parse(
        JSON.parse(await readFile(this.path, 'utf8')) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  view() {
    return {
      settings: this.settings,
      revision: this.revision,
      connection: this.connection
        ? {
            earlyEndpoint: this.connection.earlyEndpoint,
            programEndpoint: this.connection.programEndpoint,
            passwordProvided: Boolean(this.connection.password),
          }
        : null,
    };
  }
  configured() {
    return this.settings.enabled ? this.connection : undefined;
  }
  configure(settings: ObserverSettings) {
    const value = observerSettingsSchema.parse(settings);
    const next = this.writing.then(async () => {
      if (this.path) await atomicJson(this.path, value);
      this.settings = value;
      this.changed();
    });
    this.writing = next.catch(() => {});
    return next;
  }
  setConnection(value: ObserverConnection) {
    this.connection = observerConnectionSchema.parse(value);
    this.changed('connection');
  }
  clearConnection() {
    this.connection = undefined;
    this.changed('connection');
  }
  subscribe(listener: (kind: 'settings' | 'connection') => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(kind: 'settings' | 'connection' = 'settings') {
    this.revision = randomUUID();
    this.listeners.forEach((f) => f(kind));
  }
}

export function registerObserverSettings(
  app: FastifyInstance,
  store: ObserverSettingsStore,
  policy: LocalWebOriginPolicy,
) {
  app.get('/local/v1/observer-assist', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(store.view()),
  );
  const schema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('configure'), settings: observerSettingsSchema }),
    z.strictObject({ action: z.literal('connection'), connection: observerConnectionSchema }),
  ]);
  app.post('/operator/observer-assist', { bodyLimit: 4096 }, async (request, reply) => {
    if (policy.mode !== 'loopback' || !checkLocalWebOrigin(policy, request.headers.origin).allowed)
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ message: '请核对时间设置、GOTV 地址和密码格式。' });
    if (parsed.data.action === 'configure') await store.configure(parsed.data.settings);
    else store.setConnection(parsed.data.connection);
    return store.view();
  });
}
