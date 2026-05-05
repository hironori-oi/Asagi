# =============================================================================
# AS-CLEAN-18: Asagi diagnostic bundle collector (Windows / PowerShell)
# =============================================================================
# 目的:
#   オーナーの実機 smoke が fail した際、CEO / Dev 部門が遠隔で原因解析できる
#   よう、~/.asagi/ 配下 + Codex CLI 環境 + lint 結果を **PII redact しつつ**
#   zip 1 ファイルにまとめる。AS-HOTFIX-QW3/QW5/QW6 の trauma から学んだ
#   「実機固有 issue は手元で再現困難 → 診断情報の制度化が必須」教訓を体現。
#
# 収集対象 (PII safe):
#   1. ~/.asagi/ 配下の files (name + size + mtime + 先頭 256 byte hex)
#   2. ~/.asagi/history.db の SQLite header parse (magic + page size +
#      schema cookie + encoding + page count)
#   3. ~/.asagi/store.json の **keys のみ** (values は [redacted])
#   4. ~/.codex/auth.json の **存在 + size + mtime のみ** (内容完全 skip)
#   5. Codex CLI: where + --version (PATH 検出 + 0.128.0 整合確認)
#   6. cargo --version + rustc --version (toolchain 整合)
#   7. lint-execute-batch.ps1 -Strict 実行結果 (0 findings であるべき)
#   8. OS info: OSVersion / RAM / free disk on $env:USERPROFILE drive
#   9. 環境変数 ASAGI_* + RUST_LOG (smoke env 確認)
#
# 明示的に **収集しない** (PII / secret):
#   - history.db の data (header bytes 256 のみ)
#   - store.json の values
#   - auth.json の中身
#   - keyring entry の値 (PowerShell からは access 不可、何もしない)
#   - 過去の commit 履歴 (`git log` 不要)
#
# Usage:
#   pwsh scripts/asagi-diagnostic-bundle.ps1
#     → ~/.asagi/diagnostic-bundle-yyyyMMdd-HHmmss.zip 生成
#
#   pwsh scripts/asagi-diagnostic-bundle.ps1 -OutDir D:\temp
#     → D:\temp\diagnostic-bundle-yyyyMMdd-HHmmss.zip 生成
#
# Maintainer: Asagi CEO 起票, AS-CLEAN-18, DEC-018-047 (12) 続報 2026-05-05
# =============================================================================

[CmdletBinding()]
param(
    [string]$OutDir = (Join-Path $env:USERPROFILE ".asagi"),
    [switch]$NoLint
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

# -----------------------------------------------------------------------------
# Setup
# -----------------------------------------------------------------------------
$timestamp  = Get-Date -Format "yyyyMMdd-HHmmss"
$tempDir    = Join-Path $env:TEMP "asagi-diagnostic-$timestamp"
$null       = New-Item -ItemType Directory -Force -Path $tempDir
$report     = New-Object System.Collections.Specialized.OrderedDictionary
$asagiDir   = Join-Path $env:USERPROFILE ".asagi"
$codexDir   = Join-Path $env:USERPROFILE ".codex"

Write-Host "[diagnostic-bundle] collecting into $tempDir" -ForegroundColor Cyan

# -----------------------------------------------------------------------------
# (1) ~/.asagi/ file inventory
# -----------------------------------------------------------------------------
$asagiFiles = @()
if (Test-Path $asagiDir) {
    Get-ChildItem -Path $asagiDir -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
        $info = [PSCustomObject]@{
            name        = $_.Name
            sizeBytes   = $_.Length
            mtimeUtc    = $_.LastWriteTimeUtc.ToString("o")
            hexHead256  = $null
        }
        try {
            $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
            $head  = $bytes[0..([Math]::Min(255, $bytes.Length - 1))]
            $info.hexHead256 = ($head | ForEach-Object { $_.ToString("X2") }) -join ' '
        } catch {
            $info.hexHead256 = "[read failed: $($_.Exception.Message)]"
        }
        $asagiFiles += $info
    }
}
$report["asagi_dir"] = @{
    path  = $asagiDir
    exists = (Test-Path $asagiDir)
    files = $asagiFiles
}

