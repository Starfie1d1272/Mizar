import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { programPayloadSchema } from '@mizar/protocol/program';
import { expect, it } from 'vitest';
import { startLhmHost } from '../src/hud-compat/host.js';

const programFixtures = JSON.parse(
  readFileSync(
    new URL(
      '../../web/src/program/fixtures/generated/real-program-fixtures.generated.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { fixtures: Record<string, { snapshot: { payload: unknown } }> };
const radarFixtures = JSON.parse(
  readFileSync(
    new URL(
      '../../web/src/program/fixtures/generated/real-radar-fixtures.generated.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { fixtures: Record<string, { samples: { snapshot: { payload: unknown } }[] }> };

it('registers and re-registers the instance with current config and projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-lhm-'));
  await writeFile(join(root, 'index.html'), 'sample');
  await writeFile(
    join(root, 'panel.json'),
    JSON.stringify([{ name: 'display_settings', inputs: [{ name: 'left_image', type: 'image' }] }]),
  );
  const bytes = readFileSync(
    new URL(
      '../../../packages/cs2-assets/generated/public/assets/cs2/maps/de_ancient-default.cb6adca45e32.png',
      import.meta.url,
    ),
  );
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(root, `${digest}.png`), bytes);
  const ref = `/local/v1/local-assets/${digest}.png`;
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const program = programPayloadSchema.parse(
    programFixtures.fixtures['real-warmup']!.snapshot.payload,
  );
  program.series!.entrants.a.logoUrl = ref;
  const avatarId = program.players[0]!.sourcePlayerId;
  const avatarFilename = `${'a'.repeat(64)}.jpg`;
  program.players[0]!.avatarUrl = `/local/v1/steam-avatar/${avatarFilename}`;
  const avatarBytes = readFileSync(
    new URL(
      '../../../packages/cs2-assets/generated/public/assets/cs2/thumbnails/de_ancient.1dea314b9eba.jpg',
      import.meta.url,
    ),
  );
  const bundle = {
    program,
    radar: radarFixtures.fixtures.warmup!.samples[0]!.snapshot.payload,
  };
  const projections = {
    getCurrent: () => bundle,
    subscribePresentation: (listener: (value: typeof bundle) => void) => {
      listener(bundle);
      return () => {};
    },
  } as never;
  const host = await startLhmHost({
    root,
    port,
    projections,
    config: { display_settings: { left_title: 'test', left_image: ref } },
    localAssetsDirectory: root,
    steamAvatars: {
      image: (filename: string) =>
        Promise.resolve(filename === avatarFilename ? avatarBytes : null),
    } as never,
    webRoot: new URL('../../../packages/cs2-assets/generated/public/', import.meta.url).pathname,
  });
  const socket = io(`http://127.0.0.1:${port}`, { autoConnect: false });
  const register = () =>
    new Promise<{ config: unknown; update: unknown }>((resolve) => {
      let config: unknown;
      socket.once('readyToRegister', () =>
        socket.emit('register', 'mizar', false, 'cs2', 'DEFAULT'),
      );
      socket.once('hud_config', (value) => {
        config = value;
      });
      socket.once('update', (value) => resolve({ config, update: value }));
      socket.connect();
    });
  try {
    expect(await register()).toMatchObject({
      config: { display_settings: { left_title: 'test', left_image: ref } },
      update: { map: { name: 'de_ancient' } },
    });
    socket.disconnect();
    expect(await register()).toMatchObject({ update: { map: { name: 'de_ancient' } } });
    const response = await fetch(host.url);
    expect(await response.text()).toBe('sample');
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect((await fetch(`http://127.0.0.1:${port}/operator`)).status).toBe(404);
    const match = (await (await fetch(`http://127.0.0.1:${port}/api/match/current`)).json()) as {
      left: { id: string };
      right: { id: string };
    };
    expect(new Set([match.left.id, match.right.id])).toEqual(
      new Set([program.series!.entrants.a.entryId, program.series!.entrants.b.entryId]),
    );
    const logo = await fetch(
      `http://127.0.0.1:${port}/api/teams/logo/${encodeURIComponent(program.series!.entrants.a.entryId)}`,
    );
    expect(Buffer.from(await logo.arrayBuffer())).toEqual(bytes);
    const image = await fetch(
      `http://127.0.0.1:${port}/api/huds/mizar/display_settings/left_image`,
    );
    expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes);
    expect(
      (await fetch(`http://127.0.0.1:${port}/api/huds/mizar/display_settings/other`)).status,
    ).toBe(404);
    const avatar = await fetch(
      `http://127.0.0.1:${port}/api/players/avatar/steamid/${avatarId}/image`,
    );
    expect(Buffer.from(await avatar.arrayBuffer())).toEqual(avatarBytes);
    expect(
      (await fetch(`http://127.0.0.1:${port}/api/players/avatar/steamid/unknown/image`)).status,
    ).toBe(404);
    const mapImage = await fetch(
      `http://127.0.0.1:${port}/api/game-maps/cs2/image/de_ancient/radar`,
    );
    expect(Buffer.from(await mapImage.arrayBuffer())).toEqual(bytes);
    const maps = (await (await fetch(`http://127.0.0.1:${port}/api/game-maps/cs2`)).json()) as {
      lhmId: string;
      radars: {
        lhmId: string;
        originX: number;
        originY: number;
        pxPerUX: number;
        pxPerUY: number;
        visibleUnderHeight: number | null;
        visibleOverHeight: number | null;
      }[];
    }[];
    expect(maps.find((map) => map.lhmId === 'de_ancient')?.radars[0]).toMatchObject({
      originX: 590.6,
      originY: 432.8,
      pxPerUX: 0.2,
      pxPerUY: -0.2,
    });
    const nukeImage = await fetch(`http://127.0.0.1:${port}/api/game-maps/cs2/image/de_nuke/radar`);
    expect(nukeImage.headers.get('content-type')).toBe('image/svg+xml');
    expect((await nukeImage.text()).match(/<image /g)).toHaveLength(2);
    const nuke = maps.find((map) => map.lhmId === 'de_nuke')!;
    const layers = nuke.radars;
    expect(layers).toHaveLength(2);
    expect(layers[0]!.originX).toBeCloseTo(256 + 3453 / 14);
    expect(layers[1]!.originY - layers[0]!.originY).toBe(512);
    expect(layers[0]!.visibleUnderHeight!).toBeLessThan(-495);
    expect(layers[1]!.visibleOverHeight).toBe(-495);
    expect(
      (await fetch(`http://127.0.0.1:${port}/api/game-maps/cs2/image/de_unknown/radar`)).status,
    ).toBe(404);
  } finally {
    socket.disconnect();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
