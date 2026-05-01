#!/usr/bin/env node
// =============================================================================
// codex-schema-snapshot.mjs
// -----------------------------------------------------------------------------
// Asagi (PRJ-018) RAs-14 緩和スクリプト
//
// 目的:
//   - Codex CLI が公式提供する `codex app-server generate-ts --out DIR`
//     を週次で実行し、TypeScript schema を snapshot として保存
//   - 直近の前 snapshot との diff を検出
//   - breaking change 候補（method 削除 / 必須フィールド追加 / 型 narrowing）を
//     heuristic で抽出して列挙
//   - exit code:
//       0 = breaking 検知なし（差分有無は問わず）
//       1 = breaking 検知あり / generate-ts 失敗
//
// セキュリティ:
//   外部プロセス起動は spawnSync(..., { shell: false }) のみを使用。
//   shell を介さないため、引数が直接 argv として渡り、コマンドインジェクション
//   は構造的に発生しない。CODEX_BIN_PATH 環境変数も spawnSync の第 1 引数として
//   そのまま渡るのみで、shell 解釈は受けない。
//
// 注意:
//   Codex CLI 未インストール時は exit 0 にして CI を通す。
//   理由: 開発環境で Codex CLI を持たない devs / マシンでも安全に実行可能。
//   CI 側ではインストール確実なので「未インストール」は本来発生せず、
//   インストール失敗時は別ステップ（CLI install）が失敗する想定。
//
// 参照:
//   - reports/research-report-v2.md § 主要発見 2 / § 5.6 (新規 POC #6 候補)
//   - reports/research-report-v2-addendum-generate-ts.md
//   - decisions.md DEC-018-022 / 023
//   - risks.md RAs-14
// =============================================================================

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// -----------------------------------------------------------------------------
// 定数
// -----------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = resolve(__dirname, "..");
const SCHEMA_ROOT = join(APP_ROOT, "codex-schema");
const SNAPSHOT_DIR = join(SCHEMA_ROOT, "snapshots");
const DIFF_DIR = join(SCHEMA_ROOT, "diffs");
const TMP_DIR = join(SCHEMA_ROOT, ".codex-schema-tmp");

const CODEX_BIN = process.env.CODEX_BIN_PATH || "codex";

// -----------------------------------------------------------------------------
// utility
// -----------------------------------------------------------------------------
function log(msg) {
  process.stdout.write(`[codex-schema-snapshot] ${msg}\n`);
}

function todayISO() {
  // UTC 基準の YYYY-MM-DD 文字列（CI が UTC で動くため）
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// 安全な外部コマンド実行ラッパ。shell: false 固定で injection 不可能。
function tryRun(cmd, args) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: false,
  });
  if (r.error) {
    return { ok: false, stdout: "", stderr: String(r.error), code: null };
  }
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status,
  };
}

// -----------------------------------------------------------------------------
// 1. Codex CLI 存在確認
// -----------------------------------------------------------------------------
function checkCodexInstalled() {
  const r = tryRun(CODEX_BIN, ["--version"]);
  if (!r.ok) {
    return false;
  }
  log(`Codex CLI detected: ${r.stdout.trim() || "(version unknown)"}`);
  return true;
}

// -----------------------------------------------------------------------------
// 2. generate-ts 実行
//    addendum で確認した正式コマンド: codex app-server generate-ts --out DIR
// -----------------------------------------------------------------------------
function runGenerateTs() {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
  ensureDir(TMP_DIR);

  log(`Running: ${CODEX_BIN} app-server generate-ts --out ${TMP_DIR}`);
  const r = tryRun(CODEX_BIN, [
    "app-server",
    "generate-ts",
    "--out",
    TMP_DIR,
  ]);

  if (!r.ok) {
    // generate-ts 未対応の古い codex の可能性 → help を見て診断
    log(`generate-ts failed (exit=${r.code}). stderr:\n${r.stderr}`);
    log("Falling back to `codex app-server --help` for diagnosis.");
    const h = tryRun(CODEX_BIN, ["app-server", "--help"]);
    log(`app-server --help output:\n${h.stdout}\n${h.stderr}`);
    return null;
  }
  return TMP_DIR;
}

// -----------------------------------------------------------------------------
// 3. tmp の生成物を 1 つの統合 .ts ファイルに集約
// -----------------------------------------------------------------------------
function collectTsFiles(dir) {
  const out = [];
  function walk(d) {
    const entries = readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && /\.ts$/.test(e.name)) {
        out.push(full);
      }
    }
  }
  walk(dir);
  return out.sort();
}

