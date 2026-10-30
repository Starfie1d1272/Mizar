import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommentaryProbe } from '../src/obs/remote-commentary.js';
import { guardedPreparationWrites, type ObsRpc } from '../src/obs/reconcile.js';

const endpoint = 'ws://127.0.0.1:4455';
const context = { endpoint, collection: 'Mizar', sceneName: '等待画面' };

async function usingProbe(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-probe-'));
  try {
    await run(join(directory, 'probe.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function obsFor(options: {
  output: () => Promise<Record<string, unknown>>;
  create: () => Promise<Record<string, unknown>>;
}): ObsRpc {
  return {
    call: async (type) => {
      if (type === 'GetStreamStatus' || type === 'GetRecordStatus') return { outputActive: false };
      if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: 'Mizar' };
      if (type === 'GetVersion')
        return {
          availableRequests: [
            'CreateInput',
            'GetInputKindList',
            'GetInputPropertiesListPropertyItems',
          ],
        };
      if (type === 'GetInputKindList') return { inputKinds: ['wasapi_process_output_capture'] };
      if (type === 'GetInputList') return { inputs: [] };
      if (type === 'GetOutputList') return options.output();
      if (type === 'CreateInput') return options.create();
      throw new Error(`unexpected ${type}`);
    },
  };
}

test('an unknown result after dispatch retains the probe journal', async () =>
  usingProbe(async (path) => {
    let sent = false;
    const obs = obsFor({
      output: async () => ({ outputs: [] }),
      create: async () => {
        sent = true;
        throw new Error('connection lost after dispatch');
      },
    });
    await assert.rejects(
      createCommentaryProbe(guardedPreparationWrites(obs), path, context, async () => {}),
      /connection lost/,
    );
    assert.equal(sent, true);
    const journal = JSON.parse(await readFile(path, 'utf8')) as { name: string; uuid?: string };
    assert.equal(journal.name, '其他解说');
    assert.equal(journal.uuid, undefined);
  }));

test('a changed journal is not removed when the output guard rejects before dispatch', async () =>
  usingProbe(async (path) => {
    let sent = false;
    const changed = '{"external":"changed"}\n';
    const obs = obsFor({
      output: async () => {
        await writeFile(path, changed);
        return {
          outputs: [
            {
              outputName: 'Plugin video',
              outputActive: true,
              outputFlags: { OBS_OUTPUT_VIDEO: true },
            },
          ],
        };
      },
      create: async () => {
        sent = true;
        return {};
      },
    });
    await assert.rejects(
      createCommentaryProbe(guardedPreparationWrites(obs), path, context, async () => {}),
      /Plugin video/,
    );
    assert.equal(sent, false);
    assert.equal(await readFile(path, 'utf8'), changed);
  }));
