import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import { checkArchitecture } from './check.mjs';
import { RUNTIME_COLORS } from './design.mjs';

const root = resolve(import.meta.dirname, '__design_virtual_root__');
const files = {
  'apps/web/package.json': JSON.stringify({
    name: '@mizar/web',
    type: 'module',
    dependencies: { react: '19.3.0' },
  }),
};
const check = (extra) => checkArchitecture({ rootDir: root, files: { ...files, ...extra } });
const designRules = (violations) => violations.filter((v) => v.ruleId.startsWith('ARCH_DESIGN'));

describe('Design System architecture guard', () => {
  it('keeps native broadcast artwork inside the default widget scope', () => {
    const sheet = postcss.parse(
      readFileSync(
        new URL('../../apps/web/src/program/designs/native.css', import.meta.url),
        'utf8',
      ),
    );
    const unscoped = [];
    sheet.walkAtRules('keyframes', (rule) => {
      expect([
        'mizar-pulse-enter',
        'mizar-pulse-observed',
        'mizar-pulse-planted',
        'mizar-pulse-defusing',
        'mizar-pulse-resolved',
        'mizar-pulse-scan',
      ]).toContain(rule.params);
    });
    sheet.walkRules((rule) => {
      if (rule.parent.type === 'atrule' && rule.parent.name === 'keyframes') return;
      let scoped = false;
      for (let node = rule; node; node = node.parent) {
        if (
          node.type === 'rule' &&
          node.selector.includes(".hud-widget-design[data-hud-design='current']")
        )
          scoped = true;
      }
      if (!scoped) unscoped.push(rule.selector);
    });
    expect(unscoped).toEqual([]);
  });
  it.each([
    ['color', '.feature { color: #123456; }', 'ARCH_DESIGN_RAW_COLOR'],
    ['rgb', '.feature { background: rgb(0 0 0); }', 'ARCH_DESIGN_RAW_COLOR'],
    [
      'new palette',
      ':root { --other-accent: var(--mizar-accent-primary); }',
      'ARCH_DESIGN_TOKEN_OWNER',
    ],
    ['canonical redeclaration', '.feature { --mizar-bg-canvas: #000; }', 'ARCH_DESIGN_TOKEN_OWNER'],
    ['private namespace', ':root { --debug-gap: 4px; }', 'ARCH_DESIGN_LEGACY_NAMESPACE'],
    [
      'legacy reference',
      '.feature { color: var(--broadcast-shell-ink); }',
      'ARCH_DESIGN_LEGACY_NAMESPACE',
    ],
    ['raw radius', '.feature { border-radius: 17px; }', 'ARCH_DESIGN_RECIPE'],
    ['raw shadow', '.feature { box-shadow: 0 1px 12px black; }', 'ARCH_DESIGN_RECIPE'],
    ['raw font', '.feature { font-family: Arial; }', 'ARCH_DESIGN_RECIPE'],
    [
      'Base consumption',
      '.feature { color: var(--mizar-color-blue-400); }',
      'ARCH_DESIGN_BASE_CONSUMPTION',
    ],
    [
      'removed token',
      '.feature { color: var(--mizar-removed-token); }',
      'ARCH_DESIGN_UNKNOWN_TOKEN',
    ],
    [
      'new runtime channel',
      '.feature { color: var(--mizar-event-special); }',
      'ARCH_DESIGN_UNKNOWN_TOKEN',
    ],
  ])('rejects %s', (_name, css, ruleId) => {
    expect(check({ 'apps/web/src/new.css': css })).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId })]),
    );
  });
  it('allows semantic recipes, renderer geometry and approved runtime variables', () => {
    expect(
      designRules(
        check({
          'apps/web/src/new.css':
            '.feature { color: var(--mizar-fg-primary); border-radius: var(--mizar-shape-panel); gap: 15px; }',
          'apps/web/src/program/new.css': '.scene { width: 1920px; color: #123456; }',
          'apps/web/src/colors.css': [...RUNTIME_COLORS]
            .map((v) => `.scene { ${v}: #123456; }`)
            .join('\n'),
        }),
      ),
    ).toEqual([]);
  });
  it('rejects raw values in inline UI styles', () => {
    expect(
      designRules(
        check({
          'apps/web/src/ui/Bad.tsx':
            'export const value = { color: "#123456", borderRadius: "17px" };',
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'ARCH_DESIGN_RAW_COLOR' }),
        expect.objectContaining({ ruleId: 'ARCH_DESIGN_RECIPE' }),
      ]),
    );
  });
  it('keeps legacy budget exact by selector, file and occurrence count', () => {
    const original = readFileSync(
      new URL('../../apps/web/src/product-shell.css', import.meta.url),
      'utf8',
    );
    expect(designRules(check({ 'apps/web/src/product-shell.css': original }))).toEqual([]);
    expect(designRules(check({ 'apps/web/src/copy.css': original })).length).toBeGreaterThan(0);
    expect(
      designRules(
        check({
          'apps/web/src/product-shell.css': original + '\n:root { --broadcast-shell-bg: #0b0d14; }',
        }),
      ).length,
    ).toBeGreaterThan(0);
  });
  it.each(['ui', 'patterns'])(
    'rejects %s imports of business helpers, including type/dynamic/re-export',
    (layer) => {
      for (const source of [
        'import type { Match } from "@mizar/core";',
        'export { Match } from "../feature.js";',
        'const helper = import("../feature.js");',
      ]) {
        expect(designRules(check({ [`apps/web/src/${layer}/bad.ts`]: source }))).toEqual(
          expect.arrayContaining([expect.objectContaining({ ruleId: 'ARCH_DESIGN_DEPENDENCY' })]),
        );
      }
    },
  );
  it('forbids ui → patterns but permits patterns → ui', () => {
    expect(
      designRules(
        check({ 'apps/web/src/ui/bad.ts': 'export { Workbench } from "../patterns/index.js";' }),
      ),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: 'ARCH_DESIGN_DEPENDENCY' })]),
    );
    expect(
      designRules(
        check({ 'apps/web/src/patterns/good.ts': 'export { Panel } from "../ui/index.js";' }),
      ),
    ).toEqual([]);
  });
});

it('rejects a numeric inline radius and raw colors in canonical stories', () => {
  expect(
    designRules(
      check({
        'apps/web/src/ui/bad.tsx': 'export const style = { borderRadius: 17 };',
        'apps/web/src/ui/bad.stories.tsx': 'export const style = { color: "#ffffff" };',
      }),
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ruleId: 'ARCH_DESIGN_RECIPE' }),
      expect.objectContaining({ ruleId: 'ARCH_DESIGN_RAW_COLOR' }),
    ]),
  );
});

it('allows the existing data-only Rivals fixture in stories, never in primitives', () => {
  const source =
    'import { RIVALS_BP_RECORDS } from "../program/fixtures/rivals-bp-records.generated.js";';
  expect(designRules(check({ 'apps/web/src/ui/example.stories.tsx': source }))).toEqual([]);
  expect(designRules(check({ 'apps/web/src/ui/bad.tsx': source }))).toEqual(
    expect.arrayContaining([expect.objectContaining({ ruleId: 'ARCH_DESIGN_DEPENDENCY' })]),
  );
});

it('rejects CSS imports that reverse the shared component dependency direction', () => {
  expect(
    designRules(check({ 'apps/web/src/ui/bad.css': '@import "../patterns/patterns.css";' })),
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ ruleId: 'ARCH_DESIGN_DEPENDENCY' })]),
  );
});
