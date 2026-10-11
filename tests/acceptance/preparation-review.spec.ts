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

test('OBS Program diagnostics distinguish packaging, capture evidence and an offline preparation', async ({
  page,
}, testInfo) => {
  let launches = 0;
  await page.addInitScript(() => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: (command: string) => {
          if (command === 'launch_obs') return Promise.resolve(false);
          return Promise.resolve({ busy: false, pending: false, running: false, message: null });
        },
      },
    });
  });
  let obs = {
    connection: 'unavailable',
    connectionFailure: 'refused',
    currentScene: null as string | null,
    expectedScene: 'Mizar · 比赛中',
    sceneAligned: null as boolean | null,
    port: 4455,
    streaming: false,
    recording: false,
    passwordConfigured: false,
    video: null,
    findings: [],
    programEvidence: null as Record<string, unknown> | null,
  };
  await page.route('**/local/v1/obs', (route) => route.fulfill({ json: obs }));
  await page.route('**/operator/obs/*', (route) => {
    if (route.request().url().endsWith('/launch-target')) launches++;
    return route.fulfill({
      json: { ok: true, findings: [], executablePath: 'C:\\OBS\\obs64.exe' },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('main')).toBeVisible();
  expect(launches).toBe(0);
  await expect(
    page.getByText('未找到 OBS，请在设置中选择 obs64.exe。', { exact: true }),
  ).toHaveCount(0);
  obs = {
    ...obs,
    connection: 'connected',
    currentScene: 'Mizar · 赛前等待',
    sceneAligned: false,
    programEvidence: {
      state: 'measured',
      collection: 'mizar',
      sceneId: 'waiting',
      composition: 'full_screen_graphic',
      sources: [{ role: 'browser', present: true, enabled: true }],
      capture: null,
    },
  };
  await page.goto('/settings?tab=obs');
  await expect.poll(() => launches).toBe(1);
  await expect(page.getByText(/当前节目为全屏包装，不使用游戏采集/)).not.toBeVisible();
  await expect(page.getByText(/请在工作台重新点击要播出的场景/)).toBeVisible();
  const details = page.getByText('节目与捕获诊断', { exact: true });
  await details.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/当前节目为全屏包装，不使用游戏采集/)).toBeVisible();
  await expect(page.getByText('播出网页 · 已添加 是 · 已启用 是', { exact: true })).toBeVisible();
  obs = {
    ...obs,
    currentScene: 'Mizar · 比赛中',
    sceneAligned: true,
    programEvidence: {
      state: 'measured',
      collection: 'mizar',
      sceneId: 'gameplay',
      composition: 'gameplay_overlay',
      sources: [
        { role: 'capture', present: true, enabled: false },
        { role: 'browser', present: true, enabled: true },
      ],
      capture: {
        kind: 'game_capture',
        mode: 'window',
        target: 'cs2.exe',
        targetAvailable: false,
        cs2WindowCount: 0,
        videoActive: false,
        videoShowing: true,
        width: 0,
        height: 0,
      },
    },
  };
  await expect(page.getByText(/状态用于定位来源/)).toBeVisible();
  await expect(page.getByText(/捕获类型 · 游戏捕获/)).toBeVisible();
  await expect(page.getByText(/目标可选 · 否/)).toBeVisible();
  await expect(page.getByText(/来源尺寸 · 0 × 0/)).toBeVisible();
  await page.setViewportSize({ width: 1366, height: 768 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('obs-program-diagnostics.png'),
    fullPage: true,
  });
  await details.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/捕获类型 · 游戏捕获/)).not.toBeVisible();
  await expect(page.getByText(/Mizar 选择 ·/)).not.toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('obs-capture-collapsed.png'), fullPage: true });
});

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
  }, testInfo) => {
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
      if (source === 'online') {
        await page.route('**/local/v1/rivalhub-connection', (route) =>
          route.fulfill({
            json: {
              paired: true,
              activeMatchId: match.matchId,
              sourceReady: false,
              websiteUrl: `https://match.starfie1d.top/admin/m2-sample/matches/${match.matchId}`,
              lastRefreshAt: '2026-10-08T14:00:00Z',
            },
          }),
        );
        await page.route('**/operator/rivalhub/refresh', (route) =>
          route.fulfill({ json: { message: '比赛资料已同步，包括 BP、名单与解说信息。' } }),
        );
        await page.reload();
        const refresh = page.getByRole('button', { name: '刷新比赛资料与 BP', exact: true });
        await expect(refresh).toBeVisible();
        await refresh.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByText('比赛资料已同步，包括 BP、名单与解说信息。')).toBeVisible();
        await expect(page.getByRole('link', { name: '打开网站本场工作台' })).toHaveAttribute(
          'href',
          new RegExp(`/matches/${match.matchId}$`),
        );
        await expect(page.getByText('切换比赛', { exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('match-refresh.png'), fullPage: true });
      }
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

test('Preview changes never TAKE a scene and reopening restores its destination', async ({
  page,
  context,
}) => {
  const commands: string[] = [];
  await context.route('**/operator/program-scene', (route) => {
    commands.push(route.request().url());
    return route.fulfill({ json: {} });
  });
  await page.goto('/preview');
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
  await expect(page.getByText('正在等待 Steam 启动 CS2', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复配置备份' })).toBeDisabled();
  await page.getByRole('link', { name: '游戏设置', exact: true }).click();
  await expect(page.getByText('正在等待 Steam 启动 CS2', { exact: true })).toBeVisible();
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

test('configuration failure offers an explicit preserved launch and keeps its limits visible', async ({
  page,
}) => {
  await page.route('**/local/v1/demo-test', (route) =>
    route.fulfill({
      json: {
        active: false,
        phase: 'idle',
        requestId: null,
        teamAName: '',
        teamBName: '',
        dataReady: false,
      },
    }),
  );
  // Synthetic IPC fixture proves the user choice and command flow, not native CS2.
  await page.addInitScript(() => {
    const preserved = sessionStorage.getItem('fixture-preserved-launch') === 'yes';
    const state = {
      canPreserve: false,
      preserveSettings: preserved,
      pending: preserved,
      running: preserved,
      qualityPreset: 'very-high',
      frameRateLimit: 60,
      message: null as string | null,
    };
    const choices: unknown[] = [];
    Object.assign(window, {
      preservedLaunchChoices: choices,
      __TAURI_INTERNALS__: {
        invoke: async <T>(command: string, args?: Record<string, unknown>) => {
          await Promise.resolve();
          if (command === 'gsi_status') return { installed: true, conflict: false } as T;
          if (command === 'start_managed_cs2') {
            choices.push(args?.preserveSettings === true);
            if (args?.preserveSettings !== true) {
              state.canPreserve = true;
              state.message = 'cs2_video.txt / setting.defaultres：冲突重复，未修改配置。';
              throw new Error(state.message);
            }
            sessionStorage.setItem('fixture-preserved-launch', 'yes');
            state.canPreserve = false;
            state.preserveSettings = true;
            state.pending = true;
            state.running = true;
            state.message =
              '已保持原游戏设置；未应用自动画质、帧率和游戏窗口布局，本机 HUD 覆盖已停用。';
          }
          return (command === 'cs2_config_status' ? { ...state } : {}) as T;
        },
      },
    });
  });
  await page.route('**/local/v1/production', (route) =>
    route.fulfill({
      json: { mode: 'preparation', revision: 'preserved-1', canEnter: true },
    }),
  );
  await page.route('**/local/v1/obs', (route) =>
    route.fulfill({
      json: { connection: 'connected', findings: [] },
    }),
  );
  const actions: unknown[] = [];
  await page.route('**/operator/production', (route) => {
    actions.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });
  await page.goto('/');
  const preserve = page.getByRole('button', { name: '保持原游戏设置继续', exact: true });
  await expect(preserve).toHaveCount(0);
  await page.getByRole('button', { name: '启动游戏并打开工作台', exact: true }).click();
  await expect(preserve).toBeVisible();
  await expect(page.getByText('未应用游戏设置，原始配置已备份', { exact: true })).toBeVisible();
  await expect(page.getByText(/保持原设置继续时，不应用自动画质/)).toBeVisible();
  expect(actions).toEqual([]);
  await preserve.click();
  await expect(page.getByText('CS2 正在运行，已保持原游戏设置', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { preservedLaunchChoices: unknown[] }).preservedLaunchChoices,
    ),
  ).toEqual([false, true]);
  expect(actions).toEqual([{ action: 'enter', expectedRevision: 'preserved-1' }]);
  await expect(page.getByRole('button', { name: '退出本次 CS2', exact: true })).toBeVisible();
  await page.goto('/workspace/dock');
  await expect(page.getByText('关闭本次游戏，保留游戏设置', { exact: true })).toBeVisible();
  await expect(page.getByText('关闭游戏并恢复配置', { exact: true })).toHaveCount(0);
});

test('OBS preparation groups scene drift, repairs and rechecks while retaining manual video guidance', async ({
  page,
}, testInfo) => {
  let connected = true;
  let findings = [
    { code: 'video_settings', message: '画布与输出仍需设为 1920×1080 / 60fps。' },
    ...Array.from({ length: 8 }, (_, index) => ({
      code: 'transform_drift',
      message: `场景 ${index + 1} 的画面变换与目标尺寸不一致；保留自定义来源，仅恢复 Mizar 浏览器画面。`,
    })),
  ];
  const commands: string[] = [];
  await page.route('**/local/v1/obs', (route) =>
    route.fulfill({
      json: {
        connection: connected ? 'connected' : 'password_required',
        currentScene: 'Mizar · 等待',
        port: 4455,
        sceneAligned: true,
        streaming: false,
        recording: false,
        passwordConfigured: true,
        video: { canvas: '1280×720', output: '1280×720', fps: 30 },
        findings,
      },
    }),
  );
  await page.route('**/operator/obs/*', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)!;
    commands.push(action);
    if (action === 'repair')
      findings = findings.filter((finding) => finding.code === 'video_settings');
    await route.fulfill({ json: { ok: true, findings } });
  });
  await page.goto('/settings?tab=obs');
  const repair = page.getByRole('button', { name: '一键修复 Mizar 场景', exact: true });
  const pictureCheck = page.getByRole('region', { name: '检查画面', exact: true });
  const openObs = page.getByRole('button', { name: '打开 OBS', exact: true });
  await expect(repair).toBeVisible();
  await expect(openObs).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '打开 OBS', exact: true })).toHaveCount(0);
  await expect(page.getByText('场景 1 的画面变换', { exact: false })).not.toBeVisible();
  for (const width of [1920, 1366]) {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : 768 });
    await expect(repair).toBeInViewport();
    const content = await page.getByRole('main').evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: bounds.left + parseFloat(style.paddingLeft),
        width: bounds.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      };
    });
    const collapsed = (await pictureCheck.boundingBox())!;
    expect(Math.abs(collapsed.x - content.left)).toBeLessThan(1);
    expect(Math.abs(collapsed.width - content.width)).toBeLessThan(1);
    expect((await openObs.boundingBox())!.y + (await openObs.boundingBox())!.height).toBeLessThan(
      collapsed.y,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`obs-grouped-${width}.png`) });
    await page.getByText('技术详情 · 9 项', { exact: true }).click();
    await expect(page.getByText('场景 8 的画面变换', { exact: false })).toBeVisible();
    expect(Math.abs((await pictureCheck.boundingBox())!.width - content.width)).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`obs-details-${width}.png`) });
    await page.getByText('技术详情 · 9 项', { exact: true }).click();
  }
  await repair.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/请在 OBS「设置 → 视频」将画布和输出设为/)).toBeVisible();
  await expect(repair).toHaveCount(0);
  expect(commands.filter((action) => action !== 'ensure')).toEqual(['repair', 'check']);
  await page.screenshot({ path: testInfo.outputPath('obs-after-repair.png') });
  connected = false;
  await expect(page.getByText('需要密码', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '打开 OBS', exact: true })).toBeVisible();
  await expect(page.getByLabel('WebSocket 端口')).toBeVisible();
  await expect(page.getByLabel('WebSocket 密码')).toBeVisible();
  await expect(openObs).toHaveCount(1);
});

