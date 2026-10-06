import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseTree } from 'jsonc-parser';

export const RUNTIME_COLORS = new Set([
  '--mizar-event-accent',
  '--mizar-entrant-a',
  '--mizar-entrant-b',
  '--mizar-side-ct',
  '--mizar-side-t',
  // Strict HudResolvedPreset semantic values; local Gameplay subtree only.
  '--mizar-hud-text-primary',
  '--mizar-hud-text-muted',
  '--mizar-hud-state-danger',
  '--mizar-hud-state-warning',
  '--mizar-hud-state-success',
  '--mizar-hud-state-unknown',
  '--mizar-hud-objective-bomb',
  '--mizar-hud-objective-defuse',
  '--mizar-hud-surface-primary',
  '--mizar-hud-surface-strong',
  '--mizar-hud-surface-opacity',
  '--mizar-hud-border-opacity',
  '--mizar-hud-radius-sm',
  '--mizar-hud-radius-md',
  '--mizar-hud-radius-lg',
  '--mizar-hud-font-family',
]);

export const TOKEN_FILES = ['base', 'semantic', 'product', 'broadcast', 'technical'];
const types = new Set([
  'color',
  'dimension',
  'duration',
  'fontFamily',
  'fontWeight',
  'number',
  'cubicBezier',
]);
const aliasPattern = /^\{([^{}]+)\}$/;
const surfaceNames = new Set(['product', 'broadcast', 'technical']);
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const packageRoot = resolve(import.meta.dirname, '..');

export function parseTokenJson(source, file) {
  const errors = [];
  const tree = parseTree(source, errors, { allowTrailingComma: false, disallowComments: true });
  if (errors.length || !tree) throw new Error(`${file}: invalid JSON`);
  function visit(node) {
    if (node.type === 'object') {
      const names = new Set();
      for (const property of node.children ?? []) {
        const name = property.children[0].value;
        if (names.has(name)) throw new Error(`${file}: duplicate name ${name}`);
        names.add(name);
      }
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  return JSON.parse(source);
}

function validateValue(type, value, name) {
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  let valid = false;
  if (type === 'color')
    valid =
      value?.colorSpace === 'srgb' &&
      Array.isArray(value.components) &&
      value.components.length === 3 &&
      value.components.every((n) => finite(n) && n >= 0 && n <= 1) &&
      finite(value.alpha) &&
      value.alpha >= 0 &&
      value.alpha <= 1;
  if (type === 'dimension' || type === 'duration')
    valid =
      finite(value?.value) &&
      value.value >= 0 &&
      (type === 'dimension' ? ['px', 'rem'] : ['ms', 's']).includes(value?.unit);
  if (type === 'fontFamily')
    valid =
      (typeof value === 'string' && value.length > 0) ||
      (Array.isArray(value) &&
        value.length > 0 &&
        value.every((v) => typeof v === 'string' && v.length > 0));
  if (type === 'fontWeight') valid = finite(value) && value >= 1 && value <= 1000;
  if (type === 'number') valid = finite(value);
  if (type === 'cubicBezier')
    valid =
      Array.isArray(value) &&
      value.length === 4 &&
      value.every(finite) &&
      value[0] >= 0 &&
      value[0] <= 1 &&
      value[2] >= 0 &&
      value[2] <= 1;
  if (!valid) throw new Error(`${name}: invalid ${type} value`);
}

export function compileTokens(documents) {
  const tokens = new Map();
  const cssNames = new Set();
  function walk(group, path, layer, inheritedType) {
    if (!group || typeof group !== 'object' || Array.isArray(group))
      throw new Error(`${path}: invalid group/token`);
    const type = group.$type ?? inheritedType;
    if (type !== undefined && !types.has(type))
      throw new Error(`${path}: unsupported type ${type}`);
    for (const key of Object.keys(group).filter((key) => key.startsWith('$'))) {
      if (!['$type', '$value', '$description', '$extensions', '$deprecated'].includes(key))
        throw new Error(`${path}: unsupported schema property ${key}`);
    }
    if (group.$description !== undefined && typeof group.$description !== 'string')
      throw new Error(`${path}: invalid description`);
    if (
      group.$extensions !== undefined &&
      (!group.$extensions ||
        typeof group.$extensions !== 'object' ||
        Array.isArray(group.$extensions))
    )
      throw new Error(`${path}: invalid extensions`);
    if (
      group.$deprecated !== undefined &&
      typeof group.$deprecated !== 'boolean' &&
      typeof group.$deprecated !== 'string'
    )
      throw new Error(`${path}: invalid deprecated metadata`);
    if (Object.hasOwn(group, '$value')) {
      if (!path || !type || Object.keys(group).some((key) => !key.startsWith('$')))
        throw new Error(`${path}: invalid token schema`);
      const cssName = `--mizar-${path.replaceAll('.', '-')}`;
      if (tokens.has(path) || cssNames.has(cssName))
        throw new Error(`${path}: duplicate token/CSS name`);
      if (layer !== 'base' && !aliasPattern.test(group.$value))
        throw new Error(`${path}: ${layer} must alias its foundation`);
      tokens.set(path, { type, value: group.$value, layer, cssName });
      cssNames.add(cssName);
      return;
    }
    for (const [key, child] of Object.entries(group)) {
      if (key.startsWith('$')) continue;
      if (!namePattern.test(key)) throw new Error(`${path}: invalid name ${key}`);
      if (path === '' && surfaceNames.has(layer) && key !== layer)
        throw new Error(`${layer}: wrong surface root`);
      walk(child, path ? `${path}.${key}` : key, layer, type);
    }
  }
  for (const [layer, document] of Object.entries(documents)) {
    if (!TOKEN_FILES.includes(layer)) throw new Error(`Unknown layer ${layer}`);
    walk(document, '', layer);
  }
  const resolved = new Map();
  function resolveToken(name, stack = []) {
    if (stack.includes(name)) throw new Error(`Alias cycle: ${[...stack, name].join(' -> ')}`);
    if (resolved.has(name)) return resolved.get(name);
    const token = tokens.get(name);
    if (!token) throw new Error(`Removed or unknown token: ${name}`);
    const match = typeof token.value === 'string' && token.value.match(aliasPattern);
    let value = token.value;
    if (match) {
      const target = tokens.get(match[1]);
      if (!target) throw new Error(`${name}: unknown alias ${match[1]}`);
      if (target.type !== token.type) throw new Error(`${name}: alias type mismatch`);
      const allowedLayer =
        token.layer === 'base' ? 'base' : token.layer === 'semantic' ? 'base' : 'semantic';
      // Same-layer aliases are allowed; cycles still fail above. Surfaces cannot bypass semantics.
      if (target.layer !== allowedLayer && target.layer !== token.layer)
        throw new Error(`${name}: invalid layer dependency ${target.layer}`);
      value = resolveToken(match[1], [...stack, name]);
    }
    validateValue(token.type, value, name);
    resolved.set(name, value);
    return value;
  }
  for (const name of tokens.keys()) resolveToken(name);
  const lines = [...tokens]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, token]) => {
      const match = typeof token.value === 'string' && token.value.match(aliasPattern);
      const value = match
        ? `var(${tokens.get(match[1]).cssName})`
        : cssValue(token.type, resolved.get(name));
      const declaration = `  ${token.cssName}: ${value};`;
      // Match the repository's 100-column formatting for explicit font stacks.
      return token.type === 'fontFamily' && declaration.length > 100
        ? `  ${token.cssName}:\n    ${value};`
        : declaration;
    });
  return {
    tokens,
    css: `/* Generated from src/*.tokens.json. Do not edit. */\n:root {\n${lines.join('\n')}\n}\n`,
  };
}

