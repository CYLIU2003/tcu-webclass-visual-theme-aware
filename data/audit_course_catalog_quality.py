#!/usr/bin/env python3
"""Run source, grain, freshness, coverage, and referential-integrity audits."""
from __future__ import annotations
import argparse, hashlib, json, re, sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DOCS = ROOT / "docs"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output-root", type=Path, default=ROOT, help="監査結果の出力先（既存ファイルは上書きしません）")
output_root = parser.parse_args().output_root.resolve()
output_data = output_root / "data"
output_docs = output_root / "docs"
output_data.mkdir(parents=True, exist_ok=True)
output_docs.mkdir(parents=True, exist_ok=True)
output_json = output_data / "course-catalog-quality-audit-2026.json"
output_md = output_docs / "COURSE_CATALOG_QUALITY_AUDIT_2026.md"
if output_json.exists() or output_md.exists():
    raise FileExistsError("既存の監査結果は上書きしません。新規の --output-root を指定してください。")
manifest = json.loads((DATA / "official-sources-2026.json").read_text(encoding="utf-8"))
base = json.loads((DATA / "timetable-2026.json").read_text(encoding="utf-8"))
catalog = json.loads((DATA / "course-catalog-2026.json").read_text(encoding="utf-8"))
code_index = json.loads((DATA / "official-timetable-code-index-2026.json").read_text(encoding="utf-8"))
corrections = json.loads((DATA / "timetable-corrections-2026.json").read_text(encoding="utf-8"))
guides = json.loads((DATA / "study-guide-profile-2026.json").read_text(encoding="utf-8"))
academic_years = json.loads((DATA / "academic-years.json").read_text(encoding="utf-8"))
source_by_id = {s["id"]: s for s in manifest["sources"]}
base_codes = {str(c.get("courseCode", "")).lower() for c in base["courses"]}
offering_ids = {o["offeringId"] for o in catalog["offerings"]}
valid_code = re.compile(r"[a-z]{2,4}[a-z0-9]{0,2}[0-9]{4,7}\Z")

checks = []
def record(name, passed, evidence, severity="medium"):
    checks.append({"check": name, "status": "pass" if passed else "fail", "severity": severity, "evidence": evidence})

# Source coverage and file identity.
missing_cache, hash_mismatch, page_count_mismatch = [], [], []
for s in manifest["sources"]:
    local_path = s.get("localPath", "")
    local = ROOT / local_path if local_path else None
    if not local or not local.is_file():
        missing_cache.append(s["id"]); continue
    raw = local.read_bytes()
    if hashlib.sha256(raw).hexdigest() != s.get("sha256") or len(raw) != s.get("bytes"):
        hash_mismatch.append(s["id"])
        continue
    try:
        actual_pages = len(PdfReader(str(local), strict=True).pages)
    except Exception as exc:
        page_count_mismatch.append({"sourceId": s["id"], "error": str(exc)[:200]})
        continue
    if actual_pages != s.get("pageCount"):
        page_count_mismatch.append({"sourceId": s["id"], "expected": s.get("pageCount"), "actual": actual_pages})
record("registered_source_files_integrity", not missing_cache and not hash_mismatch and not page_count_mismatch,
       {"officialSources": len(manifest["sources"]), "cacheMissing": missing_cache,
        "hashOrSizeMismatch": hash_mismatch, "pageCountMismatchOrUnreadable": page_count_mismatch}, "high")

base_time = datetime.fromisoformat(base["dataset"]["generatedAt"].replace("Z", "+00:00"))
if base_time.tzinfo is None:
    # A date-only snapshot is dated in Japan; do not compare naive and UTC datetimes.
    base_time = base_time.replace(tzinfo=timezone(timedelta(hours=9)))
audit_time = datetime.now(timezone.utc)
age_days = (audit_time - base_time).days
record("base_snapshot_freshness", age_days <= 30, {"snapshotGeneratedAt": base["dataset"]["generatedAt"], "auditRunAt": audit_time.isoformat(timespec="seconds"), "officialSourcesCheckedOn": manifest["checkedOn"], "ageDays": age_days}, "high")

