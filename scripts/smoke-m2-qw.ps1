# =====================================================================
# M2 Quick Win Phase smoke launcher (DEC-018-046 / AS-HOTFIX-QW1)
# =====================================================================
#
# 用途: オーナー手動 smoke の手数を最小化するワンクリック起動。
#
# 使い方:
#   1. PowerShell でこのファイルを右クリック → 「PowerShell で実行」
#      （または: PS> .\scripts\smoke-m2-qw.ps1）
#   2. Tauri dev が起動するまで 30〜60 秒待機（初回はビルド込みで 90 秒程度）
#   3. アプリウィンドウが開いたら projects/PRJ-018/reports/smoke-m2-qw-checklist-2026-05-03.md
#      の手順 A → C をその順で実施（合計 60 秒目安）
#   4. ウィンドウ右上 × で終了 → コンソールも閉じる
#
# このスクリプトは smoke 用に以下を短縮します:
#   - SIDECAR_IDLE_THRESHOLD_MS = 10_000 (本番 30 分 → 10 秒)
#   - SIDECAR_IDLE_REAPER_INTERVAL_MS = 2_000 (本番 60 秒 → 2 秒)
#   - MOCK_EXPIRY_IN_SECS = 600 (10 分 = 期限警告閾値 30 分以内 → 即 warning 発火)
#   - AUTH_POLL_INTERVAL_MS = 2_000 (本番 5 分 → 2 秒, AS-HOTFIX-QW6)
#   - SIDECAR_MODE = mock (default、Codex CLI 不要)
#
# 本番値は contract.rs に定義されており、env 未設定時はそちらが使われる。
# 本スクリプトは smoke 終了後に env を残さない（PowerShell プロセスローカル）。
# =====================================================================

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

Write-Host ''
Write-Host '==================================================================' -ForegroundColor Cyan
Write-Host '  Asagi M2 Quick Win Phase — Smoke Launcher (DEC-018-046)' -ForegroundColor Cyan
Write-Host '==================================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host '【Smoke env (本セッションのみ有効)】' -ForegroundColor Yellow

# ===== Smoke A: idle auto-shutdown — 30min → 10sec =====
$env:ASAGI_SIDECAR_IDLE_THRESHOLD_MS = '10000'
$env:ASAGI_SIDECAR_IDLE_REAPER_INTERVAL_MS = '2000'
Write-Host '  ASAGI_SIDECAR_IDLE_THRESHOLD_MS       = 10000   (30min -> 10sec)'
Write-Host '  ASAGI_SIDECAR_IDLE_REAPER_INTERVAL_MS = 2000    (60s -> 2sec)'

# ===== Smoke C: auth expiry warning — 期限 10 分後 (閾値 30 分以内) =====
$env:ASAGI_MOCK_EXPIRY_IN_SECS = '600'
Write-Host '  ASAGI_MOCK_EXPIRY_IN_SECS             = 600     (10min, threshold 30min)'

# ===== AS-HOTFIX-QW6: auth watchdog poll を短縮 =====
# 本番 5min のまま smoke すると idle reaper kill (10sec) より polling が遅く、
# 「認証 確認中」が永遠に表示されてしまうため smoke では 2sec に短縮する。
$env:ASAGI_AUTH_POLL_INTERVAL_MS = '2000'
Write-Host '  ASAGI_AUTH_POLL_INTERVAL_MS           = 2000    (5min -> 2sec, QW6)'

# ===== mock mode 明示 (default だが念のため) =====
$env:ASAGI_SIDECAR_MODE = 'mock'
Write-Host '  ASAGI_SIDECAR_MODE                    = mock    (Codex CLI not required)'

# ===== reaper は default 有効 =====
Remove-Item Env:\ASAGI_SIDECAR_IDLE_REAPER_DISABLED -ErrorAction SilentlyContinue
Write-Host '  ASAGI_SIDECAR_IDLE_REAPER_DISABLED    = (unset, reaper enabled)'

Write-Host ''
Write-Host '【次のステップ】' -ForegroundColor Yellow
Write-Host '  1. 30〜60 秒お待ちください（Tauri dev 起動）'
Write-Host '  2. アプリウィンドウが開いたら以下のチェックリストを開いて手順実施:'
Write-Host '     projects\PRJ-018\reports\smoke-m2-qw-checklist-2026-05-03.md'
Write-Host '  3. 終了時はウィンドウ × でクローズ → このコンソールも閉じる'
Write-Host ''
Write-Host '==================================================================' -ForegroundColor Cyan
Write-Host ''

# Tauri dev 起動 (foreground)
& pnpm tauri:dev
