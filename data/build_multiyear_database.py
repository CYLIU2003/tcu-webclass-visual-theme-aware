#!/usr/bin/env python3
"""Build a versioned SQLite copy with 2022-2025 source and code evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import tempfile
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--base-database", type=Path, default=DATA / "course-catalog-2026.sqlite",
                    help="読み取り専用で開く基礎カタログのSQLiteファイル")
parser.add_argument("--output", type=Path, default=DATA / "course-catalog-multiyear.sqlite",
                    help="新規に作成するSQLiteファイル。既存ファイルは上書きしません")
args = parser.parse_args()
OUTPUT = args.output.resolve()
if OUTPUT.exists():
    raise FileExistsError(f"出力先は既に存在します。既存データを保護するため別の --output を指定してください: {OUTPUT}")
if not OUTPUT.parent.is_dir():
    raise FileNotFoundError(f"出力先のディレクトリが存在しません: {OUTPUT.parent}")
source_manifest = json.loads((DATA / "historical-source-cache-manifest.json").read_text(encoding="utf-8"))
code_index = json.loads((DATA / "historical-timetable-code-index.json").read_text(encoding="utf-8"))
fall_candidates = json.loads((DATA / "current-fall-offering-candidates-2026.json").read_text(encoding="utf-8"))
historical_candidates = json.loads((DATA / "historical-offering-candidates.json").read_text(encoding="utf-8"))


def candidate_name_key(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    value = re.sub(r"[\u200b-\u200d\ufeff]", "", value)
    return re.sub(r"\s+", "", value).casefold()

source_by_url = {}
for source in source_manifest["records"]:
    if not source.get("localPath") or source.get("status") != "source-file-captured-not-course-row-validated":
        raise ValueError(f"Historical source is not captured: {source.get('sourceUrl')}")
    source_id = f"hist-{source['academicYear']}-{source['kind']}-{hashlib.sha256(source['sourceUrl'].encode()).hexdigest()[:16]}"
    source_by_url[source["sourceUrl"]] = (source_id, source)

fd, temp_name = tempfile.mkstemp(prefix="course-catalog-multiyear-", suffix=".sqlite.tmp", dir=OUTPUT.parent)
os.close(fd)
try:
    src = sqlite3.connect(f"{args.base_database.resolve().as_uri()}?mode=ro", uri=True)
    dst = sqlite3.connect(temp_name)
    src.backup(dst)
    src.close()
    dst.execute("PRAGMA foreign_keys = ON")
    with dst:
        dst.executescript("""
          CREATE INDEX IF NOT EXISTS ix_course_offering_year_code
            ON course_offering(academic_year, course_code);
          CREATE INDEX IF NOT EXISTS ix_code_evidence_code
            ON official_timetable_code_evidence(course_code);
          CREATE TABLE IF NOT EXISTS catalog_release_metadata (
            metadata_key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS course_offering_candidate (
            candidate_id TEXT PRIMARY KEY,
            academic_year INTEGER NOT NULL,
            course_code TEXT NOT NULL,
            source_id TEXT NOT NULL REFERENCES source_document(source_id),
            term TEXT NOT NULL DEFAULT '',
            scope TEXT NOT NULL DEFAULT '',
            title_candidates_json TEXT NOT NULL,
            instructor_candidates_json TEXT NOT NULL,
            room_candidates_json TEXT NOT NULL,
            source_pages_json TEXT NOT NULL,
            occurrence_count INTEGER NOT NULL,
            source_evidence_json TEXT NOT NULL,
            base_snapshot_match INTEGER NOT NULL DEFAULT 0,
            review_status TEXT NOT NULL,
            extraction_metadata_json TEXT NOT NULL,
            UNIQUE(academic_year,source_id,course_code)
          );
          CREATE INDEX IF NOT EXISTS ix_offering_candidate_code ON course_offering_candidate(academic_year,course_code);
          CREATE TABLE IF NOT EXISTS candidate_title_assertion (
            candidate_id TEXT NOT NULL REFERENCES course_offering_candidate(candidate_id) ON DELETE CASCADE,
            academic_year INTEGER NOT NULL,
            ordinal INTEGER NOT NULL,
            title TEXT NOT NULL,
            name_key TEXT NOT NULL,
            review_status TEXT NOT NULL DEFAULT 'provisional',
            PRIMARY KEY(candidate_id,ordinal)
          );
          CREATE INDEX IF NOT EXISTS ix_candidate_title_year_key ON candidate_title_assertion(academic_year,name_key);
          CREATE TABLE IF NOT EXISTS candidate_instructor_assertion (
            candidate_id TEXT NOT NULL REFERENCES course_offering_candidate(candidate_id) ON DELETE CASCADE,
            academic_year INTEGER NOT NULL,
            ordinal INTEGER NOT NULL,
            instructor_name TEXT NOT NULL,
            name_key TEXT NOT NULL,
            review_status TEXT NOT NULL DEFAULT 'provisional',
            PRIMARY KEY(candidate_id,ordinal)
          );
          CREATE INDEX IF NOT EXISTS ix_candidate_instructor_year_key ON candidate_instructor_assertion(academic_year,name_key);
          CREATE TABLE IF NOT EXISTS candidate_row_evidence (
            candidate_id TEXT NOT NULL REFERENCES course_offering_candidate(candidate_id) ON DELETE CASCADE,
            occurrence_ordinal INTEGER NOT NULL,
            academic_year INTEGER NOT NULL,
            source_page INTEGER NOT NULL,
            source_line INTEGER NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            title_key TEXT NOT NULL DEFAULT '',
            instructor_name TEXT NOT NULL DEFAULT '',
            instructor_key TEXT NOT NULL DEFAULT '',
            room TEXT NOT NULL DEFAULT '',
            term TEXT NOT NULL DEFAULT '',
            day TEXT NOT NULL DEFAULT '',
            period TEXT NOT NULL DEFAULT '',
            parse_status TEXT NOT NULL DEFAULT '',
            row_text TEXT NOT NULL DEFAULT '',
            cells_json TEXT NOT NULL DEFAULT '[]',
            occurrence_json TEXT NOT NULL,
            PRIMARY KEY(candidate_id, occurrence_ordinal)
          );
          CREATE TABLE IF NOT EXISTS candidate_row_review (
            candidate_id TEXT NOT NULL,
            occurrence_ordinal INTEGER NOT NULL,
            source_sha256 TEXT NOT NULL,
            reviewed_title TEXT NOT NULL,
            reviewed_title_key TEXT NOT NULL,
            reviewed_room TEXT NOT NULL,
            reviewed_room_status TEXT NOT NULL,
            reviewed_pages_json TEXT NOT NULL,
            review_method TEXT NOT NULL,
            reviewed_at TEXT NOT NULL,
            review_status TEXT NOT NULL,
            PRIMARY KEY(candidate_id, occurrence_ordinal),
            FOREIGN KEY(candidate_id, occurrence_ordinal)
              REFERENCES candidate_row_evidence(candidate_id, occurrence_ordinal) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS candidate_row_review_instructor (
            candidate_id TEXT NOT NULL,
            occurrence_ordinal INTEGER NOT NULL,
            instructor_ordinal INTEGER NOT NULL,
            instructor_name TEXT NOT NULL,
            name_key TEXT NOT NULL,
            review_status TEXT NOT NULL,
            PRIMARY KEY(candidate_id, occurrence_ordinal, instructor_ordinal),
            FOREIGN KEY(candidate_id, occurrence_ordinal)
              REFERENCES candidate_row_review(candidate_id, occurrence_ordinal) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS ix_candidate_row_title_teacher
            ON candidate_row_evidence(academic_year,title_key,instructor_key);
          CREATE INDEX IF NOT EXISTS ix_candidate_row_teacher_title
            ON candidate_row_evidence(academic_year,instructor_key,title_key);
          CREATE INDEX IF NOT EXISTS ix_candidate_review_teacher_name
            ON candidate_row_review_instructor(name_key);
        """)
        dst.executescript((DATA / "curriculum-schema-v1.sql").read_text(encoding="utf-8"))

        def insert_row_evidence(candidate_id: str, academic_year: int, row: dict) -> None:
            for ordinal, evidence in enumerate(row.get("evidence", [])):
                title = evidence.get("titleCandidate", "") or ""
                instructor = evidence.get("instructorCandidate", "") or ""
                dst.execute("""INSERT OR REPLACE INTO candidate_row_evidence VALUES
                  (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                  (candidate_id, ordinal, academic_year, int(evidence.get("page", 0)), int(evidence.get("line", 0)),
                   title, candidate_name_key(title), instructor, candidate_name_key(instructor),
                   evidence.get("roomCandidate", "") or "", evidence.get("termCandidate", "") or "",
                   evidence.get("dayCandidate", "") or "", str(evidence.get("periodCandidate", "") or ""),
                   evidence.get("columnParseStatus", ""), evidence.get("rowText", ""),
                   json.dumps(evidence.get("cells", []), ensure_ascii=False, separators=(",", ":")),
                   json.dumps(evidence, ensure_ascii=False, separators=(",", ":"))))
                reviewed = evidence.get("manualReview")
                if reviewed:
                    dst.execute("""INSERT OR REPLACE INTO candidate_row_review VALUES
                      (?,?,?,?,?,?,?,?,?,?,?)""",
                      (candidate_id, ordinal, reviewed["sourceSha256"], reviewed["title"],
                       candidate_name_key(reviewed["title"]), reviewed["room"],
                       reviewed.get("reviewedRoomStatus", "listed" if reviewed["room"] else "not-recorded"),
                       json.dumps(reviewed["reviewedPages"]), reviewed["reviewMethod"], reviewed["reviewedAt"],
                       reviewed["reviewStatus"]))
                    for teacher_ordinal, teacher in enumerate(reviewed["instructors"]):
                        dst.execute("""INSERT OR REPLACE INTO candidate_row_review_instructor VALUES
                          (?,?,?,?,?,?)""",
                          (candidate_id, ordinal, teacher_ordinal, teacher, candidate_name_key(teacher),
                           reviewed["reviewStatus"]))
        for source_id, source in source_by_url.values():
            scope = source.get("scope", {})
            title_scope = "・".join(str(scope[k]) for k in ("campus", "level") if scope.get(k))
            is_timetable = source["kind"] == "timetable" and source.get("contentRole", "course-timetable") == "course-timetable"
            title_kind = ("時間割" if is_timetable else "補助資料") if source["kind"] == "timetable" else "時間割訂正"
            metadata = {**source, "academicYear": source["academicYear"], "reviewStatus": source["status"]}
            dst.execute("""INSERT OR REPLACE INTO source_document
              (source_id,kind,title,scope,url,page_url,sha256,publication_date,metadata_json)
              VALUES (?,?,?,?,?,?,?,?,?)""",
              (source_id, f"historical-{source['kind']}" if is_timetable or source["kind"] != "timetable" else "historical-supplementary",
               f"{source['academicYear']}年度 {title_scope} {title_kind}".strip(),
               json.dumps(scope, ensure_ascii=False, separators=(",", ":")), source["sourceUrl"],
               source.get("sourcePageUrl", ""), source["sha256"], "",
               json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))))

        inserted = 0
        for row in code_index["records"]:
            source_pair = source_by_url.get(row["sourceUrl"])
            if not source_pair:
                raise ValueError(f"Code evidence has no registered source: {row['sourceUrl']}")
            source_id, source = source_pair
            dst.execute("""INSERT OR REPLACE INTO official_timetable_code_evidence
              (source_id,course_code,scope,term,occurrence_count,source_pages_json,
               source_evidence_json,base_snapshot_match,review_status)
              VALUES (?,?,?,?,?,?,?,?,?)""",
              (source_id, row["courseCode"], json.dumps(row.get("scope", {}), ensure_ascii=False), "",
               row["occurrenceCount"], json.dumps(row["sourcePages"]),
               json.dumps(row["sourceEvidence"], ensure_ascii=False), 0,
               "historical-code-indexed-needs-row-validation"))
            inserted += 1

        candidate_hashes = {s["sourceId"]: s["sourceSha256"] for s in fall_candidates["sources"]}
        for source_id, digest in candidate_hashes.items():
            source_row = dst.execute("SELECT sha256 FROM source_document WHERE source_id=?", (source_id,)).fetchone()
            if not source_row or source_row[0] != digest:
                raise ValueError(f"Current-year candidate source is missing from SQLite or its hash differs: {source_id}")
        candidate_rows_inserted = 0
        dst.execute("DELETE FROM course_offering_candidate")
        for row in fall_candidates["records"]:
            metadata = {"extractedAt": fall_candidates["extractedAt"], "parser": "extract_all_fall_candidates.py", "sourceSha256": row["sourceSha256"]}
            candidate_id = f"{fall_candidates['academicYear']}:{row['sourceId']}:{row['courseCode']}"
            dst.execute("""INSERT OR REPLACE INTO course_offering_candidate VALUES
              (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
              (candidate_id,
               fall_candidates["academicYear"], row["courseCode"], row["sourceId"], row.get("term", "後期"),
               json.dumps(row.get("scope", ""), ensure_ascii=False) if isinstance(row.get("scope"), (dict, list)) else row.get("scope", ""),
               json.dumps(row.get("titleCandidates", []), ensure_ascii=False),
               json.dumps(row.get("instructorCandidates", []), ensure_ascii=False),
               json.dumps(row.get("roomCandidates", []), ensure_ascii=False),
               json.dumps(row.get("sourcePages", [])), row["occurrenceCount"],
               json.dumps(row.get("evidence", []), ensure_ascii=False), int(row.get("baseSnapshotMatch", False)),
               row.get("reviewStatus", "provisional"), json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))))
            for ordinal, title in enumerate(row.get("titleCandidates", [])):
                dst.execute("INSERT OR REPLACE INTO candidate_title_assertion VALUES (?,?,?,?,?,?)",
                            (candidate_id, fall_candidates["academicYear"], ordinal, title, candidate_name_key(title), "provisional"))
            for ordinal, teacher in enumerate(row.get("instructorCandidates", [])):
                dst.execute("INSERT OR REPLACE INTO candidate_instructor_assertion VALUES (?,?,?,?,?,?)",
                            (candidate_id, fall_candidates["academicYear"], ordinal, teacher, candidate_name_key(teacher), "provisional"))
            insert_row_evidence(candidate_id, fall_candidates["academicYear"], row)
            candidate_rows_inserted += 1

        historical_source_lookup = {source["sourceUrl"]: source for source in source_manifest["records"]}
        historical_candidate_rows_inserted = 0
        historical_candidate_sources = {source["sourceId"]: source for source in historical_candidates["sources"]}
        for row in historical_candidates["records"]:
            source = historical_candidate_sources.get(row["sourceId"])
            if not source:
                raise ValueError(f"Historical candidate has no source manifest row: {row['sourceId']}")
            cached_source = historical_source_lookup.get(source["sourceUrl"])
            if not cached_source or cached_source.get("sha256") != row["sourceSha256"]:
                raise ValueError(f"Historical candidate source hash mismatch: {source['sourceUrl']}")
            source_row = dst.execute("SELECT sha256 FROM source_document WHERE source_id=?", (row["sourceId"],)).fetchone()
            if not source_row or source_row[0] != row["sourceSha256"]:
                raise ValueError(f"Historical candidate source is missing from SQLite or its hash differs: {row['sourceId']}")
            metadata = {"generatedAt": historical_candidates["generatedAt"], "parser": "extract_historical_offering_candidates.py", "sourceSha256": row["sourceSha256"]}
            candidate_id = f"{row['academicYear']}:{row['sourceId']}:{row['courseCode']}"
            dst.execute("""INSERT OR REPLACE INTO course_offering_candidate VALUES
              (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
              (candidate_id, row["academicYear"],
               row["courseCode"], row["sourceId"], row.get("term", ""),
               json.dumps(row.get("scope", {}), ensure_ascii=False, separators=(",", ":")),
               json.dumps(row.get("titleCandidates", []), ensure_ascii=False),
               json.dumps(row.get("instructorCandidates", []), ensure_ascii=False),
               json.dumps(row.get("roomCandidates", []), ensure_ascii=False),
               json.dumps(row.get("sourcePages", [])), row["occurrenceCount"],
               json.dumps(row.get("evidence", []), ensure_ascii=False), int(row.get("baseSnapshotMatch", False)),
               row.get("reviewStatus", "provisional"), json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))))
            for ordinal, title in enumerate(row.get("titleCandidates", [])):
                dst.execute("INSERT OR REPLACE INTO candidate_title_assertion VALUES (?,?,?,?,?,?)",
                            (candidate_id, row["academicYear"], ordinal, title, candidate_name_key(title), "provisional"))
            for ordinal, teacher in enumerate(row.get("instructorCandidates", [])):
                dst.execute("INSERT OR REPLACE INTO candidate_instructor_assertion VALUES (?,?,?,?,?,?)",
                            (candidate_id, row["academicYear"], ordinal, teacher, candidate_name_key(teacher), "provisional"))
            insert_row_evidence(candidate_id, row["academicYear"], row)
            historical_candidate_rows_inserted += 1

        meta = {
            "schemaVersion": 8,
            "curriculumSchemaVersion": 1,
            "curriculumDataStatus": "schema-installed-no-requirements-certified",
            "coverageYears": [2022, 2023, 2024, 2025, 2026],
            "normalizedOfferingYears": [2026],
            "historicalEvidenceYears": code_index["summary"]["academicYears"],
            "historicalSourceFileCount": len(source_by_url),
            "historicalCodeSourcePairs": inserted,
            "currentYearFallCandidateSourceIds": sorted(candidate_hashes),
            "currentYearFallCandidateRows": candidate_rows_inserted,
            "currentYearFallCandidatesStatus": "provisional-staging-only; not merged into course_offering",
            "visuallyReviewedCurrentCandidateRows": sum(bool(row.get("manualReview")) for row in fall_candidates["records"]),
            "visuallyReviewedCurrentOccurrences": sum(sum("manualReview" in evidence for evidence in row["evidence"]) for row in fall_candidates["records"]),
            "visuallyReviewedHistoricalCandidateRows": sum(bool(row.get("manualReview")) for row in historical_candidates["records"]),
            "visuallyReviewedHistoricalOccurrences": sum(sum("manualReview" in evidence for evidence in row["evidence"]) for row in historical_candidates["records"]),
            "historicalCandidateSourceIds": sorted(historical_candidate_sources),
            "historicalCandidateRows": historical_candidate_rows_inserted,
            "historicalCandidatesStatus": "provisional-staging-only; not merged into course_offering",
            "historicalDataStatus": "source-and-provisional-row-candidates; no historical course offering rows certified",
            "current2026DataStatus": "research-foundation-not-certified",
        }
        dst.execute("INSERT OR REPLACE INTO catalog_release_metadata VALUES (?,?)",
                    ("coverage", json.dumps(meta, ensure_ascii=False, separators=(",", ":"))))
        dst.execute("PRAGMA user_version = 8")
    fk = dst.execute("PRAGMA foreign_key_check").fetchall()
    if fk:
        raise ValueError(f"Foreign-key violations: {fk[:10]}")
    dst.close()
    # A hard link creates the destination atomically only if it does not exist.
    # In particular, never replace a database another process created meanwhile.
    os.link(temp_name, OUTPUT)