# -----------------------------------------------------------------------------
# (2) history.db SQLite header parse
# -----------------------------------------------------------------------------
$historyDb = Join-Path $asagiDir "history.db"
$dbHeader  = @{ exists = (Test-Path $historyDb) }
if ($dbHeader.exists) {
    try {
        $bytes = [System.IO.File]::ReadAllBytes($historyDb)
        if ($bytes.Length -ge 100) {
            # SQLite header spec: https://www.sqlite.org/fileformat.html#the_database_header
            $magicBytes  = $bytes[0..15]
            $magic       = [System.Text.Encoding]::ASCII.GetString($magicBytes).TrimEnd([char]0)
            $pageSize    = ([uint16]$bytes[16] -shl 8) -bor [uint16]$bytes[17]
            # schema cookie = bytes 40..43 (big-endian uint32)
            $schemaCookie = ([uint32]$bytes[40] -shl 24) -bor ([uint32]$bytes[41] -shl 16) -bor ([uint32]$bytes[42] -shl 8) -bor [uint32]$bytes[43]
            # text encoding = bytes 56..59 (big-endian uint32; 1=utf-8, 2=utf-16le, 3=utf-16be)
            $textEnc      = ([uint32]$bytes[56] -shl 24) -bor ([uint32]$bytes[57] -shl 16) -bor ([uint32]$bytes[58] -shl 8) -bor [uint32]$bytes[59]
            $textEncName  = switch ($textEnc) {
                1 { "utf-8" }
                2 { "utf-16le" }
                3 { "utf-16be" }
                default { "unknown ($textEnc)" }
            }
            # page count = bytes 28..31 (big-endian uint32, valid only if non-zero)
            $pageCount    = ([uint32]$bytes[28] -shl 24) -bor ([uint32]$bytes[29] -shl 16) -bor ([uint32]$bytes[30] -shl 8) -bor [uint32]$bytes[31]
            $dbHeader.magic         = $magic
            $dbHeader.pageSize      = $pageSize
            $dbHeader.schemaCookie  = $schemaCookie
            $dbHeader.textEncoding  = $textEncName
            $dbHeader.pageCountField = $pageCount
            $dbHeader.fileSizeBytes  = $bytes.Length
            $dbHeader.diagnosis      = if ($magic -ne "SQLite format 3") {
                "ABNORMAL: magic mismatch (not a SQLite DB)"
            } elseif ($schemaCookie -eq 0 -and $textEnc -eq 0 -and $pageCount -le 1) {
                "STALE: empty SQLite file (schema 0, encoding 0) -- AS-HOTFIX-QW5 reproducer pattern"
            } elseif ($schemaCookie -gt 0 -and $textEnc -eq 1) {
                "OK: schema present, utf-8 encoding"
            } else {
                "UNKNOWN: schema=$schemaCookie encoding=$textEnc -- manual review required"
            }
        } else {
            $dbHeader.diagnosis = "ABNORMAL: file < 100 bytes (header incomplete)"
            $dbHeader.fileSizeBytes = $bytes.Length
        }
    } catch {
        $dbHeader.error = $_.Exception.Message
    }
}
$report["history_db_header"] = $dbHeader

# -----------------------------------------------------------------------------
# (3) store.json keys-only
# -----------------------------------------------------------------------------
$storeJson = Join-Path $asagiDir "store.json"
$storeInfo = @{ exists = (Test-Path $storeJson) }
if ($storeInfo.exists) {
    try {
        $raw = Get-Content -LiteralPath $storeJson -Raw -ErrorAction Stop
        $obj = $raw | ConvertFrom-Json -ErrorAction Stop
        $keys = @()
        if ($obj -is [PSCustomObject]) {
            $obj.PSObject.Properties | ForEach-Object { $keys += $_.Name }
        }
        $storeInfo.storedKeys = $keys
        $storeInfo.note = "values intentionally redacted (PII safe)"
    } catch {
        $storeInfo.error = $_.Exception.Message
    }
}
$report["store_json"] = $storeInfo

# -----------------------------------------------------------------------------
# (4) Codex auth.json metadata only
# -----------------------------------------------------------------------------
$authJson = Join-Path $codexDir "auth.json"
$authInfo = @{ path = $authJson; exists = (Test-Path $authJson) }
if ($authInfo.exists) {
    $f = Get-Item -LiteralPath $authJson -ErrorAction SilentlyContinue
    if ($f) {
        $authInfo.sizeBytes = $f.Length
        $authInfo.mtimeUtc  = $f.LastWriteTimeUtc.ToString("o")
        $authInfo.note      = "content fully redacted (PII safe -- never read)"
    }
}
$report["codex_auth_metadata"] = $authInfo

