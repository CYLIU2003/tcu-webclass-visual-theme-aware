"""Build a review-only curriculum database from saved, hash-checked evidence."""
import argparse
import hashlib
import json
import sqlite3
import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]


def build(output: Path) -> None:
    if output.exists():
        raise FileExistsError(f"Refusing to replace {output}")
    data = json.loads((ROOT / "data/curriculum-candidates.json").read_text(encoding="utf-8"))
    sources = data["sources"]
    source_by_id = {source["id"]: source for source in sources}
    if len(source_by_id) != len(sources):
        raise ValueError("Duplicate source IDs")
    scope_year = {
        "information-science": 2026, "teaching-engineering-information": 2026,
        "hirameki-engineering": 2024, "hirameki-engineering-2023": 2023,
        "hirameki-engineering-2022": 2022, "hirameki-engineering-2025": 2025,
        "hirameki-other-2025": 2025, "hirameki-2026": 2026,
    }
    for row in data["records"]:
        if scope_year.get(row["scope"]) != row["admissionYear"]:
            raise ValueError(f"Unexpected scope/year: {row['id']}")
        source = source_by_id[row["sourceId"]]
        pages = [row["sourcePage"], *row.get("relatedPages", [])]
        if source["file"].endswith(".pdf"):
            if any(type(page) is not int or not 1 <= page <= source["pageCount"] for page in pages):
                raise ValueError(f"Invalid PDF page: {row['id']}")
        elif pages != [None]:
            raise ValueError(f"Images must not have PDF pages: {row['id']}")
    for source in sources:
        path = (ROOT / source["file"]).resolve()
        if not path.is_relative_to((ROOT / "data/source-cache/curriculum").resolve()):
            raise ValueError(f"Source outside cache: {source['id']}")
        url = urlparse(source["url"])
        if url.scheme != "https" or url.hostname not in {"www.asc.tcu.ac.jp", "hirameki.tcu.ac.jp"}:
            raise ValueError(f"Unexpected source URL: {source['id']}")
        blob = path.read_bytes()
        if len(blob) != source["size"] or hashlib.sha256(blob).hexdigest() != source["sha256"]:
            raise ValueError(f"Source hash mismatch: {source['id']}")
    fd, temporary_name = tempfile.mkstemp(prefix=".curriculum-", suffix=".sqlite", dir=output.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    con = sqlite3.connect(temporary)
    try:
        con.executescript("""
        PRAGMA foreign_keys=ON;
        CREATE TABLE source(id TEXT PRIMARY KEY, url TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
          page_count INTEGER CHECK(page_count IS NULL OR page_count > 0));
        CREATE TABLE candidate(id TEXT PRIMARY KEY, scope TEXT NOT NULL, admission_year INTEGER NOT NULL,
          title TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('required','choice','elective','conditional')),
          source_id TEXT NOT NULL REFERENCES source(id), source_page INTEGER,
          note TEXT NOT NULL, credits REAL, free_credit_candidate INTEGER NOT NULL CHECK(free_credit_candidate IN (0,1)),
          related_pages_json TEXT NOT NULL CHECK(json_valid(related_pages_json)), review_status TEXT NOT NULL
            CHECK(review_status='visually-reviewed-source-unmatched-offering'));
        """)
        con.executemany("INSERT INTO source VALUES (?,?,?,?,?)", [
            (s["id"], s["url"], s["sha256"], s["size"], s.get("pageCount")) for s in sources
        ])
        for row in data["records"]:
            con.execute("INSERT INTO candidate VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (
                row["id"], row["scope"], row["admissionYear"], row["title"], row["kind"],
                row["sourceId"], row["sourcePage"], row["note"], row["credits"], int(row.get("freeCreditCandidate", False)), json.dumps(row.get("relatedPages", [])), row["reviewStatus"]))
        assert con.execute("PRAGMA foreign_key_check").fetchall() == []
        assert con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        con.commit()
    except BaseException:
        con.close()
        temporary.unlink(missing_ok=True)
        raise
    con.close()
    try:
        os.link(temporary, output)  # Fail atomically if another output already exists.
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Built {output}: {len(data['records'])} review-only rows")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    build(parser.parse_args().output)
