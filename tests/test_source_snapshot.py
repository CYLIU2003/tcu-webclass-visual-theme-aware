#!/usr/bin/env python3
"""Verify source comparison and preservation without network access."""
import hashlib
import importlib.util
import tempfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("source_snapshot", PROJECT / "data" / "snapshot_official_sources.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

try:
    module.fetch("http://example.org/source.pdf")
    raise AssertionError("untrusted URL accepted")
except ValueError:
    pass

with tempfile.TemporaryDirectory(prefix="tcu-source-snapshot-test-") as directory:
    module.ROOT = Path(directory)
    module.FILES = module.ROOT / "objects"
    module.FILES.mkdir()
    old = b"%PDF-old-source"
    new = b"%PDF-new-source"
    cache = module.ROOT / "cache.pdf"
    cache.write_bytes(old)
    source = {"id": "sample", "fileUrl": "https://www.asc.tcu.ac.jp/test.pdf", "localPath": "cache.pdf",
              "sha256": hashlib.sha256(old).hexdigest()}
    module.fetch = lambda _url: old
    assert module.check_source(source)["status"] == "match"
    module.fetch = lambda _url: new
    changed = module.check_source(source)
    assert changed["status"] == "changed-or-cache-mismatch"
    assert cache.read_bytes() == old
    assert (module.ROOT / changed["snapshotPath"]).read_bytes() == new
    assert module.check_source(source)["snapshotPath"] == changed["snapshotPath"]
    module.fetch = lambda _url: b"not-a-pdf"
    assert module.check_source(source)["status"] == "error"
    module.OUT = module.ROOT
    module.SOURCES = [source]
    module.PAGES = []
    for status, expected_code in [("error", 1), ("changed-or-cache-mismatch", 2)]:
        module.check_source = lambda _source, value=status: {"status": value}
        try:
            module.main()
            raise AssertionError(f"{status} must produce a nonzero exit")
        except SystemExit as exc:
            assert exc.code == expected_code

print("PASS: unchanged, changed, invalid sources and cache preservation")
