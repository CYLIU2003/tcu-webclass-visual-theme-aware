#!/usr/bin/env python3
"""Export only source-row reviews suitable for display as historical examples."""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "course-catalog-multiyear.sqlite"
OUTPUT = ROOT / "data" / "historical-course-row-evidence.json"
YEARS = range(2022, 2026)
EXPECTED_REVIEW_STATUS = "visually-reviewed-provisional"
EXPECTED_REVIEW_METHOD = "official-pdf-visual-inspection"


def load_coverage(db: sqlite3.Connection) -> dict:
    row = db.execute(
        "SELECT value_json FROM catalog_release_metadata WHERE metadata_key='coverage'"
    ).fetchone()
    if not row:
        raise ValueError("catalog_release_metadata.coverage is missing")
    return json.loads(row[0])


def export() -> dict:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    try:
        if db.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("database contains foreign-key violations")
        schema_version = db.execute("PRAGMA user_version").fetchone()[0]
        if schema_version != 8:
            raise ValueError(f"expected database schema 8, got {schema_version}")

        coverage = load_coverage(db)
        guide_rows = {
            "references": db.execute("SELECT COUNT(*) FROM curriculum_course_reference").fetchone()[0],
            "requirements": db.execute("SELECT COUNT(*) FROM curriculum_requirement_group").fetchone()[0],
            "rules": db.execute("SELECT COUNT(*) FROM curriculum_rule").fetchone()[0],
            "approvedRequirements": db.execute(
                "SELECT COUNT(*) FROM curriculum_requirement_group WHERE review_status='approved'"
            ).fetchone()[0] + db.execute(
                "SELECT COUNT(*) FROM curriculum_rule WHERE review_status='approved'"
            ).fetchone()[0],
        }
        curriculum_status = (
            "not-populated"
            if guide_rows["references"] + guide_rows["requirements"] + guide_rows["rules"] == 0
            else coverage.get("curriculumDataStatus", "in-review")
        )

        rows = db.execute("""SELECT
              c.academic_year, c.course_code, c.candidate_id, e.occurrence_ordinal,
              e.source_page, e.source_line, v.reviewed_pages_json,
              v.source_sha256 AS reviewed_source_sha256, v.reviewed_title,
              v.reviewed_room, v.reviewed_room_status, v.review_status,
              v.review_method, v.reviewed_at,
              source.source_id, source.title AS source_title, source.url AS source_url,
              source.sha256 AS source_sha256, source.metadata_json
            FROM candidate_row_review v
            JOIN course_offering_candidate c USING(candidate_id)
            JOIN candidate_row_evidence e
              ON e.candidate_id=v.candidate_id AND e.occurrence_ordinal=v.occurrence_ordinal
            JOIN source_document source USING(source_id)
            WHERE c.academic_year BETWEEN 2022 AND 2025
              AND v.review_status=?
              AND v.review_method=?
            ORDER BY c.academic_year,c.course_code,source.source_id,e.source_page,e.source_line,
                     e.occurrence_ordinal""",
            (EXPECTED_REVIEW_STATUS, EXPECTED_REVIEW_METHOD)).fetchall()

        instructors_by_occurrence: dict[tuple[str, int], list[str]] = {}
        for item in db.execute("""SELECT candidate_id,occurrence_ordinal,instructor_name
            FROM candidate_row_review_instructor
            ORDER BY candidate_id,occurrence_ordinal,instructor_ordinal"""):
            key = (item[0], item[1])
            values = instructors_by_occurrence.setdefault(key, [])
            if item[2] and item[2] not in values:
                values.append(item[2])

        grouped: dict[tuple, dict] = {}
        seen_occurrences = set()
        for row in rows:
            occurrence_key = (row["candidate_id"], row["occurrence_ordinal"])
            if occurrence_key in seen_occurrences:
                raise ValueError(f"duplicate review occurrence: {occurrence_key}")
            seen_occurrences.add(occurrence_key)

            page = int(row["source_page"])
            reviewed_pages = [int(value) for value in json.loads(row["reviewed_pages_json"])]
            if page < 1 or page not in reviewed_pages:
                raise ValueError(f"review page does not match occurrence: {occurrence_key} page={page}")
            if row["reviewed_source_sha256"] != row["source_sha256"]:
                raise ValueError(f"review source hash mismatch: {occurrence_key}")
            metadata = json.loads(row["metadata_json"])
            page_count = int(metadata.get("pageCount", 0) or 0)
            if page_count and page > page_count:
                raise ValueError(f"review page is outside the PDF: {occurrence_key} page={page}/{page_count}")
            parsed_url = urlparse(row["source_url"] or "")
            if parsed_url.scheme != "https" or parsed_url.hostname not in {"asc.tcu.ac.jp", "www.asc.tcu.ac.jp"}:
                raise ValueError(f"review source is not an official HTTPS URL: {row['source_id']}")
            if not row["reviewed_title"].strip():
                raise ValueError(f"reviewed course title is empty: {occurrence_key}")

            instructors = instructors_by_occurrence.get(occurrence_key, [])
            group_key = (
                row["academic_year"], row["course_code"], row["source_id"], page,
                row["reviewed_title"], row["reviewed_room"], row["reviewed_room_status"],
                tuple(instructors),
            )
            record = grouped.get(group_key)
            if record is None:
                record = {
                    "academicYear": row["academic_year"],
                    "courseCode": row["course_code"],
                    "courseName": row["reviewed_title"],
                    "instructors": instructors,
                    "room": row["reviewed_room"],
                    "roomStatus": row["reviewed_room_status"],
                    "sourcePage": page,
                    "source": {
                        "id": row["source_id"],
                        "title": row["source_title"],
                        "url": row["source_url"],
                        "sha256": row["source_sha256"],
                    },
                    "reviewStatus": row["review_status"],
                    "reviewMethod": row["review_method"],
                    "reviewedAt": row["reviewed_at"],
                    "occurrences": 0,
                }
                grouped[group_key] = record
            record["occurrences"] += 1

        records = list(grouped.values())
        records.sort(key=lambda x: (x["academicYear"], x["courseName"], x["courseCode"], x["sourcePage"]))
        pairs = {(row["academicYear"], row["courseCode"], row["source"]["id"]) for row in records}
        occurrence_count = sum(row["occurrences"] for row in records)
        current_offering_count = db.execute("SELECT COUNT(*) FROM course_offering").fetchone()[0]
        source_count = db.execute("SELECT COUNT(*) FROM source_document").fetchone()[0]

        return {
            "schemaVersion": 1,
            "database": {
                "schemaVersion": schema_version,
                "curriculumSchemaVersion": coverage.get("curriculumSchemaVersion"),
                "sourceDocumentCount": source_count,
                "currentOfferingCount": current_offering_count,
                "currentCatalogStatus": coverage.get("current2026DataStatus", "unknown"),
                "historicalOfferingStatus": coverage.get("historicalDataStatus", "unknown"),
                "curriculumStatus": curriculum_status,
                "curriculumRows": guide_rows,
            },
            "summary": {
                "reviewedOccurrences": occurrence_count,
                "groupedExamples": len(records),
                "courseSourcePairs": len(pairs),
                "academicYears": sorted({row["academicYear"] for row in records}),
                "scope": "Historical examples only; no identity or current-offering claim.",
            },
            "records": records,
        }
    finally:
        db.close()


def main() -> None:
    payload = export()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=OUTPUT.name + ".", suffix=".tmp", dir=OUTPUT.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, OUTPUT)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise
    print(json.dumps({"output": str(OUTPUT), **payload["summary"], "database": payload["database"]},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
