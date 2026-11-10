# 年度別科目データと履修支援の設計

> **2026-11-07更新:** 年度横断SQLiteと2026年度の基礎カタログを、3,736科目の現行スナップショットから再構築しました。旧2,556科目版はローカルの `data/archive-20261107-pre-v080/` に保存し、過年度候補行と目視レビューの一致を確認しています。旧DBの出典行もバックアップ側で保持します。最新版の内部整合性は合格ですが、過年度・訂正・履修要件の確定作業は未完了で `extensionReady=false` です。以下の旧カタログに関する記述は履歴として参照してください。
>
> **研究データの配布範囲:** SQLite、原PDFキャッシュ、および未確認の抽出候補・コード索引の一部はGitHubと配布ZIPに含めません。以下の研究DB全体の再構築・監査コマンドは、これらの資料が揃った元の研究用ワークスペースで実行してください。GitHubのクローンだけでは必要な入力が不足します。履修区分の小規模な試行DBは、別途 [試行データの手順](CURRICULUM_CANDIDATE_PILOT.md) により原本を取得・照合できます。

## 対応範囲

2022〜2026年度の時間割・訂正資料・学修要覧を年度別に登録できる基盤を追加しました。2022・2023年度は教学課の公式ページと確認できた時間割／訂正PDFの所在を追加し、2024・2025年度の既登録資料も保持しています。2026年度は既存カタログと最新資料の照合を継続中です。年度別の科目行データはまだ全面的に正規化されていないため、ソース登録済みを「科目データ収録済み」とは扱いません。

資料一覧: [`../data/academic-years.json`](../data/academic-years.json)

公式ページの起点は同じ台帳の `officialSourceRoots` に記録しています。教学課トップは今年度の学修要覧、世田谷・横浜ページは最新時間割、学部・大学院アーカイブは過年度の要覧を探す入口です。2026年10月30日に `agent-browser` で世田谷・横浜の時間割ページと最新更新表示を再確認しました。

2022〜2025年度に台帳登録した時間割・訂正資料17件（約26 MB）を [`../data/source-cache/historical/`](../data/source-cache/historical/) に保存し、SHA-256・ファイルサイズ・PDFページ数を [`../data/historical-source-cache-manifest.json`](../data/historical-source-cache-manifest.json) に固定しました。授業時間割7資料の5,829コード×資料組・13,202出現箇所について科目行候補を抽出し、コード索引の出典・ページ・出現数と全件一致することを確認しています。年度横断SQLiteの `course_offering_candidate` に未承認で保存し、541組はレビューキューに残しています。15コード×資料組・23出現行は公式PDFを目視照合し、科目名・担当者・教室を出典ハッシュ付きの補正台帳へ記録しました。教室配置図・WebClass案内の3資料は授業時間割の抽出対象から除外しました。

2026年度の教学課資料24件（約68.8 MB）を [`../data/source-cache/current/2026/`](../data/source-cache/current/2026/) に保存し、台帳に相対パス・SHA-256・サイズ・ページ数を記録しました。時間割6資料から1,885コード×資料組、4,360出現箇所を候補化し、公式コード索引の組・ページ・コード別出現回数と一致することを確認しています。8コード×資料組・12出現行は原PDFを目視照合し、抽出補正と担当者全員を出典ハッシュ付きの別レビュー表に保存しました。これで全1,885組に科目名・担当者・教室候補が揃いました。残るレビューキューは135組（科目名複数候補126、担当者の未解決候補27、未結合出現18件。一部重複）です。これは抽出値の修理であり、科目データの承認ではありません。候補は正規の `course_offering` へ昇格していません。

現行カタログ品質監査は `NOT_READY_FOR_RELEASE` のままです。既存2026年度スナップショットが92日古く、公式コード×資料1,186組が既存スナップショットに見当たりません。年度横断SQLiteの内部整合性は合格していますが、拡張反映のゲートは閉じたままです。

年度横断SQLite schema v8 の `candidate_row_evidence` は2022〜2026年度の全PDF出現行を原文と自動抽出値のまま保持します。目視補正は `candidate_row_review` と `candidate_row_review_instructor` に分けるため、複数担当者を同じ科目行の下で検索できます。`reviewed_room_status` は、教室が記載されている行と原本で空欄の行を区別します。科目名と担当者の候補一覧を独立に組み合わせると、観測行にない組み合わせを含む候補組が144件あります。学年欄・クォーター欄の混入として見つかった歴史年度22組・2026年度1組はレビューキューへ送り、同名検索から除外しています。この除外後、同名科目に複数担当者が現れる候補グループは711件です。同名・担当者検索にはレビュー行テーブルと自動抽出行テーブルを統合したクエリを使います。

履修要覧と年度間科目対応の正規化モデルは [`CURRICULUM_DATABASE_DESIGN.md`](CURRICULUM_DATABASE_DESIGN.md) に定義しています。schema v1の21表は年度横断SQLiteへ導入済みですが、要覧の要求事項・科目対応データは原本の適用年度と根拠ページを確認するまで登録していません。

2024年度の公式世田谷時間割43ページでは、同名の「マーケティングリサーチ演習(2)」をコード別に保持しています。`sba514202` は坂倉 杏介・西山 敏樹・永江 総宜・鹿野 由利子、教室71A。`sbz514204` は坂倉 杏介・西山 敏樹・永江 総宜・岡澤 由季・北見 幸一・鹿野 由利子・林 和眞、教室71A(3Q),71B(4Q)です。どちらも目視確認済みですが、候補データのままで正規カタログへは未昇格です。