test('empty preparation provides existing match and the existing Demo workflow without creating state', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '选择已有比赛', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建本地比赛', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('match-entry-1920.png') });
  await page.getByRole('button', { name: '选择已有比赛', exact: true }).click();
  await expect(page).toHaveURL(/\/matches\?select=1$/);
  await expect(page.getByRole('heading', { name: '本地比赛', exact: true })).toBeVisible();
  await page.goto('/');
  await page.getByRole('button', { name: '创建 Demo 测试比赛', exact: true }).click();
  await expect(page).toHaveURL(/demoTest=1#demo-test$/);
  await expect(page.getByText('BO1 · 试播资料不入比赛库', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '启动 Demo 试播', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('demo-entry-1920.png') });
});

test('OBS scene repair stays disabled during output and conflicting collections require manual action', async ({
  page,
}) => {
  const commands: string[] = [];
  let finding = { code: 'scene_missing', message: 'Mizar 场景缺失。' };
  let streaming = true;
  await page.route('**/local/v1/obs', (route) =>
    route.fulfill({
      json: {
        connection: 'connected',
        currentScene: '用户场景',
        port: 4455,
        sceneAligned: false,
        streaming,
        recording: false,
        passwordConfigured: true,
        video: null,
        findings: [finding],
      },
    }),
  );
  await page.route('**/operator/obs/*', async (route) => {
    commands.push(new URL(route.request().url()).pathname.split('/').at(-1)!);
    await route.fulfill({ json: { ok: true, findings: [finding] } });
  });
  await page.goto('/settings?tab=obs');
  await expect(
    page.getByRole('button', { name: '一键修复 Mizar 场景', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText('OBS 正在输出。停止推流与录制后再处理配置。', { exact: true }),
  ).toBeVisible();
  expect(commands).toEqual([]);
  streaming = false;
  finding = { code: 'collection_inactive', message: '当前未使用 Mizar 场景集合。' };
  await expect(
    page.getByText('请在 OBS「场景集合」中选择 Mizar，再返回继续检查。', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /修复 Mizar 场景/ })).toHaveCount(0);
  finding = { code: 'source_kind_conflict', message: 'Mizar 来源名称冲突。' };
  await expect(
    page.getByText('Mizar 来源名称与自定义来源冲突，请先在 OBS 重命名冲突来源。', { exact: true }),
  ).toBeVisible();
  expect(commands.every((action) => action === 'ensure')).toBe(true);
});

test('desktop GSI reads distinguish pending and failed queries, preserve independent CS2 results and recheck after navigation', async ({
  page,
}, testInfo) => {
  await page.route('**/operator/obs/*', (route) =>
    route.fulfill({ json: { ok: true, findings: [], executablePath: 'C:\\OBS\\obs64.exe' } }),
  );
  await page.route('**/local/v1/obs', (route) =>
    route.fulfill({
      json: {
        connection: 'connected',
        currentScene: 'Mizar · 等待',
        port: 4455,
        streaming: false,
        recording: false,
        passwordConfigured: true,
        sceneAligned: true,
        video: null,
        findings: [],
      },
    }),
  );
  await page.addInitScript(() => {
    const configured = {
      detected: true,
      installed: true,
      conflict: false,
      readFailed: false,
      issues: [],
      cfgPath: null,
      conflictFiles: [],
      candidateCount: 1,
    };
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: (command: string) => {
          const mode = sessionStorage.getItem('gsi-read-mode') ?? 'pending';
          if (command === 'launch_obs') return Promise.resolve(true);
          if (command === 'ensure_gsi') return new Promise(() => {});
          if (command === 'gsi_status') {
            sessionStorage.setItem(
              'gsi-read-count',
              String(Number(sessionStorage.getItem('gsi-read-count') ?? 0) + 1),
            );
            if (mode === 'pending')
              return new Promise((resolve) =>
                Reflect.set(window, 'resolveGsiRead', () => resolve(configured)),
              );
            if (mode === 'failed')
              return Promise.reject(
                new Error('CS2 与 GSI 检测失败（等待工具）。private/token=secret'),
              );
            return Promise.resolve({
              ...configured,
              installed: mode !== 'missing',
              conflict: mode === 'conflict',
            });
          }
          if (command === 'cs2_host_status')
            return mode === 'pending'
              ? Promise.reject(new Error('C:\\Users\\private\\desktop.log password=secret'))
              : Promise.resolve({ found: true, managed: true });
          if (command === 'cs2_config_status')
            return Promise.resolve({
              qualityPreset: 'high',
              frameRateLimit: 60,
              running: false,
              pending: false,
              message: null,
            });
          return Promise.resolve(null);
        },
      },
    });
  });
  await page.goto('/settings?tab=gsi');
  await expect(page.getByText('正在检测 GSI', { exact: true })).toBeVisible();
  await expect(page.getByText('待安装 GSI', { exact: true })).toHaveCount(0);
  await expect(page.getByText('无法读取 CS2 窗口状态', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('gsi-checking-1920.png') });
  await page.evaluate(() => (Reflect.get(window, 'resolveGsiRead') as () => void)());
  await expect(page.getByText('GSI 文件已配置', { exact: true })).toBeVisible();
  await expect(page.getByText('无法读取 CS2 窗口状态', { exact: true })).toBeVisible();
  await expect(page.getByText(/password=secret/)).toHaveCount(0);
  await page.setViewportSize({ width: 1366, height: 768 });
  const retry = page.getByRole('button', { name: '重新检查 CS2 与 GSI', exact: true });
  await expect(retry).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('gsi-ready-cs2-failed-1366.png') });
  await page.evaluate(() => sessionStorage.setItem('gsi-read-mode', 'ready'));
  await retry.click();
  await expect(page.getByText('CS2 窗口已就绪', { exact: true })).toBeVisible();
  await expect(page.getByText(/CS2 窗口读取失败/)).toHaveCount(0);
  const reads = await page.evaluate(() => Number(sessionStorage.getItem('gsi-read-count')));
  await page.evaluate(() => sessionStorage.setItem('gsi-read-mode', 'missing'));
  await page
    .locator('.product-sidebar')
    .getByRole('link', { name: 'OBS 连接', exact: true })
    .click();
  await page
    .locator('.product-sidebar')
    .getByRole('link', { name: '游戏设置', exact: true })
    .click();
  await expect(page.getByText('待安装 GSI', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => Number(sessionStorage.getItem('gsi-read-count'))),
  ).toBeGreaterThan(reads);
  await page.evaluate(() => sessionStorage.setItem('gsi-read-mode', 'conflict'));
  await retry.click();
  await expect(page.getByText('需检查', { exact: true })).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem('gsi-read-mode', 'failed'));
  await retry.click();
  await expect(page.getByText('无法检查 GSI', { exact: true })).toBeVisible();
  await expect(page.getByText('CS2 窗口已就绪', { exact: true })).toBeVisible();
  await expect(page.getByText(/检测工具失败（等待工具）/)).toBeVisible();
  await expect(page.getByText(/token=secret/)).toHaveCount(0);
  await expect(retry).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('gsi-failed-cs2-ready-1366.png') });
});
