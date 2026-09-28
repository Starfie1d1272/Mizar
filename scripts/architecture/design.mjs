import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import postcss from 'postcss';
import ts from 'typescript';
import {
  loadTokens,
  compileTokens,
  parseTokenJson,
  TOKEN_FILES,
  RUNTIME_COLORS,
} from '../../packages/design-tokens/scripts/tokens.mjs';

export { RUNTIME_COLORS };
const legacyNamespace = /--(?:broadcast-shell|debug|hud|rh-hud|product|bp)-[\w-]+/g;
const rawColor = /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\(/i;
const foundationReference = /--mizar-(?:color|space|radius|font|motion|stroke|size|opacity)-/;
const baseline = JSON.parse(readFileSync(new URL('./design-legacy.json', import.meta.url), 'utf8'));

function isRenderer(path) {
  return path.startsWith('apps/web/src/program/');
}
function isCatalog(path) {
  return /\.stories\.[^.]+$/.test(path);
}
function isShared(path) {
  return /^apps\/web\/src\/(?:ui|patterns)\//.test(path);
}

/** Exact declarations/counts are a shrinking migration inventory, not a directory exemption. */
export function visualFindings(path, source) {
  const findings = [];
  const add = (ruleId, value) => findings.push({ ruleId, value });
  const checkValue = (key, value, context) => {
    const entry = `${context} | ${key}: ${value}`;
    if (
      key.startsWith('--') &&
      (key.startsWith('--mizar-') ||
        /color|accent|theme|radius|shadow|font|status|ink|muted|panel|surface|bg|fg|line/.test(
          key,
        ) ||
        rawColor.test(value) ||
        /var\(--mizar-(?:bg|fg|accent|status|border|focus)/.test(value)) &&
      !RUNTIME_COLORS.has(key)
    )
      add('ARCH_DESIGN_TOKEN_OWNER', entry);
    for (const name of `${key} ${value}`.match(legacyNamespace) ?? [])
      add('ARCH_DESIGN_LEGACY_NAMESPACE', `${context} | ${name}`);
    if (foundationReference.test(value)) add('ARCH_DESIGN_BASE_CONSUMPTION', entry);
    if (!isRenderer(path)) {
      if (rawColor.test(value) && !RUNTIME_COLORS.has(key)) add('ARCH_DESIGN_RAW_COLOR', entry);
      if (
        (/^(?:border-radius|border-(?:top|bottom)-(?:left|right)-radius|box-shadow|text-shadow|font-family)$/.test(
          key,
        ) ||
          /^(?:borderRadius|boxShadow|textShadow|fontFamily)$/.test(key)) &&
        !value.includes('var(--mizar-') &&
        !['0', 'none', 'inherit', '50%'].includes(value)
      )
        add('ARCH_DESIGN_RECIPE', entry);
    }
  };
  if (path.endsWith('.css')) {
    const tree = postcss.parse(source, { from: path });
    tree.walkDecls((decl) =>
      checkValue(decl.prop, decl.value, decl.parent.selector ?? decl.parent.name ?? ':root'),
    );
  } else if (/\.[cm]?[jt]sx?$/.test(path)) {
    const tree = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    function visit(node) {
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const key = ts.isPropertyAssignment(node.parent)
          ? node.parent.name.getText(tree).replace(/^['"]|['"]$/g, '')
          : 'literal';
        checkValue(key, node.text, 'source');
      }
      if (
        ts.isNumericLiteral(node) &&
        ts.isPropertyAssignment(node.parent) &&
        /^(?:borderRadius|boxShadow|textShadow|fontFamily)$/.test(node.parent.name.getText(tree)) &&
        !isRenderer(path) &&
        node.text !== '0'
      ) {
        add('ARCH_DESIGN_RECIPE', `source | ${node.parent.name.getText(tree)}: ${node.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  return findings;
}

export function checkDesign(repository, records, report) {
  let canonical = loadTokens().tokens;
  if (repository.has('packages/design-tokens/src/base.tokens.json')) {
    try {
      const result = compileTokens(
        Object.fromEntries(
          TOKEN_FILES.map((file) => [
            file,
            parseTokenJson(
              repository.read(`packages/design-tokens/src/${file}.tokens.json`) ?? '',
              file,
            ),
          ]),
        ),
      );
      canonical = result.tokens;
      if (repository.read('packages/design-tokens/generated/tokens.css') !== result.css)
        throw new Error('Generated CSS drift; run pnpm design:tokens:generate');
    } catch (error) {
      report({
        ruleId: 'ARCH_DESIGN_GENERATED',
        file: 'packages/design-tokens/generated/tokens.css',
        message: error.message,
      });
    }
  }
  const canonicalNames = new Set([...canonical.values()].map((token) => token.cssName));
  for (const [path, source] of repository.files) {
    if (!path.startsWith('apps/') || !/\.(?:css|[cm]?[jt]sx?)$/.test(path)) continue;
    const budget = new Map(Object.entries(baseline[path] ?? {}));
    for (const finding of visualFindings(path, source)) {
      const key = `${finding.ruleId} | ${finding.value}`;
      const remaining = budget.get(key) ?? 0;
      if (remaining > 0 && !isShared(path)) {
        budget.set(key, remaining - 1);
        continue;
      }
      report({
        ruleId: finding.ruleId,
        file: path,
        target: finding.value,
        message:
          'Use canonical semantic tokens/UI recipes; migrate existing declarations instead of creating a page-local theme.',
      });
    }
    if (path.endsWith('.css') && isShared(path)) {
      postcss.parse(source).walkAtRules('import', (rule) => {
        const specifier = rule.params.match(/(?:url\()?['"]([^'"]+)['"]/)?.[1] ?? rule.params;
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        const allowed =
          specifier === '@mizar/design-tokens/tokens.css' ||
          (specifier.startsWith('.') &&
            (target.startsWith('apps/web/src/ui/') ||
              (path.includes('/patterns/') && target.startsWith('apps/web/src/patterns/'))));
        if (!allowed)
          report({
            ruleId: 'ARCH_DESIGN_DEPENDENCY',
            file: path,
            target: specifier,
            message: 'Shared CSS must follow tokens → UI → patterns dependency direction.',
          });
      });
    }
    for (const name of source.match(/--mizar-[a-z0-9-]+/g) ?? []) {
      if (!canonicalNames.has(name) && !RUNTIME_COLORS.has(name))
        report({
          ruleId: 'ARCH_DESIGN_UNKNOWN_TOKEN',
          file: path,
          target: name,
          message: 'Unknown/removed canonical token or unapproved runtime presentation variable.',
        });
    }
  }
  for (const record of records.values()) {
    if (!isShared(record.path)) continue;
    const layer = record.path.includes('/ui/') ? 'ui' : 'patterns';
    for (const edge of record.allEdges) {
      const target = posix.normalize(posix.join(posix.dirname(record.path), edge.specifier));
      const allowedFixture =
        isCatalog(record.path) &&
        target === 'apps/web/src/program/fixtures/rivals-bp-records.generated.js';
      const allowedExternal =
        ['react', 'react-dom', '@mizar/design-tokens', '@mizar/design-tokens/tokens.css'].includes(
          edge.specifier,
        ) ||
        (isCatalog(record.path) &&
          (edge.specifier.startsWith('@storybook/') || edge.specifier.startsWith('storybook/')));
      const allowedLocal =
        edge.specifier.startsWith('.') &&
        (target.startsWith('apps/web/src/ui/') ||
          (layer === 'patterns' && target.startsWith('apps/web/src/patterns/')));
      if (!allowedFixture && !allowedExternal && !allowedLocal)
        report({
          ruleId: 'ARCH_DESIGN_DEPENDENCY',
          file: record.path,
          target: edge.specifier,
          message:
            'Primitives depend only on tokens/UI; patterns compose UI/patterns, never business truth.',
        });
    }
  }
}