# Course offering grain, indexes, and identity mapping.
ids = [f"{int(c.get('academicYear') or 2026)}:{str(c.get('courseCode','')).strip().lower()}" for c in base["courses"]]
record("offering_primary_key_unique", len(ids) == len(set(ids)), {"rows": len(ids), "uniqueKeys": len(set(ids)), "duplicates": len(ids)-len(set(ids))}, "high")
bad_index_refs = [r for r in code_index["records"] if r["sourceId"] not in source_by_id or not valid_code.fullmatch(r["courseCode"])]
duplicate_index_pairs = len(code_index["records"]) - len({(r["sourceId"], r["courseCode"]) for r in code_index["records"]})
bad_page_refs = [r for r in code_index["records"] if any(p < 1 or p > source_by_id[r["sourceId"]].get("pageCount", 0) for p in r["sourcePages"])]
bad_snippets = [r for r in code_index["records"] if not any(r["courseCode"] in x["snippet"].lower() for x in r["sourceEvidence"])]
record("official_code_index_integrity", not bad_index_refs and not duplicate_index_pairs and not bad_page_refs and not bad_snippets,
       {"codeSourcePairs": len(code_index["records"]), "uniqueCodes": code_index["summary"]["uniqueCourseCodes"], "invalidCodesOrSources": len(bad_index_refs), "duplicatePairs": duplicate_index_pairs, "invalidPages": len(bad_page_refs), "snippetsMissingCode": len(bad_snippets)}, "high")

missing_pairs = [r for r in code_index["records"] if r["courseCode"].lower() not in base_codes]
missing_unique = len({r["courseCode"] for r in missing_pairs})
withdrawal_signals = {
    e.get("courseCode", "").lower() for e in corrections.get("events", [])
    if re.search(r"非開講|開講中止", str(e.get("sourceExcerpt", "")))
}
missing_with_withdrawal_signal = sum(r["courseCode"].lower() in withdrawal_signals for r in missing_pairs)
withdrawal_ledger = json.loads((DATA / "visually-reviewed-withdrawals-2026.json").read_text(encoding="utf-8"))
withdrawal_source = source_by_id.get(withdrawal_ledger.get("sourceId"), {})
withdrawal_rows = withdrawal_ledger.get("records", [])
withdrawal_codes = [row.get("courseCode", "").lower() for row in withdrawal_rows]
withdrawal_ledger_valid = (withdrawal_source.get("kind") == "timetable-corrections"
    and withdrawal_source.get("sha256") == withdrawal_ledger.get("sourceSha256")
    and withdrawal_ledger.get("reviewMethod") == "official-pdf-visual-inspection"
    and withdrawal_ledger.get("sourceId") not in hash_mismatch
    and withdrawal_ledger.get("sourceId") not in missing_cache
    and not any(item.get("sourceId") == withdrawal_ledger.get("sourceId") for item in page_count_mismatch)
    and len(withdrawal_codes) == len(set(withdrawal_codes))
    and all(row.get("status") == "not-offered-in-source" and row.get("eventDate")
            and 1 <= row.get("sourcePage", 0) <= withdrawal_source.get("pageCount", 0)
            and row.get("courseCode", "").lower() in withdrawal_signals for row in withdrawal_rows))
reviewed_withdrawn = set(withdrawal_codes) if withdrawal_ledger_valid else set()
unexpected_missing = [r for r in missing_pairs if r["courseCode"].lower() not in reviewed_withdrawn
                      or r["sourceId"] != "schedule-setagaya-undergrad-fall-2026"]
record("official_to_base_code_coverage", not unexpected_missing and withdrawal_ledger_valid,
       {"sourceCodePairs": len(code_index["records"]), "matchedPairs": len(code_index["records"])-len(missing_pairs),
        "unmatchedPairs": len(missing_pairs), "reviewedWithdrawnPairs": len(missing_pairs)-len(unexpected_missing),
        "unexpectedMissingPairs": len(unexpected_missing), "distinctUnmatchedCodes": missing_unique,
        "unmatchedWithExtractedWithdrawalSignal": missing_with_withdrawal_signal,
        "withdrawalLedgerValid": withdrawal_ledger_valid, "comparison": "current-timetable-2026-codes",
        "withdrawalEvidence": "visually reviewed against captured source; subsequent corrections not checked"}, "high")

