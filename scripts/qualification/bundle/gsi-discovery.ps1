function Get-SteamInstallRoots {
    $roots = @()
    foreach ($baseRoot in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:STEAMROOT)) {
        if (-not $baseRoot) { continue }
        $roots += [string]$baseRoot
        $roots += Join-Path ([string]$baseRoot) 'Steam'
    }
    foreach ($registryPath in @(
        'HKCU:\Software\Valve\Steam',
        'HKLM:\SOFTWARE\Valve\Steam',
        'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam'
    )) {
        try {
            $properties = Get-ItemProperty -LiteralPath $registryPath -ErrorAction Stop
            foreach ($propertyName in @('InstallPath', 'SteamPath')) {
                $property = $properties.PSObject.Properties[$propertyName]
                $value = if ($property) { $property.Value } else { $null }
                if ($value) { $roots += [string]$value }
            }
        } catch { }
    }
    return @(Get-UniqueSteamPaths -Paths $roots)
}

function Get-UniqueSteamPaths {
    param([string[]]$Paths)
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $Paths) {
        if (-not $path) { continue }
        try {
            $canonical = [IO.Path]::GetFullPath($path.Replace('/', '\'))
            if ($canonical -ne [IO.Path]::GetPathRoot($canonical)) {
                $canonical = $canonical.TrimEnd([char]'\')
            }
            if ($seen.Add($canonical)) { $canonical }
        } catch { }
    }
}

function Convert-VdfPath {
    param([Parameter(Mandatory = $true)][string]$Value)
    return $Value.Replace('\\', '\').Replace('\"', '"')
}


function Stop-Cs2Discovery {
    param([string]$Code, [int]$CandidateCount = 0)
    $exception = [InvalidOperationException]::new($Code)
    $exception.Data['MizarCode'] = $Code
    $exception.Data['CandidateCount'] = $CandidateCount
    throw $exception
}

# Steam KeyValues: parse object structure rather than matching unrelated numeric keys.
function Read-SteamVdfObject {
    param([string[]]$Tokens, [hashtable]$Cursor, [int]$Depth = 0)
    if ($Depth -gt 32) { Stop-Cs2Discovery 'metadata-invalid' }
    $result = @{}
    while ($Cursor.Index -lt $Tokens.Count) {
        $key = $Tokens[$Cursor.Index++]
        if ($key -eq '}') {
            if ($Depth -eq 0) { Stop-Cs2Discovery 'metadata-invalid' }
            return $result
        }
        if ($key -eq '{' -or $Cursor.Index -ge $Tokens.Count) { Stop-Cs2Discovery 'metadata-invalid' }
        if ($key.StartsWith('"')) { $key = Convert-VdfPath $key.Substring(1, $key.Length - 2) }
        $value = $Tokens[$Cursor.Index++]
        if ($value -eq '{') { $value = Read-SteamVdfObject $Tokens $Cursor ($Depth + 1) }
        elseif ($value -eq '}') { Stop-Cs2Discovery 'metadata-invalid' }
        elseif ($value.StartsWith('"')) { $value = Convert-VdfPath $value.Substring(1, $value.Length - 2) }
        if ($result.ContainsKey($key)) { Stop-Cs2Discovery 'metadata-invalid' }
        $result[$key] = $value
    }
    if ($Depth -ne 0) { Stop-Cs2Discovery 'metadata-invalid' }
    return $result
}

function Read-SteamVdf {
    param([string]$Path)
    if ((Get-Item -LiteralPath $Path -ErrorAction Stop).Length -gt 1MB) { Stop-Cs2Discovery 'metadata-invalid' }
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop
    $tokens = @([regex]::Matches($text, '"(?:\\.|[^"\\])*"|[{}]|//[^\r\n]*|[^\s{}"]+') |
        ForEach-Object { $_.Value } | Where-Object { -not $_.StartsWith('//') })
    return Read-SteamVdfObject $tokens @{ Index = 0 }
}

function Get-SteamLibraryRoots {
    param([Parameter(Mandatory = $true)][string]$SteamRoot)
    $libraries = @($SteamRoot)
    # Current metadata first; retain the older config location as a fallback.
    foreach ($relative in @('steamapps\libraryfolders.vdf', 'config\libraryfolders.vdf')) {
        $metadataPath = Join-Path $SteamRoot $relative
        if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) { continue }
        try {
            $metadata = Read-SteamVdf $metadataPath
            if ($metadata['libraryfolders'] -isnot [hashtable]) { Stop-Cs2Discovery 'metadata-invalid' }
            foreach ($entry in $metadata['libraryfolders'].GetEnumerator()) {
                if ($entry.Key -notmatch '^\d+$') { continue }
                $path = if ($entry.Value -is [hashtable]) { $entry.Value['path'] } else { $entry.Value }
                if ($path -is [string] -and (Test-Path -LiteralPath $path -PathType Container)) { $libraries += $path }
            }
            break
        } catch { $script:Cs2MetadataFailed = $true }
    }
    return @(Get-UniqueSteamPaths -Paths $libraries)
}

function Get-Cs2Installation {
    param([string]$Root)
    $exe = Join-Path $Root 'game\bin\win64\cs2.exe'
    $cfg = Join-Path $Root 'game\csgo\cfg'
    if ((Test-Path -LiteralPath $exe -PathType Leaf) -and (Test-Path -LiteralPath $cfg -PathType Container)) {
        return @{ root = [string]$Root; executable = $exe; cfg = $cfg }
    }
    return $null
}

function Resolve-Cs2Input {
    param([string]$InputPath)
    if (-not (Test-Path -LiteralPath $InputPath)) { Stop-Cs2Discovery 'selected-path-missing' }
    $path = (Resolve-Path -LiteralPath $InputPath -ErrorAction Stop).Path
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        if ((Split-Path -Leaf $path) -ine 'cs2.exe') { Stop-Cs2Discovery 'selected-path-invalid' }
        $path = Split-Path -Parent $path
    }
    # Accept installation/game/cfg/win64 folders, or cs2.exe, without a disk scan.
    for ($level = 0; $level -lt 6 -and $path; $level++) {
        $installation = Get-Cs2Installation $path
        if ($installation) { return $installation }
        $parent = Split-Path -Parent $path
        if ($parent -eq $path) { break }
        $path = $parent
    }
    Stop-Cs2Discovery 'selected-path-invalid'
}

function Get-Cs2SelectionPath {
    if (Get-Variable -Name StateRoot -Scope Script -ErrorAction SilentlyContinue) { $root = $script:StateRoot }
    elseif ($env:MIZAR_STATE_ROOT) { $root = $env:MIZAR_STATE_ROOT }
    else { $root = Join-Path (Get-Location).Path 'state' }
    return Join-Path $root 'data\cs2-installation.json'
}

function Get-SavedCs2Input {
    $selectionPath = Get-Cs2SelectionPath
    if (Test-Path -LiteralPath $selectionPath -PathType Leaf) {
        try {
            $selection = Get-Content -LiteralPath $selectionPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($selection.version -ne 1 -or $selection.root -isnot [string]) { Stop-Cs2Discovery 'selection-unreadable' }
            return $selection.root
        } catch { Stop-Cs2Discovery 'selection-unreadable' }
    }
    # Existing GSI selections also identify the installation used for managed launch.
    $recordPath = Join-Path (Split-Path -Parent $selectionPath) 'gsi-install\install.json'
    if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
        try {
            $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($record.cfgPath -isnot [string] -or -not $record.cfgPath) { Stop-Cs2Discovery 'record-unreadable' }
            return Split-Path -Parent $record.cfgPath
        } catch { Stop-Cs2Discovery 'record-unreadable' }
    }
    return $null
}