# -----------------------------------------------------------------------------
# (5) Codex CLI version
# -----------------------------------------------------------------------------
$codexInfo = @{ found = $false }
try {
    $codexCmd = Get-Command codex -ErrorAction SilentlyContinue
    if ($codexCmd) {
        $codexInfo.found = $true
        $codexInfo.path  = $codexCmd.Source
        try {
            $codexInfo.version = (& codex --version 2>&1 | Out-String).Trim()
        } catch {
            $codexInfo.versionError = $_.Exception.Message
        }
    }
} catch {
    $codexInfo.error = $_.Exception.Message
}
$report["codex_cli"] = $codexInfo

# -----------------------------------------------------------------------------
# (6) cargo / rustc versions
# -----------------------------------------------------------------------------
$toolchainInfo = @{}
foreach ($tool in @("cargo", "rustc", "node", "pnpm")) {
    try {
        $cmd = Get-Command $tool -ErrorAction SilentlyContinue
        if ($cmd) {
            $ver = (& $tool --version 2>&1 | Out-String).Trim()
            $toolchainInfo[$tool] = @{ found = $true; version = $ver; path = $cmd.Source }
        } else {
            $toolchainInfo[$tool] = @{ found = $false }
        }
    } catch {
        $toolchainInfo[$tool] = @{ error = $_.Exception.Message }
    }
}
$report["toolchain"] = $toolchainInfo

# -----------------------------------------------------------------------------
# (7) lint-execute-batch.ps1 -Strict
# -----------------------------------------------------------------------------
$lintInfo = @{ skipped = [bool]$NoLint }
if (-not $NoLint) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
    $lintScript = Join-Path $scriptDir "lint-execute-batch.ps1"
    if (Test-Path $lintScript) {
        try {
            $lintOutput = & $lintScript -Strict 2>&1 | Out-String
            $lintInfo.exitCode = $LASTEXITCODE
            $lintInfo.output   = $lintOutput.Trim()
        } catch {
            $lintInfo.error = $_.Exception.Message
        }
    } else {
        $lintInfo.skipped = $true
        $lintInfo.note    = "lint-execute-batch.ps1 not found (script likely run outside repo)"
    }
}
$report["lint_execute_batch"] = $lintInfo

# -----------------------------------------------------------------------------
# (8) OS / system info
# -----------------------------------------------------------------------------
try {
    $osVer = [System.Environment]::OSVersion
    $os = @{
        platform   = $osVer.Platform.ToString()
        version    = $osVer.Version.ToString()
        servicePack = $osVer.ServicePack
    }
    $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue
    if ($cs) { $os.totalRamGB = [Math]::Round($cs.TotalPhysicalMemory / 1GB, 2) }
    $drive = ($env:USERPROFILE).Substring(0, 2)
    $disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$drive'" -ErrorAction SilentlyContinue
    if ($disk) {
        $os.userprofileDrive = $drive
        $os.freeGB           = [Math]::Round($disk.FreeSpace / 1GB, 2)
        $os.totalGB          = [Math]::Round($disk.Size / 1GB, 2)
    }
    $report["os"] = $os
} catch {
    $report["os"] = @{ error = $_.Exception.Message }
}

# -----------------------------------------------------------------------------
# (9) ASAGI_* + RUST_LOG environment variables
# -----------------------------------------------------------------------------
$envInfo = @{}
Get-ChildItem env: | Where-Object { $_.Name -like 'ASAGI_*' -or $_.Name -eq 'RUST_LOG' } | ForEach-Object {
    $envInfo[$_.Name] = $_.Value
}
$report["env_vars"] = $envInfo

# -----------------------------------------------------------------------------
# Meta
# -----------------------------------------------------------------------------
$report["meta"] = @{
    bundleVersion    = "1.0.0"
    bundleSpec       = "AS-CLEAN-18 / DEC-018-047 (12)"
    timestampUtc     = (Get-Date).ToUniversalTime().ToString("o")
    asagiAppVersion  = "0.1.0"
    psVersion        = $PSVersionTable.PSVersion.ToString()
    redactionPolicy  = @(
        "history.db: header bytes 0-255 only (no data pages)",
        "store.json: keys only (no values)",
        "auth.json: existence + size + mtime only (no content read)",
        "keyring: not accessed at all",
        "no git history collected"
    )
}

