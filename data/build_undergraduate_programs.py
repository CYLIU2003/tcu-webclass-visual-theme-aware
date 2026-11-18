"""Build cohort program sources and TAP domestic course recognition evidence."""
import hashlib
import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent
ENGLISH = ["Communication Skills(1)", "Communication Skills(2)",
           "Reading and Writing(1a)", "Reading and Writing(1b)",
           "Reading and Writing(2a)", "Reading and Writing(2b)"]
DESIGN_ENGLISH = ["English III-A", "English III-B"]


def compact(text):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text)).lower()


@lru_cache(maxsize=None)
def tap_table(url, names):
    cache = ROOT / "source-cache" / "undergraduate-guides" / (hashlib.sha256(url.encode()).hexdigest() + ".pdf")
    with pymupdf.open(cache) as pdf:
        for i, page in enumerate(pdf, 1):
            text = compact(page.get_text())
            if (("単位認定表[tap]" in text or "(別表1" in text and "本学での認定科目名" in text)
                    and ("履修は不可" in text or "履修不可" in text)
                    and all(compact(title) in text for title in names)):
                return {"url": f"{url}#page={i}", "page": i, "titles": names,
                        "sha256": hashlib.sha256(cache.read_bytes()).hexdigest()}
    return None


def hirameki_scope(row):
    year, faculty, department = row["year"], row["faculty"], row["department"]
    if year == 2026 and faculty != "デザイン・データ科学部":
        return "hirameki-2026"
    if year == 2025 and faculty != "デザイン・データ科学部":
        return "hirameki-engineering-2025" if faculty == "理工学部" else "hirameki-other-2025"
    if faculty == "理工学部":
        if year == 2024:
            return "hirameki-engineering"
        if year == 2023 and department != "自然科学科":
            return "hirameki-engineering-2023"
        if year == 2022 and department in {"機械工学科", "機械システム工学科", "電気電子通信工学科"}:
            return "hirameki-engineering-2022"
    return None


def build():
    guides = json.loads((ROOT / "undergraduate-guides.json").read_text(encoding="utf-8"))
    candidates = json.loads((ROOT / "curriculum-candidates.json").read_text(encoding="utf-8"))
    by_scope = {}
    for candidate in candidates["records"]:
        by_scope.setdefault(candidate["scope"], []).append(candidate)
    sources = {source["id"]: source["url"] for source in candidates["sources"]}
    profiles = {}
    for row in guides["profiles"]:
        refs = {source["kind"]: source["url"] for source in row["sources"]}
        faculty_url = refs["faculty"]
        titles = tuple(DESIGN_ENGLISH if row["faculty"] == "デザイン・データ科学部" and row["year"] >= 2024 else ENGLISH)
        tap = tap_table(faculty_url, titles)
        if tap is None:
            print(f"No validated TAP table for {row['year']} {row['faculty']}")
        hirameki = hirameki_scope(row)
        teaching = "teaching-engineering-information" if row["year"] == 2026 and refs.get("teaching") else None
        scope = {k: v for k, v in {"hirameki": hirameki, "teaching": teaching}.items() if v}
        documents = {"tap": tap["url"] if tap else faculty_url, "teaching": refs.get("teaching") or refs.get("department") or faculty_url}
        if hirameki:
            documents["hirameki"] = sources[by_scope[hirameki][0]["sourceId"]]
        profiles[f"{row['year']}:{row['department']}"] = {
            "year": row["year"], "faculty": row["faculty"], "department": row["department"],
            "tap": tap, "scopes": scope, "documents": documents,
            "teachingDocument": "teaching" in refs,
        }
    return {"schemaVersion": 1, "profiles": profiles}


if __name__ == "__main__":
    index = build()
    (ROOT / "undergraduate-programs.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(len(index["profiles"]), "undergraduate program profiles")
