/** Product entry paths shared by the browser router and Companion HTTP host. */
export const PREPARATION_PATHS: readonly string[] = [
  '/',
  '/operator',
  '/matches',
  '/resources',
  '/picture',
  '/settings',
];

export const LOCAL_TOOL_PATHS = {
  packages: '/packages',
  legacyBp: '/operator/bp',
  hud: '/operator/hud',
  debug: '/debug',
  workspace: '/workspace',
  workspaceLeft: '/workspace/left',
  workspaceDock: '/workspace/dock',
  workspaceReview: '/workspace/review',
  workspaceConnection: '/workspace/connection',
  workspaceGamePicture: '/workspace/game-picture',
  qualification: '/qualification',
} as const;

export const PUBLIC_PROGRAM_PATHS = {
  compactBp: '/program/bp-compact',
  statistics: '/program/stats',
} as const;

export const PRIVATE_PAGE_PATHS = [...PREPARATION_PATHS, ...Object.values(LOCAL_TOOL_PATHS)];
