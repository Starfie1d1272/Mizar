const PAGE_STYLE = `
:root {
  color: var(--broadcast-shell-ink);
  background: var(--broadcast-shell-bg);
  font-family: var(--broadcast-shell-font-sans);
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; }
button { font: inherit; }
.qualification-shell {
  --ink: var(--broadcast-shell-ink);
  --muted: var(--broadcast-shell-muted);
  --faint: var(--broadcast-shell-faint);
  --panel: var(--broadcast-shell-panel);
  --panel-deep: #090b10;
  --line: var(--broadcast-shell-line);
  --lime: #34d399;
  --amber: #fbbf24;
  background: var(--broadcast-shell-bg);
  color: var(--ink);
  display: grid;
  gap: 24px;
  min-height: calc(100vh - var(--broadcast-shell-topbar-height));
  max-width: var(--broadcast-shell-max-width);
  width: 100%;
  margin: 0 auto;
  padding: 32px var(--broadcast-shell-page-gutter) 48px;
  align-content: start;
}
.qualification-header { display: grid; gap: 1.5rem; max-width: 58rem; }
.qualification-kicker {
  color: var(--lime);
  font-family: "SF Mono", "Cascadia Mono", ui-monospace, monospace;
  font-size: .7rem;
  letter-spacing: .14em;
  margin: 0;
  text-transform: uppercase;
}
.qualification-header h1 {
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(2.6rem, 8vw, 6.5rem);
  font-weight: 500;
  letter-spacing: -.075em;
  line-height: .88;
  margin: 0;
  max-width: 8ch;
}
.qualification-header p:last-child { color: var(--muted); line-height: 1.6; margin: 0; max-width: 42rem; }
.qualification-signal {
  align-items: center;
  border: 1px solid var(--line);
  display: flex;
  gap: .8rem;
  justify-content: space-between;
  max-width: 58rem;
  padding: .9rem 1rem;
}
.qualification-signal__dot { background: var(--amber); border-radius: 999px; height: .65rem; width: .65rem; }
.qualification-signal[data-tone="good"] .qualification-signal__dot { background: var(--lime); }
.qualification-signal__label { color: var(--muted); font-size: .95rem; }
.qualification-signal__state { color: var(--ink); font-family: "SF Mono", "Cascadia Mono", ui-monospace, monospace; font-size: .75rem; letter-spacing: .06em; text-transform: uppercase; }
.qualification-banner { background: #1e1b4b; border: 1px solid #4338ca; border-radius: 6px; padding: .8rem 1.2rem; color: #c7d2fe; font-size: .9rem; display: flex; align-items: center; gap: .8rem; }
.qualification-banner[hidden] { display: none !important; }
.qualification-flow { display: grid; gap: .8rem; grid-template-columns: repeat(4, minmax(0, 1fr)); max-width: var(--broadcast-shell-max-width); }
.qualification-step { background: var(--panel); border-top: 2px solid var(--line); display: grid; gap: .75rem; min-height: 10rem; padding: 1rem; }
.qualification-step[data-status="active"] { border-top-color: var(--broadcast-shell-accent); }
.qualification-step[data-status="complete"] { border-top-color: var(--lime); }
.qualification-step__index { color: var(--faint); font-family: "SF Mono", "Cascadia Mono", ui-monospace, monospace; font-size: .68rem; letter-spacing: .12em; }
.qualification-step h2 { font-size: 1.05rem; font-weight: 600; margin: 0; }
.qualification-step p { color: var(--muted); font-size: .9rem; line-height: 1.5; margin: 0; }
.qualification-step__status { align-self: end; color: var(--faint); font-family: "SF Mono", "Cascadia Mono", ui-monospace, monospace; font-size: .7rem; text-transform: uppercase; }
.qualification-host-scenarios { display: grid; gap: .8rem; grid-template-columns: repeat(2, minmax(0, 1fr)); max-width: var(--broadcast-shell-max-width); }
.qualification-host-card { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 1.2rem; display: grid; gap: .75rem; }
.qualification-host-card h3 { margin: 0; font-size: 1rem; }
.qualification-host-card p { margin: 0; color: var(--muted); font-size: .85rem; line-height: 1.4; }
.qualification-host-card__status { font-family: "SF Mono", monospace; font-size: .75rem; color: var(--faint); }
.qualification-host-card__actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.qualification-host-card label { display: flex; align-items: center; gap: .4rem; font-size: .85rem; color: var(--ink); cursor: pointer; }
.qualification-grid { display: grid; gap: .8rem; grid-template-columns: minmax(0, 1.15fr) minmax(18rem, .85fr); max-width: var(--broadcast-shell-max-width); }
.qualification-panel { background: var(--panel-deep); border: 1px solid var(--line); padding: clamp(1rem, 2vw, 1.5rem); }
.qualification-panel h2 { font-size: 1.05rem; margin: 0 0 1rem; }
.qualification-checks { display: grid; gap: .65rem; margin: 0; }
.qualification-check { align-items: center; border-bottom: 1px solid var(--line); display: grid; gap: .7rem; grid-template-columns: 1fr auto; padding: .7rem 0; }
.qualification-check:last-child { border-bottom: 0; }
.qualification-check dt { color: var(--muted); font-size: .9rem; }
.qualification-check dd { color: var(--faint); font-family: "SF Mono", "Cascadia Mono", ui-monospace, monospace; font-size: .7rem; margin: 0; text-transform: uppercase; }
.qualification-check[data-status="PASS"] dd { color: var(--lime); }
.qualification-check[data-status="FAIL"] dd { color: var(--amber); }
.qualification-actions { display: flex; flex-wrap: wrap; gap: .7rem; }
.qualification-actions button { background: transparent; border: 1px solid var(--line); color: var(--ink); cursor: pointer; min-height: 2.75rem; padding: .65rem 1rem; }
.qualification-actions button[data-primary="true"] { background: var(--lime); border-color: var(--lime); color: #142018; }
.qualification-actions button:disabled { cursor: not-allowed; opacity: .38; }
.qualification-actions button:focus-visible { outline: 3px solid var(--amber); outline-offset: 3px; }
.qualification-message { color: var(--muted); line-height: 1.55; margin: 1rem 0 0; min-height: 1.6em; }
.qualification-footer { color: var(--faint); font-family: "SF Mono", "Cascadia Mono", ui-monospace, monospace; font-size: .68rem; line-height: 1.6; max-width: var(--broadcast-shell-max-width); }
.qualification-host { display:grid; gap:.75rem; grid-template-columns:repeat(3,minmax(0,1fr)); max-width:var(--broadcast-shell-max-width); }
.qualification-host__card { background:var(--panel); border:1px solid var(--line); display:grid; gap:.45rem; padding:1rem; }
.qualification-host__card span { color:var(--muted); font-size:.82rem; }
.qualification-host__card strong { font-size:1rem; font-weight:600; }
.qualification-host__card small { color:var(--faint); font-size:.75rem; line-height:1.5; }
@media (max-width: 800px) {
  .qualification-flow, .qualification-grid, .qualification-host-scenarios { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 560px) {
  .qualification-flow, .qualification-grid, .qualification-host, .qualification-host-scenarios { grid-template-columns: 1fr; }
  .qualification-header h1 { font-size: clamp(2.8rem, 17vw, 5rem); }
}
.qualification-header { gap:12px; }
.qualification-header h1 { font-family:inherit; font-size:28px; letter-spacing:-.03em; line-height:1.3; max-width:none; }
.qualification-signal { max-width:78rem; }
.qualification-header p { font-size:14px; }
.qualification-step { min-height:9rem; border-radius:6px; }
.qualification-panel { border-radius:8px; }
.qualification-signal { border-radius:6px; background:var(--panel); }
.qualification-actions button { border-radius:5px; font-size:13px; }
.qualification-actions button[data-primary="true"] { background:var(--broadcast-shell-accent); border-color:var(--broadcast-shell-accent); color:#082f49; }
.qualification-actions button[data-primary="true"]:hover:not(:disabled) { background:var(--broadcast-shell-accent-hover); border-color:var(--broadcast-shell-accent-hover); }
@media (max-width: 1100px) { .qualification-shell { padding:24px 20px; } }
@media (max-width: 480px) { .qualification-shell { padding:20px 14px; } }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
`;

