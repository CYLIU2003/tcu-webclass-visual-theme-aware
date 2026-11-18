"""Extract explicit year-advancement unit totals from the saved undergraduate guides."""

import hashlib
import json
import re
import unicodedata
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent
THIRD = re.compile(
    r"3年次(?:への)?進級(?:条件|要件)(?P<body>.{0,80}?(?:2年次終了時|2年以上在学).{0,80}?)"
    r"(?P<units>\d{2,3})単位(?:未満|以上.{0,4}修得)"
)
FOURTH = re.compile(
    r"4年次(?:への)?進級(?:条件|要件)[*＊]*(?:1一般コース2国際コース)?"
    r"総単位数(?P<units>\d{2,3})単位(?=\(?ただし|\(?以下|\(?下記)"
)
SUPPLEMENT = {
    "2023:応用化学科": [{"stage": 3, "minimum": 60, "page": 8}],
    "2023:原子力安全工学科": [{"stage": 3, "minimum": 60, "page": 8}],
    "2023:自然科学科": [{"stage": 3, "minimum": 60, "page": 8}],
    "2023:デザイン・データ科学科": [{"stage": 3, "minimum": 50, "page": 76}],
    "2024:デザイン・データ科学科": [{"stage": 3, "minimum": 50, "page": 74}],
}


def extract(url):
    path = ROOT / "source-cache" / "undergraduate-guides" / (hashlib.sha256(url.encode()).hexdigest() + ".pdf")
    with pymupdf.open(path) as document:
        return [
            re.sub(r"\s+", "", unicodedata.normalize("NFKC", page.get_text()))
            for page in document
        ]


def collect(profile, pages):
    rules = []
    for stage, pattern in [(3, THIRD), (4, FOURTH)]:
        matches = []
        for page, text in enumerate(pages, 1):
            if profile["sources"][0]["kind"] == "faculty" and profile["department"] not in text:
                continue
            for match in pattern.finditer(text):
                matches.append((page, int(match["units"])))
        distinct = {units for _, units in matches}
        if len(distinct) == 1:
            page, units = matches[0]
            if 30 <= units <= 124:
                rules.append({"stage": stage, "minimum": units, "page": page})
    return rules


def main():
    guides = json.loads((ROOT / "undergraduate-guides.json").read_text(encoding="utf-8"))
    pages_by_source = {}
    profiles = {}
    for profile in guides["profiles"]:
        url = profile["sources"][0]["url"]
        if url not in pages_by_source:
            pages_by_source[url] = extract(url)
        key = f'{profile["year"]}:{profile["department"]}'
        rules = collect(profile, pages_by_source[url])
        stages = {rule["stage"] for rule in rules}
        rules.extend(rule for rule in SUPPLEMENT.get(key, []) if rule["stage"] not in stages)
        if rules:
            profiles[key] = sorted(rules, key=lambda rule: rule["stage"])
    result = {"schemaVersion": 1, "profiles": profiles}
    (ROOT / "progression-rules.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                                                encoding="utf-8")
    print(f"Extracted explicit totals for {len(profiles)} of {len(guides['profiles'])} profiles.")


if __name__ == "__main__":
    main()