function cssValue(type, value) {
  if (type === 'color')
    return `rgb(${value.components.map((c) => +(c * 255).toFixed(3)).join(' ')} / ${value.alpha})`;
  if (type === 'dimension' || type === 'duration') return `${value.value}${value.unit}`;
  if (type === 'fontFamily')
    return (Array.isArray(value) ? value : [value])
      .map((v) =>
        /^(sans-serif|monospace|serif)$/.test(v)
          ? v
          : `'${v.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`,
      )
      .join(', ');
  if (type === 'cubicBezier') return `cubic-bezier(${value.join(', ')})`;
  return String(value);
}

export function loadTokens(root = packageRoot) {
  return compileTokens(
    Object.fromEntries(
      TOKEN_FILES.map((file) => [
        file,
        parseTokenJson(readFileSync(resolve(root, 'src', `${file}.tokens.json`), 'utf8'), file),
      ]),
    ),
  );
}

export function verifyGenerated(root = packageRoot) {
  const result = loadTokens(root);
  if (readFileSync(resolve(root, 'generated/tokens.css'), 'utf8') !== result.css)
    throw new Error('Generated CSS drift; run pnpm design:tokens:generate');
  return result;
}

export function verifySourceReferences(tokens, root = resolve(packageRoot, '../..')) {
  const names = new Set([...tokens.values()].map((token) => token.cssName));
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(?:css|[cm]?[jt]sx?|html)$/.test(entry.name)) continue;
      for (const name of readFileSync(path, 'utf8').match(/--mizar-[a-z0-9-]+/g) ?? []) {
        if (!names.has(name) && !RUNTIME_COLORS.has(name))
          throw new Error(`${path}: removed/unknown token ${name}`);
      }
    }
  }
  for (const workspaceRoot of ['apps', 'packages']) {
    for (const entry of readdirSync(resolve(root, workspaceRoot), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'design-tokens') continue;
      const src = resolve(root, workspaceRoot, entry.name, 'src');
      try {
        readdirSync(src);
      } catch {
        continue;
      }
      walk(src);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = process.argv.includes('--write') ? loadTokens() : verifyGenerated();
  verifySourceReferences(result.tokens);
  if (process.argv.includes('--write'))
    writeFileSync(resolve(packageRoot, 'generated/tokens.css'), result.css);
  if (process.argv.includes('--build')) {
    mkdirSync(resolve(packageRoot, 'dist'), { recursive: true });
    writeFileSync(resolve(packageRoot, 'dist/tokens.css'), result.css);
  }
  console.log(`Design tokens: ${result.tokens.size} validated; CSS synchronized.`);
}
