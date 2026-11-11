import { lazy, useEffect } from 'react';
import { programSceneForPath } from '@mizar/protocol/program-scenes';
import {
  LOCAL_TOOL_PATHS,
  PREPARATION_PATHS,
  PUBLIC_PROGRAM_PATHS,
} from '@mizar/protocol/local-pages';
import { OperatorShell } from './operator/OperatorShell';
import { ProgramVisualFixtureNotFound } from './program/testing/ProgramVisualFixtureNotFound';

const BpPage = lazy(() => import('./bp/BpPage').then(({ BpPage }) => ({ default: BpPage })));
const DebugPage = lazy(() =>
  import('./debug/DebugPage').then(({ DebugPage }) => ({ default: DebugPage })),
);
const HudConsolePage = lazy(() =>
  import('./operator/HudConsolePage').then(({ HudConsolePage }) => ({ default: HudConsolePage })),
);
const PreparationPage = lazy(() =>
  import('./preparation/PreparationPage').then(({ PreparationPage }) => ({
    default: PreparationPage,
  })),
);
const MatchConnectionDialog = lazy(() =>
  import('./preparation/MatchConnectionDialog').then(({ MatchConnectionDialog }) => ({
    default: MatchConnectionDialog,
  })),
);
const ProgramRoute = lazy(() =>
  import('./program/ProgramRoute').then(({ ProgramRoute }) => ({ default: ProgramRoute })),
);
const ProgramScenePage = lazy(() =>
  import('./program/ProgramScenePage').then(({ ProgramScenePage }) => ({
    default: ProgramScenePage,
  })),
);
const StatsInsertPage = lazy(() =>
  import('./program/StatsInsertPage').then(({ StatsInsertPage }) => ({ default: StatsInsertPage })),
);
const ProgramVisualFixturePage = lazy(() =>
  import('./program/testing/ProgramVisualFixturePage').then(({ ProgramVisualFixturePage }) => ({
    default: ProgramVisualFixturePage,
  })),
);
const RadarVisualFixturePage = lazy(() =>
  import('./program/testing/RadarVisualFixturePage').then(({ RadarVisualFixturePage }) => ({
    default: RadarVisualFixturePage,
  })),
);
const ResourceLibraryPage = lazy(() =>
  import('./resource-library/ResourceLibraryPage').then(({ ResourceLibraryPage }) => ({
    default: ResourceLibraryPage,
  })),
);
const GamePictureTool = lazy(() =>
  import('./workspace/GamePictureTool').then(({ GamePictureTool }) => ({
    default: GamePictureTool,
  })),
);
const WorkspacePreview = lazy(() =>
  import('./workspace/WorkspacePage').then(({ WorkspacePreview }) => ({
    default: WorkspacePreview,
  })),
);
const WorkspaceReview = lazy(() =>
  import('./workspace/WorkspacePage').then(({ WorkspaceReview }) => ({ default: WorkspaceReview })),
);
const WorkspaceLeft = lazy(() =>
  import('./workspace/WorkspacePage').then(({ WorkspaceLeft }) => ({ default: WorkspaceLeft })),
);
const WorkspaceDock = lazy(() =>
  import('./workspace/WorkspacePage').then(({ WorkspaceDock }) => ({ default: WorkspaceDock })),
);

export function App() {
  const pathname = window.location.pathname;
  if (pathname === LOCAL_TOOL_PATHS.packages) return <ResourceLibraryPage />;
  if (PREPARATION_PATHS.includes(pathname)) return <PreparationPage />;
  if (pathname === LOCAL_TOOL_PATHS.qualification)
    return (
      <OperatorShell active="/qualification">
        <main className="operator-shell">
          <header className="product-heading">
            <h1>现场验收</h1>
            <p>当前服务未开启现场验收模式。</p>
          </header>
          <section className="operator-panel">
            <h2>准备现场验收</h2>
            <p>
              请使用现场验收包的启动脚本运行验收服务，再访问此页面。验收需要真实 Windows、CS2 与 OBS
              环境。
            </p>
            <p>普通制作模式不会自动开启验收记录。</p>
            <a href="/">返回准备中心</a>
          </section>
        </main>
      </OperatorShell>
    );
  const radarRoute = /^\/__visual\/radar\/([^/]+)\/?$/.exec(pathname);
  if (radarRoute && import.meta.env.DEV && import.meta.env.VITE_VISUAL_FIXTURES === '1')
    return <RadarVisualFixturePage id={radarRoute[1]!} />;
  const visualRoute = /^\/__visual\/program\/([^/]+)\/?$/.exec(pathname);
  const isVisualPath =
    pathname === '/__visual/program' || pathname.startsWith('/__visual/program/');

  if (isVisualPath) {
    if (!import.meta.env.DEV || import.meta.env.VITE_VISUAL_FIXTURES !== '1') {
      return <ProgramVisualFixtureNotFound fixtureId={visualRoute?.[1] ?? null} />;
    }
    const fixtureId = visualRoute?.[1];
    return fixtureId === undefined ? (
      <ProgramVisualFixtureNotFound fixtureId={null} />
    ) : (
      <ProgramVisualFixturePage fixtureId={fixtureId} />
    );
  }

  if (pathname === PUBLIC_PROGRAM_PATHS.compactBp) return <BpPage compact />;
  if (pathname === LOCAL_TOOL_PATHS.workspace) return <WorkspacePreview />;
  if (pathname === LOCAL_TOOL_PATHS.workspaceGamePicture) return <GamePictureTool />;
  if (pathname === LOCAL_TOOL_PATHS.workspaceConnection) return <MatchConnectionDialog />;
  if (pathname === LOCAL_TOOL_PATHS.workspaceReview) return <WorkspaceReview />;
  if (pathname === LOCAL_TOOL_PATHS.workspaceLeft) return <WorkspaceLeft />;
  if (pathname === LOCAL_TOOL_PATHS.workspaceDock) return <WorkspaceDock />;
  if (pathname === PUBLIC_PROGRAM_PATHS.statistics) return <StatsInsertPage />;
  const programScene = programSceneForPath(pathname);
  if (programScene?.id === 'bp') return <BpPage />;
  if (programScene?.id === 'gameplay')
    return new URLSearchParams(window.location.search).get('preview') === '1' ? (
      <ProgramScenePage sceneId="gameplay" />
    ) : (
      <ProgramRoute />
    );
  if (programScene) return <ProgramScenePage sceneId={programScene.id} />;
  if (pathname === LOCAL_TOOL_PATHS.legacyBp) return <LegacyBpRedirect />;
  if (pathname === LOCAL_TOOL_PATHS.debug) return <DebugPage />;
  if (pathname === LOCAL_TOOL_PATHS.hud) return <HudConsolePage />;
  return (
    <OperatorShell active="">
      <main className="operator-shell">
        <header className="product-heading">
          <h1>页面不存在</h1>
          <p>404 · 请检查地址，或返回准备中心继续操作。</p>
        </header>
        <div className="dashboard-links">
          <a href="/">返回准备中心</a>
        </div>
      </main>
    </OperatorShell>
  );
}

function LegacyBpRedirect() {
  useEffect(() => {
    window.location.replace('/matches#match-bp');
  }, []);
  return <p>正在打开比赛资料…</p>;
}
