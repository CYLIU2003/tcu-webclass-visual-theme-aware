# 2026年度 公開時間表の収録状況

確認日: 2026-10-15。公式の学部・大学院、前期・後期・通年の公開時間表を講義コードで統合しました。

- 現在の収録: **3,736科目**（学部3,467、大学院269）
- 時間表12PDFと変更一覧6PDF。時間表の講義コードを含む196頁、10,077掲載箇所を抽出。掲載箇所は同じ科目の対開講・別名・複数学科・資料重複を含むため、科目数とは異なります。
- 前期PDF内の暫定後期を除き、8,644掲載箇所を統合対象として照合。後期は後期版PDFを優先。
- 全12時間表のコード抽出漏れは0件。現行学期の全コードについて、収録済みまたは公式に開講中止を確認。
- 訂正情報238件を保存。変更一覧だけにある追加3科目も収録。開講中止8科目は通常のデータから除き、監査用レポートへ保存。

## 対象資料

公開元: [世田谷・大学院](https://www.asc.tcu.ac.jp/7567/)、[横浜・前期](https://www.asc.tcu.ac.jp/7580/)、[横浜・後期](https://www.asc.tcu.ac.jp/8007/)。

| 時間表 | 抽出頁数 | 原資料の異なるコード数 | 掲載箇所 | 未抽出コード |
|---|---:|---:|---:|---:|
| [世田谷キャンパス・学部・前期](https://www.asc.tcu.ac.jp/wp-content/uploads/2026/04/bdd00cb5d971b29dcea530b6758858ef.pdf) | 59 | 1347 | 2,677 | 0 |
| [世田谷キャンパス・学部・後期](https://www.asc.tcu.ac.jp/wp-content/uploads/2026/04/63645e5e27f2b67bd54fe4fbf71e6ed9.pdf) | 63 | 1304 | 3,038 | 0 |
| [横浜キャンパス・学部・前期](https://www.asc.tcu.ac.jp/wp-content/uploads/2026/05/9c74fabca74255b40c7b0937b4083631.pdf) | 36 | 1090 | 2,394 | 0 |
| [横浜キャンパス・学部・後期](https://www.asc.tcu.ac.jp/wp-content/uploads/2026/09/0a9c574cbf104dc50b2678fe33f1dc55.pdf) | 14 | 413 | 1,005 | 0 |
| [総合理工学研究科・前期](https://www.asc.tcu.ac.jp/wp-content/uploads/2026/04/45f62652853be3c046219378c75c02e4.pdf) | 6 | 192 | 314 | 0 |
| [総合理工学研究科・後期](https://www.asc.tcu.ac.jp/wp-content/uploads/2026/09/fb6e01051e507fba8682b137a39a7151.pdf) | 3 | 102 | 164 | 0 |
| [環境情報学研究科・都市生活学専攻・前期](https://www.asc.tcu.ac.jp/wp-content/uploads/2026/03/a4da3651bc4018e9dc16f2311af941b4.pdf) | 4 | 63 | 150 | 0 |
| [環境情報学研究科・都市生活学専攻・後期](https://www.asc.tcu.ac.jp/wp-content/uploads/2026/09/87e1e51603db9ddc780e1433cfdc3625.pdf) | 2 | 28 | 66 | 0 |
| [環境情報学研究科・前期](https://www.asc.tcu.ac.jp/wp-content/uploads/2026/04/20ef6bb7920bc38870a5898b50e40f74-1.pdf) | 4 | 63 | 147 | 0 |
| [環境情報学研究科・後期](https://www.asc.tcu.ac.jp/wp-content/uploads/2026/09/6182ba786547bd1f1b4947262c64221f.pdf) | 2 | 28 | 66 | 0 |
| [情報データ科学研究科・前期](https://www.asc.tcu.ac.jp/wp-content/uploads/2026/04/8f0e6e5654ede6e1d81aee0e7c74d4ea.pdf) | 2 | 19 | 37 | 0 |
| [情報データ科学研究科・後期](https://www.asc.tcu.ac.jp/wp-content/uploads/2026/09/f3b503ba92b2d5a2e42ffe86157093bd.pdf) | 1 | 10 | 19 | 0 |

12はPDFファイルの数です。環境情報学研究科と都市生活学専攻の資料などは同じ科目を重複掲載しており、独立した12区分を意味しません。科目は講義コードで一意に保存しています。

## 取り込みと更新の規則

- 罫線と講義コードの座標で科目を分け、列ごとの結合セルを扱います。改行された科目名・教員名・教室を単純な行番号で結合しません。
- PDF内の「学期」欄を使います。講義コードの文字だけで前期・後期を決めません。
- 同じコードが別キャンパスや別研究科の冊子にもある場合は、開講元の時間表を優先。二次掲載の内容は extraction-report.json の secondaryListings に残し、教室を混ぜません。
- 曜日別・Q別の教室変更は該当する枠に反映。集中へ変更された科目には通常の週間枠を作りません。特定日や受講対象・言語の条件は変更原文を備考にも保存します。
- 「9:00開始」と共同原子力専攻の時限を保持。通常枠がない研究・集中講義も科目として保持します。
- 個人の履修情報はデータベースへ保存しません。画面にはWebClass標準の時間割にある科目のみ表示します。

## 空欄と対象外

- 固定の週間枠なし: **432科目**。集中講義・研究等を含みます。
- 固定教室の記載なし／未定: **520科目**。週間枠がない科目も含みます。
- 担当未定: **2科目**（sba132210、sbb515315）。別の教員を推測して埋めていません。
- 公開時間表にない非公開コース、今後の追加、WebClassだけのお知らせ、休講のリアルタイム同期は対象外です。集中講義の特定日程は備考・公式資料で確認してください。
- 以前のデータにあった ybz617001（生態環境実習）は暫定後期にのみ掲載。現在の後期時間表にないため現行データへ持ち越していません。開講中止と推測したものではありません。

## 保存場所と再生成

- data/timetable-2026.json: 現行データ。旧8科目補完も統合済み。拡張機能・設定・ポップアップはこの1ファイルを読む。
- data/extraction-report.json: 資料ごとの全コード、採用学期、暫定後期、抽出漏れ、開講中止、二次掲載。
- data/timetable-changes-2026.json: 全訂正の原文・出典頁・処理区分。
- scripts/timetable-sources-2026.json: URLと確認日。各PDFのSHA-256は本体データに保存。
- 以前の timetable-2026-fall-supplement.json と build-fall-supplement.mjs は8科目の確認記録として残しています。現行読込には使いません。

```powershell
python -m pip install -r scripts/requirements-timetables.txt
python scripts/fetch-timetable-sources.py
python scripts/extract-timetables.py
python scripts/extract-timetable-changes.py
python scripts/build-timetables.py
python scripts/report-timetable-coverage.py
python tests/validate.py
node tests/test_full_data.mjs
```

抽出キャッシュ・ダウンロードしたPDFは tmp/timetable-sources/ に置きます。再実行時にPDFのハッシュが同じならセル抽出を再利用します。確認日や資料が変わった場合は一覧を見直してから再生成します。
