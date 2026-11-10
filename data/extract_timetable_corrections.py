#!/usr/bin/env python3
"""Extract unapplied correction candidates using the official PDF table boundaries."""
from __future__ import annotations

import hashlib
import json
import re
import tempfile
import unicodedata
from collections import Counter
from datetime import date
from io import BytesIO
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CODE_RE = re.compile(r"\b[a-z]{2,5}\d{4,7}\b", re.I)
SECTION_DATE_RE = re.compile(r"(\d{1,2})月\s*(\d{1,2})日\s*訂正")
JAPANESE = r"[一-龯々ぁ-ゖァ-ヺー]"
CATEGORY_LABELS = {
    "room": r"教室|場所",
    "instructor": r"担当教員|担当者|教員名",
    "meeting": r"曜日時限|授業時間|開講日|実施日",
    "audience": r"受講対象|対象学年|開講学年",
    "language": r"開講言語",
}


def norm(text: str | None) -> str:
    return " ".join(unicodedata.normalize("NFKC", text or "").split())


def change_categories(label: str, details: str) -> list[str]:
    categories = [key for key, pattern in CATEGORY_LABELS.items() if re.search(pattern, label)]
    if re.search(r"非開講|開講中止|開講しない", details):
        categories.append("withdrawal")
    return categories


def extract_page(page, source: dict, base_by_code: dict, event_offset: int) -> list[dict]:
    events = []
    previous_bottom = 0
    for table in sorted(page.find_tables(), key=lambda item: item.bbox[1]):
        rows = table.extract()
        header = [norm(value) for value in rows[0]]
        if "講義コード" not in header:
            continue
        code_col = header.index("講義コード")
        row_dates = header[0] == "変更日" and header[-2:] == ["変更箇所", "変更内容"]
        section_dates = header[-2:] == ["変更前", "変更後"] and "担当者" in header
        if not (row_dates or section_dates):
            raise ValueError(f"Unknown correction table header: {header}")

        if section_dates:
            heading = page.crop((0, previous_bottom, page.width, table.bbox[1])).extract_text()
            matches = SECTION_DATE_RE.findall(norm(heading))
            if len(matches) != 1:
                raise ValueError(f"Expected one date above the correction table: {heading!r}")
            month, day = map(int, matches[0])
            section_date = date(2026, month, day).isoformat()
        previous_bottom = table.bbox[3]

        for row_index, row in enumerate(rows[1:], 1):
            code = norm(row[code_col]).lower()
            if not code:
                # Split PDF headers and merged title cells can have empty code slots.
                continue
            if not CODE_RE.fullmatch(code):
                raise ValueError(f"Invalid correction table code: {code!r}")
            left, top, right, bottom = table.rows[row_index].bbox
            if row_dates:
                year, month, day = map(int, norm(row[0]).split("/"))
                if year != 2026:
                    raise ValueError(f"Unexpected correction year: {year}")
                change_date = date(year, month, day).isoformat()
                date_basis = "row-date"
                title = norm(row[header.index("講義名")])
                label, details = map(norm, row[-2:])
                # A multi-line cell can describe several independent changes.
                parts = re.split(r"[→⇒]", row[-1] or "")
                before_after = []
                if len(parts) == 2 and "\n" not in (row[-1] or "") and all(map(norm, parts)):
                    before_after = [{"before": norm(parts[0]), "after": norm(parts[1])}]
            else:
                change_date, date_basis = section_date, "section-heading"
                instructor_col = header.index("担当者")
                # The graduate table splits the English title into continuation cells.
                # Only extend into rows whose code cell is merged into the current row.
                for following_index in range(row_index + 1, len(rows)):
                    if table.rows[following_index].cells[code_col] is not None:
                        break
                    bottom = table.rows[following_index].bbox[3]
                code_right = table.rows[row_index].cells[code_col][2]
                instructor_left = table.rows[row_index].cells[instructor_col][0]
                instructor_right = table.rows[row_index].cells[instructor_col][2]
                before_left = table.rows[row_index].cells[-2][0]
                raw_title = page.crop((code_right, top, instructor_left, bottom)).extract_text() or ""
                title = norm(re.sub(rf"(?<={JAPANESE})\n(?={JAPANESE})", "", raw_title))
                label = norm(page.crop((instructor_right, top, before_left, bottom)).extract_text())
                before, after = map(norm, row[-2:])
                if not before or not after:
                    raise ValueError(f"Missing before/after correction cells: {code}")
                details = f"{before} → {after}"
                before_after = [{"before": before, "after": after}]

            if not title or not details:
                raise ValueError(f"Missing title or correction text: {code}")
            event_number = event_offset + len(events) + 1
            events.append({
                "eventId": f"{source['id']}:{page.page_number}:{event_number}",
                "sourceId": source["id"],
                "sourceUrl": source["fileUrl"],
                "sourcePage": page.page_number,
                "sourceRowBox": [round(value, 2) for value in (left, top, right, bottom)],
                "courseCode": code,
                "courseNameFromSource": title,
                "courseNameFromBaseSnapshot": base_by_code.get(code, {}).get("courseName", ""),
                "changeDate": change_date,
                "changeDateBasis": date_basis,
                "changeCategoriesCandidate": change_categories(label, details),
                "beforeAfterTextCandidate": before_after,
                "sourceExcerpt": " | ".join(filter(None, (code, title, label, details))),
                "reviewStatus": "unreviewed",
                "applied": False,
            })

    page_codes = Counter(CODE_RE.findall(norm(page.extract_text()).lower()))
    row_codes = Counter(event["courseCode"] for event in events)
    if not events or page_codes != row_codes:
        raise ValueError(f"{source['id']} page {page.page_number}: "
                         f"unmatched codes {dict(page_codes - row_codes)}, "
                         f"extra codes {dict(row_codes - page_codes)}")
    return events


