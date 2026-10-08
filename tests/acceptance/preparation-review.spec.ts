import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateBroadcastManifest,
  toMatchContext,
  toMatchDocumentV1,
} from '../../packages/rivalhub/src/index.js';
import { buildApp } from '../../apps/companion/src/app.js';
import { expect, test } from './companion-isolation.js';

test('optional Steam avatars explain key acquisition and open the fixed official page on desktop', async ({
  page,
}) => {
  await page.route('**/local/v1/steam-avatars', (route) =>
    route.fulfill({ json: { configured: false, cached: 0, fetching: false } }),
  );
  await page.addInitScript(() => {
    const commands: string[] = [];
    Object.assign(window, {
      steamKeyCommands: commands,
      __TAURI_INTERNALS__: {
        invoke: <T>(command: string): Promise<T> => {
          commands.push(command);
          return Promise.resolve({
            detected: true,
            installed: true,
            conflict: false,
            qualityPreset: 'very-high',
            frameRateLimit: 60,
            pending: false,
            running: false,
            message: null,
          } as T);
        },
      },
    });
  });
  await page.goto('/settings?tab=gsi');
  await expect(page.getByRole('heading', { name: 'Steam 头像（可选）' })).toBeVisible();
  await expect(page.getByText(/域名（Domain Name）建议填写/)).toContainText('localhost');
  const link = page.getByRole('link', { name: '获取 Steam Web API Key（Steam 官方）' });
  await expect(link).toHaveAttribute('href', 'https://steamcommunity.com/dev/apikey');
  await link.click();
  expect(await page.evaluate(() => Reflect.get(window, 'steamKeyCommands') as string[])).toContain(
    'open_steam_api_key',
  );
  await expect(page).toHaveURL(/\/settings\?tab=gsi$/);
  await expect(page.getByRole('button', { name: '保存密钥', exact: true })).toBeDisabled();
});

test('GSI conflict guidance names files and keeps native installation selection available', async ({
  page,
}, testInfo) => {
  // This IPC fixture proves browser guidance, not native dialogs or actual Windows files.
  await page.addInitScript(() => {
    const commands: string[] = [];
    Object.assign(window, {
      installationCommands: commands,
      __TAURI_INTERNALS__: {
        invoke: <T>(command: string): Promise<T> => {
          commands.push(command);
          if (command === 'gsi_status')
            return Promise.resolve({
              detected: true,
              installed: false,
              conflict: true,
              fileConflict: true,
              endpointConflict: true,
              readFailed: false,
              candidateCount: 1,
              cfgPath:
                'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo\\cfg\\gamestate_integration_mizar.cfg',
              conflictFiles: [
                'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo\\cfg\\gamestate_integration_duplicate.cfg',
              ],
              issues: [
                {
                  code: 'gsi-file-changed',
                  message:
                    'Mizar GSI 文件与安装记录不一致。请先备份当前文件，再恢复原 GSI 配置并重新安装。',
                },
                {
                  code: 'endpoint-conflict',
                  message:
                    '其他 GSI 配置也向 Mizar 的接收地址发送数据。点击「一键安装 / 修复 GSI」自动备份并停用重复配置。',
                },
              ],
            } as T);
          if (command === 'select_cs2_installation') return Promise.resolve(true as T);
          if (command === 'cs2_config_status')
            return Promise.resolve({
              qualityPreset: 'high',
              frameRateLimit: 60,
              pending: false,
              running: false,
            } as T);
          return Promise.resolve({ found: false, managed: false } as T);
        },
      },
    });
  });
  await page.goto('/settings?tab=gsi');
  await expect(
    page.getByText(
      'Mizar GSI 文件与安装记录不一致。请先备份当前文件，再恢复原 GSI 配置并重新安装。',
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      '其他 GSI 配置也向 Mizar 的接收地址发送数据。点击「一键安装 / 修复 GSI」自动备份并停用重复配置。',
    ),
  ).toBeVisible();
  await expect(page.getByText(/gamestate_integration_duplicate.cfg/)).toBeVisible();
  await page.getByRole('button', { name: '打开配置文件夹', exact: true }).click();
  const selection = page.getByRole('button', { name: '选择 CS2 安装目录', exact: true });
  await selection.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText('已保存 CS2 安装位置，游戏启动与 GSI 安装共用此位置。请安装或检查 GSI。'),
  ).toBeVisible();
  const commands = await page.evaluate(
    () => Reflect.get(window, 'installationCommands') as string[],
  );
  expect(commands).toContain('select_cs2_installation');
  expect(commands).toContain('open_cs2_config_directory');
  expect(commands).not.toContain('configure_gsi');
  await page.screenshot({ path: testInfo.outputPath('gsi-conflict-guidance.png'), fullPage: true });
});

