import { URL } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTokens, verifyGenerated, TOKEN_FILES } from './tokens.mjs';
describe('Design Token contract', () => {
  it('detects generated CSS drift without repairing it', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'mizar-token-test-'));
    try {
      mkdirSync(resolve(root, 'src'));
      mkdirSync(resolve(root, 'generated'));
      for (const file of TOKEN_FILES)
        writeFileSync(
          resolve(root, 'src', `${file}.tokens.json`),
          readFileSync(new URL(`../src/${file}.tokens.json`, import.meta.url)),
        );
      const generated = resolve(root, 'generated/tokens.css');
      writeFileSync(generated, 'drift');
      expect(() => verifyGenerated(root)).toThrow('drift');
      expect(readFileSync(generated, 'utf8')).toBe('drift');
      writeFileSync(generated, loadTokens(root).css);
      expect(() => verifyGenerated(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
