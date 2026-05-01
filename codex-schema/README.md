# codex-schema/

Asagi (PRJ-018) における **Codex CLI JSON-RPC schema の自動 snapshot + 差分検知** の出力先ディレクトリです。RAs-14（Codex CLI schema 変動追随リスク）の緩和策。

## このディレクトリの位置づけ

| ディレクトリ | 内容 | コミット対象 |
|---|---|---|
| `snapshots/YYYY-MM-DD.ts` | `codex app-server generate-ts` を実行して取得した TS 型定義の凍結ファイル（UTC 日付）| Yes |
| `diffs/YYYY-MM-DD.diff` | 直近の前 snapshot との行ベース diff（追加・削除のみ）| Yes |
| `diffs/YYYY-MM-DD-breaking.md` | breaking change 候補のヒューリスティック検知レポート | Yes |
| `.codex-schema-tmp/` | スクリプト実行中の作業ディレクトリ（実行後に削除）| No (gitignore 推奨) |

## 何のためのディレクトリか

Codex CLI は OpenAI 公式が **週 1 程度のペースで minor/major release** を出しており、JSON-RPC `app-server` の method 名・params schema・notification 型が breaking change を含む可能性があります（リサーチ v2 § 1.4 / RAs-14）。

Asagi は app-server プロトコルに**直接依存**しているため、schema 変更を**自動で検知できる仕組みを CI に組み込まない限り、ユーザ環境で「ある日突然動かなくなる」リスクが高い**状態です。

このディレクトリは「最後に正しく動作した版の schema」を凍結保存し、週次で最新版と比較することで、リリース直後にも気付けるようにします。

## snapshots/ と diffs/ の関係

```
snapshots/2026-05-02.ts    <-- ベースライン (POC 通過時に凍結する想定)
snapshots/2026-05-09.ts    <-- 1 週後の自動取得
diffs/2026-05-09.diff      <-- 2026-05-02 との行 diff
diffs/2026-05-09-breaking.md <-- heuristic で抽出した breaking 候補
```

snapshots は「Asagi が動作確認済みの schema」のリビジョン履歴、diffs は「次に Asagi 側で対応すべきポイント」のメモです。

## breaking 検知時のオーナー対応フロー

CI が `breaking change candidates` を検知すると、以下が自動実行されます:

1. GitHub Actions が `[codex-schema] Breaking change detected (YYYY-MM-DD)` という Issue を起票
2. Issue 本文に `diffs/YYYY-MM-DD-breaking.md` の中身を貼付
3. snapshot / diff / breaking report が artifact として upload される

オーナー（または CEO 経由で開発部門）の対応:

1. **Issue を確認**し、breaking 候補が**真に breaking か偽陽性か**を目視判定
   - heuristic は H1 (method 削除) / H2 (required field 追加) / H3 (literal union 縮小) の 3 ルールで検知。偽陽性は許容する設計
2. **真 breaking と判定したもの**:
   - `app/asagi-app/src-tauri/src/codex_sidecar/protocol.rs` の method/event 定数を更新
   - `mock_server.rs` / `mock.rs` の dispatch 体系を追従
   - 必要に応じて Real impl 側の型定義を再生成
   - DEC を起票（breaking 内容と Asagi 側対応を記録）
3. **偽陽性のもの**:
   - Issue にコメント残してクローズ（運用ログとして diff 履歴は保持）
4. **判定が難しいもの**（reasoning effort や experimental field 等）:
   - リサーチ部門に再調査依頼

## 手動実行手順

```bash
cd projects/PRJ-018/app/asagi-app
node scripts/codex-schema-snapshot.mjs
# Codex バイナリのパスを上書きする場合:
CODEX_BIN_PATH=/path/to/codex node scripts/codex-schema-snapshot.mjs
```

実行結果:
- `codex-schema/snapshots/YYYY-MM-DD.ts` が生成される
- 直前の snapshot がある場合は `codex-schema/diffs/YYYY-MM-DD.diff` と `YYYY-MM-DD-breaking.md` も生成される
- exit code: 0 = 問題なし、1 = breaking 候補あり または generate-ts 失敗、Codex CLI 未インストール時は exit 0 で skip

## 初回 baseline について

初回 snapshot は CI 初回実行時または開発機での手動実行時に生成されます。Phase 0 POC 通過時点のものを正式 baseline として確定し、それ以降の diff を Asagi 側の追従根拠とする運用を推奨します（DEC として起票候補）。

## 参照

- `projects/PRJ-018/reports/research-report-v2.md` § 主要発見 2 / § 5.6
- `projects/PRJ-018/reports/research-report-v2-addendum-generate-ts.md` (本ディレクトリと同セットで作成)
- `projects/PRJ-018/reports/research-generate-ts-ci-implementation.md`
- `projects/PRJ-018/decisions.md` DEC-018-022 / DEC-018-023
- `projects/PRJ-018/risks.md` RAs-14
- 公式: [App Server – Codex (OpenAI Developers)](https://developers.openai.com/codex/app-server)
- 公式: [codex/codex-rs/app-server/README.md](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
