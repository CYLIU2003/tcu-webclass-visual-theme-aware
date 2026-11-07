#!/usr/bin/env python3
"""Audit the merged SQLite database against source manifests and JSON indexes."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--database", type=Path, default=DATA / "course-catalog-multiyear.sqlite")
parser.add_argument("--report-json", type=Path)
parser.add_argument("--report-md", type=Path)
args = parser.parse_args()
db_path = args.database.resolve()
if db_path != (DATA / "course-catalog-multiyear.sqlite").resolve() and (args.report_json is None or args.report_md is None):
    parser.error("--database に別のDBを指定する場合は --report-json と --report-md も指定してください")
report_json = (args.report_json or DATA / "multiyear-database-audit.json").resolve()
report_md = (args.report_md or ROOT / "docs" / "MULTIYEAR_DATABASE_AUDIT.md").resolve()
if len({db_path, report_json, report_md}) != 3:
    parser.error("DBと2つの監査レポートには別々のパスを指定してください")
base = json.loads((DATA / "timetable-2026.json").read_text(encoding="utf-8"))
sources = json.loads((DATA / "historical-source-cache-manifest.json").read_text(encoding="utf-8"))["records"]
code_index = json.loads((DATA / "historical-timetable-code-index.json").read_text(encoding="utf-8"))
fall_candidates = json.loads((DATA / "current-fall-offering-candidates-2026.json").read_text(encoding="utf-8"))
historical_candidates = json.loads((DATA / "historical-offering-candidates.json").read_text(encoding="utf-8"))
historical_review_queue = json.loads((DATA / "historical-candidate-review-queue.json").read_text(encoding="utf-8"))
current_review_queue = json.loads((DATA / "current-fall-candidate-review-queue-2026.json").read_text(encoding="utf-8"))
title_review_rules = json.loads((DATA / "course-title-review-rules.json").read_text(encoding="utf-8"))
excluded_title_keys = title_review_rules["identitySearchExcludedTitleKeys"]
excluded_title_key_set = set(excluded_title_keys)
excluded_title_sql = "title_key NOT IN (" + ",".join("'" + key.replace("'", "''") + "'" for key in excluded_title_keys) + ")"
official_sources = json.loads((DATA / "official-sources-2026.json").read_text(encoding="utf-8"))["sources"]
audit = json.loads((DATA / "course-catalog-quality-audit-2026.json").read_text(encoding="utf-8"))

checks = []


def normalized_name_key(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    value = re.sub(r"[\u200b-\u200d\ufeff]", "", value)
    return re.sub(r"\s+", "", value).casefold()


def add(name: str, passed: bool, evidence: dict) -> None:
    checks.append({"check": name, "status": "pass" if passed else "fail", "evidence": evidence})


db = sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)
db.execute("PRAGMA foreign_keys=ON")
integrity = [row[0] for row in db.execute("PRAGMA integrity_check")]
fk = db.execute("PRAGMA foreign_key_check").fetchall()
user_version = db.execute("PRAGMA user_version").fetchone()[0]
tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
curriculum_tables = {"course_concept", "course_concept_offering", "curriculum_program", "curriculum_plan_version",
    "curriculum_version_source", "curriculum_plan_version_evidence",
    "curriculum_section", "curriculum_section_evidence",
    "curriculum_course_reference", "curriculum_course_reference_evidence",
    "curriculum_requirement_group", "curriculum_requirement_member", "curriculum_requirement_evidence",
    "curriculum_rule", "curriculum_rule_evidence", "curriculum_rule_course_target",
    "curriculum_rule_group_target", "curriculum_rule_section_target", "curriculum_revision_event",
    "curriculum_course_offering_link",
    "curriculum_course_offering_link_evidence"}
expected_tables = {"source_document", "course_offering", "official_timetable_code_evidence", "catalog_release_metadata", "course_offering_candidate", "candidate_title_assertion", "candidate_instructor_assertion", "candidate_row_evidence", "candidate_row_review", "candidate_row_review_instructor"} | curriculum_tables
counts = {t: db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in expected_tables if t in tables}

base_keys = {(int(x.get("academicYear") or 2026), str(x.get("courseCode", "")).lower()) for x in base["courses"]}
db_keys = set(db.execute("SELECT academic_year,lower(course_code) FROM course_offering"))
add("current_offering_snapshot_preserved", db_keys == base_keys,
    {"jsonRows": len(base_keys), "sqliteRows": len(db_keys), "setDifferences": len(base_keys ^ db_keys)})

source_failures = []
source_id_by_url = {}
for src in sources:
    if not src.get("localPath") or not src.get("sha256"):
        source_failures.append({"url": src.get("sourceUrl"), "reason": "not-captured"})
        continue
    path = ROOT / src["localPath"]
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != src["sha256"]:
        source_failures.append({"url": src["sourceUrl"], "reason": "cache-hash-mismatch"})
        continue
    record = db.execute("SELECT source_id,sha256 FROM source_document WHERE url=?", (src["sourceUrl"],)).fetchone()
    if not record or record[1] != src["sha256"]:
        source_failures.append({"url": src["sourceUrl"], "reason": "sqlite-source-missing-or-hash-mismatch"})
        continue
    source_id_by_url[src["sourceUrl"]] = record[0]
add("historical_source_files_match_sqlite", not source_failures and len(source_id_by_url) == len(sources),
    {"expected": len(sources), "matched": len(source_id_by_url), "failures": source_failures})

historical_index_rows = code_index["records"]
code_failures = []
for row in historical_index_rows:
    if len(row.get("sourceEvidence", [])) != row.get("occurrenceCount"):
        code_failures.append({"year": row["academicYear"], "code": row["courseCode"], "reason": "not-all-occurrence-evidence-preserved"})
    sid = source_id_by_url.get(row["sourceUrl"])
    if not sid:
        code_failures.append({"year": row["academicYear"], "code": row["courseCode"], "reason": "source-unlinked"})
        continue
    found = db.execute("""SELECT occurrence_count,source_pages_json,source_evidence_json,review_status
                          FROM official_timetable_code_evidence WHERE source_id=? AND course_code=?""",
                       (sid, row["courseCode"])).fetchone()
    if not found:
        code_failures.append({"year": row["academicYear"], "code": row["courseCode"], "reason": "evidence-row-missing"})
        continue
    if (found[0] != row["occurrenceCount"] or json.loads(found[1]) != row["sourcePages"]
            or json.loads(found[2]) != row["sourceEvidence"]
            or found[3] != "historical-code-indexed-needs-row-validation"):
        code_failures.append({"year": row["academicYear"], "code": row["courseCode"], "reason": "evidence-content-differs"})
db_hist_count = db.execute("""SELECT COUNT(*) FROM official_timetable_code_evidence e
                              JOIN source_document s USING(source_id)
                              WHERE s.kind='historical-timetable'""").fetchone()[0]
add("historical_code_evidence_reconciles", not code_failures and db_hist_count == len(historical_index_rows),
    {"indexRows": len(historical_index_rows), "sqliteRows": db_hist_count, "mismatches": len(code_failures)})

meta_row = db.execute("SELECT value_json FROM catalog_release_metadata WHERE metadata_key='coverage'").fetchone()
meta = json.loads(meta_row[0]) if meta_row else {}
historic_offerings = db.execute("SELECT COUNT(*) FROM course_offering WHERE academic_year BETWEEN 2022 AND 2025").fetchone()[0]
uncoded_documents = code_index["summary"].get("documentsWithoutCodeEvidence", [])
supplementary_documents = code_index["summary"].get("excludedSupplementaryDocuments", [])
add("scope_and_release_status_explicit", user_version == 8 and meta.get("schemaVersion") == 8 and meta.get("historicalDataStatus", "").startswith("source-and-provisional-row-candidates")
    and meta.get("normalizedOfferingYears") == [2026] and historic_offerings == 0,
    {"userVersion": user_version, "metadata": meta, "historicalOfferingRows": historic_offerings,
     "historicalPdfDocumentsWithoutExtractedCodeEvidence": uncoded_documents})

curriculum_row_counts = {table: counts.get(table, -1) for table in sorted(curriculum_tables)}
expected_curriculum_triggers = {
    "curriculum_section_parent_same_version_insert", "curriculum_section_parent_same_version_update",
    "curriculum_course_reference_section_same_version_insert", "curriculum_course_reference_section_same_version_update",
    "curriculum_requirement_parent_same_version_insert", "curriculum_requirement_parent_same_version_update",
    "curriculum_requirement_member_same_version_insert", "curriculum_requirement_member_same_version_update",
    "curriculum_rule_course_target_same_version_insert", "curriculum_rule_course_target_same_version_update",
    "curriculum_rule_group_target_same_version_insert", "curriculum_rule_group_target_same_version_update",
    "curriculum_rule_section_target_same_version_insert", "curriculum_rule_section_target_same_version_update",
    "curriculum_revision_target_same_version_insert", "curriculum_revision_target_same_version_update",
}
actual_triggers = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
actual_indexes = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
expected_curriculum_indexes = {
    "ix_course_concept_title", "ix_course_concept_offering_offering", "ix_curriculum_plan_cohort",
    "ix_curriculum_section_parent", "ix_curriculum_course_ref_code", "ix_curriculum_course_ref_title",
    "ix_curriculum_requirement_tree", "ix_curriculum_link_offering", "ix_curriculum_evidence_source_page",
    "ix_curriculum_version_evidence_source", "ix_curriculum_revision_target",
    "ix_curriculum_rule_course_target", "ix_curriculum_rule_group_target", "ix_curriculum_rule_section_target",
    "ux_curriculum_section_sibling_order", "ux_curriculum_reference_sibling_order",
    "ux_curriculum_requirement_sibling_order",
}
add("curriculum_schema_v1_tables_and_constraints_installed",
    curriculum_tables.issubset(tables)
    and meta.get("curriculumSchemaVersion") == 1
    and meta.get("curriculumDataStatus") in {"schema-installed-no-requirements-certified", "source-backed-requirements-staged", "requirements-certified"}
    and expected_curriculum_triggers.issubset(actual_triggers)
    and expected_curriculum_indexes.issubset(actual_indexes),
    {"curriculumSchemaVersion": meta.get("curriculumSchemaVersion"),
     "curriculumDataStatus": meta.get("curriculumDataStatus"),
     "tableCounts": curriculum_row_counts,
     "missingTriggers": sorted(expected_curriculum_triggers - actual_triggers),
     "missingIndexes": sorted(expected_curriculum_indexes - actual_indexes)})

approved_requirement_records = db.execute("""SELECT
    (SELECT COUNT(*) FROM curriculum_requirement_group WHERE review_status='approved')
  + (SELECT COUNT(*) FROM curriculum_rule WHERE review_status='approved')""").fetchone()[0]
curriculum_data_status = meta.get("curriculumDataStatus")
curriculum_status_consistent = (
    (curriculum_data_status == "schema-installed-no-requirements-certified" and approved_requirement_records == 0)
    or curriculum_data_status == "source-backed-requirements-staged"
    or (curriculum_data_status == "requirements-certified" and approved_requirement_records > 0)
)
add("curriculum_data_status_matches_certification_state",
    curriculum_status_consistent,
    {"curriculumDataStatus": curriculum_data_status,
     "approvedRequirementGroupsAndRules": approved_requirement_records,
     "curriculumRowCounts": curriculum_row_counts})

approved_plan_cohort_overlaps = db.execute("""SELECT COUNT(*) FROM curriculum_plan_version a
    JOIN curriculum_plan_version b
      ON a.program_id=b.program_id AND a.plan_version_id<b.plan_version_id
     AND a.version_status='approved' AND b.version_status='approved'
     AND a.admission_year_start<=COALESCE(b.admission_year_end,2200)
     AND b.admission_year_start<=COALESCE(a.admission_year_end,2200)""").fetchone()[0]
add("approved_curriculum_versions_do_not_overlap_cohorts", approved_plan_cohort_overlaps == 0,
    {"approvedPlanVersionCohortOverlaps": approved_plan_cohort_overlaps})

curriculum_evidence_tables = (
    ("curriculum_plan_version_evidence", "pdf_page_no"),
    ("curriculum_section_evidence", "pdf_page_no"),
    ("curriculum_course_reference_evidence", "pdf_page_no"),
    ("curriculum_requirement_evidence", "pdf_page_no"),
    ("curriculum_rule_evidence", "pdf_page_no"),
    ("curriculum_revision_event", "pdf_page_no"),
    ("curriculum_course_offering_link_evidence", "pdf_page_no"),
)
curriculum_source_hash_mismatches = []
curriculum_page_range_errors = []
curriculum_source_span_errors = []
source_page_counts = {}
for source_id, metadata_json in db.execute("SELECT source_id,metadata_json FROM source_document"):
    try:
        metadata = json.loads(metadata_json)
        source_page_counts[source_id] = int(metadata.get("pageCount", 0) or 0)
    except (TypeError, ValueError, json.JSONDecodeError):
        source_page_counts[source_id] = 0
for table, page_column in curriculum_evidence_tables:
    for evidence_id, source_id, evidence_sha, page_no, source_sha in db.execute(
            f"SELECT e.rowid,e.source_id,e.source_sha256,e.{page_column},s.sha256 "
            f"FROM {table} e LEFT JOIN source_document s USING(source_id)"):
        if not source_sha or source_sha != evidence_sha:
            curriculum_source_hash_mismatches.append(f"{table}:{evidence_id}:{source_id}")
        page_count = source_page_counts.get(source_id, 0)
        if page_no < 1 or (page_count > 0 and page_no > page_count):
            curriculum_page_range_errors.append(f"{table}:{evidence_id}:{source_id}:{page_no}/{page_count}")
for concept_id, offering_id, source_id, page_no, metadata_json in db.execute(
        """SELECT link.concept_id,link.offering_id,link.source_id,link.source_page,source.metadata_json
           FROM course_concept_offering link JOIN source_document source USING(source_id)"""):
    try:
        page_count = int(json.loads(metadata_json).get("pageCount", 0) or 0)
    except (TypeError, ValueError, json.JSONDecodeError):
        page_count = 0
    if page_no < 1 or (page_count > 0 and page_no > page_count):
        curriculum_source_span_errors.append(f"course_concept_offering:{concept_id}:{offering_id}:{page_no}/{page_count}")
for plan_version_id, source_id, page_start, page_end, metadata_json in db.execute(
        """SELECT link.plan_version_id,link.source_id,link.page_start,link.page_end,source.metadata_json
           FROM curriculum_version_source link JOIN source_document source USING(source_id)"""):
    try:
        page_count = int(json.loads(metadata_json).get("pageCount", 0) or 0)
    except (TypeError, ValueError, json.JSONDecodeError):
        page_count = 0
    if ((page_start is not None and page_start < 1)
            or (page_count > 0 and page_start is not None and page_start > page_count)
            or (page_count > 0 and page_end is not None and page_end > page_count)):
        curriculum_source_span_errors.append(f"curriculum_version_source:{plan_version_id}:{source_id}:{page_start}-{page_end}/{page_count}")
add("curriculum_evidence_hashes_and_pdf_pages_reconcile",
    not curriculum_source_hash_mismatches and not curriculum_page_range_errors and not curriculum_source_span_errors,
    {"evidenceTables": [table for table, _ in curriculum_evidence_tables],
     "sourceHashMismatches": curriculum_source_hash_mismatches,
     "pdfPageRangeErrors": curriculum_page_range_errors,
     "sourceSpanErrors": curriculum_source_span_errors})

curriculum_cross_version_errors = {
    "section_parent": db.execute("""SELECT COUNT(*) FROM curriculum_section child
        JOIN curriculum_section parent ON parent.section_id=child.parent_section_id
        WHERE child.plan_version_id<>parent.plan_version_id""").fetchone()[0],
    "course_reference_section": db.execute("""SELECT COUNT(*) FROM curriculum_course_reference ref
        JOIN curriculum_section section ON section.section_id=ref.section_id
        WHERE ref.plan_version_id<>section.plan_version_id""").fetchone()[0],
    "requirement_parent": db.execute("""SELECT COUNT(*) FROM curriculum_requirement_group child
        JOIN curriculum_requirement_group parent ON parent.requirement_group_id=child.parent_group_id
        WHERE child.plan_version_id<>parent.plan_version_id""").fetchone()[0],
    "requirement_member": db.execute("""SELECT COUNT(*) FROM curriculum_requirement_member member
        JOIN curriculum_requirement_group group_row USING(requirement_group_id)
        JOIN curriculum_course_reference ref USING(course_ref_id)
        WHERE group_row.plan_version_id<>ref.plan_version_id""").fetchone()[0],
    "rule_course_target": db.execute("""SELECT COUNT(*) FROM curriculum_rule_course_target target
        JOIN curriculum_rule rule USING(rule_id)
        JOIN curriculum_course_reference ref USING(course_ref_id)
        WHERE rule.plan_version_id<>ref.plan_version_id""").fetchone()[0],
    "rule_group_target": db.execute("""SELECT COUNT(*) FROM curriculum_rule_group_target target
        JOIN curriculum_rule rule USING(rule_id)
        JOIN curriculum_requirement_group group_row USING(requirement_group_id)
        WHERE rule.plan_version_id<>group_row.plan_version_id""").fetchone()[0],
    "rule_section_target": db.execute("""SELECT COUNT(*) FROM curriculum_rule_section_target target
        JOIN curriculum_rule rule USING(rule_id)
        JOIN curriculum_section section USING(section_id)
        WHERE rule.plan_version_id<>section.plan_version_id""").fetchone()[0],
    "revision_course_target": db.execute("""SELECT COUNT(*) FROM curriculum_revision_event event
        JOIN curriculum_course_reference ref ON ref.course_ref_id=event.target_course_ref_id
        WHERE event.plan_version_id<>ref.plan_version_id""").fetchone()[0],
    "revision_group_target": db.execute("""SELECT COUNT(*) FROM curriculum_revision_event event
        JOIN curriculum_requirement_group group_row ON group_row.requirement_group_id=event.target_requirement_group_id
        WHERE event.plan_version_id<>group_row.plan_version_id""").fetchone()[0],
    "revision_rule_target": db.execute("""SELECT COUNT(*) FROM curriculum_revision_event event
        JOIN curriculum_rule rule ON rule.rule_id=event.target_rule_id
        WHERE event.plan_version_id<>rule.plan_version_id""").fetchone()[0],
    "revision_section_target": db.execute("""SELECT COUNT(*) FROM curriculum_revision_event event
        JOIN curriculum_section section ON section.section_id=event.target_section_id
        WHERE event.plan_version_id<>section.plan_version_id""").fetchone()[0],
}
approved_offerings_in_multiple_concepts = db.execute("""SELECT COUNT(*) FROM (
    SELECT offering_id FROM course_concept_offering WHERE review_status='approved'
    GROUP BY offering_id HAVING COUNT(DISTINCT concept_id)>1)""").fetchone()[0]
add("curriculum_tree_and_course_concept_links_are_consistent",
    not any(curriculum_cross_version_errors.values()) and approved_offerings_in_multiple_concepts == 0,
    {"crossVersionRelationshipErrors": curriculum_cross_version_errors,
     "offeringsApprovedUnderMultipleConcepts": approved_offerings_in_multiple_concepts})

invalid_approved_curriculum_links = db.execute("""SELECT COUNT(*)
    FROM curriculum_course_offering_link link
    JOIN curriculum_course_reference ref USING(course_ref_id)
    JOIN curriculum_plan_version version USING(plan_version_id)
    WHERE link.review_status='approved'
      AND (ref.review_status<>'approved' OR version.version_status<>'approved')""").fetchone()[0]
invalid_approved_curriculum_links += db.execute("""SELECT COUNT(*)
    FROM curriculum_course_offering_link link
    WHERE link.review_status='approved' AND NOT EXISTS (
      SELECT 1 FROM curriculum_course_offering_link_evidence evidence
      JOIN source_document source USING(source_id)
      WHERE evidence.link_id=link.link_id
        AND evidence.review_status IN ('reviewed','approved')
        AND evidence.source_sha256=source.sha256
    )""").fetchone()[0]
approved_concept_links_without_evidence = db.execute("""SELECT COUNT(*)
    FROM course_concept_offering link
    LEFT JOIN source_document source USING(source_id)
    WHERE link.review_status='approved'
      AND (source.source_id IS NULL OR link.source_page<1 OR COALESCE(link.evidence_text,'')='')""").fetchone()[0]
approved_record_evidence_gaps = {
    "plan_versions": db.execute("""SELECT COUNT(*) FROM curriculum_plan_version row
      WHERE row.version_status='approved' AND NOT EXISTS (
        SELECT 1 FROM curriculum_plan_version_evidence evidence
        JOIN source_document source USING(source_id)
        WHERE evidence.plan_version_id=row.plan_version_id
          AND evidence.review_status IN ('reviewed','approved')
          AND evidence.source_sha256=source.sha256)""").fetchone()[0],
    "sections": db.execute("""SELECT COUNT(*) FROM curriculum_section row
      JOIN curriculum_plan_version version USING(plan_version_id)
      WHERE row.review_status='approved' AND (version.version_status<>'approved' OR NOT EXISTS (
        SELECT 1 FROM curriculum_section_evidence evidence
        JOIN source_document source USING(source_id)
        WHERE evidence.section_id=row.section_id
          AND evidence.review_status IN ('reviewed','approved')
          AND evidence.source_sha256=source.sha256))""").fetchone()[0],
    "course_references": db.execute("""SELECT COUNT(*) FROM curriculum_course_reference row
      JOIN curriculum_plan_version version USING(plan_version_id)
      WHERE row.review_status='approved' AND (version.version_status<>'approved' OR NOT EXISTS (
        SELECT 1 FROM curriculum_course_reference_evidence evidence
        JOIN source_document source USING(source_id)
        WHERE evidence.course_ref_id=row.course_ref_id
          AND evidence.review_status IN ('reviewed','approved')
          AND evidence.source_sha256=source.sha256))""").fetchone()[0],
    "requirement_groups": db.execute("""SELECT COUNT(*) FROM curriculum_requirement_group row
      JOIN curriculum_plan_version version USING(plan_version_id)
      WHERE row.review_status='approved' AND (version.version_status<>'approved' OR NOT EXISTS (
        SELECT 1 FROM curriculum_requirement_evidence evidence
        JOIN source_document source USING(source_id)
        WHERE evidence.requirement_group_id=row.requirement_group_id
          AND evidence.review_status IN ('reviewed','approved')
          AND evidence.source_sha256=source.sha256))""").fetchone()[0],
    "rules": db.execute("""SELECT COUNT(*) FROM curriculum_rule row
      JOIN curriculum_plan_version version USING(plan_version_id)
      WHERE row.review_status='approved' AND (version.version_status<>'approved' OR NOT EXISTS (
        SELECT 1 FROM curriculum_rule_evidence evidence
        JOIN source_document source USING(source_id)
        WHERE evidence.rule_id=row.rule_id
          AND evidence.review_status IN ('reviewed','approved')
          AND evidence.source_sha256=source.sha256))""").fetchone()[0],
    "approved_members_with_unapproved_parent": db.execute("""SELECT COUNT(*) FROM curriculum_requirement_member member
      JOIN curriculum_requirement_group group_row USING(requirement_group_id)
      JOIN curriculum_course_reference ref USING(course_ref_id)
      JOIN curriculum_plan_version version ON version.plan_version_id=group_row.plan_version_id
      WHERE member.review_status='approved'
        AND (group_row.review_status<>'approved' OR ref.review_status<>'approved' OR version.version_status<>'approved')""").fetchone()[0],
}
add("approved_curriculum_records_require_reviewed_source_evidence",
    invalid_approved_curriculum_links == 0
    and approved_concept_links_without_evidence == 0
    and not any(approved_record_evidence_gaps.values()),
    {"approvedLinksWithUncertifiedReferenceOrMissingEvidence": invalid_approved_curriculum_links,
     "approvedConceptLinksMissingEvidence": approved_concept_links_without_evidence,
     "approvedRecordEvidenceGaps": approved_record_evidence_gaps})

expected_supplementary = {
    "data/source-cache/historical/2022/2022-timetable-02.pdf": "campus-plan",
    "data/source-cache/historical/2023/2023-timetable-02.pdf": "webclass-guide",
    "data/source-cache/historical/2024/2024-timetable-02.pdf": "webclass-guide",
}
observed_supplementary = {x.get("path"): x.get("contentRole") for x in supplementary_documents}
add("supplementary_pdfs_excluded_from_course_extraction", observed_supplementary == expected_supplementary,
    {"expected": expected_supplementary, "observed": observed_supplementary})

candidate_integrity_issues = []
official_by_id = {x["id"]: x for x in official_sources}
official_code_index = json.loads((DATA / "official-timetable-code-index-2026.json").read_text(encoding="utf-8"))
indexed_pairs = {(r["sourceId"], r["courseCode"]): (set(r["sourcePages"]), r["occurrenceCount"]) for r in official_code_index["records"]}
candidate_pairs = {(r["sourceId"], r["courseCode"]): (set(r["sourcePages"]), r["occurrenceCount"]) for r in fall_candidates["records"]}
index_pair_mismatches = sorted([f"missing:{sid}:{code}" for sid, code in indexed_pairs.keys() - candidate_pairs.keys()]
                               + [f"unexpected:{sid}:{code}" for sid, code in candidate_pairs.keys() - indexed_pairs.keys()]
                               + [f"page-difference:{sid}:{code}" for (sid, code) in indexed_pairs.keys() & candidate_pairs.keys()
                                  if indexed_pairs[(sid, code)][0] != candidate_pairs[(sid, code)][0]]
                               + [f"occurrence-count-difference:{sid}:{code}" for (sid, code) in indexed_pairs.keys() & candidate_pairs.keys()
                                  if indexed_pairs[(sid, code)][1] != candidate_pairs[(sid, code)][1]])
if sum(r["occurrenceCount"] for r in fall_candidates["records"]) != sum(r["occurrenceCount"] for r in official_code_index["records"]):
    index_pair_mismatches.append("total-occurrence-count-differs-from-code-index")
for source in fall_candidates["sources"]:
    official_source = official_by_id.get(source["sourceId"])
    if not official_source or official_source.get("sha256") != source["sourceSha256"]:
        candidate_integrity_issues.append(f"candidate-source-hash-does-not-match-official-manifest:{source['sourceId']}")
candidate_rows_db = db.execute("""SELECT candidate_id,academic_year,course_code,source_id,title_candidates_json,
    instructor_candidates_json,room_candidates_json,source_pages_json,occurrence_count,source_evidence_json,
    base_snapshot_match,review_status,extraction_metadata_json FROM course_offering_candidate""").fetchall()
expected_current_map = {(r["sourceId"], r["courseCode"]): r for r in fall_candidates["records"]}
expected_historical_map = {(r["sourceId"], r["courseCode"]): r for r in historical_candidates["records"]}
expected_candidate_map = {**expected_current_map, **expected_historical_map}
if len(candidate_rows_db) != len(expected_candidate_map):
    candidate_integrity_issues.append("candidate-row-count-mismatch")
for row in candidate_rows_db:
    (candidate_id, year, code, source_id, titles, teachers, rooms, pages, occurrences, evidence,
     base_match, status, extraction_meta) = row
    source_candidate = expected_candidate_map.get((source_id, code))
    if not source_candidate:
        candidate_integrity_issues.append(f"unexpected-candidate:{source_id}:{code}")
        continue
    if (year != source_candidate["academicYear"]
            or candidate_id != f"{year}:{source_id}:{code}"
            or json.loads(titles) != source_candidate["titleCandidates"]
            or json.loads(teachers) != source_candidate["instructorCandidates"]
            or json.loads(rooms) != source_candidate["roomCandidates"]
            or json.loads(pages) != source_candidate["sourcePages"]
            or occurrences != source_candidate["occurrenceCount"]
            or json.loads(evidence) != source_candidate["evidence"]
            or base_match != int(source_candidate["baseSnapshotMatch"])
            or status != "provisional"):
        candidate_integrity_issues.append(f"candidate-content-mismatch:{source_id}:{code}")
candidate_meta_row = db.execute("SELECT value_json FROM catalog_release_metadata WHERE metadata_key='coverage'").fetchone()
candidate_metadata = json.loads(candidate_meta_row[0]) if candidate_meta_row else {}
historical_index_pairs = {(r["sourceUrl"], r["courseCode"]): r for r in code_index["records"]}
historical_source_url = {s["sourceId"]: s["sourceUrl"] for s in historical_candidates["sources"]}
historical_candidate_pairs = {(historical_source_url.get(r["sourceId"]), r["courseCode"]): r for r in historical_candidates["records"]}
historical_pair_mismatches = []
historical_pair_mismatches.extend(f"missing:{url}:{code}" for url, code in historical_index_pairs.keys() - historical_candidate_pairs.keys())
historical_pair_mismatches.extend(f"unexpected:{url}:{code}" for url, code in historical_candidate_pairs.keys() - historical_index_pairs.keys())
historical_pair_mismatches.extend(f"pages:{url}:{code}" for url, code in historical_index_pairs.keys() & historical_candidate_pairs.keys()
                                  if set(historical_index_pairs[(url, code)]["sourcePages"]) != set(historical_candidate_pairs[(url, code)]["sourcePages"]))
historical_pair_mismatches.extend(f"occurrences:{url}:{code}" for url, code in historical_index_pairs.keys() & historical_candidate_pairs.keys()
                                  if historical_index_pairs[(url, code)]["occurrenceCount"] != historical_candidate_pairs[(url, code)]["occurrenceCount"])
for source in historical_candidates["sources"]:
    manifest_source = next((s for s in sources if s["sourceUrl"] == source["sourceUrl"]), None)
    if not manifest_source or manifest_source.get("sha256") != source["sourceSha256"]:
        historical_pair_mismatches.append(f"hash:{source['sourceUrl']}")
add("fall_candidate_rows_preserved_as_unpromoted_evidence", not candidate_integrity_issues
    and not index_pair_mismatches
    and candidate_metadata.get("currentYearFallCandidateRows") == len(expected_current_map)
    and candidate_metadata.get("currentYearFallCandidateSourceIds") == sorted(s["sourceId"] for s in fall_candidates["sources"])
    and candidate_metadata.get("currentYearFallCandidatesStatus", "").startswith("provisional-staging-only"),
    {"sourceIds": [s["sourceId"] for s in fall_candidates["sources"]],
     "jsonRows": len(expected_current_map), "sqliteRowsTotal": len(candidate_rows_db),
     "officialIndexPairs": len(indexed_pairs), "candidatePairs": len(candidate_pairs),
     "officialOccurrenceCount": sum(r["occurrenceCount"] for r in official_code_index["records"]),
     "candidateOccurrenceCount": sum(r["occurrenceCount"] for r in fall_candidates["records"]),
     "parsedTitleRows": sum(bool(r.get("titleCandidates")) for r in fall_candidates["records"]),
     "parsedInstructorRows": sum(bool(r.get("instructorCandidates")) for r in fall_candidates["records"]),
     "multiTitleCandidates": sum(len(r.get("titleCandidates", [])) > 1 for r in fall_candidates["records"]),
     "multiInstructorCandidates": sum(bool(r.get("instructorConflict")) for r in fall_candidates["records"]),
     "rowsWithMultipleInstructorNames": sum(len(r.get("instructorCandidates", [])) > 1 for r in fall_candidates["records"]),
     "statusCounts": {s: sum(r.get("reviewStatus") == s for r in fall_candidates["records"]) for s in sorted({r.get("reviewStatus") for r in fall_candidates["records"]})},
     "mismatches": candidate_integrity_issues + index_pair_mismatches})

add("historical_candidate_rows_match_every_indexed_occurrence",
    not candidate_integrity_issues and not historical_pair_mismatches
    and candidate_metadata.get("historicalCandidateRows") == len(expected_historical_map)
    and candidate_metadata.get("historicalCandidateSourceIds") == sorted(s["sourceId"] for s in historical_candidates["sources"])
    and candidate_metadata.get("historicalCandidatesStatus", "").startswith("provisional-staging-only"),
    {"sourceDocuments": len(historical_candidates["sources"]), "indexPairs": len(historical_index_pairs),
     "candidatePairs": len(historical_candidate_pairs), "sqliteRows": len(expected_historical_map),
     "indexOccurrences": sum(r["occurrenceCount"] for r in code_index["records"]),
     "candidateOccurrences": sum(r["occurrenceCount"] for r in historical_candidates["records"]),
     "parsedTitleRows": sum(bool(r["titleCandidates"]) for r in historical_candidates["records"]),
     "parsedInstructorRows": sum(bool(r["instructorCandidates"]) for r in historical_candidates["records"]),
     "multiTitleCandidates": sum(r["titleConflict"] for r in historical_candidates["records"]),
     "multiInstructorCandidates": sum(r["instructorConflict"] for r in historical_candidates["records"]),
     "mismatches": candidate_integrity_issues + historical_pair_mismatches})

expected_title_assertions = set()
expected_instructor_assertions = set()
expected_row_evidence = set()
for (source_id, code), row in expected_candidate_map.items():
    candidate_id = f"{row['academicYear']}:{source_id}:{code}"
    for ordinal, title in enumerate(row.get("titleCandidates", [])):
        expected_title_assertions.add((candidate_id, row["academicYear"], ordinal, title, normalized_name_key(title), "provisional"))
    for ordinal, teacher in enumerate(row.get("instructorCandidates", [])):
        expected_instructor_assertions.add((candidate_id, row["academicYear"], ordinal, teacher, normalized_name_key(teacher), "provisional"))
    for ordinal, evidence in enumerate(row.get("evidence", [])):
        title = evidence.get("titleCandidate", "") or ""
        instructor = evidence.get("instructorCandidate", "") or ""
        expected_row_evidence.add((
            candidate_id, ordinal, row["academicYear"], int(evidence.get("page", 0)), int(evidence.get("line", 0)),
            title, normalized_name_key(title), instructor, normalized_name_key(instructor),
            evidence.get("roomCandidate", "") or "", evidence.get("termCandidate", "") or "",
            evidence.get("dayCandidate", "") or "", str(evidence.get("periodCandidate", "") or ""),
            evidence.get("columnParseStatus", ""), evidence.get("rowText", ""),
            json.dumps(evidence.get("cells", []), ensure_ascii=False, separators=(",", ":")),
            json.dumps(evidence, ensure_ascii=False, separators=(",", ":")),
        ))
actual_title_assertions = set(db.execute("SELECT candidate_id,academic_year,ordinal,title,name_key,review_status FROM candidate_title_assertion"))
actual_instructor_assertions = set(db.execute("SELECT candidate_id,academic_year,ordinal,instructor_name,name_key,review_status FROM candidate_instructor_assertion"))
actual_row_evidence = set(db.execute("""SELECT candidate_id,occurrence_ordinal,academic_year,source_page,source_line,
    title,title_key,instructor_name,instructor_key,room,term,day,period,parse_status,row_text,cells_json,occurrence_json
    FROM candidate_row_evidence"""))
candidate_indexes = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
expected_candidate_indexes = {"ix_candidate_title_year_key", "ix_candidate_instructor_year_key", "ix_candidate_row_title_teacher", "ix_candidate_row_teacher_title"}
expected_candidate_indexes.add("ix_candidate_review_teacher_name")
add("candidate_title_and_teacher_search_indexes_reconcile",
    actual_title_assertions == expected_title_assertions
    and actual_instructor_assertions == expected_instructor_assertions
    and expected_candidate_indexes.issubset(candidate_indexes),
    {"expectedTitleAssertions": len(expected_title_assertions), "sqliteTitleAssertions": len(actual_title_assertions),
     "expectedInstructorAssertions": len(expected_instructor_assertions), "sqliteInstructorAssertions": len(actual_instructor_assertions),
     "missingIndexes": sorted(expected_candidate_indexes - candidate_indexes),
     "yearSpecificTitleSearch": "WITH searchable AS (SELECT c.academic_year,c.course_code,c.source_id,r.source_page,r.source_line,v.reviewed_title AS title,v.reviewed_title_key AS title_key,i.instructor_name,i.name_key AS instructor_key FROM candidate_row_review v JOIN candidate_row_evidence r USING(candidate_id,occurrence_ordinal) JOIN candidate_row_review_instructor i USING(candidate_id,occurrence_ordinal) JOIN course_offering_candidate c USING(candidate_id) UNION ALL SELECT c.academic_year,c.course_code,c.source_id,r.source_page,r.source_line,r.title,r.title_key,r.instructor_name,r.instructor_key FROM candidate_row_evidence r JOIN course_offering_candidate c USING(candidate_id) LEFT JOIN candidate_row_review v USING(candidate_id,occurrence_ordinal) WHERE v.candidate_id IS NULL AND r.title<>'' AND r.instructor_name<>'') SELECT academic_year,course_code,source_id,source_page,source_line,title,instructor_name FROM searchable WHERE academic_year=? AND title_key=? AND instructor_key=? AND title_key NOT IN ('1q','2q','3q','4q') ORDER BY course_code,source_id,source_page,source_line",
     "mismatches": {"title": len(expected_title_assertions ^ actual_title_assertions),
                    "instructor": len(expected_instructor_assertions ^ actual_instructor_assertions)}})

expected_review_rows = set()
expected_review_instructors = set()
review_source_mismatches = []
review_field_mismatches = []
historical_review_sources = {source["sourceId"]: source for source in historical_candidates["sources"]}
for (source_id, code), row in expected_candidate_map.items():
    candidate_id = f"{row['academicYear']}:{source_id}:{code}"
    manual = row.get("manualReview")
    if manual:
        source = official_by_id.get(source_id) or historical_review_sources.get(source_id) or {}
        source_sha = source.get("sha256", source.get("sourceSha256", ""))
        if (manual.get("sourceSha256") != row.get("sourceSha256")
                or manual.get("sourceSha256") != source_sha
                or not set(row.get("sourcePages", [])).issubset(manual.get("reviewedPages", []))
                or manual.get("reviewStatus") != "visually-reviewed-provisional"):
            review_source_mismatches.append(f"{source_id}:{code}")
        room_status = manual.get("reviewedRoomStatus")
        reviewed_room = next((e.get("manualReview", {}).get("room", "") for e in row.get("evidence", [])
                              if e.get("manualReview")), "")
        expected_room_candidates = [reviewed_room] if room_status == "listed" else []
        if (not {"title", "instructors", "room"}.issubset(set(manual.get("reviewedFields", [])))
                or room_status not in {"listed", "blank-in-source"}
                or (room_status == "listed") != bool(reviewed_room)
                or row.get("roomCandidates") != expected_room_candidates):
            review_field_mismatches.append(f"{source_id}:{code}")
    for ordinal, evidence in enumerate(row.get("evidence", [])):
        reviewed = evidence.get("manualReview")
        if not reviewed:
            continue
        expected_review_rows.add((candidate_id, ordinal, reviewed["sourceSha256"], reviewed["title"],
                                  normalized_name_key(reviewed["title"]), reviewed["room"],
                                  reviewed["reviewedRoomStatus"],
                                  json.dumps(reviewed["reviewedPages"]), reviewed["reviewMethod"],
                                  reviewed["reviewedAt"], reviewed["reviewStatus"]))
        for instructor_ordinal, teacher in enumerate(reviewed["instructors"]):
            expected_review_instructors.add((candidate_id, ordinal, instructor_ordinal, teacher,
                                             normalized_name_key(teacher), reviewed["reviewStatus"]))
actual_review_rows = set(db.execute("""SELECT candidate_id,occurrence_ordinal,source_sha256,reviewed_title,
    reviewed_title_key,reviewed_room,reviewed_room_status,reviewed_pages_json,review_method,reviewed_at,review_status
    FROM candidate_row_review"""))
actual_review_instructors = set(db.execute("""SELECT candidate_id,occurrence_ordinal,instructor_ordinal,
    instructor_name,name_key,review_status FROM candidate_row_review_instructor"""))
add("visual_review_rows_and_teacher_assertions_reconcile",
    actual_review_rows == expected_review_rows
    and actual_review_instructors == expected_review_instructors
    and not review_source_mismatches
    and not review_field_mismatches
    and candidate_metadata.get("visuallyReviewedCurrentCandidateRows") == sum(bool(row.get("manualReview")) for row in fall_candidates["records"])
    and candidate_metadata.get("visuallyReviewedCurrentOccurrences") == sum(sum("manualReview" in e for e in row["evidence"]) for row in fall_candidates["records"])
    and candidate_metadata.get("visuallyReviewedHistoricalCandidateRows") == sum(bool(row.get("manualReview")) for row in historical_candidates["records"])
    and candidate_metadata.get("visuallyReviewedHistoricalOccurrences") == sum(sum("manualReview" in e for e in row["evidence"]) for row in historical_candidates["records"]),
    {"overrideCurrentCandidateRows": sum(bool(row.get("manualReview")) for row in fall_candidates["records"]),
     "overrideHistoricalCandidateRows": sum(bool(row.get("manualReview")) for row in historical_candidates["records"]),
     "expectedReviewedOccurrences": len(expected_review_rows), "sqliteReviewedOccurrences": len(actual_review_rows),
     "expectedInstructorAssertions": len(expected_review_instructors), "sqliteInstructorAssertions": len(actual_review_instructors),
     "sourceHashOrPageCoverageMismatches": review_source_mismatches,
     "reviewFieldOrRoomStatusMismatches": review_field_mismatches,
     "reviewRowMismatches": len(expected_review_rows ^ actual_review_rows),
     "instructorMismatches": len(expected_review_instructors ^ actual_review_instructors)})

expected_blank_room_reviews = {
    (f"{row['academicYear']}:{row['sourceId']}:{row['courseCode']}", ordinal)
    for row in expected_candidate_map.values()
    for ordinal, evidence in enumerate(row.get("evidence", []))
    if evidence.get("manualReview", {}).get("reviewedRoomStatus") == "blank-in-source"
}
actual_blank_room_reviews = set(db.execute("""SELECT candidate_id,occurrence_ordinal
    FROM candidate_row_review WHERE reviewed_room_status='blank-in-source'"""))
queued_missing_room = {
    (row["sourceId"], row["courseCode"])
    for queue in (historical_review_queue, current_review_queue)
    for row in queue["records"]
    if "missing-room" in row["reasonCodes"]
}
blank_room_pairs = {(row["sourceId"], row["courseCode"])
                    for row in expected_candidate_map.values()
                    if row.get("manualReview", {}).get("reviewedRoomStatus") == "blank-in-source"}
add("visually_reviewed_blank_room_is_not_treated_as_missing",
    actual_blank_room_reviews == expected_blank_room_reviews
    and not (blank_room_pairs & queued_missing_room),
    {"expectedBlankRoomOccurrences": len(expected_blank_room_reviews),
     "sqliteBlankRoomOccurrences": len(actual_blank_room_reviews),
     "blankRoomPairsIncorrectlyQueuedAsMissing": sorted(blank_room_pairs & queued_missing_room)})

marketing_title_key = normalized_name_key("マーケティングリサーチ演習(2)")
marketing_rows = db.execute("""SELECT c.course_code,v.reviewed_title,v.reviewed_title_key,
    v.reviewed_room,v.reviewed_room_status,i.instructor_name,i.name_key
    FROM candidate_row_review v
    JOIN candidate_row_evidence r USING(candidate_id,occurrence_ordinal)
    JOIN candidate_row_review_instructor i USING(candidate_id,occurrence_ordinal)
    JOIN course_offering_candidate c USING(candidate_id)
    WHERE c.academic_year=2024 AND c.source_id='hist-2024-timetable-a4d8d1ab9b4ac371'
      AND c.course_code IN ('sba514202','sbz514204')
    ORDER BY c.course_code,i.instructor_name""").fetchall()
marketing_by_code = {}
for code, title, title_key, room, room_status, instructor, instructor_key in marketing_rows:
    item = marketing_by_code.setdefault(code, {"title": title, "titleKey": title_key,
        "room": room, "roomStatus": room_status, "instructors": set()})
    item["instructors"].add(instructor)
expected_marketing_teachers = {
    "sba514202": {"坂倉 杏介", "西山 敏樹", "永江 総宜", "鹿野 由利子"},
    "sbz514204": {"坂倉 杏介", "西山 敏樹", "永江 総宜", "岡澤 由季", "北見 幸一", "鹿野 由利子", "林 和眞"},
}
marketing_example_matches = (
    set(marketing_by_code) == set(expected_marketing_teachers)
    and all(item["titleKey"] == marketing_title_key and item["roomStatus"] == "listed"
            and item["instructors"] == expected_marketing_teachers[code]
            for code, item in marketing_by_code.items())
    and marketing_by_code["sba514202"]["room"] == "71A"
    and marketing_by_code["sbz514204"]["room"] == "71A(3Q),71B(4Q)"
    and marketing_by_code["sba514202"]["instructors"] != marketing_by_code["sbz514204"]["instructors"]
)
add("same_title_different_teacher_2024_offerings_remain_distinct", marketing_example_matches,
    {"title": "マーケティングリサーチ演習(2)",
     "offerings": {code: {"titleKey": item["titleKey"], "room": item["room"],
                           "roomStatus": item["roomStatus"], "instructors": sorted(item["instructors"])}
                   for code, item in marketing_by_code.items()},
     "expectedCourseCodes": sorted(expected_marketing_teachers)})

cartesian_overstatement_groups = db.execute("""WITH pair_rows AS (
    SELECT r.candidate_id,v.reviewed_title title,i.instructor_name
    FROM candidate_row_evidence r JOIN candidate_row_review v USING(candidate_id,occurrence_ordinal)
    JOIN candidate_row_review_instructor i USING(candidate_id,occurrence_ordinal)
    UNION ALL
    SELECT r.candidate_id,r.title,r.instructor_name FROM candidate_row_evidence r
    LEFT JOIN candidate_row_review v USING(candidate_id,occurrence_ordinal)
    WHERE v.candidate_id IS NULL AND r.title<>'' AND r.instructor_name<>''
), pairs AS (
    SELECT candidate_id,COUNT(DISTINCT title||char(0)||instructor_name) pair_n,
           COUNT(DISTINCT NULLIF(title,'')) title_n,COUNT(DISTINCT NULLIF(instructor_name,'')) teacher_n
    FROM pair_rows WHERE title<>'' AND instructor_name<>'' GROUP BY candidate_id)
    SELECT COUNT(*) FROM pairs WHERE title_n>1 AND teacher_n>1 AND pair_n<title_n*teacher_n""").fetchone()[0]
same_title_multiple_teacher_groups = db.execute(f"""WITH pairs AS (
    SELECT r.academic_year,v.reviewed_title_key title_key,i.name_key instructor_key
    FROM candidate_row_evidence r JOIN candidate_row_review v USING(candidate_id,occurrence_ordinal)
    JOIN candidate_row_review_instructor i USING(candidate_id,occurrence_ordinal)
    UNION ALL
    SELECT r.academic_year,r.title_key,r.instructor_key FROM candidate_row_evidence r
    LEFT JOIN candidate_row_review v USING(candidate_id,occurrence_ordinal)
    WHERE v.candidate_id IS NULL
), title_groups AS (
    SELECT academic_year,title_key FROM pairs
    WHERE title_key<>'' AND instructor_key<>'' AND {excluded_title_sql} GROUP BY academic_year,title_key
    HAVING COUNT(DISTINCT instructor_key)>1)
    SELECT COUNT(*) FROM title_groups""").fetchone()[0]
invalid_row_locations = db.execute("SELECT COUNT(*) FROM candidate_row_evidence WHERE source_page<1 OR source_line<1").fetchone()[0]
identity_search_sql = f"""WITH searchable AS (
    SELECT c.academic_year,c.course_code,c.source_id,r.source_page,r.source_line,
           v.reviewed_title title,v.reviewed_title_key title_key,
           i.instructor_name,i.name_key instructor_key
    FROM candidate_row_review v
    JOIN candidate_row_evidence r USING(candidate_id,occurrence_ordinal)
    JOIN candidate_row_review_instructor i USING(candidate_id,occurrence_ordinal)
    JOIN course_offering_candidate c USING(candidate_id)
    UNION ALL
    SELECT c.academic_year,c.course_code,c.source_id,r.source_page,r.source_line,
           r.title,r.title_key,r.instructor_name,r.instructor_key
    FROM candidate_row_evidence r
    JOIN course_offering_candidate c USING(candidate_id)
    LEFT JOIN candidate_row_review v USING(candidate_id,occurrence_ordinal)
    WHERE v.candidate_id IS NULL AND r.title<>'' AND r.instructor_name<>'')
    SELECT academic_year,course_code,source_id,source_page,source_line,title,instructor_name
    FROM searchable
    WHERE academic_year=? AND title_key=? AND instructor_key=?
      AND title<>'' AND instructor_name<>''
      AND {excluded_title_sql}
    ORDER BY course_code,source_id,source_page,source_line"""
add("row_level_title_teacher_provenance_reconciles",
    actual_row_evidence == expected_row_evidence and expected_candidate_indexes.issubset(candidate_indexes)
    and invalid_row_locations == 0,
    {"expectedPdfOccurrences": len(expected_row_evidence), "sqlitePdfOccurrences": len(actual_row_evidence),
     "mismatches": len(expected_row_evidence ^ actual_row_evidence),
     "invalidPageOrLineLocations": invalid_row_locations,
     "candidateGroupsWhereIndependentListsWouldCreateFalsePairs": cartesian_overstatement_groups,
     "sameTitleGroupsWithMultipleTeachersAcrossOfferings": same_title_multiple_teacher_groups,
     "sameTitleDifferentInstructorSearch": identity_search_sql})

excluded_title_candidate_pairs = {(row["sourceId"], row["courseCode"])
                                 for row in expected_candidate_map.values()
                                 if any(normalized_name_key(title) in excluded_title_key_set
                                        for title in row.get("titleCandidates", []))}
queued_excluded_title_pairs = {(row["sourceId"], row["courseCode"])
                               for queue in (historical_review_queue, current_review_queue)
                               for row in queue["records"]
                               if title_review_rules["reviewReasonCode"] in row["reasonCodes"]}
excluded_title_source_rows = db.execute("""WITH pairs AS (
    SELECT r.title_key FROM candidate_row_evidence r
    LEFT JOIN candidate_row_review v USING(candidate_id,occurrence_ordinal)
    WHERE v.candidate_id IS NULL
    UNION ALL
    SELECT v.reviewed_title_key FROM candidate_row_review v)
    SELECT COUNT(*) FROM pairs WHERE title_key IN ({})""".format(
        ",".join("'" + key.replace("'", "''") + "'" for key in excluded_title_keys))).fetchone()[0]
documented_exclusion = "title_key NOT IN (" + ", ".join("'" + key + "'" for key in excluded_title_keys) + ")"
schema_doc = (ROOT / "docs" / "DATA_SCHEMA.md").read_text(encoding="utf-8")
add("suspicious_numeric_and_quarter_title_labels_are_queued_and_excluded",
    excluded_title_candidate_pairs.issubset(queued_excluded_title_pairs)
    and excluded_title_sql in identity_search_sql
    and schema_doc.count(documented_exclusion) >= 2,
    {"excludedTitleCandidatePairs": len(excluded_title_candidate_pairs),
     "queuedForManualReview": len(excluded_title_candidate_pairs & queued_excluded_title_pairs),
     "missingFromReviewQueue": sorted(excluded_title_candidate_pairs - queued_excluded_title_pairs),
     "excludedTitleSourceRows": excluded_title_source_rows,
     "identitySearchExcludesLabels": excluded_title_sql in identity_search_sql,
     "documentedQueriesExcludingLabels": schema_doc.count(documented_exclusion),
     "excludedTitleKeys": excluded_title_keys})

historical_candidate_sources = {source["sourceId"]: source for source in historical_candidates["sources"]}
rule_example_mismatches = []
for example in title_review_rules.get("sourceExamples", []):
    source = official_by_id.get(example["sourceId"]) or historical_candidate_sources.get(example["sourceId"])
    expected_sha = source.get("sourceSha256", source.get("sha256", "")) if source else ""
    if not source or expected_sha != example["sourceSha256"]:
        rule_example_mismatches.append(f"source-hash:{example['sourceId']}")
        continue
    matching_rows = [row for row in expected_candidate_map.values()
                     if row["sourceId"] == example["sourceId"]
                     and any(int(evidence.get("page", 0)) == example["page"]
                             and normalized_name_key(evidence.get("titleCandidate", "")) == normalized_name_key(example["printedValue"])
                             for evidence in row.get("evidence", []))]
    if not matching_rows:
        rule_example_mismatches.append(f"page-value-not-in-candidate-evidence:{example['sourceId']}:{example['page']}:{example['printedValue']}")
add("title_exclusion_rule_examples_match_source_hash_and_page_evidence",
    len(title_review_rules.get("sourceExamples", [])) == 3 and not rule_example_mismatches,
    {"sourceExamples": len(title_review_rules.get("sourceExamples", [])),
     "exampleMismatches": rule_example_mismatches})

add("sqlite_foreign_keys_and_schema", integrity == ["ok"] and not fk and expected_tables.issubset(tables),
    {"integrityCheck": integrity, "foreignKeyViolations": len(fk), "missingTables": sorted(expected_tables - tables), "tableCounts": counts})
db.close()

hard_failures = [c for c in checks if c["status"] == "fail"]
extension_ready = (not hard_failures and not uncoded_documents and historic_offerings > 0
                   and audit.get("decision") == "READY_FOR_REVIEW")
result = {
    "schemaVersion": 1,
    "database": db_path.name,
    "checkCount": len(checks),
    "failedChecks": len(hard_failures),
    "checks": checks,
    "databaseIntegrity": "PASS" if not hard_failures else "FAIL",
    "extensionReady": extension_ready,
    "decision": "READY_FOR_EXTENSION_REVIEW" if extension_ready else "DATABASE_INTEGRITY_PASS_SCOPE_INCOMPLETE" if not hard_failures else "DATABASE_INTEGRITY_FAIL",
}
report_json.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
lines = ["# 年度横断SQLiteデータベース監査", "", f"判定: **{result['decision']}**", "",
         f"データベース整合性: **{result['databaseIntegrity']}**", f"拡張機能反映可能: **{'はい' if extension_ready else 'いいえ'}**", "",
         "## チェック結果", "", "| チェック | 結果 | 根拠 |", "|---|---|---|"]
for check in checks:
    lines.append(f"| {check['check']} | {check['status']} | `{json.dumps(check['evidence'], ensure_ascii=False)}` |")
lines += ["", "## 未完了の範囲", "", f"- 2022〜2025年度の正規化済み開講科目レコード: {historic_offerings}",
          f"- 2022〜2025年度の未承認科目行候補: {len(historical_candidates['records'])}",
          f"- 授業時間割として扱うPDFで講義コード未抽出: {len(uncoded_documents)}",
          f"- 科目抽出対象から除外した補助PDF: {len(supplementary_documents)}",
          f"- 2026年度カタログ品質監査: {audit.get('decision')}",
          f"- 2026年度後期・全6資料の未承認候補行: {len(fall_candidates['records'])}（候補テーブルへ保存、科目正規テーブルには未昇格）",
          "歴史年度のPDFとコード証拠は保存済みですが、過年度の科目名・担当者・時間割を確定値として扱える完成度ではありません。", ""]
report_md.write_text("\n".join(lines), encoding="utf-8")
print(json.dumps({"decision": result["decision"], "databaseIntegrity": result["databaseIntegrity"],
                  "failedChecks": len(hard_failures), "extensionReady": extension_ready,
                  "candidateRows": len(candidate_rows_db)}, ensure_ascii=False))
if hard_failures:
    sys.exit(1)