# -----------------------------------------------------------------------------
# Write report.json + report.txt + raw artifacts
# -----------------------------------------------------------------------------
$reportJsonPath = Join-Path $tempDir "report.json"
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportJsonPath -Encoding UTF8

$reportTxtPath = Join-Path $tempDir "report.txt"
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("=== Asagi Diagnostic Bundle ===")
$lines.Add("Generated: $($report.meta.timestampUtc)")
$lines.Add("Spec     : $($report.meta.bundleSpec)")
$lines.Add("")
$lines.Add("--- history.db ---")
if ($dbHeader.exists) {
    $lines.Add("  exists       : YES (size $($dbHeader.fileSizeBytes) bytes)")
    if ($dbHeader.magic) {
        $lines.Add("  magic        : '$($dbHeader.magic)'")
        $lines.Add("  pageSize     : $($dbHeader.pageSize)")
        $lines.Add("  schemaCookie : $($dbHeader.schemaCookie)")
        $lines.Add("  textEncoding : $($dbHeader.textEncoding)")
        $lines.Add("  pageCount    : $($dbHeader.pageCountField)")
        $lines.Add("  diagnosis    : $($dbHeader.diagnosis)")
    } elseif ($dbHeader.diagnosis) {
        $lines.Add("  diagnosis    : $($dbHeader.diagnosis)")
    }
} else {
    $lines.Add("  exists: NO")
}
$lines.Add("")
$lines.Add("--- store.json ---")
$lines.Add("  exists: $($storeInfo.exists)")
if ($storeInfo.storedKeys) { $lines.Add("  keys  : $($storeInfo.storedKeys -join ', ')") }
$lines.Add("")
$lines.Add("--- codex auth.json ---")
$lines.Add("  exists: $($authInfo.exists)")
if ($authInfo.sizeBytes) { $lines.Add("  size  : $($authInfo.sizeBytes) bytes") }
$lines.Add("")
$lines.Add("--- Codex CLI ---")
if ($codexInfo.found) {
    $lines.Add("  path   : $($codexInfo.path)")
    $lines.Add("  version: $($codexInfo.version)")
} else {
    $lines.Add("  not found in PATH")
}
$lines.Add("")
$lines.Add("--- Lint execute_batch ---")
if ($lintInfo.skipped) {
    $lines.Add("  skipped")
} else {
    $lines.Add("  exitCode: $($lintInfo.exitCode)")
    $lines.Add("  output  :")
    foreach ($l in ($lintInfo.output -split "`n")) { $lines.Add("    $l") }
}
$lines.Add("")
$lines.Add("--- OS ---")
$lines.Add("  $(($report.os | ConvertTo-Json -Depth 3))")
$lines.Add("")
$lines.Add("--- ASAGI_* env vars ---")
if ($envInfo.Count -eq 0) { $lines.Add("  (none set)") }
else { foreach ($k in $envInfo.Keys) { $lines.Add("  $k = $($envInfo[$k])") } }

Set-Content -LiteralPath $reportTxtPath -Value $lines -Encoding UTF8

# -----------------------------------------------------------------------------
# Zip + cleanup
# -----------------------------------------------------------------------------
if (-not (Test-Path $OutDir)) { $null = New-Item -ItemType Directory -Force -Path $OutDir }
$zipPath = Join-Path $OutDir "diagnostic-bundle-$timestamp.zip"
if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $tempDir '*') -DestinationPath $zipPath -CompressionLevel Optimal

Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[diagnostic-bundle] OK: $zipPath" -ForegroundColor Green
Write-Host "[diagnostic-bundle] DB diagnosis: $($dbHeader.diagnosis)" -ForegroundColor $(
    if ($dbHeader.diagnosis -like 'OK*') { 'Green' }
    elseif ($dbHeader.diagnosis -like 'STALE*') { 'Yellow' }
    elseif ($dbHeader.diagnosis -like 'ABNORMAL*') { 'Red' }
    else { 'Cyan' }
)
Write-Host "[diagnostic-bundle] Share this zip with CEO/Dev for remote analysis."
