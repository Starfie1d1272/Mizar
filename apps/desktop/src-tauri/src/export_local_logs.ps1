$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$source = [IO.DirectoryInfo]::new($env:MIZAR_EXPORT_LOG_SOURCE)
$destination = $env:MIZAR_EXPORT_LOG_DESTINATION
if (!$source.Exists -or ($source.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Local logs directory is unavailable.'
}

$temporary = [IO.Path]::Combine([IO.Path]::GetDirectoryName($destination), [Guid]::NewGuid().ToString() + '.partial')
$omissions = [Collections.Generic.List[string]]::new()
$buffer = [byte[]]::new(65536)
$directories = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()
$directories.Push($source)
$temporaryCreated = $false
try {
    $target = [IO.File]::Open($temporary, 'CreateNew', 'ReadWrite', 'None')
    $temporaryCreated = $true
    try {
        $archive = [IO.Compression.ZipArchive]::new($target, 'Create', $true)
        try {
            while ($directories.Count -gt 0) {
                $directory = $directories.Pop()
                try {
                    $children = $directory.GetFileSystemInfos()
                } catch {
                    $omissions.Add($directory.FullName.Substring($source.FullName.Length) + ' (directory unavailable)')
                    continue
                }
                foreach ($child in $children) {
                    $name = 'logs' + $child.FullName.Substring($source.FullName.Length).Replace('\', '/')
                    if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                        $omissions.Add($name + ' (reparse point)')
                        continue
                    }
                    if ($child -is [IO.DirectoryInfo]) {
                        if ($name -in @('logs/performance-pending', 'logs/diagnostic-outbox')) {
                            $directories.Push($child)
                        }
                        continue
                    }
                    # Only producer logs and sealed evidence bodies. Upload state contains
                    # installation credentials even when it lives next to the logs.
                    if ($name -notmatch '^logs/(?:(?:session|desktop|document)-[a-f0-9-]{36}\.ndjson|(?:supervisor\.ndjson|companion(?:\.stderr)?\.log)(?:\.[0-9]+)?|host-retention\.ndjson|performance-pending/[a-f0-9-]{36}\.(?:[a-f0-9]{4}|[a-f0-9]{8})\.gz|diagnostic-outbox/[a-f0-9]{64}\.gz)$') {
                        continue
                    }
                    $compression = [IO.Compression.CompressionLevel]::Fastest
                    if ($name.EndsWith('.gz', [StringComparison]::OrdinalIgnoreCase)) {
                        $compression = [IO.Compression.CompressionLevel]::NoCompression
                    }
                    try {
                        $inputFile = [IO.File]::Open($child.FullName, 'Open', 'Read', [IO.FileShare]'ReadWrite, Delete')
                    } catch {
                        $omissions.Add($name + ' (file unavailable)')
                        continue
                    }
                    try {
                        $remaining = $inputFile.Length
                        $entry = $archive.CreateEntry($name, $compression).Open()
                        try {
                            while ($remaining -gt 0) {
                                try {
                                    $read = $inputFile.Read($buffer, 0, [int][Math]::Min($remaining, $buffer.Length))
                                } catch {
                                    $read = 0
                                }
                                if ($read -eq 0) {
                                    $omissions.Add($name + ' (partial read)')
                                    break
                                }
                                $entry.Write($buffer, 0, $read)
                                $remaining -= $read
                            }
                        } finally {
                            $entry.Dispose()
                        }
                    } finally {
                        $inputFile.Dispose()
                    }
                }
            }
            $report = [IO.StreamWriter]::new($archive.CreateEntry('mizar-export-status.txt').Open())
            try {
                $report.WriteLine('Mizar local log archive v1. Scope: all retained local logs. Active files are copied up to their observed length.')
                $report.WriteLine('Archived at: ' + [DateTimeOffset]::UtcNow.ToString('o'))
                $report.WriteLine('Unavailable or partial entries: ' + $omissions.Count)
                foreach ($omission in $omissions) { $report.WriteLine($omission) }
            } finally {
                $report.Dispose()
            }
        } finally {
            $archive.Dispose()
        }
        $target.Flush($true)
    } finally {
        $target.Dispose()
    }
    [IO.File]::Move($temporary, $destination)
} finally {
    if ($temporaryCreated -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
}