test('CS2 launch settings use desktop intents and expose pending recovery', async ({
  page,
  context,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-cs2-settings-'));
  const app = buildApp({
    matchManifestPath: join(directory, 'match.json'),
    localTournamentPath: join(directory, 'tournament.json'),
  });
  await app.ready();
  await context.route('**/local/v1/production', async (route) => {
    const response = await app.inject('/local/v1/production');
    await route.fulfill({
      status: response.statusCode,
      body: response.body,
      contentType: 'application/json',
    });
  });
  try {
    // IPC fixture verifies browser interaction only, not Steam, Windows or CS2.
    await page.addInitScript(() => {
      const status = {
        qualityPreset: localStorage.getItem('fixture-quality') ?? 'very-high',
        frameRateLimit: Number(localStorage.getItem('fixture-frames') ?? 60),
        pending: false,
        running: false,
        message: null,
      };
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          invoke: <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
            if (command === 'gsi_status')
              return Promise.resolve({ installed: true, conflict: false } as T);
            if (command === 'set_cs2_preferences') {
              status.qualityPreset = String(args?.qualityPreset);
              status.frameRateLimit = Number(args?.frameRateLimit);
              localStorage.setItem('fixture-quality', status.qualityPreset);
              localStorage.setItem('fixture-frames', String(status.frameRateLimit));
            }
            if (command === 'start_managed_cs2') {
              status.pending = true;
              status.running = true;
            }
            if (command === 'finish_managed_cs2' || command === 'restore_cs2_backup') {
              status.pending = false;
              status.running = false;
            }
            return Promise.resolve((command === 'cs2_config_status' ? { ...status } : {}) as T);
          },
        },
      });
    });
    await page.route('**/local/v1/obs', (route) =>
      route.fulfill({ json: { connection: 'connected', findings: [] } }),
    );
    await page.goto('/settings?tab=gsi');
    await expect(page.getByRole('heading', { name: 'CS2 启动设置' })).toBeVisible();
    const quality = page.getByRole('combobox', { name: '游戏画质', exact: true });
    const frames = page.getByRole('combobox', { name: '游戏帧率上限', exact: true });
    await expect(quality).toHaveValue('very-high');
    await expect(frames).toHaveValue('60');
    await quality.selectOption('high');
    await expect(quality).toHaveValue('high');
    await quality.selectOption('medium');
    await expect(
      page.getByText('中画质采用游戏原生预设，包含 FSR 缩放，画面清晰度会降低。'),
    ).toBeVisible();
    await quality.selectOption('preserve');
    await frames.selectOption('0');
    await expect(page.getByRole('alert')).toContainText('导致雷达或播出画面卡顿');
    await frames.selectOption('30');
    await expect(frames).toHaveValue('30');
    await frames.selectOption('60');
    await expect(page.getByRole('button', { name: '启动 CS2', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '保存启动设置', exact: true }).click();
    await expect(page.getByText('已保存，下次启动生效。', { exact: true })).toBeVisible();
    await page.reload();
    await expect(quality).toHaveValue('preserve');
    await expect(frames).toHaveValue('60');
    await expect(quality).toBeEnabled();
    await expect(page.getByRole('button', { name: '退出 CS2 并恢复设置' })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const source of ['online', 'cache'] as const) {
  test(`Preparation displays the complete ${source} MatchDocument read-only`, async ({
    page,
    context,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), 'mizar-readonly-ui-'));
    // Contract fixture exercises provider ownership; the logo is an explicit presentation test asset.
    const fixture = JSON.parse(
      await readFile('packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json', 'utf8'),
    ) as { entrants: { a: { logoUrl: string } } };
    fixture.entrants.a.logoUrl = 'https://assets.example.test/team-logo.svg';
    const validated = validateBroadcastManifest(fixture);
    if (!validated.ok) throw new Error('invalid fixture');
    const match = toMatchContext(validated.value);
    const app = buildApp({
      matchManifestPath: join(directory, 'match.json'),
      localTournamentPath: join(directory, 'tournament.json'),
      matchContextBinding: {
        manifest: validated.value,
        context: match,
        origin: source,
        freshness: source === 'cache' ? 'stale' : 'fresh',
        diagnostics: [],
      },
    });
    try {
      await app.ready();
      await context.route('https://assets.example.test/team-logo.svg', (route) =>
        route.fulfill({
          path: 'apps/web/public/brand/mizar-mark.svg',
          contentType: 'image/svg+xml',
        }),
      );
      const initial = await app.inject('/local/v1/match-document');
      expect(initial.statusCode, initial.body).toBe(200);
      await context.route(
        /\/local\/v1\/(?:match-document|tournament|production-guidance)$/,
        async (route) => {
          const response = await app.inject(new URL(route.request().url()).pathname);
          expect(response.statusCode, response.body).toBe(200);
          await route.fulfill({
            status: response.statusCode,
            body: response.body,
            contentType: 'application/json',
          });
        },
      );
      await page.goto('/matches');
      await expect(
        page.getByText(match.competition?.name ?? 'missing-event', { exact: true }),
      ).toBeVisible();
      await expect(page.getByText('计划开始', { exact: true })).toBeVisible();
      await expect(page.getByText('RivalHub 比赛资料', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '保存比赛资料' })).toHaveCount(0);
      if (source === 'online')
        await expect(page.getByRole('link', { name: '在网站管理' })).toHaveAttribute(
          'href',
          new RegExp(`/matches/${match.matchId}$`),
        );
      await page.getByRole('link', { name: '队伍与名单', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: match.entrants.a.name, exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('img', { name: `${match.entrants.a.name} 队标` })).toBeVisible();
      await expect(
        page.locator('.preparation-roster').getByText('星火一号', { exact: true }),
      ).toBeVisible();
      await expect(
        page.locator('.preparation-roster').getByText('星火替补', { exact: true }),
      ).toBeVisible();
      if (process.env.MIZAR_REVIEW_SCREENSHOTS === '1')
        await page.screenshot({ path: `.agent-tmp/review-${source}-roster.png`, fullPage: true });
      await page.getByText('Steam 身份', { exact: true }).first().click();
      await expect(page.getByText('76561198000000001', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '从当前服务器识别首发' })).toHaveCount(0);
      await page.getByRole('link', { name: '地图与 BP', exact: true }).click();
      await expect(page.getByRole('list', { name: 'BP 步骤' })).toContainText('DUST2');
      await expect(page.getByRole('list', { name: 'BP 步骤' })).toContainText('禁用');
      await expect(page.getByRole('article', { name: /ANCIENT/ })).toContainText('16 : 12');
      await expect(page.getByText('未填写', { exact: true })).toHaveCount(0);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('Tool surfaces retain their role and Preview changes never TAKE a scene', async ({
  page,
  context,
}) => {
  const commands: string[] = [];
  await context.route('**/operator/program-scene', (route) => {
    commands.push(route.request().url());
    return route.fulfill({ json: {} });
  });
  for (const path of ['/operator/hud?mode=fixture', '/operator/bp', '/debug', '/preview']) {
    await page.goto(path);
    await expect(page.locator('.mizar-tool-heading')).toBeVisible();
    await expect(page.getByRole('navigation', { name: '制作导航' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '总览', exact: true })).toHaveCount(0);
    for (const width of [1493, 1920, 390]) {
      await page.setViewportSize({ width, height: width === 1493 ? 992 : 1080 });
      const heading = await page.locator('.mizar-tool-heading').boundingBox();
      expect(heading!.x).toBeLessThan(80);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      if (width !== 390)
        await page.screenshot({
          path: `.agent-tmp/rc-fixes/tool-${path.split('?')[0]!.replaceAll('/', '-')}-${width}.png`,
        });
    }
  }
  await page.setViewportSize({ width: 1493, height: 992 });
  await page.getByRole('button', { name: '对阵', exact: true }).click();
  await expect(page.getByTitle('节目预览', { exact: true })).toHaveAttribute(
    'src',
    /\/program\/matchup\?preview=1(?:&|$)/,
  );
  await expect(page.frameLocator('iframe[title="节目预览"]').locator('.intro-body')).toBeVisible();
  expect(commands).toEqual([]);
  await page.goto('/picture');
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: '打开独立节目预览' }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/\/preview$/);
  await expect(popup.getByRole('navigation', { name: '制作导航' })).toHaveCount(0);
  // Named window recovery: even a previously drifted browser tool is restored when reopened.
  await popup.goto('/');
  await page.getByRole('button', { name: '打开独立节目预览' }).click();
  await expect(popup).toHaveURL(/\/preview$/);
  await expect(popup.locator('.mizar-tool-heading')).toBeVisible();
  await expect(popup.frameLocator('iframe').locator('.program-scene--waiting')).toBeVisible();
  if (process.env.MIZAR_REVIEW_SCREENSHOTS === '1')
    await popup.screenshot({ path: '.agent-tmp/review-preview.png' });
  await popup.close();
});

