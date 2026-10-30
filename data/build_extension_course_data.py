#!/usr/bin/env python3
"""Export source-linked 2022-2025 timetable rows for the extension.

The extension keeps visually reviewed rows separate from unreviewed PDF
extraction candidates. Nothing in this export is promoted to a canonical
historical course offering.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import tempfile
import unicodedata
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = ROOT / "data" / "course-catalog-multiyear.sqlite"
DEFAULT_OUTPUT = ROOT / "data" / "historical-course-row-evidence.json"
YEARS = tuple(range(2022, 2026))
EXPECTED_SCHEMA_VERSION = 8
EXPECTED_REVIEW_STATUS = "visually-reviewed-provisional"
EXPECTED_REVIEW_METHOD = "official-pdf-visual-inspection"
ALLOWED_PARSE_STATUSES = {"cell-anchored-row", "positional-inference", "needs-review"}
COURSE_CODE_RE = re.compile(r"^[a-z]{3,4}\d{4,6}$")
GENERIC_TITLE_KEYS = {"1", "2", "3", "4", "1q", "2q", "3q", "4q"}


def normalized_title_key(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    value = re.sub(r"[\u200b-\u200d\ufeff]", "", value)
    return re.sub(r"\s+", "", value).casefold()


def load_coverage(db: sqlite3.Connection) -> dict:
    row = db.execute(
        "SELECT value_json FROM catalog_release_metadata WHERE metadata_key='coverage'"
    ).fetchone()
    if not row:
        raise ValueError("catalog_release_metadata.coverage is missing")
    return json.loads(row[0])


def validate_source(row: sqlite3.Row) -> dict:
    source_url = row["source_url"] or ""
    parsed_url = urlparse(source_url)
    if parsed_url.scheme != "https" or parsed_url.hostname not in {"asc.tcu.ac.jp", "www.asc.tcu.ac.jp"}:
        raise ValueError(f"source is not official HTTPS: {row['source_id']}")
    source_hash = row["source_sha256"] or ""
    if not re.fullmatch(r"[a-f0-9]{64}", source_hash):
        raise ValueError(f"invalid source SHA-256: {row['source_id']}")
    metadata = json.loads(row["metadata_json"])
    page_count = int(metadata.get("pageCount", 0) or 0)
    page = int(row["source_page"] or 0)
    line = int(row["source_line"] or 0)
    if page < 1 or (page_count and page > page_count):
        raise ValueError(f"source page is out of range: {row['source_id']} p.{page}/{page_count}")
    if line < 1:
        raise ValueError(f"source line is invalid: {row['source_id']} p.{page} line={line}")
    return {
        "id": row["source_id"],
        "title": row["source_title"],
        "url": source_url,
        "sha256": source_hash,
        "pageCount": page_count or None,
    }


def export(database_path: Path) -> dict:
    if not database_path.is_file():
        raise FileNotFoundError(f"multi-year database not found: {database_path}")
    db = sqlite3.connect(database_path)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    try:
        if db.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("database contains foreign-key violations")
        schema_version = db.execute("PRAGMA user_version").fetchone()[0]
        if schema_version != EXPECTED_SCHEMA_VERSION:
            raise ValueError(f"expected database schema {EXPECTED_SCHEMA_VERSION}, got {schema_version}")

        coverage = load_coverage(db)
        curriculum_rows = {
            "references": db.execute("SELECT COUNT(*) FROM curriculum_course_reference").fetchone()[0],
            "requirements": db.execute("SELECT COUNT(*) FROM curriculum_requirement_group").fetchone()[0],
            "rules": db.execute("SELECT COUNT(*) FROM curriculum_rule").fetchone()[0],
        }
        curriculum_rows["approvedRequirements"] = db.execute(
            "SELECT COUNT(*) FROM curriculum_requirement_group WHERE review_status='approved'"
        ).fetchone()[0] + db.execute(
            "SELECT COUNT(*) FROM curriculum_rule WHERE review_status='approved'"
        ).fetchone()[0]
        curriculum_status = (
            "not-populated"
            if curriculum_rows["references"] + curriculum_rows["requirements"] + curriculum_rows["rules"] == 0
            else coverage.get("curriculumDataStatus", "in-review")
        )

        instructor_map: dict[tuple[str, int], list[str]] = {}
        for item in db.execute("""SELECT candidate_id,occurrence_ordinal,instructor_name
            FROM candidate_row_review_instructor
            ORDER BY candidate_id,occurrence_ordinal,instructor_ordinal"""):
            key = (item["candidate_id"], item["occurrence_ordinal"])
            names = instructor_map.setdefault(key, [])
            if item["instructor_name"] and item["instructor_name"] not in names:
                names.append(item["instructor_name"])

        query = """SELECT
              c.academic_year,c.course_code,c.candidate_id,e.occurrence_ordinal,
              e.source_page,e.source_line,e.title,e.instructor_name,e.room,
              e.term,e.day,e.period,e.parse_status,
              v.reviewed_title,v.reviewed_room,v.reviewed_room_status,
              v.source_sha256 AS reviewed_source_sha256,v.reviewed_pages_json,
              v.review_status,v.review_method,
              s.source_id,s.title AS source_title,s.url AS source_url,
              s.sha256 AS source_sha256,s.metadata_json
            FROM course_offering_candidate c
            JOIN candidate_row_evidence e USING(candidate_id)
            JOIN source_document s USING(source_id)
            LEFT JOIN candidate_row_review v
              ON v.candidate_id=e.candidate_id AND v.occurrence_ordinal=e.occurrence_ordinal
            WHERE c.academic_year BETWEEN ? AND ?
            ORDER BY c.academic_year,c.course_code,s.source_id,e.source_page,e.source_line,
                     e.occurrence_ordinal"""

        grouped: dict[tuple, dict] = {}
        occurrence_counts: Counter[int] = Counter()
        reviewed_counts: Counter[int] = Counter()
        source_records: dict[str, dict] = {}
        seen_occurrences: set[tuple[str, int]] = set()
        raw_row_count = 0

        for row in db.execute(query, (YEARS[0], YEARS[-1])):
            raw_row_count += 1
            year = int(row["academic_year"])
            code = str(row["course_code"] or "").strip().lower()
            if year not in YEARS or not COURSE_CODE_RE.fullmatch(code):
                raise ValueError(f"invalid historical year/course code: {year}/{code!r}")
            occurrence_key = (row["candidate_id"], int(row["occurrence_ordinal"]))
            if occurrence_key in seen_occurrences:
                raise ValueError(f"duplicate source-row occurrence: {occurrence_key}")
            seen_occurrences.add(occurrence_key)

            source = validate_source(row)
            source_records[source["id"]] = source
            page = int(row["source_page"])
            line = int(row["source_line"])
            parse_status = str(row["parse_status"] or "")
            if parse_status not in ALLOWED_PARSE_STATUSES:
                raise ValueError(f"unexpected parse status: {parse_status!r}")

            is_reviewed = bool(row["review_status"])
            if is_reviewed:
                if row["review_status"] != EXPECTED_REVIEW_STATUS:
                    raise ValueError(f"unexpected review status for {occurrence_key}: {row['review_status']}")
                if row["review_method"] != EXPECTED_REVIEW_METHOD:
                    raise ValueError(f"unexpected review method for {occurrence_key}: {row['review_method']}")
                if row["reviewed_source_sha256"] != source["sha256"]:
                    raise ValueError(f"review source hash mismatch: {occurrence_key}")
                reviewed_pages = [int(value) for value in json.loads(row["reviewed_pages_json"])]
                if page not in reviewed_pages:
                    raise ValueError(f"review page mismatch: {occurrence_key} page={page}")
                title = str(row["reviewed_title"] or "").strip()
                if not title:
                    raise ValueError(f"reviewed title is empty: {occurrence_key}")
                title_status = "visually-reviewed"
                instructors = instructor_map.get(occurrence_key, [])
                instructor_text = ""
                room = str(row["reviewed_room"] or "")
                room_status = str(row["reviewed_room_status"] or "not-recorded")
                review_status = EXPECTED_REVIEW_STATUS
                review_method = EXPECTED_REVIEW_METHOD
                reviewed_counts[year] += 1
            else:
                raw_title = str(row["title"] or "").strip()
                title_key = normalized_title_key(raw_title)
                if title_key in GENERIC_TITLE_KEYS:
                    title = ""
                    title_status = "generic-label-excluded"
                elif raw_title:
                    title = raw_title
                    title_status = "unreviewed-extraction"
                else:
                    title = ""
                    title_status = "not-extracted"
                instructors = []
                instructor_text = str(row["instructor_name"] or "").strip()
                room = str(row["room"] or "").strip()
                room_status = "unreviewed-extraction" if room else "not-extracted"
                review_status = "unreviewed-text-extraction"
                review_method = ""

            occurrence_counts[year] += 1
            term = str(row["term"] or "").strip()
            day = str(row["day"] or "").strip()
            period = str(row["period"] or "").strip()
            # Identical extracted rows on one page are compressed together while
            # every original source-line location remains attached to the record.
            group_key = (
                year, code, source["id"], title, title_status,
                tuple(instructors), instructor_text, room, room_status,
                parse_status, review_status, review_method,
            )
            record = grouped.get(group_key)
            if record is None:
                record = {
                    "academicYear": year,
                    "courseCode": code,
                    "courseName": title,
                    "titleStatus": title_status,
                    "instructors": instructors,
                    "instructorText": instructor_text,
                    "room": room,
                    "roomStatus": room_status,
                    "scheduleCandidates": [],
                    "occurrences": 0,
                    "parseStatus": parse_status,
                    "reviewStatus": review_status,
                    "reviewMethod": review_method,
                    "source": source,
                }
                grouped[group_key] = record
            schedule = next((item for item in record["scheduleCandidates"]
                             if (item["termCandidate"], item["dayCandidate"], item["periodCandidate"]) == (term, day, period)), None)
            if schedule is None:
                schedule = {
                    "termCandidate": term,
                    "dayCandidate": day,
                    "periodCandidate": period,
                    "sourceLocations": [],
                    "occurrences": 0,
                }
                record["scheduleCandidates"].append(schedule)
            location = next((item for item in schedule["sourceLocations"] if item["page"] == page), None)
            if location is None:
                location = {"page": page, "sourceLines": [], "occurrences": 0}
                schedule["sourceLocations"].append(location)
            location["sourceLines"].append(line)
            location["occurrences"] += 1
            schedule["occurrences"] += 1
            record["occurrences"] += 1

        records = list(grouped.values())
        for record in records:
            merged_locations: dict[int, dict] = {}
            for schedule in record["scheduleCandidates"]:
                for location in schedule["sourceLocations"]:
                    location["sourceLines"] = sorted(set(location["sourceLines"]))
                    merged = merged_locations.setdefault(location["page"], {
                        "page": location["page"], "sourceLines": [], "occurrences": 0
                    })
                    merged["sourceLines"].extend(location["sourceLines"])
                    merged["occurrences"] += location["occurrences"]
                schedule["sourceLocations"].sort(key=lambda item: item["page"])
            record["sourceLocations"] = [
                {"page": page, "sourceLines": sorted(set(item["sourceLines"])), "occurrences": item["occurrences"]}
                for page, item in sorted(merged_locations.items())
            ]
            record["scheduleCandidates"].sort(key=lambda item: (
                item["termCandidate"], item["dayCandidate"], item["periodCandidate"]
            ))
        records.sort(key=lambda row: (
            row["academicYear"],row["courseCode"],row["source"]["id"],
            row["sourceLocations"][0]["page"] if row["sourceLocations"] else 0,
            row["sourceLocations"][0]["sourceLines"][0] if row["sourceLocations"] else 0,
        ))

        if raw_row_count != len(seen_occurrences):
            raise ValueError("historical occurrence reconciliation failed")
        if sum(occurrence_counts.values()) != raw_row_count:
            raise ValueError("annual historical occurrence counts do not reconcile")
        source_count = db.execute("SELECT COUNT(*) FROM source_document").fetchone()[0]
        current_offering_count = db.execute("SELECT COUNT(*) FROM course_offering").fetchone()[0]

        annual = {}
        for year in YEARS:
            year_records = [row for row in records if row["academicYear"] == year]
            annual[str(year)] = {
                "sourceOccurrences": occurrence_counts[year],
                "visuallyReviewedOccurrences": reviewed_counts[year],
                "unreviewedOccurrences": occurrence_counts[year] - reviewed_counts[year],
                "groupedRows": len(year_records),
                "uniqueCourseCodes": len({row["courseCode"] for row in year_records}),
            }

        return {
            "schemaVersion": 2,
            "database": {
                "schemaVersion": schema_version,
                "curriculumSchemaVersion": coverage.get("curriculumSchemaVersion"),
                "sourceDocumentCount": source_count,
                "currentOfferingCount": current_offering_count,
                "currentCatalogStatus": coverage.get("current2026DataStatus", "unknown"),
                "historicalOfferingStatus": coverage.get("historicalDataStatus", "unknown"),
                "curriculumStatus": curriculum_status,
                "curriculumRows": curriculum_rows,
            },
            "summary": {
                "sourceOccurrences": raw_row_count,
                "visuallyReviewedOccurrences": sum(reviewed_counts.values()),
                "unreviewedOccurrences": raw_row_count - sum(reviewed_counts.values()),
                "groupedRows": len(records),
                "sourceDocuments": len(source_records),
                "academicYears": list(YEARS),
                "byYear": annual,
                "scope": "Official timetable PDF row evidence; provisional only, not an approved historical course catalog.",
            },
            "sources": sorted(source_records.values(), key=lambda item: item["id"]),
            "records": records,
        }
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=DEFAULT_DB_PATH,
                        help="audited course-catalog-multiyear.sqlite")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT,
                        help="extension JSON output path")
    args = parser.parse_args()

    payload = export(args.database)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=args.output.name + ".", suffix=".tmp", dir=args.output.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, args.output)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise
    print(json.dumps({"output": str(args.output), **payload["summary"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
