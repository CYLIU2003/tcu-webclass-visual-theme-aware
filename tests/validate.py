#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DAYS = {"月", "火", "水", "木", "金", "土", "日"}
CODE_RE = re.compile(r"^[a-z]{3,4}\d{4,6}$")


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def main() -> None:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    require(manifest.get("manifest_version") == 3, "manifest_version must be 3")
    require(manifest.get("version") == "0.5.0", "extension version must be 0.5.0")
    require(manifest.get("host_permissions") == ["https://webclass.tcu.ac.jp/*"], "host scope must remain limited to WebClass")
    require(bool(manifest.get("content_scripts")), "content_scripts is missing")
    extension_resources = {resource for group in manifest.get("web_accessible_resources", []) for resource in group.get("resources", [])}
    require("data/historical-course-row-evidence.json" in extension_resources, "historical evidence must be web accessible to the content script")

    data = json.loads((ROOT / "data" / "timetable-2026.json").read_text(encoding="utf-8"))
    report = json.loads((ROOT / "data" / "extraction-report.json").read_text(encoding="utf-8"))
    require(data.get("schemaVersion") == 2, "schemaVersion must be 2")
    dataset = data.get("dataset") or {}
    scope = dataset.get("scope") or {}
    courses = data.get("courses")
    require(isinstance(courses, list) and courses, "courses must be a non-empty array")
    require(len(courses) == 2556, f"expected 2556 unique courses, got {len(courses)}")
    require(scope.get("uniqueCourses") == len(courses), "scope.uniqueCourses mismatch")
    require(scope.get("rawOccurrences") == 5569, "raw occurrence count mismatch")
    require(scope.get("timetablePages") == 107, "timetable page count mismatch")
    require(len(scope.get("sourceDocuments") or []) == 5, "five source documents are required")
    require(report.get("summary", {}).get("uniqueCourses") == len(courses), "report summary mismatch")

    period_profiles = dataset.get("periodProfiles") or {}
    require(period_profiles.get("standard", {}).get("periods", {}).get("1") == {"start": "09:20", "end": "11:00"}, "standard period profile is invalid")
    require(period_profiles.get("joint-nuclear", {}).get("periods", {}).get("1") == {"start": "08:50", "end": "10:30"}, "joint-nuclear period profile is invalid")

    codes: set[str] = set()
    no_instructor: list[str] = []
    for index, course in enumerate(courses, start=1):
        name = course.get("courseName")
        require(isinstance(name, str) and name.strip(), f"course #{index}: courseName is missing")
        require(len(name) <= 120, f"{course.get('courseCode')}: suspiciously long courseName")
        require(not re.search(r"(卒業研究\([^)]*\)\s*){3,}", name), f"{course.get('courseCode')}: merged research names detected")

        code = course.get("courseCode")
        require(isinstance(code, str) and CODE_RE.fullmatch(code), f"{name}: invalid courseCode {code!r}")
        require(code not in codes, f"duplicate courseCode: {code}")
        codes.add(code)

        instructors = course.get("instructors")
        require(isinstance(instructors, list), f"{name}: instructors must be an array")
        if not instructors:
            no_instructor.append(code)

        meetings = course.get("meetings")
        require(isinstance(meetings, list), f"{name}: meetings must be an array")
        for meeting in meetings:
            require(meeting.get("day") in DAYS, f"{name}: invalid day {meeting.get('day')!r}")
            period = meeting.get("period")
            require(isinstance(period, int) and 1 <= period <= 9, f"{name}: invalid period {period!r}")
            require(isinstance(meeting.get("room"), str), f"{name}: room must be a string")
            require(isinstance(meeting.get("rooms"), list), f"{name}: rooms must be an array")
            require(meeting.get("timeProfile") in period_profiles, f"{name}: invalid timeProfile")

        require(isinstance(course.get("departments"), list), f"{name}: departments must be an array")
        require(isinstance(course.get("campuses"), list), f"{name}: campuses must be an array")
        require(isinstance(course.get("scheduleTypes"), list), f"{name}: scheduleTypes must be an array")

    require(no_instructor == ["sbb001518"], f"unexpected courses without instructors: {no_instructor}")

    history = json.loads((ROOT / "data" / "historical-course-row-evidence.json").read_text(encoding="utf-8"))
    require(history.get("schemaVersion") == 1, "historical evidence schemaVersion must be 1")
    history_summary = history.get("summary") or {}
    history_rows = history.get("records")
    require(isinstance(history_rows, list), "historical evidence records must be a list")
    require(history_summary.get("reviewedOccurrences") == 23, "historical reviewed occurrence count mismatch")
    require(history_summary.get("groupedExamples") == 15 == len(history_rows), "historical grouped example count mismatch")
    require(history_summary.get("courseSourcePairs") == 15, "historical course/source pair count mismatch")
    require(history_summary.get("academicYears") == [2022, 2024, 2025], "historical evidence year scope mismatch")
    require(history.get("database", {}).get("curriculumStatus") == "not-populated", "curriculum status must not imply populated requirements")
    require(history.get("database", {}).get("curriculumRows", {}).get("approvedRequirements") == 0, "unverified curriculum requirements must not be certified")
    for row in history_rows:
        require(2022 <= row.get("academicYear", 0) <= 2025, "current-year row leaked into historical evidence")
        require(CODE_RE.fullmatch(str(row.get("courseCode", ""))) is not None, "invalid course code in historical evidence")
        require(row.get("reviewStatus") == "visually-reviewed-provisional", "historical evidence must remain provisional")
        require(row.get("reviewMethod") == "official-pdf-visual-inspection", "unexpected historical review method")
        require(row.get("sourcePage", 0) > 0, "historical evidence page is required")
        require(re.fullmatch(r"[a-f0-9]{64}", str(row.get("source", {}).get("sha256", ""))) is not None, "invalid historical source hash")
        require(str(row.get("source", {}).get("url", "")).startswith("https://www.asc.tcu.ac.jp/"), "historical source URL must be official HTTPS")
        require(isinstance(row.get("instructors"), list), "historical instructors must stay row-scoped")

    marketing_rows = {
        row["courseCode"]: row for row in history_rows
        if row["academicYear"] == 2024 and row["courseName"] == "マーケティングリサーチ演習(2)"
    }
    require(set(marketing_rows) == {"sba514202", "sbz514204"}, "same-title 2024 offerings must remain separate by course code")
    require(marketing_rows["sba514202"]["instructors"] != marketing_rows["sbz514204"]["instructors"], "same-title offerings must preserve their different instructor lists")

    expected = {
        "smaa030081": ("パワーエレクトロニクス特論", {("月", 2, "12K"), ("木", 2, "12K")}),
        "smaa030061": ("ナノエレクトロニクス特論", {("月", 4, "13A"), ("木", 2, "13A")}),
        "ymab210005": ("インタラクションデザイン特論", {("月", 1, "33A"), ("月", 2, "33A")}),
        "yab991201": ("NPOとソーシャルビジネス", {("月", 2, "31A"), ("月", 3, "31A")}),
        "yaz627015": ("卒業研究(1)", set()),
    }
    by_code = {course["courseCode"]: course for course in courses}
    for code, (name, meetings) in expected.items():
        require(code in by_code, f"required course missing: {code}")
        course = by_code[code]
        require(course["courseName"] == name, f"{code}: unexpected name {course['courseName']!r}")
        actual = {(item["day"], item["period"], item["room"]) for item in course["meetings"]}
        require(meetings.issubset(actual), f"{code}: expected meetings missing")

    labels = {item.get("label") for item in scope.get("departments") or []}
    for required_label in {
        "機械工学科", "電気電子通信工学科", "情報科学科", "環境創生学科",
        "社会メディア学科", "デザイン・データ科学科", "総合理工学研究科",
        "環境情報学研究科", "情報データ科学研究科"
    }:
        require(required_label in labels, f"department scope missing: {required_label}")

    required_files = [
        ROOT / "src" / "content.js",
        ROOT / "src" / "content.css",
        ROOT / "src" / "popup.html",
        ROOT / "src" / "options.html",
        ROOT / "demo" / "preview.html",
        ROOT / "demo" / "preview-live-dom.html",
        ROOT / "demo" / "preview-live-dom-standalone.html",
        ROOT / "tests" / "test_live_dom.py",
        ROOT / "docs" / "VALIDATION.md",
        ROOT / "data" / "timetable-2026.js",
        ROOT / "data" / "historical-course-row-evidence.json",
        ROOT / "data" / "build_extension_course_data.py",
        ROOT / "tests" / "build_live_dom_preview.py",
        ROOT / "docs" / "DATA_COVERAGE.md",
    ]
    for path in required_files:
        require(path.exists(), f"missing file: {path.relative_to(ROOT)}")

    print(
        f"OK: Manifest V3 / {len(courses)} courses / {scope.get('rawOccurrences')} occurrences / "
        f"{len(scope.get('sourceDocuments') or [])} sources / {scope.get('timetablePages')} pages"
    )


if __name__ == "__main__":
    main()
