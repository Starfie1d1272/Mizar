import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ContextEnvelope, MatchDocumentV1 } from '@mizar/core/match-context';
import { buildApp } from '../src/app.js';

it('requires only match context, preserves match through hide/resume/finish, and rejects stale commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-lifecycle-'));
  const app = buildApp({
    matchManifestPath: join(root, 'match.json'),
    localTournamentPath: join(root, 'local.json'),
  });
  const headers = { origin: 'http://127.0.0.1:3000' };
  const get = async () =>
    (await app.inject('/local/v1/production')).json<{
      mode: string;
      revision: string;
      canEnter: boolean;
    }>();
  const send = async (action: string, revision: string) =>
    app.inject({
      method: 'POST',
      url: '/operator/production',
      headers,
      payload: { action, expectedRevision: revision },
    });
  try {
    const initial = await get();
    expect(initial).toMatchObject({ mode: 'preparation', canEnter: false });
    expect((await send('enter', initial.revision)).statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/local-match/create',
          headers,
          payload: { teamA: 'A', teamB: 'B', format: 'bo3' },
        })
      ).statusCode,
    ).toBe(200);
    const document = (await app.inject('/local/v1/match-document')).json<
      ContextEnvelope<MatchDocumentV1>
    >();
    expect((await send('enter', (await get()).revision)).json()).toMatchObject({ mode: 'live' });
    expect((await send('finish', initial.revision)).statusCode).toBe(409);
    expect((await send('hide', (await get()).revision)).json()).toMatchObject({ mode: 'hidden' });
    expect((await send('enter', (await get()).revision)).json()).toMatchObject({ mode: 'live' });
    expect((await send('finish', (await get()).revision)).json()).toMatchObject({
      mode: 'preparation',
    });
    expect((await app.inject('/local/v1/match-document')).json()).toEqual(document);
    expect((await app.inject('/local/v1/program-scenes')).json()).toMatchObject({
      active: 'waiting',
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/production',
          headers: { origin: 'https://foreign.test' },
          payload: { action: 'enter', expectedRevision: (await get()).revision },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('persists desktop visibility separately and cannot alter on-air HUD state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-overlay-'));
  const app = buildApp({ localTournamentPath: join(root, 'local.json') });
  try {
    const hud = (await app.inject('/local/v1/hud-config')).body;
    const policy = (await app.inject('/local/v1/desktop-overlay')).json<{ revision: string }>();
    const response = await app.inject({
      method: 'POST',
      url: '/operator/desktop-overlay',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {
        revision: policy.revision,
        enabled: true,
        visibility: { radar: true, 'top-score-bar': false },
      },
    });
    expect(response.statusCode).toBe(200);
    expect((await app.inject('/local/v1/hud-config')).body).toBe(hud);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/desktop-overlay',
          headers: { origin: 'http://127.0.0.1:3000' },
          payload: { revision: policy.revision, enabled: false, visibility: {} },
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await app.close();
  }
  const restored = buildApp({ localTournamentPath: join(root, 'local.json') });
  try {
    expect((await restored.inject('/local/v1/desktop-overlay')).json()).toMatchObject({
      visibility: { radar: true, 'top-score-bar': false },
    });
  } finally {
    await restored.close();
    await rm(root, { recursive: true, force: true });
  }
});