test('server quick create requires an explicit saved Team decision and sends only candidate proof plus choices', async ({
  page,
}) => {
  // Synthetic candidate exercises confirmation UI; production evidence validation is covered by Companion tests.
  const players = (offset: number) =>
    Array.from({ length: 5 }, (_, i) => ({
      steam64: `765611980000000${offset + i}`,
      displayName: `Observed ${offset + i}`,
    }));
  let generation = 1;
  await page.route('**/local/v1/roster-candidate', (route) =>
    route.fulfill({
      json: {
        local: false,
        candidate: {
          revision: `candidate-${generation}`,
          contextRevision: 'context-1',
          sourceGeneration: generation,
          mapEpoch: 2,
          ctName: 'Alpha',
          tName: 'Beta',
          ctEntrant: null,
          ct: players(10),
          t: players(20),
          teamOptions: {
            ct: [{ teamId: 'saved-alpha', name: 'Alpha' }],
            t: [{ teamId: 'saved-beta', name: 'Beta' }],
          },
        },
      },
    }),
  );
  let submitted: unknown;
  await page.route('**/operator/local-match/create-from-server', (route) => {
    submitted = route.request().postDataJSON() as unknown;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/matches?tab=roster&createFromServer=1');
  const capture = page.locator('.preparation-capture');
  const create = capture.getByRole('button', { name: '创建本地比赛', exact: true });
  await expect(create).toBeDisabled();
  await capture.getByLabel('CT 队伍资料', { exact: true }).selectOption('saved-alpha');
  await expect(create).toBeDisabled();
  await capture.getByLabel('T 队伍资料', { exact: true }).selectOption('new');
  await expect(create).toBeEnabled();
  generation = 2;
  await expect(capture.getByText('服务器名单已变化，请重新识别。', { exact: true })).toBeVisible();
  await expect(create).toBeDisabled();
  await capture.getByRole('button', { name: '从当前服务器创建比赛', exact: true }).click();
  await capture.getByLabel('CT 队伍资料', { exact: true }).selectOption('saved-alpha');
  await capture.getByLabel('T 队伍资料', { exact: true }).selectOption('new');
  await expect(create).toBeEnabled();
  await create.click();
  await expect
    .poll(() => submitted)
    .toEqual({
      candidateRevision: 'candidate-2',
      expectedContextRevision: 'context-1',
      expectedSourceGeneration: 2,
      expectedMapEpoch: 2,
      ctEntrant: '',
      teamA: '',
      teamB: '',
      format: 'bo3',
      teamAId: 'saved-alpha',
    });
});

test('Overview attention contains recovery actions rather than duplicating optional capability failures', async ({
  page,
}) => {
  const fixture: unknown = JSON.parse(
    await readFile('packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json', 'utf8'),
  );
  await page.route('**/local/v1/match-document', (route) =>
    route.fulfill({
      json: { document: toMatchDocumentV1(fixture), source: 'rivalhub', freshness: 'fresh' },
    }),
  );
  await page.route('**/local/v1/readiness', (route) =>
    route.fulfill({
      json: [
        {
          label: 'BP 画面',
          ready: false,
          reason: '等待 BP',
          href: '/matches?tab=maps',
          action: null,
        },
        {
          label: '比赛画面',
          ready: false,
          reason: '等待比赛数据',
          href: '/settings?tab=gsi',
          action: null,
        },
        {
          label: '对阵画面',
          ready: false,
          reason: '等待比赛资料',
          href: '/matches?tab=roster',
          action: null,
        },
        {
          label: 'OBS',
          ready: false,
          reason: '浏览器源地址需要修复',
          href: '/settings?tab=obs',
          action: '检查 OBS 连接与配置',
        },
      ],
    }),
  );
  await page.goto('/');
  const attention = page
    .locator('.mizar-panel')
    .filter({ has: page.getByRole('heading', { name: '开播检查', exact: true }) });
  const recovery = attention.locator('.preparation-readiness');
  await expect(recovery).toHaveCount(1);
  await expect(recovery).toHaveAccessibleName('检查 OBS 连接与配置');
  await expect(recovery).toContainText('配置');
  await expect(recovery).toHaveAttribute('href', '/settings?tab=obs');
  await expect(attention.locator('.preparation-pending summary')).toHaveText('待确认 · 3 项');
  await expect(page.locator('.preparation-readiness').filter({ hasText: 'OBS' })).toContainText(
    '浏览器源地址需要修复',
  );
});

test('uncertain Steam launch recovery stays visible after navigation and requires cancellation acknowledgement', async ({
  page,
}) => {
  // Explicit IPC boundary fixture: this proves recovery UX, not Windows process handling.
  await page.addInitScript(() => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async <T>(command: string, args?: Record<string, unknown>) => {
          await Promise.resolve();
          const restored = sessionStorage.getItem('test-cs2-restored') === 'yes';
          if (command === 'restore_cs2_backup') {
            if (args?.confirmSteamCancelled !== true) throw new Error('未确认取消 Steam 请求');
            sessionStorage.setItem('test-cs2-restored', 'yes');
          }
          return (
            command === 'cs2_config_status'
              ? {
                  pending: !restored,
                  running: false,
                  qualityPreset: 'preserve',
                  frameRateLimit: 60,
                  busy: false,
                  phase: restored ? 'idle' : 'uncertain',
                  message: restored ? '原设置已恢复。' : 'Steam 启动结果待确认，备份仍保留。',
                }
              : {}
          ) as T;
        },
      },
    });
  });
  await page.route('**/local/v1/production', (route) =>
    route.fulfill({ json: { mode: 'preparation', revision: 'recovery-1', canEnter: false } }),
  );
  await page.goto('/');
  await expect(page.getByText('CS2 原配置尚未恢复', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复配置备份' })).toBeDisabled();
  await page.getByRole('link', { name: '游戏设置', exact: true }).click();
  await expect(page.getByText('CS2 原配置尚未恢复', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '恢复配置备份' })).toBeDisabled();
  await page.getByRole('checkbox', { name: '已取消 Steam 启动请求，并确认 CS2 已关闭' }).check();
  await page.getByRole('button', { name: '恢复配置备份' }).click();
  await expect(page.getByRole('button', { name: '恢复配置备份' })).toHaveCount(0);
  await expect(page.getByText('原设置已恢复', { exact: true })).toBeVisible();
});

