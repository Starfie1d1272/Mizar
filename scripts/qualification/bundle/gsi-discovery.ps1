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
                $value = $properties.$propertyName
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

function Get-SteamLibraryRoots {
    param([Parameter(Mandatory = $true)][string]$SteamRoot)
    $libraries = @($SteamRoot)
    $metadataPath = Join-Path $SteamRoot 'steamapps\libraryfolders.vdf'
    if (Test-Path -LiteralPath $metadataPath -PathType Leaf) {
        try {
            $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8
            foreach ($pattern in @(
                '(?im)^\s*"path"\s+"(?<path>(?:\\.|[^"])*)"',
                '(?im)^\s*"\d+"\s+"(?<path>(?:\\.|[^"])*)"'
            )) {
                foreach ($match in [regex]::Matches($metadata, $pattern)) {
                    $path = Convert-VdfPath -Value $match.Groups['path'].Value
                    if ($path -and (Test-Path -LiteralPath $path -PathType Container)) { $libraries += $path }
                }
            }
        } catch { }
    }
    return @(Get-UniqueSteamPaths -Paths $libraries)
}

function Resolve-CfgDirectory {
    param([string]$ExplicitRoot)
    if ($ExplicitRoot) {
        $resolved = (Resolve-Path -LiteralPath $ExplicitRoot -ErrorAction Stop).Path
        $leaf = Split-Path -Leaf $resolved
        if ($leaf -ieq 'cfg' -and (Test-Path -LiteralPath $resolved -PathType Container)) { return $resolved }
        $candidates = @(
            (Join-Path $resolved 'game\csgo\cfg'),
            (Join-Path $resolved 'csgo\cfg'),
            (Join-Path $resolved 'cfg')
        )
        $candidates = @(Get-UniqueSteamPaths -Paths @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Container }))
        if ($candidates.Count -eq 1) { return [string]$candidates[0] }
        throw "无法从 -Cs2Root 解析唯一的 CS2 cfg 目录；请传入 game\csgo\cfg 或 CS2 安装根目录"
    }

    $steamRoots = @(Get-SteamInstallRoots)
    $libraryRoots = @()
    foreach ($steamRoot in $steamRoots) { $libraryRoots += @(Get-SteamLibraryRoots -SteamRoot $steamRoot) }
    $libraryRoots = @(Get-UniqueSteamPaths -Paths $libraryRoots)
    $candidates = @()
    foreach ($libraryRoot in $libraryRoots) {
        foreach ($product in @('Counter-Strike 2', 'Counter-Strike Global Offensive')) {
            foreach ($relative in @('game\csgo\cfg', 'csgo\cfg')) {
                $candidate = Join-Path $libraryRoot "steamapps\common\$product\$relative"
                if (Test-Path -LiteralPath $candidate -PathType Container) { $candidates += $candidate }
            }
        }
    }
    $candidates = @(Get-UniqueSteamPaths -Paths $candidates)
    if ($candidates.Count -eq 1) { return [string]$candidates[0] }
    if ($candidates.Count -eq 0) { throw '未找到 CS2 cfg 目录；请传入 -Cs2Root <path>' }
    throw "找到多个 CS2 cfg 目录；请传入 -Cs2Root <path> 选择一个（候选数：$($candidates.Count)）"
}