export function qualificationRequestOptions(
  controlToken: string,
  method: string,
  body?: unknown,
): { method: string; headers: Record<string, string>; body?: string } {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'x-qualification-token': controlToken,
  };
  if (body === undefined) return { method, headers };
  return {
    method,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const PAGE_SCRIPT = (
  controlToken: string,
  qualificationProfile: 'base' | 'objective-timing' | 'release',
): string => `
const controlToken = ${JSON.stringify(controlToken).replaceAll('<', '\\u003c')};
const qualificationProfile = ${JSON.stringify(qualificationProfile)};
const requestOptions = ${qualificationRequestOptions.toString()};
const stateLabels = {
  waiting: '等待 CS2',
  receiving: '正在接收比赛数据',
  stale: '比赛数据已过期',
  ready: '可以导出结果',
};
const checkLabels = {
  productionChain: '第一场数据已进入正式处理链路',
  realSilenceToStale: '数据过期与退出 CS2 已分别确认',
  explicitNextExecution: '下一场从新的地图执行开始',
  demoBRecovery: '第二场已恢复且无上一场残留',
  captureIntegrity: '采集记录完整且可验证',
  browserReload: '普通浏览器重载正常恢复',
  obsReload: 'OBS Browser Source 重载恢复',
  sceneVisibility: 'OBS 场景可见性切换正常',
  companionRestart: '制播服务受控重启正常恢复',
};
const flow = [
  { id: 'a', markers: ['demo-a-live'] },
  { id: 'stop', markers: ['runtime-stale', 'cs2-closed'] },
  { id: 'next', markers: ['next-execution'] },
  { id: 'b', markers: ['cs2-reopened', 'demo-b-live'] },
];
const byId = (id) => document.getElementById(id);
const stateText = byId('qualification-state');
const signal = document.querySelector('.qualification-signal');
const message = byId('qualification-message');
const result = byId('qualification-result');
const checks = byId('qualification-checks');
const hostStatus = byId('qualification-host-obs');
const hostVersion = byId('qualification-host-version');
const browserStatus = byId('qualification-host-browser');
const buttons = [...document.querySelectorAll('button[data-action]')];
let finalizationComplete = false;
let isRestarting = false;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

async function call(path, method = 'GET', body) {
  const response = await fetch(path, requestOptions(method, body));
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || '本地制播服务请求失败，请检查服务后重试');
  return data;
}

async function refreshHosts() {
  try {
    const response = await fetch('/debug/hosts', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('无法读取浏览器接入状态');
    const data = await response.json();
    if (!data || !data.active || !Number.isSafeInteger(data.active.obs) || !Number.isSafeInteger(data.active.browser)) {
      throw new Error('浏览器接入状态无法识别');
    }
    hostStatus.textContent = data.active.obs > 0 ? '已连接 ' + data.active.obs + ' 个通道' : '尚未连接';
    hostVersion.textContent = Array.isArray(data.active.obsVersions) && data.active.obsVersions.length > 0
      ? '识别版本 ' + data.active.obsVersions.join('、') + '；仍需确认实际画面'
      : '连接标识只作参考，请确认实际画面';
    browserStatus.textContent = data.active.browser > 0 ? '已连接 ' + data.active.browser + ' 个通道' : '尚未连接';
  } catch {
    hostStatus.textContent = '暂不可用';
    hostVersion.textContent = '无法读取本地通道状态';
    browserStatus.textContent = '暂不可用';
  }
}

function checkStatus(status) {
  return status === 'PASS' ? '已通过' : status === 'FAIL' ? '失败' : '待确认';
}

function resultLabel(value) {
  return value === 'PASS' ? '通过' : value === 'FAIL' ? '失败' : '证据不足';
}

function renderHostScenarios(hostCheckpoints = []) {
  if (qualificationProfile !== 'release') return;
  const scenarios = ['browser-reload', 'obs-reload', 'scene-visibility', 'companion-restart'];
  for (const s of scenarios) {
    const before = hostCheckpoints.find((c) => c.scenario === s && c.phase === 'before');
    const after = hostCheckpoints.find((c) => c.scenario === s && c.phase === 'after');
    const statusEl = byId('host-status-' + s);
    const beforeBtn = byId('host-before-' + s);
    const afterBtn = byId('host-after-' + s);
    const visibleBox = byId('host-visible-' + s);
    if (!statusEl) continue;

    if (after) {
      statusEl.textContent = '已完成（' + (after.programVisible ? '画面已确认' : '未确认画面') + '）';
      if (beforeBtn) beforeBtn.disabled = true;
      if (afterBtn) afterBtn.disabled = true;
      if (visibleBox) { visibleBox.checked = true; visibleBox.disabled = true; }
    } else if (before) {
      statusEl.textContent = '已记录操作前检查点，等待操作后目视确认';
      if (beforeBtn) beforeBtn.disabled = true;
      if (visibleBox) visibleBox.disabled = false;
      if (afterBtn) afterBtn.disabled = !visibleBox || !visibleBox.checked;
    } else {
      statusEl.textContent = '等待记录操作前检查点';
      if (beforeBtn) beforeBtn.disabled = false;
      if (visibleBox) { visibleBox.checked = false; visibleBox.disabled = true; }
      if (afterBtn) afterBtn.disabled = true;
    }
  }
}

function render(data) {
  if (finalizationComplete) return;
  const objectiveMode = qualificationProfile === 'objective-timing';
  const releaseMode = qualificationProfile === 'release';
  stateText.textContent = stateLabels[data.state] || '正在读取状态';
  signal.dataset.tone = data.state === 'receiving' || data.state === 'ready' ? 'good' : 'neutral';
  result.textContent = resultLabel(data.result);
  result.dataset.tone = data.result.toLowerCase();
  checks.innerHTML = objectiveMode
    ? [
        '<div class="qualification-check" data-status="' + (data.objectiveScenarioProgress?.complete ? 'PASS' : 'INCONCLUSIVE') + '"><dt>目标时钟场景窗口</dt><dd>' + escapeHtml(String(data.objectiveScenarioProgress?.completed ?? 0) + '/' + String(data.objectiveScenarioProgress?.required ?? 8)) + '</dd></div>',
        '<div class="qualification-check" data-status="' + escapeHtml(data.checks.captureIntegrity.status) + '"><dt>采集记录状态</dt><dd>' + escapeHtml(checkStatus(data.checks.captureIntegrity.status)) + '</dd></div>',
      ].join('')
    : Object.entries(data.checks).map(([key, check]) =>
        '<div class="qualification-check" data-status="' + escapeHtml(check.status) + '"><dt>' + escapeHtml(checkLabels[key] || check.label) + '</dt><dd>' + escapeHtml(checkStatus(check.status)) + '</dd></div>'
      ).join('');
  for (const step of flow) {
    const card = document.querySelector('[data-step="' + step.id + '"]');
    const completed = step.markers.every((marker) => data.markers.includes(marker));
    const active = !completed && step.markers.some((marker) => data.markers.includes(marker));
    card.dataset.status = completed ? 'complete' : active ? 'active' : 'pending';
    card.querySelector('[data-step-status]').textContent = completed ? '已完成' : active ? '进行中' : '等待操作';
  }
  const receiving = data.state === 'receiving';
  const baseActionIds = ['confirm-a', 'confirm-stop', 'next-execution', 'confirm-reopen', 'confirm-b'];
  for (const id of baseActionIds) byId(id).hidden = objectiveMode;
  document.querySelector('.qualification-flow').hidden = objectiveMode;
  byId('confirm-a').disabled = objectiveMode || !receiving || data.markers.includes('demo-a-live');
  byId('confirm-stop').disabled = objectiveMode || !data.markers.includes('demo-a-live') || data.markers.includes('cs2-closed');
  byId('next-execution').disabled = objectiveMode || data.result === 'FAIL' || !data.markers.includes('runtime-stale') || !data.markers.includes('cs2-closed') || data.markers.includes('next-execution');
  byId('confirm-reopen').disabled = objectiveMode || !data.markers.includes('next-execution') || data.markers.includes('cs2-reopened');
  byId('confirm-b').disabled = objectiveMode || !data.markers.includes('cs2-reopened') || !receiving || data.markers.includes('demo-b-live');

  renderHostScenarios(data.hostCheckpoints);

  const allHostPassed = releaseMode
    ? ['browser-reload', 'obs-reload', 'scene-visibility', 'companion-restart'].every((s) => {
        const after = data.hostCheckpoints?.find((c) => c.scenario === s && c.phase === 'after');
        return after && after.programVisible === true;
      })
    : true;

  byId('finish').disabled = data.result === 'FAIL' || (objectiveMode ? !data.objectiveScenarioProgress?.complete : !data.markers.includes('demo-b-live') || !allHostPassed);
  if (objectiveMode) {
    message.textContent = data.objectiveScenarioProgress?.complete
      ? '八类目标时钟场景窗口已记录；可结束测试并生成离线验收结论。'
      : '目标时钟专项验收进行中；使用 mark.ps1 为八类场景记录开始/结束窗口。';
  } else if (releaseMode && !allHostPassed && data.markers.includes('demo-b-live')) {
    message.textContent = '基础两场流程已完成；请继续完成下方全部 4 个 Host 生产场景检查点及目视确认。';
  }
}

async function refresh() {
  if (finalizationComplete) return;
  void refreshHosts();
  try {
    const data = await call('/qualification/status');
    if (isRestarting) {
      isRestarting = false;
      const banner = byId('restart-banner');
      if (banner) banner.hidden = true;
      message.textContent = '制播服务已受控重启并恢复连接，请目视确认画面正常后记录操作后检查点。';
    }
    render(data);
  } catch {
    if (isRestarting) {
      const banner = byId('restart-banner');
      if (banner) banner.hidden = false;
      stateText.textContent = '制播服务正在重启...';
      message.textContent = '制播服务正在受控重启，页面正在自动重试连接...';
      signal.dataset.tone = 'neutral';
    } else {
      stateText.textContent = '无法连接本地制播服务';
      message.textContent = '操作或连接未完成，请检查本地制播服务后重试。';
      signal.dataset.tone = 'neutral';
    }
  }
}

function renderFinalization(data) {
  finalizationComplete = true;
  stateText.textContent = '测试已完成';
  signal.dataset.tone =
    data.result === 'PASS' && data.verification === 'passed' && data.cleanup !== 'failed'
      ? 'good'
      : 'neutral';
  result.textContent = resultLabel(data.result);
  result.dataset.tone = String(data.result || 'INCONCLUSIVE').toLowerCase();
  buttons.forEach((button) => { button.disabled = true; });
  const reportPath = data.reportPath || 'evidence/<runId>/REPORT.md';
  const verification = data.verification === 'passed' ? '核心验收已验证' : '核心验收验证未通过';
  const cleanup = data.cleanup === 'failed'
    ? '环境恢复失败，请人工检查 GSI 配置'
    : data.cleanup === 'passed'
      ? '环境已恢复'
      : '环境恢复状态待确认';
  const diagnostics = data.verification === 'passed' || !data.diagnosticsPath
    ? ''
    : '诊断日志：' + data.diagnosticsPath;
  message.textContent = '核心验收：' + resultLabel(data.result) + ' · ' + verification + ' · ' + cleanup + ' · 报告：' + reportPath + (diagnostics ? ' · ' + diagnostics : '');
}

async function waitForFinalization() {
  const deadline = Date.now() + 60000;
  message.textContent = '正在整理采集记录并生成最终验收结果。';
  while (Date.now() < deadline) {
    try {
      const data = await call('/qualification/finalization');
      if (data.status === 'complete') {
        renderFinalization(data);
        void call('/qualification/finalization/ack', 'POST').catch(() => {});
        return;
      }
      message.textContent = '正在生成验收证据，请稍候。';
    } catch {}
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  message.textContent = '等待最终验收证据超时；请在验收包的 evidence 目录检查日志。';
}

async function act(path, method = 'POST', body) {
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const data = await call(path, method, body);
    message.textContent = data.message || '操作已记录';
    if (data.status === 'stopping') {
      await waitForFinalization();
      return;
    }
    await refresh();
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : '操作或连接未完成，请检查本地制播服务后重试。';
    await refresh();
  }
}

byId('confirm-a').onclick = () => void act('/qualification/marker', 'POST', { kind: 'demo-a-live' });
byId('confirm-stop').onclick = () => void act('/qualification/stop');
byId('next-execution').onclick = () => void act('/qualification/next-map-execution');
byId('confirm-reopen').onclick = () => void act('/qualification/marker', 'POST', { kind: 'cs2-reopened' });
byId('confirm-b').onclick = () => void act('/qualification/marker', 'POST', { kind: 'demo-b-live' });
byId('finish').onclick = () => void act('/qualification/finish');

if (qualificationProfile === 'release') {
  const scenarios = ['browser-reload', 'obs-reload', 'scene-visibility'];
  for (const s of scenarios) {
    const bBtn = byId('host-before-' + s);
    const aBtn = byId('host-after-' + s);
    const vBox = byId('host-visible-' + s);
    if (bBtn) bBtn.onclick = () => void act('/qualification/host-checkpoint', 'POST', { scenario: s, phase: 'before' });
    if (vBox) vBox.onchange = () => { if (aBtn) aBtn.disabled = !vBox.checked; };
    if (aBtn) aBtn.onclick = () => void act('/qualification/host-checkpoint', 'POST', { scenario: s, phase: 'after', programVisible: true });
  }

  const restartBtn = byId('host-before-companion-restart');
  const restartAfterBtn = byId('host-after-companion-restart');
  const restartVBox = byId('host-visible-companion-restart');
  if (restartBtn) {
    restartBtn.onclick = async () => {
      isRestarting = true;
      const banner = byId('restart-banner');
      if (banner) banner.hidden = false;
      await act('/qualification/restart-companion', 'POST');
    };
  }
  if (restartVBox) {
    restartVBox.onchange = () => {
      if (restartAfterBtn) restartAfterBtn.disabled = !restartVBox.checked;
    };
  }
  if (restartAfterBtn) {
    restartAfterBtn.onclick = () => void act('/qualification/host-checkpoint', 'POST', { scenario: 'companion-restart', phase: 'after', programVisible: true });
  }
}

void refresh();
window.setInterval(() => { if (!finalizationComplete) void refresh(); }, 1000);
`;

export function qualificationPageHtml(
  controlToken: string,
  qualificationProfile: 'base' | 'objective-timing' | 'release' = 'base',
): string {
  const objectiveMode = qualificationProfile === 'objective-timing';
  const releaseMode = qualificationProfile === 'release';
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <title>现场验收 · Mizar</title>
    <link rel="stylesheet" href="/product-shell.css" />
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <header class="product-topbar" aria-label="制作导航">
      <a class="product-brand" href="/operator"><img class="product-brand__mark" src="/brand/mizar-mark.svg" alt="" /><span>Mizar</span></a>
      <nav aria-label="制作导航"><a href="/operator">制作控制</a><a href="/operator/hud">HUD 编辑器</a><a href="/debug">运行诊断</a></nav>
      <div class="product-topbar__actions"><a href="/qualification" aria-current="page">现场验收</a><a class="product-output-link" href="/program" target="_blank" rel="noreferrer">打开播出画面 <span aria-hidden="true">↗</span></a></div>
    </header>
    <main class="qualification-shell">
      <section class="qualification-signal" aria-live="polite">
        <span class="qualification-signal__dot" aria-hidden="true"></span>
        <span class="qualification-signal__label">比赛数据</span>
        <strong class="qualification-signal__state" id="qualification-state">正在读取状态</strong>
      </section>

      ${releaseMode ? '<div id="restart-banner" class="qualification-banner" hidden><span class="qualification-signal__dot"></span><span>制播服务正在受控重启，页面正在自动重试连接...</span></div>' : ''}

      <header class="qualification-header">
        <p class="qualification-kicker">Mizar / 现场验收</p>
        <h1>现场验收</h1>
        <p>${objectiveMode ? '这个页面用于目标时钟专项验收：八类场景由 PowerShell 标记明确圈定，页面只显示采集状态与场景窗口进度；最终语义与数值结论由离线证据验证器计算。' : releaseMode ? '这个页面用于生产环境准入验收（Release Profile）：必须连续完成两场 Demo 流程，并通过普通浏览器重载、OBS Browser Source 重载、OBS 场景可见性切换与制播服务受控重启 4 类宿主生产场景及目视画面确认。' : '这个页面用于连续两场 Demo 的真实环境验收：确认第一场数据正常，退出 CS2 并等待比赛数据过期，再开始下一场，验证第二场从干净状态恢复。'}</p>
      </header>

      <section class="qualification-host" aria-label="浏览器接入状态">
        <article class="qualification-host__card"><span>OBS 浏览器源</span><strong id="qualification-host-obs">正在读取</strong><small id="qualification-host-version">连接标识只作参考，请确认实际画面</small></article>
        <article class="qualification-host__card"><span>普通浏览器</span><strong id="qualification-host-browser">正在读取</strong><small>按本地实时通道连接数统计</small></article>
        <article class="qualification-host__card"><span>现场确认</span><strong>仍需目视检查</strong><small>连接标识不能证明页面可见或播出画面正确</small></article>
      </section>

      <section class="qualification-flow" aria-label="现场验收流程">
        <article class="qualification-step" data-step="a"><span class="qualification-step__index">01 / 第一场</span><h2>播放 Demo A</h2><p>等页面显示正在接收比赛数据后，确认第一场正常。</p><span class="qualification-step__status" data-step-status>等待操作</span></article>
        <article class="qualification-step" data-step="stop"><span class="qualification-step__index">02 / 停止</span><h2>退出 CS2</h2><p>在 CS2 中执行 quit；页面会自动识别一段时间未收到新数据，随后由你确认已经退出 CS2。</p><span class="qualification-step__status" data-step-status>等待操作</span></article>
        <article class="qualification-step" data-step="next"><span class="qualification-step__index">03 / 下一场</span><h2>准备下一场</h2><p>点击一次，准备接收下一场比赛。</p><span class="qualification-step__status" data-step-status>等待操作</span></article>
        <article class="qualification-step" data-step="b"><span class="qualification-step__index">04 / 第二场</span><h2>播放 Demo B</h2><p>重新打开 CS2，确认第二场没有上一场残留。</p><span class="qualification-step__status" data-step-status>等待操作</span></article>
      </section>

      ${
        releaseMode
          ? `
      <section class="qualification-host-scenarios" aria-label="Host 生产场景验证">
        <article class="qualification-host-card" data-scenario="browser-reload">
          <h3>01 / 普通浏览器重载</h3>
          <p>在普通浏览器打开 /program 播出画面，记录操作前检查点，刷新浏览器，确认画面恢复后记录操作后检查点。</p>
          <div class="qualification-host-card__status" id="host-status-browser-reload">等待记录操作前检查点</div>
          <div class="qualification-host-card__actions">
            <button id="host-before-browser-reload">记录重载前</button>
            <label><input type="checkbox" id="host-visible-browser-reload" disabled /> 目视确认播出画面恢复</label>
            <button id="host-after-browser-reload" disabled>记录重载后</button>
          </div>
        </article>

        <article class="qualification-host-card" data-scenario="obs-reload">
          <h3>02 / OBS Browser Source 重载</h3>
          <p>在 OBS 中右键 Browser Source 选择“重新加载当前页面缓存”，确认画面恢复并记录检查点。</p>
          <div class="qualification-host-card__status" id="host-status-obs-reload">等待记录操作前检查点</div>
          <div class="qualification-host-card__actions">
            <button id="host-before-obs-reload">记录重载前</button>
            <label><input type="checkbox" id="host-visible-obs-reload" disabled /> 目视确认播出画面恢复</label>
            <button id="host-after-obs-reload" disabled>记录重载后</button>
          </div>
        </article>

        <article class="qualification-host-card" data-scenario="scene-visibility">
          <h3>03 / OBS 场景可见性切换</h3>
          <p>隐藏并重新显示 OBS Browser Source 场景，确认连接未断且渲染恢复。</p>
          <div class="qualification-host-card__status" id="host-status-scene-visibility">等待记录操作前检查点</div>
          <div class="qualification-host-card__actions">
            <button id="host-before-scene-visibility">记录切换前</button>
            <label><input type="checkbox" id="host-visible-scene-visibility" disabled /> 目视确认播出画面恢复</label>
            <button id="host-after-scene-visibility" disabled>记录切换后</button>
          </div>
        </article>

        <article class="qualification-host-card" data-scenario="companion-restart">
          <h3>04 / 制播服务受控重启</h3>
          <p>点击受控重启服务（退出码 75），Supervisor 自动重新拉起服务，OBS 源自动重连后目视确认画面恢复。</p>
          <div class="qualification-host-card__status" id="host-status-companion-restart">等待触发受控重启</div>
          <div class="qualification-host-card__actions">
            <button id="host-before-companion-restart">受控重启服务</button>
            <label><input type="checkbox" id="host-visible-companion-restart" disabled /> 目视确认播出画面恢复</label>
            <button id="host-after-companion-restart" disabled>记录重启后</button>
          </div>
        </article>
      </section>
      `
          : ''
      }

      <section class="qualification-grid">
        <article class="qualification-panel">
          <h2>现场操作</h2>
          <div class="qualification-actions">
            <button id="confirm-a" data-action="demo-a-live" data-primary="true">确认第一场数据正常</button>
            <button id="confirm-stop" data-action="cs2-closed">我已退出 CS2</button>
            <button id="next-execution" data-action="next-execution" data-primary="true">开始下一场</button>
            <button id="confirm-reopen" data-action="cs2-reopened">确认 CS2 已重新打开</button>
            <button id="confirm-b" data-action="demo-b-live" data-primary="true">确认第二场数据正常</button>
            <button id="finish" data-action="finish">结束测试并导出结果</button>
          </div>
          <p class="qualification-message" id="qualification-message" aria-live="polite">页面会自动记录验收所需信息并生成报告。</p>
        </article>
        <article class="qualification-panel">
          <h2>本次结果 <span id="qualification-result">证据不足</span></h2>
          <dl class="qualification-checks" id="qualification-checks"></dl>
        </article>
      </section>

      <footer class="qualification-footer">本地现场验收页面 · 验收证据与播出画面独立 · 机器结果保存在 evidence/REPORT.md 与 qualification.json</footer>
    </main>
    <script>${PAGE_SCRIPT(controlToken, qualificationProfile)}</script>
  </body>
</html>`;
}
