import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { checkArchitecture } from './check.mjs';

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

it('rejects CSS imports that reverse the shared component dependency direction', () => {
  expect(
    designRules(check({ 'apps/web/src/ui/bad.css': '@import "../patterns/patterns.css";' })),
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ ruleId: 'ARCH_DESIGN_DEPENDENCY' })]),
  );
});