def extract_corrections(root: Path = ROOT) -> dict:
    data = root / "data"
    sources = json.loads((data / "official-sources-2026.json").read_text(encoding="utf-8"))["sources"]
    base = json.loads((data / "timetable-2026.json").read_text(encoding="utf-8"))["courses"]
    base_by_code = {str(course.get("courseCode", "")).lower(): course for course in base}
    events = []
    for source in sources:
        if source.get("kind") != "timetable-corrections":
            continue
        raw = (root / source["localPath"]).read_bytes()
        if hashlib.sha256(raw).hexdigest() != source.get("sha256") or len(raw) != source.get("bytes"):
            raise ValueError(f"Correction PDF cache identity mismatch: {source['id']}")
        source_events = []
        with pdfplumber.open(BytesIO(raw)) as pdf:
            if len(pdf.pages) != source.get("pageCount"):
                raise ValueError(f"Correction PDF page count mismatch: {source['id']}")
            for page in pdf.pages:
                source_events.extend(extract_page(page, source, base_by_code, len(source_events)))
        events.extend(source_events)

    if not events:
        raise ValueError("No registered correction events")
    return {
        "schemaVersion": 1,
        "academicYear": 2026,
        "generatedFrom": "official-sources-2026.json",
        "notice": "公式PDFの訂正表から行単位で抽出した候補。講義データへは未適用。",
        "events": events,
    }


def main() -> None:
    result = extract_corrections()
    output = DATA / "timetable-corrections-2026.json"
    with tempfile.TemporaryDirectory(dir=output.parent) as directory:
        staging = Path(directory) / output.name
        staging.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        staging.replace(output)
    events = result["events"]
    print(json.dumps({"events": len(events), "sources": len({e["sourceId"] for e in events}),
                      "unmatchedCodes": sum(not e["courseNameFromBaseSnapshot"] for e in events)}))


if __name__ == "__main__":
    main()