function persistSnapshot(tmpDir, dateStr) {
  ensureDir(SNAPSHOT_DIR);
  const tsFiles = collectTsFiles(tmpDir);
  if (tsFiles.length === 0) {
    log("No .ts files found in generate-ts output. Aborting snapshot.");
    return null;
  }
  const header =
    `// Codex schema snapshot ${dateStr} (UTC)\n` +
    `// Source: ${CODEX_BIN} app-server generate-ts --out ./.codex-schema-tmp\n` +
    `// Files: ${tsFiles.length}\n\n`;
  const body = tsFiles
    .map((f) => {
      const rel = f.substring(tmpDir.length + 1).replace(/\\/g, "/");
      return `// ===== ${rel} =====\n${readFileSync(f, "utf8")}\n`;
    })
    .join("\n");
  const snapPath = join(SNAPSHOT_DIR, `${dateStr}.ts`);
  writeFileSync(snapPath, header + body, "utf8");
  log(`Snapshot saved: ${snapPath}`);
  return snapPath;
}

// -----------------------------------------------------------------------------
// 4. 直近の前 snapshot を取得
// -----------------------------------------------------------------------------
function findPreviousSnapshot(currentDateStr) {
  if (!existsSync(SNAPSHOT_DIR)) return null;
  const snaps = readdirSync(SNAPSHOT_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.ts$/.test(f) && f !== `${currentDateStr}.ts`)
    .sort();
  if (snaps.length === 0) return null;
  return join(SNAPSHOT_DIR, snaps[snaps.length - 1]);
}

// -----------------------------------------------------------------------------
// 5. 行ベース簡易 diff（追加・削除のみ列挙）
// -----------------------------------------------------------------------------
function lineDiff(a, b) {
  const aLines = a.split(/\r?\n/);
  const bLines = b.split(/\r?\n/);
  const aSet = new Set(aLines);
  const bSet = new Set(bLines);
  const removed = aLines.filter((l) => !bSet.has(l));
  const added = bLines.filter((l) => !aSet.has(l));
  return { added, removed };
}

function writeDiffReport(prev, current, dateStr) {
  ensureDir(DIFF_DIR);
  const prevTxt = readFileSync(prev, "utf8");
  const currTxt = readFileSync(current, "utf8");
  const { added, removed } = lineDiff(prevTxt, currTxt);

  const lines = [];
  lines.push(`# Codex schema diff ${dateStr} (UTC)`);
  lines.push(`Previous snapshot: ${prev}`);
  lines.push(`Current snapshot:  ${current}`);
  lines.push(`Added lines:   ${added.length}`);
  lines.push(`Removed lines: ${removed.length}`);
  lines.push("");
  lines.push("## Added");
  lines.push("```ts");
  for (const l of added.slice(0, 500)) lines.push(l);
  if (added.length > 500) lines.push(`/* ... ${added.length - 500} more added lines ... */`);
  lines.push("```");
  lines.push("");
  lines.push("## Removed");
  lines.push("```ts");
  for (const l of removed.slice(0, 500)) lines.push(l);
  if (removed.length > 500) lines.push(`/* ... ${removed.length - 500} more removed lines ... */`);
  lines.push("```");

  const diffPath = join(DIFF_DIR, `${dateStr}.diff`);
  writeFileSync(diffPath, lines.join("\n"), "utf8");
  log(`Diff report saved: ${diffPath}`);
  return { added, removed, diffPath };
}

