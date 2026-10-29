import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ envelope: '', verified: 0 }));
vi.mock('../src/updates/box.js', () => ({
  BoxSource: class {
    link() {
      return Promise.resolve('https://box.nju.edu.cn/seafhttp/files/test');
    }
  },
}));
vi.mock('../src/updates/network.js', () => ({
  updateJson: () => Promise.resolve({ repo_name: 'Mizar', user_perm: 'r' }),
  updateRequest: () => Promise.resolve(new Response(state.envelope)),
  boundedBytes: async (response: Response) => Buffer.from(await response.arrayBuffer()),
}));
vi.mock('@mizar/resource-pack-contract/attestation', async (original) => {
  const actual = await original<typeof import('@mizar/resource-pack-contract/attestation')>();
  return {
    ...actual,
    createMizarVerifier: () =>
      Promise.resolve({
        verify: () => {
          state.verified++;
        },
      }),
  };
});
import { readMulnxMirror } from '../src/orchestration/tool-mirror.js';
const sha = 'a'.repeat(64),
  sourceSha = 'b'.repeat(40);
function makeEnvelope(path = '.github/workflows/mulnx-sync.yml', tamper = false) {
  const notice = { size: 1, sha256: sha };
  const index = Buffer.from(
    JSON.stringify({
      schema: 'mizar.mulnx-index.v1',
      repository: 'Co1Swet/MulNX_CS2',
      sourceSha,
      checkedAt: new Date().toISOString(),
      release: {
        id: 1,
        assetId: 2,
        tag: 'v1',
        publishedAt: '2026-01-01T00:00:00Z',
        url: 'https://github.com/Co1Swet/MulNX_CS2/releases/download/v1/MulNX.7z',
        size: 1,
        sha256: sha,
      },
      notices: { 'LICENSE.txt': notice, 'COPYRIGHT.md': notice, 'SECURITY.md': notice },
    }),
  );
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [
      {
        name: 'mulnx-index.json',
        digest: { sha256: tamper ? sha : createHash('sha256').update(index).digest('hex') },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: 'https://github.com/Starfie1d1272/Mizar',
            path,
            ref: 'refs/heads/main',
          },
        },
        resolvedDependencies: [
          {
            uri: 'git+https://github.com/Starfie1d1272/Mizar@refs/heads/main',
            digest: { gitCommit: sourceSha },
          },
        ],
      },
    },
  };
  return JSON.stringify({
    schema: 'mizar.mulnx-envelope.v1',
    indexBase64: index.toString('base64'),
    proof: {
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
      },
    },
  });
}
beforeEach(() => {
  state.verified = 0;
});
it('accepts only the dedicated workflow subject and rejects a changed index', async () => {
  state.envelope = makeEnvelope();
  expect((await readMulnxMirror('/tmp/mizar-test-trust')).release.id).toBe(1);
  expect(state.verified).toBe(1);
  state.envelope = makeEnvelope('.github/workflows/release-qualification.yml');
  await expect(readMulnxMirror('/tmp/mizar-test-trust')).rejects.toThrow();
  state.envelope = makeEnvelope(undefined, true);
  await expect(readMulnxMirror('/tmp/mizar-test-trust')).rejects.toThrow();
});
