# =============================================================================
# AS-CLEAN-16: execute_batch × 値返す SQL 同型バグ予防 lint (PowerShell 版)
# =============================================================================
# 目的:
#   rusqlite の `Connection::execute_batch()` は **「値を返さない SQL のみ」**
#   を許可する。SELECT / RETURNING / 一部 PRAGMA (= 値返す) を含むと
#   `Error: Execute returned results - did you mean to call query?` で実機 panic。
#
# 過去の同型バグ chain:
#   1. AS-CLEAN-09     : `bundled-full` features 欠落 → FTS5 未有効
#   2. AS-HOTFIX-QW3   : `fts5_version()` (値返す) → `fts5_source_id()` 修正
#   3. AS-HOTFIX-QW5   : `PRAGMA journal_mode = WAL` (値返す) → query_row 修正
#
# このスクリプトは src-tauri/src/ 配下の全 .rs を走査し、
# `.execute_batch(` 呼び出しブロック内に blacklist パターンが含まれていれば
# warn (デフォルト) または fail (-Strict) する。
#
# Usage:
#   ./scripts/lint-execute-batch.ps1            # warn-only, exit 0
#   ./scripts/lint-execute-batch.ps1 -Strict    # findings あれば exit 1 (CI 用)
#
# 偽陽性抑制:
#   呼び出し直前行に `// ALLOW(execute-batch-result): <理由>` を書くと skip。
#
# Maintainer: Asagi Dev (CEO 起票, AS-CLEAN-16)
# =============================================================================

[CmdletBinding()]
param(
    [switch]$Strict,
    [string]$Root = (Join-Path $PSScriptRoot "..\src-tauri\src")
)

$ErrorActionPreference = "Stop"

# Blacklist: pattern + 説明 (case-insensitive 評価)
$blacklist = @(
    @{
        Pattern = '\bSELECT\s+';
        Reason  = 'SELECT statements return rows; use query_row / query_map / prepare()'
    },
    @{
        Pattern = '\bRETURNING\b';
        Reason  = 'RETURNING clause returns rows; use query_row / query_map'
    },
    @{
        Pattern = 'PRAGMA\s+journal_mode\s*=';
        Reason  = 'PRAGMA journal_mode = ... returns new mode name; use query_row (AS-HOTFIX-QW5)'
    },
    @{
        Pattern = '\bfts5_version\s*\(';
        Reason  = 'fts5_version() returns version string; use query_row (AS-HOTFIX-QW3)'
    }
)

if (-not (Test-Path $Root)) {
    Write-Error "Root path not found: $Root"
    exit 2
}

$files = Get-ChildItem -Path $Root -Recurse -Filter *.rs -File
$findings = @()

foreach ($file in $files) {
    $lines = Get-Content -LiteralPath $file.FullName
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]

        # コメント行はスキップ
        if ($line -match '^\s*//') { continue }

        if ($line -notmatch '\.execute_batch\s*\(') { continue }

        # ALLOW marker チェック (直前行)
        if ($i -gt 0 -and $lines[$i - 1] -match 'ALLOW\(execute-batch-result\)') {
            continue
        }

        # ブロック抽出: 呼び出し行から最大 80 行 or `);` (top-level) まで
        $block = New-Object System.Collections.Generic.List[string]
        $depth = 0
        $started = $false
        $maxLook = [Math]::Min($i + 80, $lines.Count - 1)
        for ($j = $i; $j -le $maxLook; $j++) {
            $segment = $lines[$j]
            $block.Add($segment) | Out-Null

            foreach ($ch in $segment.ToCharArray()) {
                if ($ch -eq '(') { $depth++; $started = $true }
                elseif ($ch -eq ')') { $depth-- }
            }
            if ($started -and $depth -le 0) { break }
        }
        $blockText = ($block -join "`n")

        foreach ($rule in $blacklist) {
            if ([Regex]::IsMatch($blockText, $rule.Pattern, 'IgnoreCase')) {
                $findings += [PSCustomObject]@{
                    File    = $file.FullName.Replace((Resolve-Path $Root).Path, '').TrimStart('\','/')
                    Line    = $i + 1
                    Pattern = $rule.Pattern
                    Reason  = $rule.Reason
                }
            }
        }
    }
}

if ($findings.Count -eq 0) {
    # AS-CLEAN-19: Write-Output to ensure capture by pipeline / subprocess
    # (e.g. asagi-diagnostic-bundle.ps1 invokes this and captures output via 2>&1 | Out-String)
    Write-Output "[lint-execute-batch] OK: 0 findings across $($files.Count) .rs files"
    exit 0
}

Write-Output "[lint-execute-batch] FOUND $($findings.Count) potential issues:"
foreach ($f in $findings) {
    Write-Output ("  {0}:{1}" -f $f.File, $f.Line)
    Write-Output ("    pattern: {0}" -f $f.Pattern)
    Write-Output ("    fix    : {0}" -f $f.Reason)
}

if ($Strict) {
    Write-Output "[lint-execute-batch] -Strict mode: failing build"
    exit 1
}

Write-Output "[lint-execute-batch] (warn-only mode, pass -Strict to fail CI)"
exit 0