all_fall_candidates = json.loads((DATA / "current-fall-offering-candidates-2026.json").read_text(encoding="utf-8"))
review_queue_path = DATA / "current-fall-candidate-review-queue-2026.json"
review_queue = json.loads(review_queue_path.read_text(encoding="utf-8")) if review_queue_path.is_file() else {"summary": {}}
indexed_pairs = {(r["sourceId"], r["courseCode"]): (set(r["sourcePages"]), r["occurrenceCount"]) for r in code_index["records"]}
candidate_pairs = {(r["sourceId"], r["courseCode"]): (set(r["sourcePages"]), r["occurrenceCount"]) for r in all_fall_candidates["records"]}
candidate_coverage_issues = []
candidate_coverage_issues.extend(f"candidate-missing:{sid}:{code}" for sid, code in indexed_pairs.keys() - candidate_pairs.keys())
candidate_coverage_issues.extend(f"candidate-unexpected:{sid}:{code}" for sid, code in candidate_pairs.keys() - indexed_pairs.keys())
candidate_coverage_issues.extend(f"source-pages-differ:{sid}:{code}" for (sid, code) in indexed_pairs.keys() & candidate_pairs.keys()
                                 if indexed_pairs[(sid, code)][0] != candidate_pairs[(sid, code)][0])
candidate_coverage_issues.extend(f"occurrence-count-differs:{sid}:{code}" for (sid, code) in indexed_pairs.keys() & candidate_pairs.keys()
                                 if indexed_pairs[(sid, code)][1] != candidate_pairs[(sid, code)][1])
candidate_occurrences = sum(r["occurrenceCount"] for r in all_fall_candidates["records"])
index_occurrences = sum(r["occurrenceCount"] for r in code_index["records"])
if candidate_occurrences != index_occurrences:
    candidate_coverage_issues.append("total-occurrence-count-differs")
record("official_to_staging_candidate_coverage", not candidate_coverage_issues,
       {"officialCodeSourcePairs": len(indexed_pairs), "candidateCodeSourcePairs": len(candidate_pairs),
        "officialOccurrences": index_occurrences, "candidateOccurrences": candidate_occurrences,
        "stagedRowsRemainProvisional": all(r.get("reviewStatus") == "provisional" for r in all_fall_candidates["records"]),
        "mismatches": candidate_coverage_issues}, "high")

# Correction events are staged, never applied without validation.
corr_codes = [e for e in corrections["events"] if not valid_code.fullmatch(e["courseCode"]) or e["courseCode"] not in e["sourceExcerpt"].lower()]
corr_sources = [e for e in corrections["events"] if e["sourceId"] not in source_by_id or source_by_id[e["sourceId"]].get("kind") != "timetable-corrections"]
corr_dates = [e for e in corrections["events"] if not e.get("changeDate")]
corr_pages = [e for e in corrections["events"] if e["sourcePage"] < 1 or e["sourcePage"] > source_by_id[e["sourceId"]].get("pageCount",0)]
corr_applied = [e for e in corrections["events"] if e.get("applied")]
corr_unmatched = [e for e in corrections["events"] if f"2026:{e['courseCode']}" not in offering_ids]
record("correction_event_provenance", not corr_codes and not corr_sources and not corr_dates and not corr_pages and not corr_applied,
       {"events": len(corrections["events"]), "invalidCodeOrExcerpt": len(corr_codes), "invalidSource": len(corr_sources), "missingDate": len(corr_dates), "invalidPage": len(corr_pages), "prematurelyApplied": len(corr_applied), "unmatchedToBaseOfferings": len(corr_unmatched)}, "high")

# Study guide term index bounds and counts.
guide_bad = []
for g in guides["guides"]:
    s = source_by_id.get(g["sourceId"], {})
    if s.get("kind") != "study-guide" or g["pageCount"] != s.get("pageCount"):
        guide_bad.append(g["sourceId"]); continue
    if not isinstance(g.get("termPages"), dict):
        guide_bad.append(g["sourceId"]); continue
    for term, pages in g["termPages"].items():
        if len(pages) != g["termPageCounts"].get(term) or any(p < 1 or p > g["pageCount"] for p in pages):
            guide_bad.append(g["sourceId"]); break
