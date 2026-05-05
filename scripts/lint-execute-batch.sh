#!/usr/bin/env bash
# =============================================================================
# AS-CLEAN-16: execute_batch × 値返す SQL 同型バグ予防 lint (bash 版)
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
# warn (デフォルト) または fail (--strict) する。
#
# Usage:
#   ./scripts/lint-execute-batch.sh             # warn-only, exit 0
#   ./scripts/lint-execute-batch.sh --strict    # findings あれば exit 1 (CI 用)
#
# 偽陽性抑制:
#   呼び出し直前行に `// ALLOW(execute-batch-result): <理由>` を書くと skip。
#
# Maintainer: Asagi Dev (CEO 起票, AS-CLEAN-16)
# =============================================================================

set -euo pipefail

STRICT=0
ROOT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --strict) STRICT=1; shift ;;
        --root)   ROOT="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
ROOT="${ROOT:-$SCRIPT_DIR/../src-tauri/src}"

if [[ ! -d "$ROOT" ]]; then
    echo "Root path not found: $ROOT" >&2
    exit 2
fi

# Blacklist: "pattern|||reason" 形式 (case-insensitive 評価)
BLACKLIST=(
    '\bSELECT[[:space:]]+|||SELECT statements return rows; use query_row / query_map / prepare()'
    '\bRETURNING\b|||RETURNING clause returns rows; use query_row / query_map'
    'PRAGMA[[:space:]]+journal_mode[[:space:]]*=|||PRAGMA journal_mode = ... returns new mode name; use query_row (AS-HOTFIX-QW5)'
    '\bfts5_version[[:space:]]*\(|||fts5_version() returns version string; use query_row (AS-HOTFIX-QW3)'
)

FINDINGS=()
FILE_COUNT=0

while IFS= read -r -d '' file; do
    FILE_COUNT=$((FILE_COUNT + 1))
    mapfile -t LINES < "$file"
    rel="${file#${ROOT}/}"

    for ((i=0; i<${#LINES[@]}; i++)); do
        line="${LINES[$i]}"

        # コメント行スキップ
        [[ "$line" =~ ^[[:space:]]*// ]] && continue

        # execute_batch 呼び出し検出
        [[ "$line" =~ \.execute_batch[[:space:]]*\( ]] || continue

        # ALLOW marker チェック (直前行)
        if (( i > 0 )) && [[ "${LINES[$((i-1))]}" == *"ALLOW(execute-batch-result)"* ]]; then
            continue
        fi

        # ブロック抽出: 最大 80 行 or 括弧バランス 0
        depth=0
        started=0
        block=""
        max=$((i + 80))
        (( max > ${#LINES[@]} - 1 )) && max=$((${#LINES[@]} - 1))
        for ((j=i; j<=max; j++)); do
            seg="${LINES[$j]}"
            block+="$seg"$'\n'
            for ((k=0; k<${#seg}; k++)); do
                ch="${seg:$k:1}"
                if [[ "$ch" == "(" ]]; then
                    depth=$((depth + 1)); started=1
                elif [[ "$ch" == ")" ]]; then
                    depth=$((depth - 1))
                fi
            done
            if (( started == 1 && depth <= 0 )); then break; fi
        done

        # blacklist 評価
        for entry in "${BLACKLIST[@]}"; do
            pattern="${entry%%|||*}"
            reason="${entry##*|||}"
            if echo "$block" | grep -iEq "$pattern"; then
                FINDINGS+=("$rel:$((i+1))|||$pattern|||$reason")
            fi
        done
    done
done < <(find "$ROOT" -type f -name "*.rs" -print0)

if (( ${#FINDINGS[@]} == 0 )); then
    echo "[lint-execute-batch] OK: 0 findings across $FILE_COUNT .rs files"
    exit 0
fi

echo "[lint-execute-batch] FOUND ${#FINDINGS[@]} potential issues:"
for f in "${FINDINGS[@]}"; do
    loc="${f%%|||*}"
    rest="${f#*|||}"
    pattern="${rest%%|||*}"
    reason="${rest##*|||}"
    echo "  $loc"
    echo "    pattern: $pattern"
    echo "    fix    : $reason"
done

if (( STRICT == 1 )); then
    echo "[lint-execute-batch] --strict mode: failing build"
    exit 1
fi

echo "[lint-execute-batch] (warn-only mode, pass --strict to fail CI)"
exit 0
