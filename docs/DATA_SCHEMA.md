# 時間割データ仕様（Schema Version 2）

`data/timetable-2026.json` は、2026年度の学部・大学院時間割を講義コード単位で統合したデータです。

## ルート

```json
{
  "schemaVersion": 2,
  "dataset": {
    "id": "tcu-2026-all-departments-timetable",
    "title": "2026年度 東京都市大学 全学部・全研究科 授業時間表",
    "academicYear": 2026,
    "scope": {
      "timetablePages": 196,
      "rawOccurrences": 10077,
      "uniqueCourses": 3736,
      "sourceDocuments": [],
      "departments": [],
      "campuses": []
    },
    "periodProfiles": {}
  },
  "courses": []
}
```

## Course

```json
{
  "academicYear": 2026,
  "semester": "前期",
  "semesters": ["前期"],
  "termBlock": "前期後",
  "termBlocks": ["前期後"],
  "courseName": "パワーエレクトロニクス特論",
  "aliases": [],
  "courseCode": "smaa030081",
  "instructors": ["鈴木 憲吏"],
  "meetings": [
    {
      "day": "月",
      "period": 2,
      "termBlock": "前期後",
      "room": "12K",
      "rooms": ["12K"],
      "campus": "世田谷キャンパス",
      "timeProfile": "standard",
      "startsAtNine": false,
      "sources": []
    }
  ],
  "scheduleTypes": ["regular"],
  "level": "大学院",
  "departments": [
    {"code": "院総", "label": "総合理工学研究科", "sourceGroup": "総合理工学研究科"}
  ],
  "campuses": ["世田谷キャンパス"],
  "category": "専門科目",
  "notes": ["対開講(月2,木2)"],
  "sources": []
}
```

## 重要な仕様

- `courseCode` が主キーです。科目名だけで一意性を仮定しません。
- 教室は `meetings` 単位で保持します。曜日・クラスごとに異なる教室へ対応します。
- `rooms` が複数の場合は、クラス別または掲載上の複数候補です。
- `meetings` が空でも正規データです。集中講義、研究、時間外実施などを表します。
- `scheduleTypes` は `regular`、`intensive`、`all-year`、`irregular` を使用します。
- `timeProfile` は通常時限と共同原子力専攻の時限差を区別します。
- `startsAtNine` は、学部時間割の「9:00開始」欄を保持します。
- `departments` は複数学科への掲載を保持します。
- `sources` には資料名とページ番号を残し、抽出根拠を追跡できます。
- `source` / `sources` は `id`・`document`・`url`・`pages` を保持します。元PDFのハッシュは `dataset.scope.sourceDocuments` に保存します。
- 科目の `rooms` は週間枠があれば訂正後の教室一覧です。週間枠がない科目でも原資料に教室があれば保持します。
- `changes` に変更一覧の原文・出典・処理区分を保持します。条件付き変更や特定日の情報は `notes` でも確認できます。
- 取り消し科目は本体の `courses` に入れず、抽出レポートの `withdrawnCourses` に保存します。

## 年度横断DBの同名科目・担当者検索

名前と担当者は、同一PDF掲載行で観測された組み合わせとして検索します。別々に抽出した氏名と科目名の候補を掛け合わせず、目視確認行を優先します。数字やクォーター表示を科目名と誤認した候補はレビュー対象とし、名前検索では除外します。検索結果は未承認の掲載候補です。

```sql
WITH searchable AS (
  SELECT c.academic_year, c.course_code, c.source_id, r.source_page, r.source_line,
         v.reviewed_title AS title, v.reviewed_title_key AS title_key,
         i.instructor_name, i.name_key AS instructor_key
  FROM candidate_row_review v
  JOIN candidate_row_evidence r USING(candidate_id, occurrence_ordinal)
  JOIN candidate_row_review_instructor i USING(candidate_id, occurrence_ordinal)
  JOIN course_offering_candidate c USING(candidate_id)
  UNION ALL
  SELECT c.academic_year, c.course_code, c.source_id, r.source_page, r.source_line,
         r.title, r.title_key, r.instructor_name, r.instructor_key
  FROM candidate_row_evidence r
  JOIN course_offering_candidate c USING(candidate_id)
  LEFT JOIN candidate_row_review v USING(candidate_id, occurrence_ordinal)
  WHERE v.candidate_id IS NULL AND r.title <> '' AND r.instructor_name <> ''
)
SELECT * FROM searchable
WHERE academic_year = ? AND title_key = ? AND instructor_key = ?
  AND title_key NOT IN ('1', '2', '3', '4', '1q', '2q', '3q', '4q');
```

同じ名称に複数の担当者が掲載された候補を調べる場合も、同じ行単位の組と除外条件を使います。

```sql
WITH pairs AS (
  SELECT r.academic_year, v.reviewed_title_key AS title_key, i.name_key AS instructor_key
  FROM candidate_row_evidence r
  JOIN candidate_row_review v USING(candidate_id, occurrence_ordinal)
  JOIN candidate_row_review_instructor i USING(candidate_id, occurrence_ordinal)
  UNION ALL
  SELECT r.academic_year, r.title_key, r.instructor_key
  FROM candidate_row_evidence r
  LEFT JOIN candidate_row_review v USING(candidate_id, occurrence_ordinal)
  WHERE v.candidate_id IS NULL
)
SELECT academic_year, title_key, COUNT(DISTINCT instructor_key) AS teacher_count
FROM pairs
WHERE title_key <> '' AND instructor_key <> ''
  AND title_key NOT IN ('1', '2', '3', '4', '1q', '2q', '3q', '4q')
GROUP BY academic_year, title_key HAVING COUNT(DISTINCT instructor_key) > 1;
```
