"""Generate the cohort guide index from saved official HTML and optional PDF cache."""

import argparse
import hashlib
import html
import json
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

from undergraduate_requirement_templates import graduation_templates

ROOT = Path(__file__).resolve().parent
FACULTIES = {
    "理工学部": ["機械工学科", "機械システム工学科", "電気電子通信工学科", "医用工学科",
             "応用化学科", "原子力安全工学科", "自然科学科"],
    "建築都市デザイン学部": ["建築学科", "都市工学科"],
    "情報工学部": ["情報科学科", "知能情報工学科"],
    "環境学部": ["環境創生学科", "環境経営システム学科"],
    "メディア情報学部": ["社会メディア学科", "情報システム学科"],
    "デザイン・データ科学部": ["デザイン・データ科学科"],
    "都市生活学部": ["都市生活学科"],
    "人間科学部": ["人間科学科"],
}
ANCHOR = re.compile(r'<a\b[^>]*?\bhref="([^"]+)"[^>]*>(.*?)</a>', re.S)


def official_links(section):
    grouped = {}
    faculty = None
    for url, markup in ANCHOR.findall(section):
        label = html.unescape(re.sub(r"<[^>]+>", "", markup)).strip(" \r\n\t＜＞")
        url = html.unescape(url)
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or parsed.netloc != "www.asc.tcu.ac.jp" or not parsed.path.endswith(".pdf"):
            continue
        url = parsed._replace(scheme="https").geturl()
        if label in FACULTIES:
            faculty = label
            grouped[faculty] = {}
        if faculty:
            if label in grouped[faculty]:
                raise ValueError(f"Duplicate link for {faculty} / {label}")
            grouped[faculty][label] = url
    return grouped


def profiles(year, section):
    groups = official_links(section)
    expected = set(FACULTIES) - ({"デザイン・データ科学部"} if year == 2022 else set())
    if groups.keys() != expected:
        raise ValueError(f"{year} faculty coverage mismatch: {groups.keys()}")
    for faculty, departments in FACULTIES.items():
        if faculty not in expected:
            continue
        links = groups[faculty]
        for department in departments:
            actual = "児童学科" if year == 2022 and department == "人間科学科" else department
            primary = links[department] if faculty in list(FACULTIES)[:3] else links[faculty]
            sources = [{"kind": "department" if department in links else "faculty", "url": primary}]
            for name, kind in [(faculty, "faculty"), ("共通分野", "common"), ("教職課程", "teaching")]:
                if name in links and links[name] != primary:
                    sources.append({"kind": kind, "url": links[name]})
            profile = {"year": year, "faculty": faculty, "department": actual, "sources": sources}
            templates = graduation_templates(profile)
            if templates:
                profile["graduationTemplates"] = templates
            yield profile


def cache_path(url):
    return ROOT / "source-cache" / "undergraduate-guides" / (hashlib.sha256(url.encode()).hexdigest() + ".pdf")


def download(url):
    path = cache_path(url)
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".part")
    subprocess.run([
        "curl", "--fail", "--silent", "--show-error", "--location", "--proto-redir", "=https",
        "--max-time", "60", "--retry", "2", "--user-agent", "Mozilla/5.0",
        "--output", str(partial), url,
    ], check=True)
    with partial.open("rb") as file:
        if file.read(5) != b"%PDF-":
            raise ValueError(f"Invalid PDF from {url}")
    partial.replace(path)


def cached_evidence(url):
    path = cache_path(url)
    if not path.exists():
        return {}
    import pymupdf

    raw = path.read_bytes()
    with pymupdf.open(stream=raw) as pdf:
        candidates = []
        for number, page in enumerate(pdf, start=1):
            raw_text = page.get_text()
            text = re.sub(r"\s+", "", raw_text)
            heading = re.search(
                r"^\s*(?:[0-9０-９-]+\s*[.．　]\s*)?卒業(?:の要件|要件|条件|に必要な単位)[\s*＊]*$",
                raw_text, re.M,
            )
            table = "卒業必要単位数は下表のとおり" in text
            if (heading or table) and re.search(r"[0-9０-９]{2,3}単位", text):
                candidates.append(number)
        return {"sha256": hashlib.sha256(raw).hexdigest(), "pages": len(pdf), "graduationPages": candidates}


def build(current, archive, fetch=False):
    current_html = current.read_text(encoding="utf-8-sig")
    current_section = current_html.split("2026年度 学修要覧</h3>", 1)[1].split("2026年度 履修要綱</h3>", 1)[0]
    archive_html = archive.read_text(encoding="utf-8-sig")
    sections = re.split(r'<h3\b[^>]*>(20\d\d)年度</h3>', archive_html)
    year_sections = {int(year): section for year, section in zip(sections[1::2], sections[2::2])}
    year_sections[2026] = current_section
    items = [entry for year in range(2022, 2027) for entry in profiles(year, year_sections[year])]
    urls = sorted({source["url"] for entry in items for source in entry["sources"]})
    if fetch:
        with ThreadPoolExecutor(max_workers=4) as pool:
            for _ in pool.map(download, urls):
                pass
    documents = {url: cached_evidence(url) for url in urls}
    for row in items:
        evidence = documents[row["sources"][0]["url"]]
        if evidence:
            pages = [
                page for template in row.get("graduationTemplates", [])
                for page in [template["sourcePage"], *template.get("additionalPages", [])]
            ]
            if any(not 1 <= page <= evidence["pages"] for page in pages):
                raise ValueError(f"Invalid graduation source page for {row['department']} {row['year']}")
            evidence["graduationPages"] = sorted(set(evidence["graduationPages"]) | set(pages))
    return {
        "schemaVersion": 1,
        "indexes": [
            {"url": url, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            for url, path in [
                ("https://www.asc.tcu.ac.jp/", current),
                ("https://www.asc.tcu.ac.jp/syllabus_archives/", archive),
            ]
        ],
        "documents": documents,
        "profiles": items,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("current", type=Path)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--fetch", action="store_true", help="Download missing PDFs from the official links")
    args = parser.parse_args()
    output = build(args.current, args.archive, args.fetch)
    (ROOT / "undergraduate-guides.json").write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
