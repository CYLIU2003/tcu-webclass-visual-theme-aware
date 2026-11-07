# 年度横断データベースと拡張機能の連携

## 公開データと状態

年度横断SQLiteを元データとし、拡張機能には必要な行証拠だけをJSONとして書き出します。拡張機能はSQLiteやPDFキャッシュを直接読み込みません。

| 項目 | 内容 |
|---|---|
| 過年度（2022〜2025年度） | 公式時間割PDF 7資料 / PDF掲載行 13,202行（目視確認 23行、未確認候補 13,179行、集約 6,447行） |
| 2026年度後期・通年候補 | 公式時間割PDF 6資料 / PDF掲載行 4,360行（目視確認 12行、未確認候補 4,348行、集約 2,053行、候補ペア 1,885組）。1,186組未収録は旧2,556科目版との照合結果 |
| 2026年度時間割訂正表候補 | 公式訂正表PDF 4資料 / 訂正候補イベント 69件（すべて自動未適用・出典PDF抜粋とページリンク付き） |
| 2026年度公式履修要覧・教育課程表案内 | 履修要覧PDF 11冊（計 1,026頁・用語索引 1,030件 / 447頁）＋大学院教育課程表PDF 3資料 |
| 正規化済み・承認済みの過年度開講科目 | 0件 |
| 履修要覧の確定要件データ | 未登録（0件） |

年度ごとの行数、ページ、講義コード、PDF URL、SHA-256は `data/historical-course-row-evidence.json` に含まれています。23行は担当・教室・科目名の行をPDFで確認した参考記録です。その他は抽出候補のまま保持し、カードに確認状態を表示します。抽出候補の正確性は保証しません。

同じ科目名で講義コードや担当が異なる候補を別々の行として保持します。講義コード一致は「年度間で同じ科目」と認定する意味ではなく、同名・別コードも同一科目と推定しません。教室・曜日・時限も候補欄として示し、元のPDFページへのリンクを付けます。履修判断には最新の公式資料を使ってください。

## データの分離

- `course_offering`: 年度横断SQLite内の旧2026年度スナップショット2,556科目。拡張機能の `timetable-2026.json` は別途再抽出した3,736科目であり、照合値を混同しません。
- `course_offering_candidate` / `candidate_row_evidence`: 過年度PDFから抽出した未承認の候補。確定カタログとは別に保存します。
- `candidate_row_review`: PDFの行を目視した限定的な確認記録。自動抽出行を承認済みに変更する用途ではありません。
- `curriculum_*`: 履修要覧を将来取り込むためのスキーマ。現時点の要件行は0件です。

履修支援を実装するときは、開講年度と入学年度別の履修要覧を分け、PDFページ・ファイルハッシュ・確認状態を要件ごとに持たせます。学生個人の履修進捗は公開カタログから分離します。

## 再生成と検証

過年度JSONは、schema v8の監査済み年度横断SQLiteから生成します。SQLiteと原PDFキャッシュはこの拡張機能リポジトリには含めていないため、生成時はフルデータ作業環境のDBパスを渡します。

```powershell
python data/build_extension_course_data.py --database "C:\path\to\course-catalog-multiyear.sqlite"
python tests/validate.py
node --check src/content.js
node --check src/popup.js
node --check src/options.js
node tests/test_normalization.mjs
python tests/build_live_dom_preview.py
python tests/test_live_dom.py
python tests/build_guide.py
python scripts/package_extension.py
```

フルデータ作業環境では、SQLiteを書き出す前にデータベース生成と監査を実行します。

```powershell
python data/build_multiyear_database.py --output data/course-catalog-multiyear-rebuilt.sqlite
python data/audit_multiyear_database.py --database data/course-catalog-multiyear-rebuilt.sqlite --report-json data/rebuilt-audit.json --report-md docs/REBUILT_DATABASE_AUDIT.md
```

再構築は新規ファイルに行い、既存DBへの上書きは拒否します。監査後、追加・確認済みデータの移行を確認してから利用してください。

`build_extension_course_data.py` はDB schema、外部キー、公式HTTPS出典、SHA-256、PDFページ範囲、行位置、目視確認状態、年度別件数を検査してから、JSONを一時ファイル経由で更新します。テストとパッケージ作成は、13,202行の件数、全4年度の範囲、23行の目視確認数、同名・別講義コードの分離を再確認します。

## 配布ZIP

`scripts/package_extension.py` はソースとJSONから、再現可能な `TCU_WebClass_Visual_Theme_Aware_v0.7.1.zip` とSHA-256ファイルを作成します。ZIPには拡張機能の実行ファイル、過年度行証拠、初回導入ガイド、データ範囲の説明を入れます。年度横断SQLiteや原PDFキャッシュは含めません。