// -----------------------------------------------------------------------------
// 6. breaking change heuristic
//    H1: method 削除 (前 snapshot の `method:"..."` が現 snapshot から消失)
//    H2: 必須フィールド追加 / optional → required 格上げ
//    H3: literal union 縮小（型 narrowing 候補）
//    偽陽性は許容、偽陰性最小化を優先。Issue 起票後、目視判定する運用。
// -----------------------------------------------------------------------------
function detectBreakingChanges({ added, removed, prevTxt, currTxt }) {
  const findings = [];

  // H1
  const methodRe = /["']?method["']?\s*[:=]\s*["']([^"']+)["']/;
  const removedMethods = new Set();
  for (const l of removed) {
    const m = l.match(methodRe);
    if (m) removedMethods.add(m[1]);
  }
  const currentMethods = new Set();
  for (const l of currTxt.split(/\r?\n/)) {
    const m = l.match(methodRe);
    if (m) currentMethods.add(m[1]);
  }
  for (const meth of removedMethods) {
    if (!currentMethods.has(meth)) {
      findings.push({
        rule: "H1",
        severity: "breaking",
        message: `method "${meth}" appears removed (in previous snapshot, absent in current)`,
      });
    }
  }

  // H2
  const requiredPropRe = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*[^?].*[;,]?\s*$/;
  const optionalPropRe = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\?\s*:/;
  const prevPropLines = new Set(prevTxt.split(/\r?\n/).map((l) => l.trim()));
  for (const l of added) {
    const trimmed = l.trim();
    if (optionalPropRe.test(trimmed)) continue;
    if (requiredPropRe.test(trimmed)) {
      const m = trimmed.match(requiredPropRe);
      if (!m) continue;
      const propName = m[1];
      const prevHadOptional = [...prevPropLines].some((pl) =>
        new RegExp(`^${propName}\\?\\s*:`).test(pl),
      );
      if (prevHadOptional) {
        findings.push({
          rule: "H2",
          severity: "breaking",
          message: `property "${propName}" promoted from optional to required: ${trimmed}`,
        });
      } else if (!prevPropLines.has(trimmed)) {
        findings.push({
          rule: "H2",
          severity: "warning",
          message: `new required property line (could be a new interface or a breaking addition): ${trimmed}`,
        });
      }
    }
  }

  // H3
  const unionRe = /(["'][^"']+["'](?:\s*\|\s*["'][^"']+["'])+)/g;
  function extractUnions(text) {
    const map = new Map();
    for (const line of text.split(/\r?\n/)) {
      let m;
      while ((m = unionRe.exec(line))) {
        const literals = m[1]
          .split("|")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .sort();
        const key = literals.join("|");
        map.set(key, new Set(literals));
      }
    }
    return map;
  }
  const prevUnions = extractUnions(prevTxt);
  const currUnionLiterals = new Set();
  for (const set of extractUnions(currTxt).values()) {
    for (const v of set) currUnionLiterals.add(v);
  }
  for (const [, set] of prevUnions) {
    for (const lit of set) {
      if (!currUnionLiterals.has(lit)) {
        findings.push({
          rule: "H3",
          severity: "breaking",
          message: `literal "${lit}" disappeared from union types (possible enum narrowing)`,
        });
      }
    }
  }

  // dedup
  const seen = new Set();
  const dedup = [];
  for (const f of findings) {
    const k = `${f.rule}|${f.severity}|${f.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(f);
  }
  return dedup;
}

function writeBreakingReport(findings, dateStr) {
  ensureDir(DIFF_DIR);
  const path = join(DIFF_DIR, `${dateStr}-breaking.md`);
  const lines = [];
  lines.push(`# Codex schema breaking change candidates ${dateStr} (UTC)`);
  lines.push("");
  lines.push("> Heuristic detection. Review each finding manually before acting.");
  lines.push("> Rules: H1 = method removed, H2 = required field added / optional->required, H3 = literal union narrowed.");
  lines.push("");
  const breaking = findings.filter((f) => f.severity === "breaking");
  const warnings = findings.filter((f) => f.severity === "warning");
  lines.push(`## Breaking (count: ${breaking.length})`);
  if (breaking.length === 0) {
    lines.push("- (none)");
  } else {
    for (const f of breaking) {
      lines.push(`- [${f.rule}] ${f.message}`);
    }
  }
  lines.push("");
  lines.push(`## Warnings (count: ${warnings.length})`);
  if (warnings.length === 0) {
    lines.push("- (none)");
  } else {
    for (const f of warnings.slice(0, 200)) {
      lines.push(`- [${f.rule}] ${f.message}`);
    }
    if (warnings.length > 200) {
      lines.push(`- ... and ${warnings.length - 200} more`);
    }
  }
  writeFileSync(path, lines.join("\n"), "utf8");
  log(`Breaking report saved: ${path}`);
  return { path, breakingCount: breaking.length, warningCount: warnings.length };
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------
function main() {
  log(`Asagi codex schema snapshot start (CODEX_BIN=${CODEX_BIN})`);

  if (!checkCodexInstalled()) {
    log("Codex CLI not found. Skipping (exit 0).");
    log("Set CODEX_BIN_PATH env var if codex is installed but not on PATH.");
    process.exit(0);
  }

  ensureDir(SCHEMA_ROOT);
  ensureDir(SNAPSHOT_DIR);
  ensureDir(DIFF_DIR);

  const dateStr = todayISO();
  const tmpDir = runGenerateTs();
  if (!tmpDir) {
    log("generate-ts execution failed. See output above. Exiting non-zero (1).");
    process.exit(1);
  }

  const snapPath = persistSnapshot(tmpDir, dateStr);
  if (!snapPath) {
    log("Snapshot persistence failed. Exit 1.");
    process.exit(1);
  }

  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 失敗しても致命的ではない
  }

  const prev = findPreviousSnapshot(dateStr);
  if (!prev) {
    log("No previous snapshot found. This is baseline. Exit 0.");
    process.exit(0);
  }

  const { added, removed } = writeDiffReport(prev, snapPath, dateStr);
  const prevTxt = readFileSync(prev, "utf8");
  const currTxt = readFileSync(snapPath, "utf8");
  const findings = detectBreakingChanges({ added, removed, prevTxt, currTxt });
  const { breakingCount, warningCount } = writeBreakingReport(findings, dateStr);

  log(`Summary: ${breakingCount} breaking, ${warningCount} warnings.`);
  if (breakingCount > 0) {
    log("BREAKING change candidates detected. Exit 1.");
    process.exit(1);
  }
  log("No breaking change candidates. Exit 0.");
  process.exit(0);
}

main();
