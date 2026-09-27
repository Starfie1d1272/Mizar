import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { BpProjection } from '@rivalhub-broadcast/core/projection';
import { BpSession, registerBpRoutes } from '../src/bp/controller.js';
import { createLocalWebOriginPolicy } from '../src/local-web/origin-policy.js';
import { bpSnapshotSchema } from '@rivalhub-broadcast/protocol/bp';

// Synthetic session boundary; real match rendering is covered in browser acceptance.
const projection: BpProjection = {
  matchId: 'm',
  competition: '比赛',
  stage: '决赛',
  format: 'bo1',
  entrants: {
    a: { entryId: 'a', name: '左队', logoUrl: null },
    b: { entryId: 'b', name: '右队', logoUrl: null },
  },
  cards: Array.from({ length: 7 }, (_, index) => ({
    mapName: `de_map_${index}`,
    kind: index === 6 ? ('decider' as const) : ('ban' as const),
    entrant: index === 6 ? null : ('a' as const),
    sideChoice: null,
  })),
  steps: Array.from({ length: 7 }, (_, cardIndex) => ({ cardIndex, kind: 'card' as const })),
};

describe('BP presentation session', () => {
  it('uses bounded current state, persists final recap, exits and plays again', () => {
    let time = 0;
    const session = new BpSession(
      () => projection,
      () => time,
    );
    const initial = session.get();
    expect(initial.state).toBe('hidden');
    expect(session.command('play', initial.revision)?.revealedCount).toBe(1);
    expect(session.command('play', initial.revision)).toBeNull();
    time = 1599;
    expect(session.get().revealedCount).toBe(1);
    time = 1600 * 6;
    expect(session.get().state).toBe('shown');
    time = 9e9;
    expect(session.get().state).toBe('shown');
    expect(session.command('hide', session.get().revision)?.state).toBe('hiding');
    time += 359;
    expect(session.get().state).toBe('hiding');
    time++;
    expect(session.get().state).toBe('hidden');
    expect(session.command('play', session.get().revision)?.state).toBe('revealing');
  });
  it('clears on wrong match, unavailable/mismatch or BP changes; restart stays hidden', () => {
    let current: BpProjection | null = projection;
    const session = new BpSession(() => current);
    session.command('play', session.get().revision);
    current = { ...projection, matchId: 'other' };
    expect(session.get().state).toBe('hidden');
    session.command('play', session.get().revision);
    current = null;
    expect(session.get()).toMatchObject({ state: 'hidden', projection: null, revealedCount: 0 });
    expect(session.command('play', session.get().revision)).toBeNull();
    expect(new BpSession(() => projection).get().state).toBe('hidden');
  });
  it('enforces origin, LAN and stale command protections with conditional polling', async () => {
    const app = Fastify();
    registerBpRoutes(app, {
      getProjection: () => projection,
      originPolicy: createLocalWebOriginPolicy(),
    });
    try {
      const read = await app.inject('/local/v1/bp');
      const initial = bpSnapshotSchema.parse(read.json());
      expect(
        (
          await app.inject({
            url: '/local/v1/bp',
            headers: { 'if-none-match': String(read.headers.etag) },
          })
        ).statusCode,
      ).toBe(304);
      const payload = { kind: 'play', expectedRevision: initial.revision };
      for (const origin of [undefined, 'https://evil.example']) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/operator/bp-command',
              payload,
              headers: origin ? { origin } : {},
            })
          ).statusCode,
        ).toBe(403);
      }
      const command = {
        method: 'POST' as const,
        url: '/operator/bp-command',
        payload,
        headers: { origin: 'http://127.0.0.1' },
      };
      expect((await app.inject(command)).statusCode).toBe(200);
      expect((await app.inject(command)).statusCode).toBe(409);
      expect((await app.inject({ ...command, payload: { kind: 'next' } })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
    const lan = Fastify();
    registerBpRoutes(lan, {
      getProjection: () => projection,
      originPolicy: createLocalWebOriginPolicy({
        host: '0.0.0.0',
        lanMode: true,
        allowedOrigins: ['http://192.168.1.1'],
      }),
    });
    try {
      expect(
        (
          await lan.inject({
            method: 'POST',
            url: '/operator/bp-command',
            payload: { kind: 'play', expectedRevision: 'x' },
            headers: { origin: 'http://192.168.1.1' },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await lan.close();
    }
  });
});
