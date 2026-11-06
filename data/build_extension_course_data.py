#!/usr/bin/env python3
"""Export source-linked multi-year database evidence for the extension.

Exports:
- 2022-2025 official timetable PDF row evidence (visually reviewed vs unreviewed)
- 2026 fall official timetable PDF candidate row evidence (provisional staging)
- 2026 official timetable correction PDF candidate events (unapplied)
- 2026 official study guide & curriculum table PDF keyword-page navigation

The extension keeps visually reviewed rows separate from unreviewed PDF
extraction candidates. Nothing in this export is promoted to a canonical
historical course offering or certified curriculum requirement.
"""
from __future__ import annotations

import argparse
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
CURRENT_YEAR = 2026
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


def validate_official_source_doc(
    source_id: str,
    source_title: str,
    source_url: str,
    source_hash: str,
    metadata_json: str,
    *,
    page: int | None = None,
    line: int | None = None,
) -> dict:
    parsed_url = urlparse(source_url or "")
    if parsed_url.scheme != "https" or parsed_url.hostname not in {"asc.tcu.ac.jp", "www.asc.tcu.ac.jp"}:
        raise ValueError(f"source is not official HTTPS: {source_id}")
    if not re.fullmatch(r"[a-f0-9]{64}", source_hash or ""):
        raise ValueError(f"invalid source SHA-256: {source_id}")
    metadata = json.loads(metadata_json or "{}")
    page_count = int(metadata.get("pageCount", 0) or 0)
    if page is not None:
        if page < 1 or (page_count and page > page_count):
            raise ValueError(f"source page is out of range: {source_id} p.{page}/{page_count}")
    if line is not None and line < 1:
        raise ValueError(f"source line is invalid: {source_id} p.{page} line={line}")
    return {
        "id": source_id,
        "title": source_title,
        "url": source_url,
        "sha256": source_hash,
        "pageCount": page_count or None,
    }


def validate_source(row: sqlite3.Row) -> dict:
    return validate_official_source_doc(
        row["source_id"],
        row["source_title"],
        row["source_url"] or "",
        row["source_sha256"] or "",
        row["metadata_json"],
        page=int(row["source_page"] or 0),
        line=int(row["source_line"] or 0),
    )


