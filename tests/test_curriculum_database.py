"""Test source, year, page, uniqueness and safe-output database gates."""
from pathlib import Path
import hashlib
import importlib.util
import json
import sqlite3
import tempfile

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("curriculum_builder", root / "data/build_curriculum_candidates.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

with tempfile.TemporaryDirectory(prefix="curriculum-gates-") as temp:
    path = Path(temp)
    (path / "data/source-cache/curriculum").mkdir(parents=True)
    evidence = b"synthetic test source"
    (path / "data/source-cache/curriculum/source.pdf").write_bytes(evidence)
    source = {"id": "s", "url": "https://www.asc.tcu.ac.jp/source.pdf", "file": "data/source-cache/curriculum/source.pdf", "sha256": hashlib.sha256(evidence).hexdigest(), "size": len(evidence), "pageCount": 2}
    row = {"id": "r", "scope": "information-science", "admissionYear": 2026, "title": "科目", "kind": "choice", "sourceId": "s", "sourcePage": 1, "relatedPages": [2], "note": "候補", "credits": None, "reviewStatus": "visually-reviewed-source-unmatched-offering"}
    payload = {"sources": [source], "records": [row]}
    builder.ROOT = path
    def save():
        (path / "data/curriculum-candidates.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf8")
    save()
    output = path / "valid.sqlite"
    builder.build(output)
    conn = sqlite3.connect(output)
    try:
        assert conn.execute("select related_pages_json from candidate").fetchone()[0] == "[2]"
        assert conn.execute("select page_count from source").fetchone()[0] == 2
    finally:
        conn.close()
    before = output.read_bytes()
    try:
        builder.build(output)
        raise AssertionError("existing output was overwritten")
    except FileExistsError:
        assert output.read_bytes() == before
    payload["records"] = [row, dict(row)]
    save()
    try:
        builder.build(path / "duplicate.sqlite")
        raise AssertionError("duplicate key accepted")
    except sqlite3.IntegrityError:
        assert not (path / "duplicate.sqlite").exists()
    payload["records"] = [{**row, "relatedPages": [3]}]
    save()
    try:
        builder.build(path / "bad-page.sqlite")
        raise AssertionError("out-of-range page accepted")
    except ValueError:
        assert not (path / "bad-page.sqlite").exists()
    payload["records"] = [{**row, "admissionYear": 2025}]
    save()
    try:
        builder.build(path / "bad-year.sqlite")
        raise AssertionError("mismatched year accepted")
    except ValueError:
        assert not (path / "bad-year.sqlite").exists()
    (path / "data/source-cache/curriculum/source.pdf").write_bytes(b"changed")
    payload["records"] = [row]
    save()
    try:
        builder.build(path / "bad-hash.sqlite")
        raise AssertionError("changed source accepted")
    except ValueError:
        assert not (path / "bad-hash.sqlite").exists()
print("PASS: duplicate IDs, source hashes, year/page bounds and atomic output gates")
