import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const desktopRoot = join(repositoryRoot, 'apps/desktop/src-tauri');

// 保留已有原生控制入口；当前 Web UI 通过 Companion 的 overlay policy 控制显示。
const commandsWithoutWebConsumer = ['set_program_overlay_enabled'];
const demoCommands = ['select_demo_file', 'start_demo_test', 'enter_demo_test', 'finish_demo_test'];

function webCommands(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const invokeNames = new Set();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const specifier of bindings.elements) {
      const imported = (specifier.propertyName ?? specifier.name).text;
      if (
        imported === 'desktopInvoke' ||
        (statement.moduleSpecifier.text === '@tauri-apps/api/core' && imported === 'invoke')
      )
        invokeNames.add(specifier.name.text);
    }
  }
  const commands = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      invokeNames.has(node.expression.text)
    ) {
      const command = node.arguments[0];
      expect(
        command !== undefined && ts.isStringLiteralLike(command),
        `${path}: Desktop command 必须为可审查的字面量`,
      ).toBe(true);
      commands.push(command.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return commands;
}

describe('Desktop capability contract', () => {
  it('keeps build registration, handlers, frontend calls and scoped grants in sync', async () => {
    const [build, main, config, capability, demoCapability] = await Promise.all([
      readFile(join(desktopRoot, 'build.rs'), 'utf8'),
      readFile(join(desktopRoot, 'src/main.rs'), 'utf8'),
      readFile(join(desktopRoot, 'tauri.conf.json'), 'utf8').then(JSON.parse),
      readFile(join(desktopRoot, 'capabilities/workspace.json'), 'utf8').then(JSON.parse),
      readFile(join(desktopRoot, 'capabilities/demo-test.json'), 'utf8').then(JSON.parse),
    ]);
    const manifest = build.match(/AppManifest::new\(\)\s*\.commands\(\s*&\s*\[([^\]]*)\]/);
    expect(manifest, '必须读取 production AppManifest commands').not.toBeNull();
    const registered = Array.from(
      manifest[1].matchAll(/"([a-z][a-z0-9_]*)"/g),
      (match) => match[1],
    );
    const handler = main.match(/tauri::generate_handler!\s*\[([^\]]*)\]/);
    expect(handler, '必须读取 production invoke handler').not.toBeNull();
    const handled = handler[1]
      .split(',')
      .map((command) => command.trim())
      .filter(Boolean);
    expect(registered.length).toBeGreaterThan(0);
    expect(new Set(registered).size).toBe(registered.length);
    expect(handled.toSorted()).toEqual(registered.toSorted());

    const webRoot = join(repositoryRoot, 'apps/web/src');
    const paths = (await readdir(webRoot, { recursive: true })).filter(
      (path) => /\.(ts|tsx)$/.test(path) && !/\.(test|stories)\./.test(path),
    );
    const invoked = new Set(
      (
        await Promise.all(
          paths.map(async (path) => webCommands(path, await readFile(join(webRoot, path), 'utf8'))),
        )
      ).flat(),
    );
    expect([...invoked].toSorted()).toEqual(
      registered.filter((command) => !commandsWithoutWebConsumer.includes(command)).toSorted(),
    );

    expect(config.app.security.capabilities).toEqual(['workspace', 'demo-test']);
    expect(demoCapability.identifier).toBe('demo-test');
    expect(demoCapability.remote.urls).toEqual(['http://127.0.0.1:3000/*']);
    expect(demoCapability.windows).toEqual(['main']);
    expect(demoCapability.permissions.toSorted()).toEqual(
      demoCommands.map((command) => `allow-${command.replaceAll('_', '-')}`).toSorted(),
    );
    expect(capability.identifier).toBe('workspace');
    expect(capability.remote.urls).toEqual(['http://127.0.0.1:3000/*']);
    expect(capability.windows.toSorted()).toEqual(
      [
        'main',
        'workspace-left',
        'workspace-dock',
        'program-overlay',
        'tool-hud',
        'tool-bp',
        'tool-diagnostics',
        'tool-preview',
      ].toSorted(),
    );
    expect(capability.permissions.toSorted()).toEqual(
      registered
        .filter((command) => !demoCommands.includes(command))
        .map((command) => `allow-${command.replaceAll('_', '-')}`)
        .toSorted(),
    );
  });

  it('reads generic and aliased invoke calls while ignoring comments and strings', () => {
    expect(
      webCommands(
        'commands.tsx',
        `import { desktopInvoke as invoke } from './client';
         // invoke('comment_only');
         const example = "invoke('string_only')";
         invoke<{ found: boolean }>('cs2_host_status');
         invoke('open_rivalhub_authorization', { url: 'https://example.invalid' });`,
      ),
    ).toEqual(['cs2_host_status', 'open_rivalhub_authorization']);
  });
});