function Resolve-CfgDirectory {
    param([string]$ExplicitRoot)
    $script:Cs2CandidateCount = 0
    $script:Cs2MetadataFailed = $false
    if (-not $ExplicitRoot) { $ExplicitRoot = Get-SavedCs2Input }
    if ($ExplicitRoot) {
        $installation = Resolve-Cs2Input $ExplicitRoot
        $script:Cs2CandidateCount = 1
        return $installation.cfg
    }
    $libraryRoots = @()
    foreach ($steamRoot in @(Get-SteamInstallRoots)) { $libraryRoots += @(Get-SteamLibraryRoots $steamRoot) }
    $candidates = @()
    foreach ($libraryRoot in @(Get-UniqueSteamPaths $libraryRoots)) {
        $manifestPath = Join-Path $libraryRoot 'steamapps\appmanifest_730.acf'
        if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
            try {
                $manifest = Read-SteamVdf $manifestPath
                $app = $manifest['AppState']
                if ($app -isnot [hashtable] -or $app['appid'] -ne '730' -or $app['installdir'] -isnot [string] -or
                    -not $app['installdir'] -or $app['installdir'] -match '[\\/:]' -or $app['installdir'] -in @('.', '..')) {
                    Stop-Cs2Discovery 'metadata-invalid'
                }
                $root = Join-Path $libraryRoot ('steamapps\common\' + $app['installdir'])
                if (Get-Cs2Installation $root) { $candidates += $root; continue }
            } catch { $script:Cs2MetadataFailed = $true }
        }
        foreach ($product in @('Counter-Strike 2', 'Counter-Strike Global Offensive')) {
            $root = Join-Path $libraryRoot "steamapps\common\$product"
            if (Get-Cs2Installation $root) { $candidates += $root }
        }
    }
    $candidates = @(Get-UniqueSteamPaths $candidates)
    $script:Cs2CandidateCount = $candidates.Count
    if ($candidates.Count -eq 1) { return (Get-Cs2Installation $candidates[0]).cfg }
    if ($candidates.Count -eq 0) {
        if ($script:Cs2MetadataFailed) { Stop-Cs2Discovery 'metadata-invalid' }
        Stop-Cs2Discovery 'installation-not-found'
    }
    Stop-Cs2Discovery 'multiple-installations' $candidates.Count
}
