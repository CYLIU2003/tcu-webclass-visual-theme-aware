# 科目カタログ品質監査（2026-10-30）

判定: **NOT_READY_FOR_RELEASE**

## チェック結果

| 項目 | 結果 | 根拠 |
|---|---|---|
| registered_source_files_integrity | pass | `{"officialSources": 24, "cacheMissing": [], "hashOrSizeMismatch": [], "pageCountMismatchOrUnreadable": []}` |
| base_snapshot_freshness | fail | `{"snapshotGeneratedAt": "2026-07-30T03:29:11+00:00", "auditRunAt": "2026-10-30T06:43:08+00:00", "officialSourcesCheckedOn": "2026-10-28", "ageDays": 92}` |
| offering_primary_key_unique | pass | `{"rows": 2556, "uniqueKeys": 2556, "duplicates": 0}` |
| official_code_index_integrity | pass | `{"codeSourcePairs": 1885, "uniqueCodes": 1847, "invalidCodesOrSources": 0, "duplicatePairs": 0, "invalidPages": 0, "snippetsMissingCode": 0}` |
| official_to_base_code_coverage | fail | `{"sourceCodePairs": 1885, "matchedPairs": 699, "unmatchedPairs": 1186, "unmatchedPairRate": 0.6292, "distinctUnmatchedCodes": 1186}` |
| official_to_staging_candidate_coverage | pass | `{"officialCodeSourcePairs": 1885, "candidateCodeSourcePairs": 1885, "officialOccurrences": 4360, "candidateOccurrences": 4360, "stagedRowsRemainProvisional": true, "mismatches": []}` |
| correction_event_provenance | pass | `{"events": 69, "invalidCodeOrExcerpt": 0, "invalidSource": 0, "missingDate": 0, "invalidPage": 0, "prematurelyApplied": 0, "unmatchedToBaseOfferings": 59}` |
| study_guide_page_index_integrity | pass | `{"guides": 11, "pages": 1026, "badProfiles": [], "interpretation": "keyword navigation only; not validated course requirements"}` |
| multi_year_registry_and_cohort_model | pass | `{"academicYears": [2022, 2023, 2024, 2025, 2026], "timetableLandingUrls": 10, "missingGuideOrTimetableYears": [], "historicalTimetableFiles": 10, "historicalCorrectionFiles": 7, "officialRootPagesRecorded": 3, "currentRootsMatchYearRegistry": true, "offeringKey": ["academicYear", "courseCode"], "curriculumVersionKey": ["admissionYear", "program", "degreeLevel", "campus"], "courseRowsNormalizedForHistoricalYears": false}` |
| fall_pdf_candidate_extraction_calibration | pass | `{"sourceId": "schedule-setagaya-undergrad-fall-2026", "candidateCodes": 1305, "rowOccurrences": 3038, "codeCellAnchoredRows": 2988, "baseComparableCodes": 134, "titleAgreements": 124, "instructorOverlaps": 133, "titleConflicts": 111, "instructorConflicts": 22, "promotionAllowed": false, "reason": "Candidate parser calibration does not validate all rows or correction semantics."}` |
| sqlite_referential_integrity | pass | `{"foreignKeyViolations": 0, "tableCounts": {"source_document": 29, "course_offering": 2556, "official_timetable_code_evidence": 1885, "correction_event": 69, "study_guide_term_page": 1030}}` |

## リリース阻害事項

- 2026年度後期の全6公式PDFについて候補行は揃ったが、1,885コード×資料組は未確定候補で、135組は空欄・複数候補・未結合出現を含む。訂正の反映と原表照合が未完了。
- 基礎カタログは2026-07-30生成で、秋の公式資料を反映した授業行データへ更新していない。
- 59/69件の訂正イベント候補は基礎カタログに該当講義コードがなく、変更内容を適用していない。
- 2022〜2025年度は5,829組の候補を保存したが、541組の原表確認・訂正反映と正規化済み開講行の作成が未完了。
- 学修要覧の索引は語句ページ検索であり、履修要件の意味抽出・年度別検証をしていない。

## 判断

出典ファイル・キー・ページ・参照整合性の機械チェックは確認可能な範囲で合格しました。ただし、これは最新カタログの正確性を証明しません。後期PDFの表を授業行へ構造化して原表と照合し、訂正差分と履修要件を確認するまで、学生向けの確定データとして配布しないでください。