finally:
    if os.path.exists(temp_name):
        os.unlink(temp_name)

with sqlite3.connect(OUTPUT) as check:
    counts = {table: check.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
              for table in ("source_document", "course_offering", "official_timetable_code_evidence")}
counts["course_offering_candidate"] = check.execute("SELECT COUNT(*) FROM course_offering_candidate").fetchone()[0]
counts["candidate_title_assertion"] = check.execute("SELECT COUNT(*) FROM candidate_title_assertion").fetchone()[0]
counts["candidate_instructor_assertion"] = check.execute("SELECT COUNT(*) FROM candidate_instructor_assertion").fetchone()[0]
counts["candidate_row_evidence"] = check.execute("SELECT COUNT(*) FROM candidate_row_evidence").fetchone()[0]
counts["candidate_row_review"] = check.execute("SELECT COUNT(*) FROM candidate_row_review").fetchone()[0]
counts["candidate_row_review_instructor"] = check.execute("SELECT COUNT(*) FROM candidate_row_review_instructor").fetchone()[0]
curriculum_tables = [
    "course_concept", "course_concept_offering", "curriculum_program", "curriculum_plan_version",
    "curriculum_version_source", "curriculum_plan_version_evidence",
    "curriculum_section", "curriculum_section_evidence",
    "curriculum_course_reference", "curriculum_course_reference_evidence",
    "curriculum_requirement_group", "curriculum_requirement_member", "curriculum_requirement_evidence",
    "curriculum_rule", "curriculum_rule_evidence", "curriculum_rule_course_target",
    "curriculum_rule_group_target", "curriculum_rule_section_target", "curriculum_revision_event",
    "curriculum_course_offering_link",
    "curriculum_course_offering_link_evidence",
]
counts.update({table: check.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in curriculum_tables})
print(json.dumps({"output": str(OUTPUT), "schemaVersion": 8, "curriculumSchemaVersion": 1,
                  "counts": counts, "historicalPairsInserted": inserted,
                  "currentYearFallCandidateRowsInserted": candidate_rows_inserted,
                  "historicalCandidateRowsInserted": historical_candidate_rows_inserted}, ensure_ascii=False))