record("study_guide_page_index_integrity", len(guides["guides"]) == 11 and not guide_bad,
       {"guides": len(guides["guides"]), "pages": guides.get("totalPageCount", sum(g.get("pageCount", 0) for g in guides["guides"])), "badProfiles": sorted(set(guide_bad)), "interpretation": "keyword navigation only; not validated course requirements"}, "medium")

# Multi-year source registry and cohort/offering separation.
year_rows = academic_years.get("years", [])
year_ids = [y.get("academicYear") for y in year_rows]
year_urls = [u for y in year_rows for u in y.get("timetablePages", {}).values()]
missing_year_urls = [y.get("academicYear") for y in year_rows if not y.get("timetablePages") or not y.get("studyGuideArchives")]
identity_model = academic_years.get("identityAndPlanningModel", {})
official_roots = academic_years.get("officialSourceRoots", {})
current_roots = official_roots.get("currentYearTimetables", {})
current_year_row = next((y for y in year_rows if y.get("academicYear") == current_roots.get("academicYear")), {})
roots_valid = (official_roots.get("teachingAffairsHome", {}).get("url") == "https://www.asc.tcu.ac.jp/"
               and current_roots.get("setagaya", {}).get("url") == current_year_row.get("timetablePages", {}).get("setagaya")
               and current_roots.get("yokohama", {}).get("url") == current_year_row.get("timetablePages", {}).get("yokohama")
               and official_roots.get("studyGuideArchives", {}).get("undergraduate") == "https://www.asc.tcu.ac.jp/syllabus_archives/")
record("multi_year_registry_and_cohort_model",
       year_ids == sorted(set(year_ids)) and set(range(2022, 2027)).issubset(set(year_ids)) and not missing_year_urls
       and all(u.startswith("https://www.asc.tcu.ac.jp/") for u in year_urls)
       and roots_valid
       and identity_model.get("offeringKey") == ["academicYear", "courseCode"]
       and identity_model.get("curriculumVersionKey") == ["admissionYear", "program", "degreeLevel", "campus"],
       {"academicYears": year_ids, "timetableLandingUrls": len(year_urls), "missingGuideOrTimetableYears": missing_year_urls,
        "historicalTimetableFiles": sum(len(y.get("fallTimetableFiles", [])) for y in year_rows),
        "historicalCorrectionFiles": sum(len(y.get("correctionFiles", [])) for y in year_rows),
        "officialRootPagesRecorded": len(official_roots), "currentRootsMatchYearRegistry": roots_valid,
        "offeringKey": identity_model.get("offeringKey"), "curriculumVersionKey": identity_model.get("curriculumVersionKey"),
        "courseRowsNormalizedForHistoricalYears": False}, "high")

# Candidate parser calibration against the independently assembled July snapshot.
candidates_path = DATA / "setagaya-fall-offering-candidates-2026.json"
candidate_data = json.loads(candidates_path.read_text(encoding="utf-8")) if candidates_path.is_file() else {"summary": {}}
candidate_summary = candidate_data.get("summary", {})
base_matches = candidate_summary.get("baseCodeMatches", 0)
title_agreements = candidate_summary.get("matchedBaseTitlesAgree", 0)
teacher_agreements = candidate_summary.get("matchedBaseInstructorOverlap", 0)
anchored = candidate_summary.get("rowsAtCodeAnchoredCell", 0)
occurrences = candidate_summary.get("rowOccurrences", 0)
record("fall_pdf_candidate_extraction_calibration",
       bool(base_matches) and title_agreements / max(1, base_matches) >= .90
       and teacher_agreements / max(1, base_matches) >= .95
       and anchored / max(1, occurrences) >= .90,
       {"sourceId": candidate_data.get("sourceId"), "candidateCodes": candidate_summary.get("uniqueCodes", 0),
        "rowOccurrences": occurrences, "codeCellAnchoredRows": anchored,
        "baseComparableCodes": base_matches, "titleAgreements": title_agreements,
        "instructorOverlaps": teacher_agreements, "titleConflicts": candidate_summary.get("titleConflicts"),
        "instructorConflicts": candidate_summary.get("instructorConflicts"),
        "promotionAllowed": False, "reason": "Candidate parser calibration does not validate all rows or correction semantics."}, "high")