test('a starting operation reports progress while navigation remains usable', async ({ page }) => {
  await page.addInitScript(() =>
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: <T>(command: string) =>
          Promise.resolve(
            (command === 'cs2_config_status' ? { busy: true, phase: 'starting' } : {}) as T,
          ),
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByText('正在启动 CS2，等待 Steam…', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '游戏设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存启动设置', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: 'OBS 连接', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'OBS 连接与配置' })).toBeVisible();
});

test('configured Steam key uses a non-secret mask and updates only with new input', async ({
  page,
}) => {
  await page.route('**/local/v1/steam-avatars', (route) =>
    route.fulfill({ json: { configured: true, cached: 3, unavailable: false } }),
  );
  const writes: unknown[] = [];
  await page.route('**/operator/steam-avatars', (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/settings?tab=gsi');
  const key = page.getByLabel('Steam Web API Key（可选，推荐填写）');
  await expect(key).toHaveValue('');
  await expect(key).toHaveAttribute('placeholder', '••••••••••••');
  await expect(page.getByRole('button', { name: '更新密钥', exact: true })).toBeDisabled();
  await key.fill('A'.repeat(32));
  await page.getByRole('button', { name: '更新密钥', exact: true }).click();
  await expect(key).toHaveValue('');
  expect(writes).toEqual([{ action: 'configure', key: 'A'.repeat(32) }]);
  await page.setViewportSize({ width: 900, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(page.getByRole('button', { name: '更新密钥', exact: true })).toBeDisabled();
});

test('advanced settings show packaged version and commit separately', async ({ page }) => {
  await page.route('**/health', (route) =>
    route.fulfill({ json: { product: { appVersion: '1.0.0-rc.27', gitSha: 'a'.repeat(40) } } }),
  );
  await page.goto('/settings?tab=advanced');
  await expect(page.getByText('v1.0.0-rc.27', { exact: true })).toBeVisible();
  await expect(page.getByText('a'.repeat(12), { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '诊断与支持' })).toBeVisible();
});
