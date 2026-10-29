import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { exportModule, writePackArchive } from '@mizar/broadcast-pack';
import type { BroadcastConfigDocument, ModuleRecord } from '@mizar/broadcast-config';
import { HudConfigStore } from '../../src/hud-config/store.js';
import { buildApp } from '../../src/app.js';

it('repairs a damaged active picture package with an explicit identical reimport after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'broadcast-pack-repair-'));
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC',
    'base64',
  );
  const headers = { origin: 'http://127.0.0.1:3000', 'content-type': 'application/x-mizarpack' };
  const jsonHeaders = { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' };
  const makeApp = async () => {
    const hud = new HudConfigStore();
    await hud.load();
    return buildApp({ obsConfigPath: join(root, 'obs.json'), hudConfigStore: hud });
  };
  const app = await makeApp();
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const modules = (await (await fetch(`${address}/local/v1/broadcast-modules`)).json()) as {
      modules: Array<{ module: ModuleRecord }>;
    };
    const program = structuredClone(
      modules.modules.find(({ module }) => module.kind === 'program')!.module,
    );
    if (program.kind !== 'program') throw new Error('program missing');
    program.value.assets['pulse.background'] = {
      resource: {
        id: 'local:mizar-pack:00000000-0000-4000-8000-000000000000',
        version: '1.0.0',
        digest: '0'.repeat(64),
      },
      fileId: 'background',
    };
    const template = exportModule(program, {
      asset: () => ({ package: '$self', fileId: 'background' }),
      resource: () => {
        throw new Error('unexpected');
      },
      tool: () => {
        throw new Error('unexpected');
      },
    });
    const moduleBytes = Buffer.from(JSON.stringify(template));
    const manifest = {
      format: 'mizar.pack',
      formatVersion: 1,
      packageId: randomUUID(),
      version: '1.0.0',
      name: '图片场景',
      author: '',
      modules: [
        {
          entryId: 'scene',
          module: 'program',
          schemaVersion: 1,
          fileId: 'scene-json',
          required: true,
        },
      ],
      presets: [],
      dependencies: [],
      requirements: [],
      files: [
        {
          id: 'scene-json',
          path: 'scene.json',
          mediaType: 'application/json',
          bytes: moduleBytes.length,
          sha256: createHash('sha256').update(moduleBytes).digest('hex'),
        },
        {
          id: 'background',
          path: 'background.png',
          mediaType: 'image/png',
          bytes: image.length,
          sha256: createHash('sha256').update(image).digest('hex'),
        },
      ],
    };
    const zip = await writePackArchive(
      Buffer.from(JSON.stringify(manifest)),
      new Map([
        ['scene.json', moduleBytes],
        ['background.png', image],
      ]),
    );
    const blob = () => new Blob([new Uint8Array(zip)]);
    const imported = await fetch(`${address}/operator/resource-library/import-pack`, {
      method: 'POST',
      headers,
      body: blob(),
    });
    expect(imported.status).toBe(200);
    const result = (await imported.json()) as {
      mapping: {
        source: { id: string; version: string; digest: string };
        moduleEntries: Record<string, string[]>;
      };
    };
    const sceneId = result.mapping.moduleEntries.scene![0]!;
    let document = (await (
      await fetch(`${address}/local/v1/broadcast-presets`)
    ).json()) as BroadcastConfigDocument;
    const scene = document.modules.find((module) => module.id === sceneId)!;
    const apply = (base: string, revision: string) =>
      fetch(`${base}/operator/broadcast-modules/apply`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          moduleId: scene.id,
          expectedRevision: scene.revision,
          expectedActiveRevision: revision,
          requestId: randomUUID(),
        }),
      });
    expect((await apply(address, document.active.revision)).status).toBe(200);
    const ref = result.mapping.source;
    const query = new URLSearchParams({
      resourceId: ref.id,
      version: ref.version,
      digest: ref.digest,
      fileId: 'background',
    });
    expect(
      Buffer.from(
        await (await fetch(`${address}/local/v1/broadcast-assets?${query}`)).arrayBuffer(),
      ),
    ).toEqual(image);
    await app.close();
    const filename = `${createHash('sha256')
      .update(JSON.stringify([ref.id, ref.version]))
      .digest('hex')}.mizarpack`;
    await writeFile(join(root, 'music-packs', filename), Buffer.from('broken zip'));
    const resumed = await makeApp();
    try {
      const next = await resumed.listen({ host: '127.0.0.1', port: 0 });
      expect((await fetch(`${next}/local/v1/broadcast-modules`)).status).toBe(200);
      expect((await fetch(`${next}/local/v1/broadcast-assets?${query}`)).status).toBe(422);
      const whileDamaged = (await (
        await fetch(`${next}/local/v1/broadcast-presets`)
      ).json()) as BroadcastConfigDocument;
      const hud = whileDamaged.modules.find((module) => module.kind === 'hud')!;
      const hudApply = await fetch(`${next}/operator/broadcast-modules/apply`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          moduleId: hud.id,
          expectedRevision: hud.revision,
          expectedActiveRevision: whileDamaged.active.revision,
          requestId: randomUUID(),
        }),
      });
      expect(hudApply.status).toBe(200);
      const different = await writePackArchive(
        Buffer.from(JSON.stringify({ ...manifest, name: '不同摘要' })),
        new Map([
          ['scene.json', moduleBytes],
          ['background.png', image],
        ]),
      );
      const conflict = await fetch(`${next}/operator/resource-library/import-pack`, {
        method: 'POST',
        headers,
        body: new Blob([new Uint8Array(different)]),
      });
      expect(conflict.status).toBe(409);
      const corruptInput = await fetch(`${next}/operator/resource-library/import-pack`, {
        method: 'POST',
        headers,
        body: new Blob(['not a zip']),
      });
      expect(corruptInput.status).toBe(400);
      expect((await fetch(`${next}/local/v1/broadcast-assets?${query}`)).status).toBe(422);
      const checked = await fetch(`${next}/operator/resource-library/check-pack`, {
        method: 'POST',
        headers,
        body: blob(),
      });
      expect(checked.status).toBe(200);
      const inspection = (await checked.json()) as { source: { digest: string } };
      const selection = new URLSearchParams({
        digest: inspection.source.digest,
        selection: JSON.stringify({ modules: ['scene'], presets: [] }),
      });
      const before = (await (
        await fetch(`${next}/local/v1/broadcast-presets`)
      ).json()) as BroadcastConfigDocument;
      const reimport = await fetch(`${next}/operator/resource-library/import-pack?${selection}`, {
        method: 'POST',
        headers,
        body: blob(),
      });
      expect(reimport.status).toBe(200);
      expect(((await reimport.json()) as { reused: boolean }).reused).toBe(true);
      document = (await (
        await fetch(`${next}/local/v1/broadcast-presets`)
      ).json()) as BroadcastConfigDocument;
      expect(document.modules.map((module) => module.id)).toEqual(
        before.modules.map((module) => module.id),
      );
      expect((await apply(next, document.active.revision)).status).toBe(200);
      const display = (await (await fetch(`${next}/local/v1/broadcast-display-config`)).json()) as {
        program: { assets: Record<string, { resource: unknown }> };
      };
      expect(display.program.assets['pulse.background']?.resource).toEqual(ref);
      expect(
        Buffer.from(
          await (await fetch(`${next}/local/v1/broadcast-assets?${query}`)).arrayBuffer(),
        ),
      ).toEqual(image);
    } finally {
      await resumed.close();
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