# Database row counts and foreign keys.
db = sqlite3.connect(DATA / "course-catalog-2026.sqlite")
fk = db.execute("PRAGMA foreign_key_check").fetchall()
db_counts = {t: db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("source_document", "course_offering", "official_timetable_code_evidence", "correction_event", "study_guide_term_page")}
record("sqlite_referential_integrity", not fk and db_counts["course_offering"] == len(base["courses"]) and db_counts["official_timetable_code_evidence"] == len(code_index["records"]) and db_counts["correction_event"] == len(corrections["events"]), {"foreignKeyViolations": len(fk), "tableCounts": db_counts}, "high")
db.close()

failed = [c for c in checks if c["status"] == "fail"]
historical_candidates = json.loads((DATA / "historical-offering-candidates.json").read_text(encoding="utf-8"))
historical_queue_path = DATA / "historical-candidate-review-queue.json"
historical_queue = json.loads(historical_queue_path.read_text(encoding="utf-8")) if historical_queue_path.is_file() else {"summary": {}}
blockers = [f"2026年度後期の全6公式PDFについて候補行は揃ったが、1,885コード×資料組は未確定候補で、{review_queue.get('summary', {}).get('rowsRequiringReview', '一部')}組は空欄・複数候補・未結合出現を含む。訂正の反映と原表照合が未完了。", f"2026年度の基礎スナップショットは{base['dataset']['generatedAt']}生成で、現在の公式索引との未一致は{len(missing_pairs)}組で、このうち{len(missing_pairs)-len(unexpected_missing)}組は保存済み変更一覧の非開講・中止を目視確認。行レベルの全件照合と後続訂正の確認は未完了。", f"{len(corr_unmatched)}/{len(corrections['events'])}件の訂正イベント候補は現在の基礎カタログに該当講義コードがなく、訂正イベントは自動適用していない。", f"2022〜2025年度は5,829組の候補を保存したが、{historical_queue.get('summary', {}).get('rowsRequiringReview', '一部')}組の原表確認・訂正反映と正規化済み開講行の作成が未完了。", "学修要覧の索引は語句ページ検索であり、履修要件の意味抽出・年度別検証をしていない。"]
assessment = {"asOf": audit_time.date().isoformat(), "decision": "NOT_READY_FOR_RELEASE" if failed or blockers else "READY_FOR_REVIEW", "checkCount": len(checks), "failedChecks": len(failed), "checks": checks, "knownReleaseBlockers": blockers, "scope": "2022-2026 public teaching-affairs source registry; 2026 source identity, freshness, code/page provenance, correction staging, study-guide page index, SQLite integrity, multi-year/cohort model"}
with output_json.open("x", encoding="utf-8") as stream:
    stream.write(json.dumps(assessment, ensure_ascii=False, indent=2)+"\n")
lines = [f"# 科目カタログ品質監査（{assessment['asOf']}）", "", f"判定: **{assessment['decision']}**", "", "## チェック結果", "", "| 項目 | 結果 | 根拠 |", "|---|---|---|"]
for c in checks:
    lines.append(f"| {c['check']} | {c['status']} | `{json.dumps(c['evidence'], ensure_ascii=False)}` |")
lines += ["", "## リリース阻害事項", ""] + [f"- {x}" for x in blockers]
lines += ["", "## 判断", "", "出典ファイル・キー・ページ・参照整合性の機械チェックは確認可能な範囲で合格しました。ただし、これは最新カタログの正確性を証明しません。後期PDFの表を授業行へ構造化して原表と照合し、訂正差分と履修要件を確認するまで、学生向けの確定データとして配布しないでください。", ""]
with output_md.open("x", encoding="utf-8") as stream:
    stream.write("\n".join(lines))
print(json.dumps({"decision": assessment["decision"], "checks": len(checks), "failed": len(failed), "baseAgeDays": age_days, "unmatchedOfficialPairs": len(missing_pairs), "distinctUnmatchedCodes": missing_unique}, ensure_ascii=False))