def export_candidate_rows(
    db: sqlite3.Connection,
    instructor_map: dict[tuple[str, int], list[str]],
    year_start: int,
    year_end: int,
    *,
    include_base_match: bool = False,
) -> tuple[list[dict], dict[str, dict], Counter[int], Counter[int], int]:
    allowed_years = set(range(year_start, year_end + 1))
    query = """SELECT
          c.academic_year,c.course_code,c.candidate_id,c.base_snapshot_match,
          c.scope AS candidate_scope,c.term AS candidate_term,
          e.occurrence_ordinal,
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

    for row in db.execute(query, (year_start, year_end)):
        raw_row_count += 1
        year = int(row["academic_year"])
        code = str(row["course_code"] or "").strip().lower()
        if year not in allowed_years or not COURSE_CODE_RE.fullmatch(code):
            raise ValueError(f"invalid candidate year/course code: {year}/{code!r}")
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
        term = str(row["term"] or row["candidate_term"] or "").strip()
        day = str(row["day"] or "").strip()
        period = str(row["period"] or "").strip()
        base_match = bool(row["base_snapshot_match"])
        scope_label = str(row["candidate_scope"] or "").strip()
        # Identical extracted rows on one page are compressed together while
        # every original source-line location remains attached to the record.
        group_key = (
            year, code, source["id"], title, title_status,
            tuple(instructors), instructor_text, room, room_status,
            parse_status, review_status, review_method,
            base_match if include_base_match else None,
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
            if include_base_match:
                record["baseSnapshotMatch"] = base_match
                record["scope"] = scope_label
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
        row["academicYear"], row["courseCode"], row["source"]["id"],
        row["sourceLocations"][0]["page"] if row["sourceLocations"] else 0,
        row["sourceLocations"][0]["sourceLines"][0] if row["sourceLocations"] else 0,
    ))

    if raw_row_count != len(seen_occurrences):
        raise ValueError("candidate occurrence reconciliation failed")
    if sum(occurrence_counts.values()) != raw_row_count:
        raise ValueError("annual candidate occurrence counts do not reconcile")
    return records, source_records, occurrence_counts, reviewed_counts, raw_row_count


def export_correction_events(db: sqlite3.Connection) -> dict:
    query = """SELECT
          e.event_id,e.source_id,e.course_code,e.base_offering_id,
          e.change_date,e.source_page,e.categories_json,e.before_after_json,
          e.source_excerpt,e.review_status,e.applied,
          s.title AS source_title,s.scope AS source_scope,
          s.url AS source_url,s.page_url AS source_page_url,
          s.sha256 AS source_sha256,s.publication_date,s.metadata_json
        FROM correction_event e
        JOIN source_document s USING(source_id)
        ORDER BY e.source_id,e.source_page,e.event_id"""

    sources: dict[str, dict] = {}
    records: list[dict] = []
    matched_count = 0

    for row in db.execute(query):
        code = str(row["course_code"] or "").strip().lower()
        if not COURSE_CODE_RE.fullmatch(code):
            raise ValueError(f"invalid course code in correction_event: {row['event_id']} {code!r}")
        page = int(row["source_page"] or 0)
        source = validate_official_source_doc(
            row["source_id"],
            row["source_title"],
            row["source_url"] or "",
            row["source_sha256"] or "",
            row["metadata_json"],
            page=page,
        )
        source["scope"] = str(row["source_scope"] or "").strip()
        source["updated"] = str(row["publication_date"] or "").strip()
        sources[source["id"]] = source

        applied = bool(row["applied"])
        if applied:
            raise ValueError(f"unverified correction event marked as applied: {row['event_id']}")
        review_status = str(row["review_status"] or "unreviewed").strip()
        excerpt = str(row["source_excerpt"] or "").strip()
        if not excerpt or code not in excerpt.lower():
            raise ValueError(f"correction event excerpt missing course code: {row['event_id']}")
        categories = json.loads(row["categories_json"] or "[]")
        before_after = json.loads(row["before_after_json"] or "[]")
        base_offering_id = row["base_offering_id"]
        if base_offering_id:
            matched_count += 1

        records.append({
            "eventId": row["event_id"],
            "courseCode": code,
            "baseOfferingId": base_offering_id,
            "baseSnapshotMatch": bool(base_offering_id),
            "changeDate": str(row["change_date"] or "").strip(),
            "categories": categories if isinstance(categories, list) else [],
            "beforeAfter": before_after if isinstance(before_after, list) else [],
            "sourceExcerpt": excerpt,
            "reviewStatus": review_status,
            "applied": False,
            "sourcePage": page,
            "source": source,
        })

    return {
        "summary": {
            "eventCount": len(records),
            "sourceDocuments": len(sources),
            "matchedToBaseOfferings": matched_count,
            "unmatchedToBaseOfferings": len(records) - matched_count,
            "appliedCount": 0,
            "scope": "Official 2026 timetable correction PDF excerpts; unreviewed and unapplied candidate events.",
        },
        "sources": sorted(sources.values(), key=lambda item: item["id"]),
        "records": records,
    }


def export_study_guide_navigation(db: sqlite3.Connection) -> dict:
    term_pages_by_source: dict[str, dict[str, list[int]]] = {}
    relevant_pages: set[tuple[str, int]] = set()
    indexed_pairs = 0
    for row in db.execute(
        "SELECT source_id, term, page_no FROM study_guide_term_page ORDER BY source_id, term, page_no"
    ):
        sid = row["source_id"]
        term = str(row["term"] or "").strip()
        page_no = int(row["page_no"] or 0)
        if page_no < 1 or not term:
            raise ValueError(f"invalid study_guide_term_page row: {sid} {term!r} p.{page_no}")
        term_pages_by_source.setdefault(sid, {}).setdefault(term, []).append(page_no)
        relevant_pages.add((sid, page_no))
        indexed_pairs += 1

    guides: list[dict] = []
    study_guide_count = 0
    curriculum_table_count = 0
    total_study_guide_pages = 0

    for row in db.execute(
        """SELECT source_id, kind, title, scope, url, page_url, sha256, metadata_json
           FROM source_document
           WHERE kind IN ('study-guide', 'curriculum-table')
           ORDER BY kind DESC, source_id"""
    ):
        source = validate_official_source_doc(
            row["source_id"],
            row["title"],
            row["url"] or "",
            row["sha256"] or "",
            row["metadata_json"],
        )
        page_count = int(source.get("pageCount") or 0)
        if page_count < 1:
            raise ValueError(f"study guide/curriculum source missing pageCount: {row['source_id']}")
        term_pages = term_pages_by_source.get(row["source_id"], {})
        for term, pages in term_pages.items():
            if any(p < 1 or p > page_count for p in pages):
                raise ValueError(f"study guide term page out of range: {row['source_id']} {term}")
        if row["kind"] == "study-guide":
            study_guide_count += 1
            total_study_guide_pages += page_count
        else:
            curriculum_table_count += 1

        guides.append({
            "id": row["source_id"],
            "kind": row["kind"],
            "title": row["title"],
            "scope": str(row["scope"] or "").strip(),
            "url": source["url"],
            "pageUrl": str(row["page_url"] or "").strip(),
            "sha256": source["sha256"],
            "pageCount": page_count,
            "termPages": {term: sorted(set(pages)) for term, pages in sorted(term_pages.items())},
        })

    return {
        "summary": {
            "studyGuideCount": study_guide_count,
            "curriculumTableCount": curriculum_table_count,
            "totalStudyGuidePages": total_study_guide_pages,
            "indexedTermPagePairs": indexed_pairs,
            "relevantPageCount": len(relevant_pages),
            "status": "keyword-navigation-only; not certified course requirements",
        },
        "guides": guides,
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

        records, source_records, occurrence_counts, reviewed_counts, raw_row_count = export_candidate_rows(
            db, instructor_map, YEARS[0], YEARS[-1], include_base_match=False
        )
        fall_records, fall_sources, fall_occurrence_counts, fall_reviewed_counts, fall_raw_row_count = export_candidate_rows(
            db, instructor_map, CURRENT_YEAR, CURRENT_YEAR, include_base_match=True
        )
        fall_pair_rows = db.execute(
            "SELECT COUNT(*), SUM(CASE WHEN base_snapshot_match=1 THEN 1 ELSE 0 END) FROM course_offering_candidate WHERE academic_year=?",
            (CURRENT_YEAR,),
        ).fetchone()
        fall_candidate_pairs = int(fall_pair_rows[0] or 0)
        fall_matched_pairs = int(fall_pair_rows[1] or 0)
        fall_unmatched_pairs = fall_candidate_pairs - fall_matched_pairs

        corrections = export_correction_events(db)
        study_guides = export_study_guide_navigation(db)

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

        fall_reviewed_total = sum(fall_reviewed_counts.values())
        current_fall_payload = {
            "summary": {
                "academicYear": CURRENT_YEAR,
                "sourceOccurrences": fall_raw_row_count,
                "visuallyReviewedOccurrences": fall_reviewed_total,
                "unreviewedOccurrences": fall_raw_row_count - fall_reviewed_total,
                "groupedRows": len(fall_records),
                "candidatePairs": fall_candidate_pairs,
                "baseSnapshotMatchedPairs": fall_matched_pairs,
                "baseSnapshotUnmatchedPairs": fall_unmatched_pairs,
                "uniqueCourseCodes": len({row["courseCode"] for row in fall_records}),
                "sourceDocuments": len(fall_sources),
                "scope": "Official 2026 fall timetable PDF row evidence; provisional staging only, not promoted to course_offering.",
            },
            "sources": sorted(fall_sources.values(), key=lambda item: item["id"]),
            "records": fall_records,
        }

        return {
            "schemaVersion": 2,
            "database": {
                "schemaVersion": schema_version,
                "curriculumSchemaVersion": coverage.get("curriculumSchemaVersion"),
                "sourceDocumentCount": source_count,
                "currentOfferingCount": current_offering_count,
                "currentCatalogStatus": coverage.get("current2026DataStatus", "unknown"),
                "currentFallCandidatesStatus": coverage.get("currentYearFallCandidatesStatus", "unknown"),
                "currentFallCandidatePairs": fall_candidate_pairs,
                "currentFallOccurrences": fall_raw_row_count,
                "currentFallReviewedOccurrences": fall_reviewed_total,
                "correctionEventCount": corrections["summary"]["eventCount"],
                "studyGuideCount": study_guides["summary"]["studyGuideCount"],
                "curriculumTableCount": study_guides["summary"]["curriculumTableCount"],
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
            "currentFallCandidates": current_fall_payload,
            "correctionEvents": corrections,
            "studyGuideNavigation": study_guides,
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
    print(json.dumps({
        "output": str(args.output),
        **payload["summary"],
        "currentFallSummary": payload["currentFallCandidates"]["summary"],
        "correctionSummary": payload["correctionEvents"]["summary"],
        "studyGuideSummary": payload["studyGuideNavigation"]["summary"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
