import { URL } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compileTokens,
  loadTokens,
  parseTokenJson,
  verifyGenerated,
  TOKEN_FILES,
  verifySourceReferences,
} from './tokens.mjs';

const dimension = (value = 4) => ({ $type: 'dimension', $value: { value, unit: 'px' } });
const documents = () => ({
  base: { space: { small: dimension() } },
  semantic: { layout: { $type: 'dimension', gap: { $value: '{space.small}' } } },
  product: { product: { layout: { $type: 'dimension', gap: { $value: '{layout.gap}' } } } },
});
describe('Design Token contract', () => {
  it('wraps long explicit font stacks without changing family ordering', () => {
    const d = documents();
    d.base.font = {
      family: {
        sans: {
          $type: 'fontFamily',
          $value: [
            'Inter',
            'Microsoft YaHei UI',
            'Microsoft YaHei',
            'PingFang SC',
            'Noto Sans CJK SC',
            'sans-serif',
          ],
        },
      },
    };
    expect(compileTokens(d).css).toContain(
      "--mizar-font-family-sans:\n    'Inter', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif;",
    );
  });

  it('resolves inherited types and chained aliases into deterministic CSS', () => {
    const result = compileTokens(documents());
    expect(result.tokens.size).toBe(3);
    expect(result.css).toContain('--mizar-product-layout-gap: var(--mizar-layout-gap)');
    expect(result.css).toContain('--mizar-space-small: 4px');
    expect(loadTokens().tokens.size).toBeGreaterThan(0);
  });
  it.each([
    [
      'unknown type',
      (d) => {
        d.base.space.small.$type = 'magic';
      },
    ],
    [
      'invalid unit',
      (d) => {
        d.base.space.small.$value.unit = 'em';
      },
    ],
    [
      'invalid value',
      (d) => {
        d.base.space.small.$value.value = -1;
      },
    ],
    [
      'invalid name',
      (d) => {
        d.base['bad.name'] = dimension();
      },
    ],
    [
      'duplicate name',
      (d) => {
        d.semantic.space = { small: { $type: 'dimension', $value: '{space.small}' } };
      },
    ],
    [
      'CSS collision',
      (d) => {
        d.base['space-small'] = dimension();
      },
    ],
    [
      'raw semantic',
      (d) => {
        d.semantic.layout.gap = dimension();
      },
    ],
    [
      'unknown alias',
      (d) => {
        d.semantic.layout.gap.$value = '{removed.token}';
      },
    ],
    [
      'alias cycle',
      (d) => {
        d.base.space.small.$value = '{space.small}';
      },
    ],
    [
      'type mismatch',
      (d) => {
        d.semantic.layout.$type = 'number';
      },
    ],
    [
      'surface bypass',
      (d) => {
        d.product.product.layout.gap.$value = '{space.small}';
      },
    ],
    [
      'reverse dependency',
      (d) => {
        d.base.space.small.$value = '{layout.gap}';
      },
    ],
    [
      'unsupported schema',
      (d) => {
        d.base.$extends = '{other}';
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const d = documents();
    mutate(d);
    expect(() => compileTokens(d)).toThrow();
  });
  it('detects duplicate JSON properties before parsing discards them', () => {
    expect(() => parseTokenJson('{"space":{},"space":{}}', 'base')).toThrow('duplicate name');
    expect(() => parseTokenJson('{/* comment */"space":{}}', 'base')).toThrow('invalid JSON');
  });
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

it('token verification rejects removed source references and allows approved runtime colors', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'mizar-token-reference-'));
  try {
    mkdirSync(resolve(root, 'apps/web/src'), { recursive: true });
    mkdirSync(resolve(root, 'packages'));
    const path = resolve(root, 'apps/web/src/feature.css');
    writeFileSync(path, '.feature { color: var(--mizar-removed-token); }');
    expect(() => verifySourceReferences(loadTokens().tokens, root)).toThrow(
      'removed/unknown token',
    );
    writeFileSync(path, '.feature { color: var(--mizar-fg-primary); --mizar-event-accent: #fff; }');
    expect(() => verifySourceReferences(loadTokens().tokens, root)).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
