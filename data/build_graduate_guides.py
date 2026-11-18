"""Rebuild the graduate guide index from the public TCU listings and saved PDFs."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urldefrag, urljoin, urlsplit

from lxml import html
import pymupdf

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "source-cache" / "graduate-guides"
BASE = "https://www.asc.tcu.ac.jp/"
LISTINGS = {"current": BASE + "syllabus_grad/", "archives": BASE + "syllabus_grad_archives/"}
EXPECTED = {2022: 8, 2023: 8, 2024: 9, 2025: 10, 2026: 10}


def fetch(url, path):
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".part")
    subprocess.run(["curl.exe" if os.name == "nt" else "curl", "-fsSL",
                    "--proto-redir", "=https", "--max-time", "60", "--retry", "2",
                    "-o", str(temp), url], check=True)
    temp.replace(path)


def profiles(year, school, links, listing):
    sources = {}
    for link in links:
        label = " ".join(link.text_content().split())
        url = urljoin(BASE, link.get("href")).replace("http://", "https://", 1)
        parts = urlsplit(url)
        if parts.netloc != "www.asc.tcu.ac.jp" or not parts.path.endswith(".pdf"):
            raise ValueError(f"Unexpected graduate guide: {url}")
        if label in sources:
            raise ValueError(f"Duplicate guide: {year} {school} {label}")
        sources[label] = url
    for major, url in sources.items():
        if not major.endswith("専攻"):
            continue
        documents = [{"label": "専攻の履修要綱", "url": url}]
        documents.extend({"label": label, "url": href} for label, href in sources.items()
                         if label == school or "教育課程表" in label)
        yield {"year": year, "school": school, "major": major, "listing": listing, "sources": documents}


def pdf_url(url):
    return urldefrag(url).url


def read_pdf(url, download):
    path = CACHE / (hashlib.sha256(url.encode()).hexdigest() + ".pdf")
    if download:
        fetch(url, path)
    with pymupdf.open(path) as pdf:
        pages = [page.get_text(sort=True) for page in pdf]
    return url, {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "pages": len(pages)}, pages


def build(download):
    listings = {}
    for name, url in LISTINGS.items():
        path = CACHE / (name + ".html")
        if download:
            fetch(url, path)
        listings[name] = html.fromstring(path.read_text(encoding="utf-8"))

    records = []
    for block in listings["archives"].xpath('//*[@id="left_col"]//div[contains(@class,"grad-year")]'):
        match = re.fullmatch(r"(20\d{2})年度", block.xpath("string(./h3)").strip())
        if not match or int(match[1]) not in range(2022, 2026):
            continue
        year = int(match[1])
        for group in block.xpath("./div/p[a]"):
            school = (group.text or "").strip().strip("＜＞")
            if not school.endswith("研究科"):
                raise ValueError(f"Missing school for {year}")
            records.extend(profiles(year, school, group.xpath("./a"), LISTINGS["archives"]))
    for article in listings["current"].xpath('//*[@id="left_col"]//article[h3]'):
        school = article.xpath("string(h3)").strip()
        records.extend(profiles(2026, school, article.xpath(".//a"), LISTINGS["current"]))
    records.sort(key=lambda row: row["year"], reverse=True)
    for year, expected in EXPECTED.items():
        keys = [(row["school"], row["major"]) for row in records if row["year"] == year]
        if len(keys) != expected or len(set(keys)) != expected:
            raise ValueError(f"Unexpected graduate guide scope in {year}: {keys}")
    urls = sorted({pdf_url(source["url"]) for row in records for source in row["sources"]})
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda url: read_pdf(url, download), urls))
    return records, {url: meta for url, meta, _ in results}, {url: pages for url, _, pages in results}


FRONT = "博士前期課程"
DOCTOR = "博士後期課程"


def program_rules(record, documents):
    joint = "国際連携環境融合科学専攻" in record["major"]
    course_rules = {}
    for source in record["sources"]:
        if "教育課程表" in source["label"]:
            continue
        url = pdf_url(source["url"])
        for page, text in enumerate(documents[url], 1):
            compact = re.sub(r"\s+", "", unicodedata.normalize("NFKC", text))
            joint_page = "本学を主大学とする学生は修了要件として" in compact
            if joint and not joint_page:
                continue
            if not joint and joint_page:
                continue
            if re.search(r"(?:合計30単位以上|第12条学生は.{0,25}30単位以上)", compact):
                rule = {"name": FRONT, "minimum": 30, "source": {
                    "label": f"{FRONT}の総単位の根拠（PDF {page}ページ）",
                    "url": f"{url}#page={page}",
                }}
                if joint:
                    rule["note"] = "東京都市大学を主大学とする場合の条件です。両大学の開設科目と指定科目の内訳、論文審査は履修要綱で確認してください。"
                course_rules.setdefault(FRONT, rule)
            if not joint and re.search(r"博士後期課程.{0,500}(?:合計|計)24単位", compact):
                course_rules.setdefault(DOCTOR, {"name": DOCTOR, "minimum": 24, "source": {
                    "label": f"{DOCTOR}の総単位の根拠（PDF {page}ページ）",
                    "url": f"{url}#page={page}",
                }})
    if FRONT not in course_rules:
        raise ValueError(f"Missing master's minimum: {record['year']} {record['major']}")
    if not joint:
        course_rules.setdefault(DOCTOR, {"name": DOCTOR})
    return [course_rules[name] for name in (FRONT, DOCTOR) if name in course_rules]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    records, documents, pages = build(args.download)
    for record in records:
        record["programs"] = program_rules(record, pages)
    (ROOT / "graduate-guides.json").write_text(json.dumps(
        {"schemaVersion": 1, "profiles": records, "documents": documents},
        ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(records)} graduate profiles, {len(documents)} verified PDF files")
