#!/usr/bin/env python3
"""Capture official page snapshots and compare current PDF bytes to the saved cache."""
from __future__ import annotations

import hashlib
import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
SOURCES = json.loads((DATA / "official-sources-2026.json").read_text(encoding="utf-8"))["sources"]
PAGES = ["https://www.asc.tcu.ac.jp/7567/", "https://www.asc.tcu.ac.jp/8007/",
         "https://www.asc.tcu.ac.jp/syllabus_archives/"]
OUT = DATA / "source-checks"
FILES = OUT / "objects"
FILES.mkdir(parents=True, exist_ok=True)
MAX_BYTES = 35 * 1024 * 1024
JST = timezone(timedelta(hours=9))


def fetch(url: str) -> bytes:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in {"asc.tcu.ac.jp", "www.asc.tcu.ac.jp"}:
        raise ValueError("URL is not an official HTTPS source")
    request = urllib.request.Request(url, headers={"User-Agent": "TCU-Source-Audit/1.0"})
    with urllib.request.urlopen(request, timeout=45) as response:
        final = urlparse(response.geturl())
        if final.scheme != "https" or final.hostname not in {"asc.tcu.ac.jp", "www.asc.tcu.ac.jp"}:
            raise ValueError("redirect left the official domain")
        data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError("response exceeds size limit")
        return data


def save_object(data: bytes, extension: str) -> str:
    digest = hashlib.sha256(data).hexdigest()
    path = FILES / (digest + extension)
    try:
        with path.open("xb") as stream:
            stream.write(data)
    except FileExistsError:
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError(f"existing snapshot object has incorrect hash: {path}")
    return path.relative_to(ROOT).as_posix()


def check_source(source: dict) -> dict:
    entry = {"id": source["id"], "url": source.get("fileUrl"), "expectedSha256": source.get("sha256"),
             "cachePath": source.get("localPath")}
    try:
        cached = (ROOT / source["localPath"]).resolve()
        cached.relative_to(ROOT.resolve())
        entry["cacheSha256"] = hashlib.sha256(cached.read_bytes()).hexdigest()
        body = fetch(source["fileUrl"])
        if not body.startswith(b"%PDF-"):
            raise ValueError("response is not a PDF")
        entry["remoteSha256"] = hashlib.sha256(body).hexdigest()
        entry["bytes"] = len(body)
        entry["status"] = "match" if entry["remoteSha256"] == entry["cacheSha256"] == source.get("sha256") else "changed-or-cache-mismatch"
        if entry["status"] != "match":
            entry["snapshotPath"] = save_object(body, ".pdf")
    except Exception as exc:
        entry.update(status="error", error=f"{type(exc).__name__}: {exc}")
    return entry


def check_page(url: str) -> dict:
    try:
        body = fetch(url)
        return {"url": url, "status": "captured", "sha256": hashlib.sha256(body).hexdigest(),
                "bytes": len(body), "snapshotPath": save_object(body, ".html")}
    except Exception as exc:
        return {"url": url, "status": "error", "error": f"{type(exc).__name__}: {exc}"}


def main() -> None:
    with ThreadPoolExecutor(max_workers=4) as pool:
        pdfs = list(pool.map(check_source, SOURCES))
        pages = list(pool.map(check_page, PAGES))
    stamp = datetime.now(JST).strftime("%Y%m%dT%H%M%S%f%z")
    output = OUT / f"official-source-snapshot-{stamp}.json"
    result = {"capturedAt": datetime.now(JST).isoformat(),
              "notice": "PDF cache is never overwritten; changed remote bytes are saved separately.",
              "sources": pdfs, "pages": pages}
    with output.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({"manifest": str(output), "pdfs": len(pdfs),
                      "matches": sum(x["status"] == "match" for x in pdfs),
                      "changes": sum(x["status"] == "changed-or-cache-mismatch" for x in pdfs),
                      "errors": [x for x in pdfs + pages if x["status"] == "error"],
                      "pagesCaptured": sum(x["status"] == "captured" for x in pages)}, ensure_ascii=False))
    if any(x["status"] == "error" for x in pdfs + pages):
        raise SystemExit(1)
    if any(x["status"] == "changed-or-cache-mismatch" for x in pdfs):
        raise SystemExit(2)


if __name__ == "__main__":
    main()
