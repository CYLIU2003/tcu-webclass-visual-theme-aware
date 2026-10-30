#!/usr/bin/env python3
"""Build a small, deterministic, installable v0.6.0 extension archive."""

from __future__ import annotations

import hashlib
import json
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.6.0"
ARCHIVE_ROOT = "tcu-webclass-visual-theme-aware"
OUTPUT = ROOT.parent / f"TCU_WebClass_Visual_Theme_Aware_v{VERSION}.zip"

PACKAGE_FILES = (
    "manifest.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "はじめにお読みください.html",
    "data/timetable-2026.json",
    "data/historical-course-row-evidence.json",
    "docs/DATA_COVERAGE.md",
    "docs/EXTENSION_DATABASE_INTEGRATION.md",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
    "src/background.js",
    "src/content.css",
    "src/content.js",
    "src/options.css",
    "src/options.html",
    "src/options.js",
    "src/popup.css",
    "src/popup.html",
    "src/popup.js",
    "src/welcome.css",
    "src/welcome.html",
    "src/welcome.js",
)
TEXT_SUFFIXES = {".css", ".html", ".js", ".json", ".md", ".py", ".txt"}


def validate_package_files() -> list[tuple[str, Path]]:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("version") != VERSION:
        raise ValueError(f"manifest version must be {VERSION}")

    files: list[tuple[str, Path]] = []
    for relative in PACKAGE_FILES:
        source = ROOT / relative
        if not source.is_file():
            raise FileNotFoundError(f"required package file is missing: {relative}")
        files.append((relative, source))

    packaged = {relative for relative, _ in files}
    referenced: set[str] = set()
    referenced.update(manifest.get("icons", {}).values())
    referenced.add(manifest["action"]["default_popup"])
    referenced.add(manifest["options_page"])
    referenced.add(manifest["background"]["service_worker"])
    for content_script in manifest.get("content_scripts", []):
        referenced.update(content_script.get("js", []))
        referenced.update(content_script.get("css", []))
    for resource_group in manifest.get("web_accessible_resources", []):
        referenced.update(resource_group.get("resources", []))
    missing_references = sorted(referenced - packaged)
    if missing_references:
        raise ValueError(f"manifest references files not in package: {missing_references}")

    history = json.loads(
        (ROOT / "data/historical-course-row-evidence.json").read_text(encoding="utf-8")
    )
    records = history.get("records", [])
    summary = history.get("summary", {})
    if history.get("schemaVersion") != 2 or len(records) != summary.get("groupedRows"):
        raise ValueError("historical evidence schema-v2 row count mismatch")
    if summary.get("academicYears") != [2022, 2023, 2024, 2025]:
        raise ValueError("historical evidence must cover 2022-2025")
    if summary.get("sourceOccurrences") != 13202:
        raise ValueError("historical evidence occurrence count mismatch")
    if summary.get("visuallyReviewedOccurrences") != 23:
        raise ValueError("historical visual-review count mismatch")
    if summary.get("unreviewedOccurrences", 0) + summary.get("visuallyReviewedOccurrences", 0) != summary.get("sourceOccurrences"):
        raise ValueError("historical review-state counts do not reconcile")
    if len(history.get("sources", [])) != 7:
        raise ValueError("historical source-document count mismatch")
    for row in records:
        if row.get("reviewStatus") not in {"visually-reviewed-provisional", "unreviewed-text-extraction"}:
            raise ValueError("unexpected historical review status")
        if row.get("academicYear") not in {2022, 2023, 2024, 2025}:
            raise ValueError("unexpected historical year")
        source = row.get("source", {})
        if not source.get("url", "").startswith("https://www.asc.tcu.ac.jp/"):
            raise ValueError("historical source must be an official HTTPS URL")
        if len(source.get("sha256", "")) != 64:
            raise ValueError("historical source must include a SHA-256")
        locations = row.get("sourceLocations", [])
        if not locations or any(location.get("page", 0) < 1 or not location.get("sourceLines") for location in locations):
            raise ValueError("historical source-row locations are missing")
        if row.get("reviewStatus") == "visually-reviewed-provisional" and row.get("reviewMethod") != "official-pdf-visual-inspection":
            raise ValueError("visually reviewed rows require the expected review method")
        if row.get("reviewStatus") == "unreviewed-text-extraction" and row.get("reviewMethod"):
            raise ValueError("unreviewed rows must not claim a review method")

    return files


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def package_bytes(relative: str, source: Path) -> bytes:
    data = source.read_bytes()
    if Path(relative).suffix.lower() in TEXT_SUFFIXES:
        data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    return data


def build() -> None:
    files = validate_package_files()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(
        prefix=f".{OUTPUT.stem}-", suffix=".tmp", dir=OUTPUT.parent, delete=False
    ) as temporary:
        temporary_path = Path(temporary.name)

    try:
        with zipfile.ZipFile(
            temporary_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
        ) as archive:
            for relative, source in files:
                info = zipfile.ZipInfo(f"{ARCHIVE_ROOT}/{relative}", date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 0
                info.external_attr = 0
                archive.writestr(info, package_bytes(relative, source), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

        with zipfile.ZipFile(temporary_path) as archive:
            bad_entry = archive.testzip()
            expected = {f"{ARCHIVE_ROOT}/{relative}" for relative, _ in files}
            actual = set(archive.namelist())
            if bad_entry or actual != expected:
                raise ValueError(f"archive verification failed: bad_entry={bad_entry}, unexpected={actual ^ expected}")

        temporary_path.replace(OUTPUT)
    finally:
        temporary_path.unlink(missing_ok=True)

    checksum = sha256(OUTPUT)
    checksum_path = OUTPUT.with_suffix(OUTPUT.suffix + ".sha256")
    checksum_path.write_text(f"{checksum}  {OUTPUT.name}\n", encoding="utf-8")
    print(json.dumps({
        "archive": str(OUTPUT),
        "sha256": checksum,
        "files": len(files),
        "historicalRows": len(json.loads((ROOT / "data/historical-course-row-evidence.json").read_text(encoding="utf-8"))["records"]),
        "historicalSourceOccurrences": 13202,
        "historicalVisuallyReviewedOccurrences": 23,
        "verified": True,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    build()
