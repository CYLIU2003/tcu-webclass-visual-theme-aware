# 拡張機能と年度横断DBの連携

## 配布データ

拡張機能はSQLiteを直接開きません。年度横断DB `data/course-catalog-multiyear.sqlite` を正本とし、ビルド時に拡張機能用の小さなJSON `data/historical-course-row-evidence.json` へ必要な過年度証拠だけを書き出します。

書き出すのは2022〜2025年度のうち、状態が `visually-reviewed-provisional`、確認方法が `official-pdf-visual-inspection` の行です。今回の収録は2022・2024・2025年度の15掲載例、23出現です。未確認の自動抽出候補は配布JSONへ入れません。これらの行は時間割PDFで確認した表記の証拠であり、年度間で同一科目だと承認された関係ではありません。

GitHubの拡張機能リポジトリには、拡張機能のソース、実行用JSON、検証コード、導入・データ範囲の説明を収録します。年度横断SQLite、元PDFのキャッシュ、未確認の抽出候補キューは含めません。コミット済みJSONからの配布ZIP生成は再現できます。SQLiteから過年度JSONを再出力する場合は、別途監査済みの年度横断DBが必要です。

科目詳細では、講義コード一致を「同じ講義コード」、完全一致の科目名だけで見つかった別コードを「同名・別コード（同一科目か未判定）」として表示します。教員と教室は各行の記録内に保ち、同名行を一つにまとめません。参照元PDFへのページリンクも添えます。

2026年度の2,556科目は既存スナップショットのままです。過年度の参考例を追加しても、現行時間割への照合完了や履修要覧の要件登録を意味しません。ポップアップ、設定画面、初回ガイドでこの品質状態を説明します。

## 再生成

プロジェクトルートで実行します。

```powershell
python data/build_multiyear_database.py
python data/audit_multiyear_database.py
python data/build_extension_course_data.py
python tests/build_live_dom_preview.py
python tests/build_guide.py
```

年度横断DB監査で失敗があれば、配布用ファイルを作る前にその不整合を修正します。エクスポーターはDB schema v8、外部キー、出典PDFのハッシュ・URL・ページを検証し、出力ファイルを一時ファイルから原子的に置き換えます。

## 更新確認

```powershell
python tests/validate.py
node --check src/content.js
node --check src/popup.js
node --check src/options.js
node tests/test_normalization.mjs
python tests/test_live_dom.py
```

WebClassの実画面で確認するときは、更新後の拡張機能を読み込み、開いているWebClassタブを更新します。カードの「詳細を見る」から過年度例がある科目だけを確認できます。

## 配布ZIPの再生成

データ出力・プレビュー・初回ガイドを更新し、検証を通した後にプロジェクトルートで実行します。

```powershell
python scripts/package_extension.py
```

`TCU_WebClass_Visual_Theme_Aware_v0.5.0.zip` とSHA-256チェックサムをプロジェクトの親フォルダーへ作成します。ZIPには拡張機能が実行時に必要とするファイル、初回ガイド、データ範囲の説明だけを収録します。SQLite、未確認の抽出候補、元PDFキャッシュは含めません。スクリプトはManifestの参照先とZIP全体を検査し、過年度行の確認状態・年度・件数も検証します。
