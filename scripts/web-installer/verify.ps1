param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null
# Production dependencies, the existing App and its sole persistent Store.
pnpm install --frozen-lockfile
if ($LASTEXITCODE) { throw 'Dependency installation failed' }
pnpm --filter @mizar/companion... --fail-if-no-match run build
if ($LASTEXITCODE) { throw 'Companion build failed' }
$bridge = Join-Path $output 'bridge'
pnpm --filter @mizar/companion deploy --prod (Join-Path $bridge 'resources/app')
if ($LASTEXITCODE) { throw 'Production dependency deployment failed' }
node "$PSScriptRoot/prepare-bridge.mjs" $bridge
if ($LASTEXITCODE) { throw 'Bridge deployment failed' }
node "$PSScriptRoot/test-resource-mirror.mjs" (Join-Path $bridge 'resources/app/dist/web-installer/resource-mirror.mjs')
if ($LASTEXITCODE) { throw 'Box resource transport failed' }
pnpm exec vitest run scripts/web-installer/qualification-plan.test.mjs scripts/web-installer/cancel-control.test.mjs packages/resource-pack-contract/catalog.test.mjs apps/companion/test/resource-store/store.test.ts apps/companion/test/resource-store/app-integration.test.ts
if ($LASTEXITCODE) { throw 'Windows resource integration tests failed' }
node "$PSScriptRoot/test-pack-cache-boundary.mjs" (Join-Path $bridge 'resources/app/dist/web-installer/install-official-pack.mjs')
if ($LASTEXITCODE) { throw 'Unverified policy rejection failed' }
& "$PSScriptRoot/test-native.ps1" -OutputDirectory $output
& "$PSScriptRoot/capture-ui.ps1" -OutputDirectory $output
$previous = @{}
foreach ($key in @('MIZAR_BRIDGE_NODE','MIZAR_BRIDGE_SCRIPT','MIZAR_BRIDGE_MODULE','MIZAR_BRIDGE_PLAN')) { $previous[$key] = [Environment]::GetEnvironmentVariable($key) }
try {
  $env:MIZAR_BRIDGE_NODE = (Get-Command node).Source
  $env:MIZAR_BRIDGE_SCRIPT = Join-Path $PSScriptRoot 'test-bootstrap-boundary.mjs'
  $env:MIZAR_BRIDGE_MODULE = Join-Path $bridge 'resources/app/dist/web-installer/complete-bootstrap.mjs'
  $env:MIZAR_BRIDGE_PLAN = Join-Path $PSScriptRoot 'legacy-stable-plan.json'
  & "$PSScriptRoot/test-nsis.ps1" -OutputDirectory $output
} finally {
  foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key,$previous[$key]) }
}
$clock.Stop()
[ordered]@{ schemaVersion=1; sourceSha=(& git rev-parse HEAD); wallTimeSeconds=$clock.Elapsed.TotalSeconds; nativeUi=$true; realNsisRegression=$true; productionDependencies=$true; productionCompletionEvidence=$false; missingEvidence=@('new trusted Core and official resource publication','cold-cache first installation','offline default EPL','installed desktop launch') } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $output 'verification.json') -Encoding UTF8