再生成・レビューキューは `python data/extract_historical_offering_candidates.py`、`python data/build_historical_candidate_review_queue.py`、`python data/extract_all_fall_candidates.py`、`python data/build_all_candidate_review_queue.py` の順に実行します。年度横断SQLiteの再構築では `--output` に新規ファイルを指定します。

再取得・再生成・監査はプロジェクトルートで次の順に実行します。

```powershell
python -m pip install -r requirements-data.txt
python data/fetch_historical_sources.py
python data/fetch_current_sources.py
python data/extract_historical_code_index.py
python data/extract_historical_offering_candidates.py
python data/build_historical_candidate_review_queue.py
python data/extract_all_fall_candidates.py
python data/extract_timetable_corrections.py
python data/profile_study_guides.py
python data/build_all_candidate_review_queue.py
python data/build_course_catalog.py --output-root tmp/catalog-rebuilt
python data/build_multiyear_database.py --base-database tmp/catalog-rebuilt/data/course-catalog-2026.sqlite --output tmp/catalog-rebuilt/data/course-catalog-multiyear.sqlite
python data/build_extension_course_data.py --database tmp/catalog-rebuilt/data/course-catalog-multiyear.sqlite --output tmp/catalog-rebuilt/data/historical-course-row-evidence.json
python data/audit_historical_sources.py
python data/audit_course_catalog_quality.py --database tmp/catalog-rebuilt/data/course-catalog-2026.sqlite --output-root tmp/catalog-rebuilt/audit
python data/audit_multiyear_database.py --database tmp/catalog-rebuilt/data/course-catalog-multiyear.sqlite --catalog-audit tmp/catalog-rebuilt/audit/data/course-catalog-quality-audit-2026.json --report-json tmp/catalog-rebuilt/audit/data/multiyear-database-audit.json --report-md tmp/catalog-rebuilt/audit/docs/MULTIYEAR_DATABASE_AUDIT.md
```

取得スクリプトは台帳URLからPDFを取り直し、PDF形式を確認してから原子的に保存します。抽出器は保存済みハッシュが一致することを先に確認し、コードごとに出典ページと原文抜粋を記録します。DB再構築では既存ファイルを上書きしません。監査後、元DBに独自に追加したデータの移行を確認してから新しいDBを採用してください。

2026年度後期の訂正表は、PDFの表罫線を使って同じ行から講義コード・科目名・訂正内容を抽出します。訂正日は世田谷では行の変更日欄、横浜では表の直前の見出しを使います。抽出結果には原表ページと行範囲（左・上・右・下、単位はPDFポイント）を保存します。担当教員の削除と科目の非開講・開講中止を区別し、訂正候補は基礎時間割へ自動適用しません。

## データの粒度

- **開講科目**: `(academicYear, courseCode)`。教員・曜日時限・教室は年度ごとに変化しうる属性です。
- **カリキュラム版**: `(admissionYear, program, degreeLevel, campus)`。履修要件は授業の開講年度ではなく、原則として学生の入学年度に対応する学修要覧・教育課程表へひも付けます。
- **年度間の科目対応**: 根拠資料と確認状態を持つ別テーブルで管理します。科目コードや名称の一致だけで同一科目と断定しません。
- **履修者の進捗**: 将来実装時に公開カタログから分離し、本人が確認・修正できる保管単位にします。WebClassの成績や認証情報を公開カタログへ取り込みません。

## 履修支援に進む際の必須データ

各カリキュラム版に、必修／選択区分、必要単位、科目群、履修前提、進級・卒業要件、適用入学年度、出典PDFのページ、訂正履歴を持たせます。要覧PDFのページ索引は検索の補助であり、要件の意味を抽出した証明にはなりません。規則は原資料との二者照合が済むまで「未確認」と表示します。

## 公開資料の起点

- [2022年度 世田谷時間割](https://www.asc.tcu.ac.jp/3606/) / [2022年度 横浜時間割PDF](https://www.asc.tcu.ac.jp/wp-content/uploads/2022/09/427f45b995e5d588c12ed4ca079abef7-1.pdf)
- [2023年度 世田谷時間割](https://www.asc.tcu.ac.jp/4571/) / [横浜時間割](https://www.asc.tcu.ac.jp/4233/)
- [2024年度 世田谷時間割](https://www.asc.tcu.ac.jp/5680/) / [横浜時間割](https://www.asc.tcu.ac.jp/5656/)
- [2025年度 世田谷時間割](https://www.asc.tcu.ac.jp/6509/) / [横浜後期時間割](https://www.asc.tcu.ac.jp/7176/)
- [学部学修要覧の過年度一覧](https://www.asc.tcu.ac.jp/syllabus_archives/) / [大学院学修要覧の過年度一覧](https://www.asc.tcu.ac.jp/syllabus_grad_archives/)

## 品質ゲート

年度・キャンパス・学部／大学院・学期ごとに出典PDFのハッシュ、ページ範囲、行抽出率、コード重複、教員／時限の矛盾、訂正適用状況を記録します。抽出候補を正規カタログに昇格する前に、公式原表との照合と訂正資料の適用を完了します。年度の一部しか揃っていない場合は、その対象範囲を画面・データ双方で明示します。
